import { Queue } from 'bullmq';
import { config } from './index';
import type { DeployJobData, StopJobData } from '@deployhub/shared';

export const DEPLOY_QUEUE_NAME = 'deployments';

export const deployQueue = new Queue<DeployJobData | StopJobData>(DEPLOY_QUEUE_NAME, {
  connection: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

deployQueue.on('error', (err) => {
  console.error('Deploy queue error:', err);
});

console.log('✅ BullMQ deploy queue initialized');
