import net from 'net';
import Redis from 'ioredis';

export class PortManager {
  private static localFallbackPorts = new Set<number>();
  private static readonly DEFAULT_START_PORT = 3100;
  private static readonly DEFAULT_END_PORT = 4500;
  private static readonly DEFAULT_LEASE_TTL_SECONDS = 7200; // 2 hours TTL for auto-recovery of crashed workers
  private static readonly LEASE_KEY_PREFIX = 'deployhub:port:lease:';
  private static redisClient: Redis | null = null;

  /**
   * Returns or initializes the Redis client for distributed port leasing.
   */
  public static getRedis(): Redis {
    if (!this.redisClient) {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const password = process.env.REDIS_PASSWORD || undefined;

      this.redisClient = new Redis({
        host,
        port,
        password,
        lazyConnect: false,
        enableOfflineQueue: true,
        maxRetriesPerRequest: 3,
      });

      this.redisClient.on('error', (err) => {
        console.warn(`[PortManager] Redis connection warning: ${err.message}`);
      });
    }
    return this.redisClient;
  }

  /**
   * Sets a custom Redis client (useful for unit/integration testing).
   */
  public static setRedis(client: Redis | null): void {
    this.redisClient = client;
  }

  /**
   * Checks if a given TCP port is available to bind at OS level.
   */
  static isTcpPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', () => {
        resolve(false);
      });

      server.once('listening', () => {
        server.close(() => {
          resolve(true);
        });
      });

      server.listen({ port, host: '0.0.0.0', exclusive: true });
    });
  }

  /**
   * Checks if a given port is unallocated in both Redis and locally.
   */
  static async isPortAvailable(port: number): Promise<boolean> {
    if (this.localFallbackPorts.has(port)) {
      return false;
    }

    try {
      const redis = this.getRedis();
      const lease = await redis.get(`${this.LEASE_KEY_PREFIX}${port}`);
      if (lease !== null) {
        return false;
      }
    } catch {
      // If Redis is unreachable, fallback to local tracking
    }

    return this.isTcpPortFree(port);
  }

  /**
   * Atomically acquires a distributed Redis-backed port lease with TTL and secondary TCP probing.
   */
  static async allocatePort(
    startPort = this.DEFAULT_START_PORT,
    endPort = this.DEFAULT_END_PORT,
    owner = 'worker'
  ): Promise<number> {
    const totalPorts = endPort - startPort + 1;
    const randomOffset = Math.floor(Math.random() * totalPorts);
    const leaseTtl = parseInt(process.env.PORT_LEASE_TTL || String(this.DEFAULT_LEASE_TTL_SECONDS), 10);

    for (let i = 0; i < totalPorts; i++) {
      const candidatePort = startPort + ((randomOffset + i) % totalPorts);

      if (this.localFallbackPorts.has(candidatePort)) {
        continue;
      }

      let acquiredRedisLease = false;

      try {
        const redis = this.getRedis();
        const leaseKey = `${this.LEASE_KEY_PREFIX}${candidatePort}`;
        const leaseValue = `${owner}:${Date.now()}`;

        // Atomic acquisition with SET NX EX
        const result = await redis.set(leaseKey, leaseValue, 'EX', leaseTtl, 'NX');
        if (result === 'OK') {
          acquiredRedisLease = true;
        } else {
          // Already leased by another worker process
          continue;
        }
      } catch (err: any) {
        console.warn(`[PortManager] Redis lease warning for port ${candidatePort}: ${err.message}. Falling back to TCP check.`);
      }

      // Secondary validation: TCP probe to verify nothing else bound outside DeployHub
      const tcpFree = await this.isTcpPortFree(candidatePort);
      if (tcpFree) {
        this.localFallbackPorts.add(candidatePort);
        return candidatePort;
      }

      // If TCP probe failed, release the Redis lease we just took
      if (acquiredRedisLease) {
        try {
          const redis = this.getRedis();
          await redis.del(`${this.LEASE_KEY_PREFIX}${candidatePort}`);
        } catch {
          // Ignored
        }
      }
    }

    throw new Error(
      `No available ports found in range ${startPort}-${endPort}. All ports are currently leased or bound.`
    );
  }

  /**
   * Releases an allocated port lease in Redis and locally.
   */
  static async releasePort(port: number): Promise<void> {
    this.localFallbackPorts.delete(port);

    try {
      const redis = this.getRedis();
      await redis.del(`${this.LEASE_KEY_PREFIX}${port}`);
    } catch (err: any) {
      console.warn(`[PortManager] Failed to delete Redis port lease for ${port}: ${err.message}`);
    }
  }
}
