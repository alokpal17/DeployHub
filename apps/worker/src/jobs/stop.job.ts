import { Job } from 'bullmq';
import { DeploymentModel } from '@deployhub/shared';
import type { StopJobData } from '@deployhub/shared';
import { DockerService } from '../services/docker.service';
import { PortManager } from '../services/port-manager.service';

export async function processStopJob(job: Job<StopJobData>): Promise<void> {
  const { deploymentId, containerId, projectId } = job.data;

  console.log(`\n==================================================`);
  console.log(`🛑 Processing Stop Job for Deployment: ${deploymentId}`);
  console.log(`   Container: ${containerId || 'N/A'}`);
  console.log(`   Project: ${projectId}`);
  console.log(`==================================================\n`);

  try {
    const deployment = await DeploymentModel.findById(deploymentId);

    const targetContainer = containerId || deployment?.containerId;
    if (targetContainer) {
      await DockerService.stopAndRemoveContainer(targetContainer);
      console.log(`✅ Stopped Docker container ${targetContainer}`);
    }

    if (deployment?.containerPort) {
      await PortManager.releasePort(deployment.containerPort);
      console.log(`✅ Released port ${deployment.containerPort}`);
    }

    await DeploymentModel.findByIdAndUpdate(deploymentId, {
      status: 'STOPPED',
      finishedAt: new Date(),
      $push: { logs: `[DEPLOYHUB] 🛑 Container stopped and port released at ${new Date().toISOString()}` },
    });

    console.log(`✅ Deployment ${deploymentId} marked as STOPPED`);
  } catch (err: any) {
    console.error(`❌ Failed to cleanly stop deployment ${deploymentId}:`, err.message);
    throw err;
  }
}
