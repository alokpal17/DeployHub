import { exec } from 'child_process';
import { promisify } from 'util';
import { DeploymentModel, ProjectModel } from '@deployhub/shared';
import { DockerService } from './docker.service';

const execAsync = promisify(exec);

export class RecoveryService {
  /**
   * Scans active deployments and automatically restarts crashed containers within bounded limits.
   */
  static async checkAndRecoverActiveContainers(): Promise<{
    checked: number;
    recovered: number;
    failed: number;
  }> {
    let checked = 0;
    let recovered = 0;
    let failed = 0;

    try {
      // Find all active deployments
      const activeDeployments = await DeploymentModel.find({
        status: { $in: ['RUNNING', 'ACTIVE'] },
        containerId: { $exists: true, $ne: null },
      });

      for (const dep of activeDeployments) {
        checked++;
        const containerId = dep.containerId!;
        const port = dep.containerPort;

        try {
          // Check docker inspect status
          const { stdout } = await execAsync(
            `docker inspect -f "{{.State.Status}} {{.State.ExitCode}} {{.State.Restarting}}" ${containerId}`
          ).catch(() => ({ stdout: '' }));

          const trimmed = stdout.trim();
          if (!trimmed) {
            // Container doesn't exist anymore
            continue;
          }

          const [status] = trimmed.split(' ');

          // If running, verify if container is responding
          if (status === 'running') {
            continue;
          }

          // Container is NOT running (e.g. 'exited', 'dead', 'created')
          console.warn(
            `⚠️ [RecoveryService] Active container ${containerId.slice(0, 12)} for deployment ${dep._id} is ${status}. Checking recovery eligibility...`
          );

          const project = await ProjectModel.findById(dep.projectId);
          const autoRecovery = project ? project.autoRecovery !== false : true;
          const maxAttempts = project?.maxRestartAttempts || 3;
          const currentRestarts = dep.restartCount || 0;

          if (!autoRecovery) {
            console.log(`[RecoveryService] Auto-recovery disabled for project ${dep.projectId}.`);
            continue;
          }

          if (currentRestarts >= maxAttempts) {
            console.warn(
              `❌ [RecoveryService] Deployment ${dep._id} exceeded max restart attempts (${currentRestarts}/${maxAttempts}). Marking UNHEALTHY.`
            );
            await DeploymentModel.findByIdAndUpdate(dep._id, {
              healthStatus: 'UNHEALTHY',
            });
            failed++;
            continue;
          }

          // Attempt restart
          console.log(
            `🔄 [RecoveryService] Attempting container restart (${currentRestarts + 1}/${maxAttempts}) for container ${containerId.slice(0, 12)}...`
          );

          await execAsync(`docker restart ${containerId}`);

          // Health check if port exists
          let isHealthy = true;
          if (port) {
            try {
              await DockerService.checkContainerHealth(containerId, port, 10000, () => {});
            } catch (err: any) {
              isHealthy = false;
              console.warn(`[RecoveryService] Post-restart health check failed: ${err.message}`);
            }
          }

          const newRestartCount = currentRestarts + 1;
          await DeploymentModel.findByIdAndUpdate(dep._id, {
            restartCount: newRestartCount,
            lastRestartAt: new Date(),
            healthStatus: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
          });

          if (isHealthy) {
            console.log(`✅ [RecoveryService] Container ${containerId.slice(0, 12)} successfully recovered!`);
            recovered++;
          } else {
            failed++;
          }
        } catch (err: any) {
          console.error(`[RecoveryService] Error inspecting/recovering deployment ${dep._id}:`, err.message);
          failed++;
        }
      }
    } catch (err: any) {
      console.error('[RecoveryService] Fatal recovery scan error:', err.message);
    }

    return { checked, recovered, failed };
  }
}
