import dotenv from 'dotenv';
import path from 'path';

// Load .env from root workspace and local package
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { Worker, QueueEvents, Job } from 'bullmq';
import mongoose from 'mongoose';
import { processDeployJob } from './jobs/deploy.job';
import { processStopJob } from './jobs/stop.job';
import { ReconciliationService } from './services/reconciliation.service';
import { RecoveryService } from './services/recovery.service';
import type { DeployJobData, StopJobData } from '@deployhub/shared';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/deployhub';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const QUEUE_NAME = 'deployments';

const redisConnection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: process.env.REDIS_PASSWORD || undefined,
};

async function start() {
  // ── Connect MongoDB ─────────────────────────────────────────────────────────
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Worker connected to MongoDB');

  // ── Boot Reconciliation ─────────────────────────────────────────────────────
  try {
    console.log('🔍 Running boot-time deployment reconciliation...');
    const result = await ReconciliationService.reconcileStaleDeployments(300000);
    if (result.reconciledCount > 0) {
      console.log(`🛡️ Recovered ${result.reconciledCount} stale deployments left from previous worker session.`);
    } else {
      console.log('✅ No stale deployments found.');
    }
  } catch (err: any) {
    console.warn('Reconciliation warning:', err.message);
  }

  // ── Periodic Background Reconciliation (Every 60s) ──────────────────────────
  const reconcileInterval = setInterval(async () => {
    try {
      await ReconciliationService.reconcileStaleDeployments(300000);
    } catch (err: any) {
      console.warn('Periodic reconciliation warning:', err.message);
    }
  }, 60000);

  // ── Periodic Container Recovery (Every 30s) ─────────────────────────────────
  const recoveryInterval = setInterval(async () => {
    try {
      await RecoveryService.checkAndRecoverActiveContainers();
    } catch (err: any) {
      console.warn('Container recovery check warning:', err.message);
    }
  }, 30000);

  // ── Start BullMQ Worker ─────────────────────────────────────────────────────
  const worker = new Worker<DeployJobData | StopJobData>(
    QUEUE_NAME,
    async (job: Job<any>) => {
      if (job.name === 'stop') {
        await processStopJob(job as Job<StopJobData>);
      } else {
        await processDeployJob(job as Job<DeployJobData>);
      }
    },
    {
      connection: redisConnection,
      concurrency: 2, // Process 2 deployments at a time
      limiter: {
        max: 10,
        duration: 60000,
      },
    }
  );

  // ── Event Listeners ─────────────────────────────────────────────────────────
  worker.on('ready', () => {
    console.log(`\n🔧 DeployHub Worker ready`);
    console.log(`   Queue: ${QUEUE_NAME}`);
    console.log(`   Concurrency: 2`);
    console.log(`   Redis: ${REDIS_HOST}:${REDIS_PORT}\n`);
  });

  worker.on('active', (job) => {
    console.log(
      `📦 Job ${job.id} (${job.name}) started — deployment ${job.data.deploymentId}`
    );
  });

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} (${job.name}) completed`);
  });

  worker.on('failed', (job, err) => {
    if (job) {
      const attemptsLeft = (job.opts.attempts || 3) - job.attemptsMade;
      console.error(
        `❌ Job ${job.id} (${job.name}) failed (${attemptsLeft} retries left): ${err.message}`
      );
    }
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
  });

  // ── Queue Events (for logging) ──────────────────────────────────────────────
  const queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

  queueEvents.on('waiting', ({ jobId }) => {
    console.log(`⏳ Job ${jobId} waiting in queue`);
  });

  // ── Graceful Shutdown ───────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n🛑 Shutting down worker...');
    clearInterval(reconcileInterval);
    clearInterval(recoveryInterval);
    await worker.close();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Failed to start worker:', err);
  process.exit(1);
});
