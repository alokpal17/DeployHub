import http from 'http';
import { Request, Response } from 'express';
import Redis from 'ioredis';

export interface ProxyRoute {
  projectId: string;
  targetPort: number;
  deploymentId: string;
  updatedAt: number;
}

export class ProxyService {
  private static localRoutes = new Map<string, ProxyRoute>();
  private static redisClient: Redis | null = null;
  private static redisSub: Redis | null = null;
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
   * Initializes real-time distributed proxy synchronization via Redis Pub/Sub
   */
  static initSync(): void {
    if (this.redisSub) return;
    try {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;

      this.redisSub = new Redis({
        host,
        port,
        password,
        enableOfflineQueue: true,
      });

      this.redisSub.subscribe(this.PROXY_CHANNEL, (err) => {
        if (err) console.warn('[ProxyService] Sub error:', err.message);
      });

      this.redisSub.on('message', (_channel, message) => {
        try {
          const payload = JSON.parse(message);
          if (payload?.projectId && payload?.targetPort) {
            this.localRoutes.set(payload.projectId, payload);
          } else if (payload?.type === 'DELETE' && payload?.projectId) {
            this.localRoutes.delete(payload.projectId);
          }
        } catch {}
      });
    } catch (e: any) {
      console.warn('[ProxyService] Sync initialization warning:', e.message);
    }
  }

  /**
   * Retrieves the active target port for a given project ID
   */
  static async getActiveRoute(projectId: string): Promise<ProxyRoute | null> {
    // 1. Check local cache
    const local = this.localRoutes.get(projectId);
    if (local) return local;

    // 2. Check Redis
    try {
      const redis = this.getRedis();
      const raw = await redis.get(`${this.ROUTE_PREFIX}${projectId}`);
      if (raw) {
        const route: ProxyRoute = JSON.parse(raw);
        this.localRoutes.set(projectId, route);
        return route;
      }
    } catch {}

    return null;
  }

  /**
   * Atomically switches traffic for a project to a new target container port
   */
  static async switchTraffic(
    projectId: string,
    targetPort: number,
    deploymentId: string
  ): Promise<boolean> {
    if (!projectId || !targetPort || targetPort < 1024 || targetPort > 65535) {
      throw new Error(`Invalid proxy routing parameters: projectId=${projectId}, targetPort=${targetPort}`);
    }

    // 1. Pre-switch health probe: verify target port is accepting HTTP traffic
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

    // 2. Persist in Redis
    const redis = this.getRedis();
    await redis.set(`${this.ROUTE_PREFIX}${projectId}`, JSON.stringify(route));

    // 3. Update local cache & broadcast
    this.localRoutes.set(projectId, route);
    try {
      await redis.publish(this.PROXY_CHANNEL, JSON.stringify(route));
    } catch {}

    console.log(`🔀 [ProxyService] Traffic switched for project ${projectId} -> port :${targetPort} (deployment ${deploymentId})`);
    return true;
  }

  /**
   * Removes proxy route for a deleted project
   */
  static async removeRoute(projectId: string): Promise<void> {
    this.localRoutes.delete(projectId);
    try {
      const redis = this.getRedis();
      await redis.del(`${this.ROUTE_PREFIX}${projectId}`);
      await redis.publish(this.PROXY_CHANNEL, JSON.stringify({ type: 'DELETE', projectId }));
    } catch {}
  }

  /**
   * Streams an incoming HTTP request to the active container for the project
   */
  static async handleProxyRequest(req: Request, res: Response, projectId: string): Promise<void> {
    const route = await this.getActiveRoute(projectId);
    if (!route || !route.targetPort) {
      res.status(502).json({
        success: false,
        error: `No active deployment found for project ${projectId}. Deployment may be offline or starting up.`,
      });
      return;
    }

    // Strip '/p/:projectId' or '/proxy/:projectId' prefix to pass rest of path to container
    let forwardPath = req.originalUrl || req.url || '/';
    const prefixMatch = forwardPath.match(/^(\/p\/[^\/]+|\/proxy\/[^\/]+|\/api\/proxy\/[^\/]+)/);
    if (prefixMatch) {
      forwardPath = forwardPath.slice(prefixMatch[1].length) || '/';
    }

    const targetPort = route.targetPort;
    const targetHost = '127.0.0.1';

    const clientReq = http.request(
      {
        host: targetHost,
        port: targetPort,
        path: forwardPath,
        method: req.method,
        headers: {
          ...req.headers,
          host: `${targetHost}:${targetPort}`,
          'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1',
          'x-forwarded-proto': req.protocol,
          'x-deployhub-project': projectId,
          'x-deployhub-deployment': route.deploymentId,
        },
        timeout: 30000,
      },
      (targetRes) => {
        res.writeHead(targetRes.statusCode || 200, targetRes.headers);
        targetRes.pipe(res);
      }
    );

    clientReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          error: `Bad Gateway: Unable to reach active deployment container on port :${targetPort}: ${err.message}`,
        });
      }
    });

    clientReq.on('timeout', () => {
      clientReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: `Gateway Timeout: Deployment container on port :${targetPort} did not respond within 30s.`,
        });
      }
    });

    req.pipe(clientReq);
  }
}
