import http from 'http';
import Redis from 'ioredis';

export interface ProxyRoute {
  projectId: string;
  targetPort: number;
  deploymentId: string;
  updatedAt: number;
}

export class ProxyService {
  private static redisClient: Redis | null = null;
  private static readonly ROUTE_PREFIX = 'deployhub:proxy:route:';
  private static readonly PROXY_CHANNEL = 'deployhub:proxy:events';

  private static getRedis(): Redis {
    if (!this.redisClient) {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;

      this.redisClient = new Redis({
        host,
        port,
        password,
        enableOfflineQueue: true,
        maxRetriesPerRequest: 3,
      });

      this.redisClient.on('error', (err) => {
        console.warn(`[ProxyService] Redis error: ${err.message}`);
      });
    }
    return this.redisClient;
  }

  /**
   * Switches traffic for a project to a new target container port in Redis and broadcasts event
   */
  static async switchTraffic(
    projectId: string,
    targetPort: number,
    deploymentId: string
  ): Promise<boolean> {
    if (!projectId || !targetPort || targetPort < 1024 || targetPort > 65535) {
      throw new Error(`Invalid proxy routing parameters: projectId=${projectId}, targetPort=${targetPort}`);
    }

    // Pre-switch health probe: verify target port is accepting HTTP traffic
    const isTargetHealthy = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://127.0.0.1:${targetPort}/`, { timeout: 2500 }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    if (!isTargetHealthy) {
      throw new Error(`Proxy switch rejected: Target container on port ${targetPort} failed HTTP pre-switch readiness probe`);
    }

    const route: ProxyRoute = {
      projectId,
      targetPort,
      deploymentId,
      updatedAt: Date.now(),
    };

    const redis = this.getRedis();
    await redis.set(`${this.ROUTE_PREFIX}${projectId}`, JSON.stringify(route));
    try {
      await redis.publish(this.PROXY_CHANNEL, JSON.stringify(route));
    } catch {}

    console.log(`🔀 [ProxyService] Traffic switched for project ${projectId} -> port :${targetPort} (deployment ${deploymentId})`);
    return true;
  }
}
