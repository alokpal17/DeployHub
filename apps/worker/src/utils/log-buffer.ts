import { DeploymentModel } from '@deployhub/shared';
import Redis from 'ioredis';

export class LogBuffer {
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private deploymentId: string;
  private onLogCallback?: (line: string) => void;
  private redactSecrets: string[] = [];
  private static readonly MAX_LOG_LINES_PER_DEPLOYMENT = 2000;
  private static redisClient: Redis | null = null;

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
    }
    return this.redisClient;
  }

  constructor(
    deploymentId: string,
    onLogCallback?: (line: string) => void,
    redactSecrets: string[] = []
  ) {
    this.deploymentId = deploymentId;
    this.onLogCallback = onLogCallback;
    this.redactSecrets = redactSecrets.filter((s) => s && s.length >= 2);
  }

  /**
   * Pushes a log line to the buffer, console, and broadcasts in real-time to Redis Pub/Sub for SSE streaming.
   */
  push(line: string): void {
    let formatted = line.trimEnd();
    if (!formatted) return;

    // Redact secret values from log output
    for (const secret of this.redactSecrets) {
      if (secret && formatted.includes(secret)) {
        formatted = formatted.split(secret).join('[REDACTED]');
      }
    }

    this.buffer.push(formatted);
    if (this.onLogCallback) {
      this.onLogCallback(formatted);
    }

    // Broadcast to real-time SSE stream listeners via Redis
    try {
      const redis = LogBuffer.getRedis();
      void redis.publish(`deployhub:logs:${this.deploymentId}`, formatted);
    } catch {}

    if (this.buffer.length >= 20) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, 300);
    }
  }

  /**
   * Flushes all buffered log lines to MongoDB with bounded document slice.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.isFlushing) {
      await new Promise((r) => setTimeout(r, 20));
    }

    if (this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const linesToFlush = [...this.buffer];
    this.buffer = [];

    try {
      // Use $slice: -2000 to keep the most recent 2,000 log lines per deployment,
      // strictly preventing unbounded MongoDB document growth toward the 16MB BSON limit.
      await DeploymentModel.findByIdAndUpdate(this.deploymentId, {
        $push: {
          logs: {
            $each: linesToFlush,
            $slice: -LogBuffer.MAX_LOG_LINES_PER_DEPLOYMENT,
          },
        },
      });
    } catch (err: any) {
      console.error(
        `[LogBuffer] Failed to persist logs to MongoDB for ${this.deploymentId}:`,
        err.message
      );
      // Put failed lines back to retry on next flush
      this.buffer.unshift(...linesToFlush);
    } finally {
      this.isFlushing = false;
      if (this.buffer.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          void this.flush();
        }, 500);
      }
    }
  }
}
