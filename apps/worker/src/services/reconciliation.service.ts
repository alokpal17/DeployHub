import { DeploymentModel } from '@deployhub/shared';
import { DockerService } from './docker.service';
import { PortManager } from './port-manager.service';

export interface ReconciliationResult {
  reconciledCount: number;
  recoveredDeploymentIds: string[];
}

export class ReconciliationService {
  /**
   * Scans MongoDB for any deployments left stuck in BUILDING, DEPLOYING, or QUEUED states
   * without an active heartbeat, marks them as FAILED, and cleans up Docker resources.
   *
   * @param staleThresholdMs Duration in ms after which a non-heartbeating deployment is considered stale (default: 5 min)
   */
  static async reconcileStaleDeployments(staleThresholdMs = 300000): Promise<ReconciliationResult> {
    const cutoffTime = new Date(Date.now() - staleThresholdMs);

    // Find any deployment in active pipeline states whose last heartbeat / start time is older than cutoff
    const staleDeployments = await DeploymentModel.find({
      status: { $in: ['BUILDING', 'DEPLOYING', 'QUEUED'] },
      $or: [
        { lastHeartbeatAt: { $lt: cutoffTime } },
        { lastHeartbeatAt: { $exists: false }, startedAt: { $lt: cutoffTime } },
      ],
    });

    const recoveredDeploymentIds: string[] = [];

    for (const dep of staleDeployments) {
      console.warn(
        `⚠️ [RECONCILIATION] Stale deployment detected: ${dep._id} (Status: ${dep.status}, Last Active: ${
          dep.lastHeartbeatAt || dep.startedAt
        })`
      );

      // 1. Teardown half-started container if any
      if (dep.containerId) {
        try {
          await DockerService.stopAndRemoveContainer(dep.containerId);
        } catch {
          // Ignored
        }
      }

      // 2. Release allocated port in Redis & local if any
      if (dep.containerPort) {
        try {
          await PortManager.releasePort(dep.containerPort);
        } catch {
          // Ignored
        }
      }

      // 3. Mark deployment as FAILED with descriptive error
      const errorMessage = 'Deployment timed out or interrupted: recovered by reconciliation engine';
      dep.status = 'FAILED';
      dep.error = errorMessage;
      dep.finishedAt = new Date();
      dep.logs.push(`[DEPLOYHUB] 🛑 ${errorMessage} at ${new Date().toISOString()}`);

      await dep.save();
      recoveredDeploymentIds.push(dep._id.toString());

      console.log(`✅ [RECONCILIATION] Successfully recovered stale deployment ${dep._id}`);
    }

    return {
      reconciledCount: recoveredDeploymentIds.length,
      recoveredDeploymentIds,
    };
  }
}
