import client from 'prom-client';
import { DeploymentModel } from '../models';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Create a dedicated Prometheus Registry
export const register = new client.Registry();

// Enable default Node.js runtime metrics (event loop lag, memory, CPU, GC)
client.collectDefaultMetrics({
  register,
  prefix: 'deployhub_',
});

// ─── Custom Deployment Metrics ────────────────────────────────────────────────
export const deploymentsTotal = new client.Counter({
  name: 'deployhub_deployments_total',
  help: 'Total number of deployment executions triggered',
  labelNames: ['project_id', 'status', 'trigger'] as const,
  registers: [register],
});

export const deploymentsSuccessTotal = new client.Counter({
  name: 'deployhub_deployments_success_total',
  help: 'Total number of successful deployments (reached RUNNING/ACTIVE state)',
  labelNames: ['project_id'] as const,
  registers: [register],
});

export const deploymentsFailedTotal = new client.Counter({
  name: 'deployhub_deployments_failed_total',
  help: 'Total number of failed deployments',
  labelNames: ['project_id', 'reason'] as const,
  registers: [register],
});

export const deploymentDurationSeconds = new client.Histogram({
  name: 'deployhub_deployment_duration_seconds',
  help: 'Total duration of end-to-end deployment lifecycle in seconds',
  labelNames: ['project_id'] as const,
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [register],
});

export const buildDurationSeconds = new client.Histogram({
  name: 'deployhub_build_duration_seconds',
  help: 'Duration of Docker image build phase in seconds',
  labelNames: ['project_id'] as const,
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [register],
});

export const queueWaitSeconds = new client.Histogram({
  name: 'deployhub_deployment_queue_wait_seconds',
  help: 'Time spent by a deployment job waiting in BullMQ queue before worker execution',
  labelNames: ['project_id'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const activeDeploymentsGauge = new client.Gauge({
  name: 'deployhub_active_deployments',
  help: 'Number of currently active deployments in QUEUED, BUILDING, DEPLOYING, or HEALTH_CHECKING states',
  labelNames: ['project_id'] as const,
  registers: [register],
});

export const runningContainersGauge = new client.Gauge({
  name: 'deployhub_running_containers',
  help: 'Number of active Docker containers managed by DeployHub',
  registers: [register],
});

export const deploymentFailuresByReason = new client.Counter({
  name: 'deployhub_deployment_failures_by_reason',
  help: 'Breakdown of deployment failures categorized by failure reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

// ─── Milestone 4: Release & Traffic Metrics ──────────────────────────────────
export const trafficSwitchesTotal = new client.Counter({
  name: 'deployhub_traffic_switches_total',
  help: 'Total number of reverse proxy traffic switches executed',
  labelNames: ['project_id', 'result'] as const,
  registers: [register],
});

export const rollbacksTotal = new client.Counter({
  name: 'deployhub_rollbacks_total',
  help: 'Total number of rollback operations triggered',
  labelNames: ['project_id', 'result'] as const,
  registers: [register],
});

export const containerRestartsTotal = new client.Counter({
  name: 'deployhub_container_restarts_total',
  help: 'Total number of automatic container restarts attempted',
  labelNames: ['project_id', 'result'] as const,
  registers: [register],
});

export const containerCpuUsageGauge = new client.Gauge({
  name: 'deployhub_container_cpu_usage',
  help: 'Real-time CPU percentage used by project container',
  labelNames: ['project_id', 'container_name'] as const,
  registers: [register],
});

export const containerMemoryUsageGauge = new client.Gauge({
  name: 'deployhub_container_memory_usage_bytes',
  help: 'Real-time memory usage in bytes by project container',
  labelNames: ['project_id', 'container_name'] as const,
  registers: [register],
});

export const containerMemoryLimitGauge = new client.Gauge({
  name: 'deployhub_container_memory_limit_bytes',
  help: 'Container memory limit in bytes',
  labelNames: ['project_id', 'container_name'] as const,
  registers: [register],
});

/**
 * Categorizes raw error messages into clean standard Prometheus reason labels
 */
export function categorizeFailureReason(errorMsg?: string): string {
  if (!errorMsg) return 'unknown_error';
  const msg = errorMsg.toLowerCase();
  if (msg.includes('git') || msg.includes('clone') || msg.includes('branch') || msg.includes('repository')) {
    return 'git_clone_error';
  }
  if (msg.includes('dockerfile') || msg.includes('docker build') || msg.includes('exit code 1')) {
    return 'build_failure';
  }
  if (msg.includes('crash') || msg.includes('exit code')) {
    return 'container_crash';
  }
  if (msg.includes('health') || msg.includes('liveness') || msg.includes('timeout')) {
    return 'health_check_timeout';
  }
  if (msg.includes('port') || msg.includes('collision')) {
    return 'port_allocation_error';
  }
  if (msg.includes('reconciliation') || msg.includes('interrupted')) {
    return 'reconciliation_timeout';
  }
  if (msg.includes('proxy') || msg.includes('switch')) {
    return 'proxy_switch_error';
  }
  return 'general_failure';
}

/**
 * Cleans up long-lived project_id label entries from Prometheus metrics
 * when a project is deleted, preventing unbounded in-memory label cardinality growth.
 */
export function removeProjectMetrics(projectId: string): void {
  try {
    const statuses = ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING', 'RUNNING', 'ACTIVE', 'PREVIOUS', 'FAILED', 'STOPPED'];
    const triggers = ['MANUAL', 'WEBHOOK', 'RETRY', 'RECONCILIATION', 'ROLLBACK'];
    const reasons = [
      'git_clone_error',
      'build_failure',
      'container_crash',
      'health_check_timeout',
      'port_allocation_error',
      'reconciliation_timeout',
      'proxy_switch_error',
      'general_failure',
      'unknown_error',
    ];
    const results = ['success', 'failed'];

    for (const status of statuses) {
      for (const trigger of triggers) {
        try {
          deploymentsTotal.remove({ project_id: projectId, status, trigger });
        } catch {}
      }
    }

    try {
      deploymentsSuccessTotal.remove({ project_id: projectId });
    } catch {}

    for (const reason of reasons) {
      try {
        deploymentsFailedTotal.remove({ project_id: projectId, reason });
      } catch {}
    }

    for (const res of results) {
      try {
        trafficSwitchesTotal.remove({ project_id: projectId, result: res });
      } catch {}
      try {
        rollbacksTotal.remove({ project_id: projectId, result: res });
      } catch {}
      try {
        containerRestartsTotal.remove({ project_id: projectId, result: res });
      } catch {}
    }

    try {
      deploymentDurationSeconds.remove({ project_id: projectId });
    } catch {}

    try {
      buildDurationSeconds.remove({ project_id: projectId });
    } catch {}

    try {
      queueWaitSeconds.remove({ project_id: projectId });
    } catch {}

    try {
      activeDeploymentsGauge.remove({ project_id: projectId });
    } catch {}
  } catch (err: any) {
    console.warn(`Failed to clean metrics for project ${projectId}:`, err.message);
  }
}

/**
 * Synchronizes real-time gauge values before Prometheus scrape
 */
export async function syncGauges(): Promise<void> {
  try {
    // 1. Sync active deployments count from database
    const activeCount = await DeploymentModel.countDocuments({
      status: { $in: ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING'] },
    });
    activeDeploymentsGauge.set({ project_id: 'global' }, activeCount);

    // 2. Sync running containers count from Docker
    try {
      const { stdout } = await execAsync('docker ps -q --filter "label=deployhub.project"');
      const count = stdout.trim().split('\n').filter(Boolean).length;
      runningContainersGauge.set(count);
    } catch {
      // If docker daemon is unreachable, keep previous count
    }
  } catch (err) {
    console.warn('Metrics gauge sync warning:', err);
  }
}

/**
 * Returns Prometheus-formatted metrics string
 */
export async function getPrometheusMetrics(): Promise<string> {
  await syncGauges();
  return register.metrics();
}
