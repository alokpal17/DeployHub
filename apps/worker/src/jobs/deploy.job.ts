import { Job } from 'bullmq';
import { DeploymentModel, ProjectModel } from '@deployhub/shared';
import type { DeployJobData, DeploymentStatus, ProjectType, DeploymentTimings } from '@deployhub/shared';
import { cloneRepository, cleanupRepo } from '../services/git.service';
import { ProjectDetector } from '../services/project-detector.service';
import { DockerService } from '../services/docker.service';
import { PortManager } from '../services/port-manager.service';
import { ProxyService } from '../services/proxy.service';
import { LogBuffer } from '../utils/log-buffer';

async function isDeploymentCancelled(deploymentId: string): Promise<boolean> {
  const dep = await DeploymentModel.findById(deploymentId, { status: 1 });
  return dep?.status === 'STOPPED';
}

async function updateDeployment(
  id: string,
  update: Partial<{
    status: DeploymentStatus;
    commitHash: string;
    commitAuthor: string;
    commitMessage: string;
    projectType: ProjectType;
    imageName: string;
    containerId: string;
    containerPort: number;
    releaseVersion: number;
    healthStatus: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
    isRollback: boolean;
    rollbackFromDeploymentId: any;
    rollbackToDeploymentId: any;
    error: string;
    queuedAt: Date;
    buildStartedAt: Date;
    buildFinishedAt: Date;
    deployStartedAt: Date;
    healthCheckStartedAt: Date;
    runningAt: Date;
    finishedAt: Date;
    lastHeartbeatAt: Date;
    timings: DeploymentTimings;
  }>
) {
  await DeploymentModel.findOneAndUpdate(
    { _id: id, status: { $ne: 'STOPPED' } },
    {
      ...update,
      lastHeartbeatAt: new Date(),
    }
  );
}

export async function processDeployJob(job: Job<DeployJobData>): Promise<void> {
  const {
    deploymentId,
    repositoryUrl,
    branch,
    projectId,
    envVars = {},
    trigger = 'MANUAL',
    queuedAt,
    isRollback = false,
    rollbackToDeploymentId,
    imageName: prebuiltImageName,
  } = job.data;

  const jobStartTime = Date.now();
  const queueTime = queuedAt ? new Date(queuedAt).getTime() : jobStartTime;
  const queueWaitMs = Math.max(0, jobStartTime - queueTime);

  console.log(`\n==================================================`);
  console.log(`🚀 Starting Deployment Job: ${deploymentId} [${trigger}]`);
  console.log(`   Project: ${projectId}`);
  console.log(`   Repo: ${repositoryUrl || 'Rollback from artifact'} (${branch || 'N/A'})`);
  console.log(`   Queue wait: ${queueWaitMs}ms`);
  if (isRollback) {
    console.log(`   🔄 ROLLBACK to target: ${rollbackToDeploymentId}`);
  }
  if (Object.keys(envVars).length > 0) {
    console.log(`   Env Vars: ${Object.keys(envVars).join(', ')}`);
  }
  console.log(`==================================================\n`);

  // Redact sensitive environment variables in logs
  const secretsToRedact = Object.entries(envVars)
    .filter(([k]) => k !== 'PORT' && k !== 'HOST' && k !== 'NODE_ENV')
    .map(([, v]) => String(v))
    .filter((v) => v && v.length >= 2);

  const logBuffer = new LogBuffer(
    deploymentId,
    (line) => {
      console.log(`  [${deploymentId.slice(-6)}] ${line}`);
    },
    secretsToRedact
  );

  const log = (line: string) => logBuffer.push(line);

  let repoPath: string | null = null;
  let allocatedPort: number | null = null;
  let createdContainerName: string | null = null;
  let builtImageName: string | null = prebuiltImageName || null;
  const buildAbortController = new AbortController();

  // Timings tracking
  let cloneStart = 0;
  let cloneDurationMs = 0;
  let buildStart = 0;
  let buildDurationMs = 0;
  let containerStartupStart = 0;
  let containerStartupDurationMs = 0;
  let healthCheckStart = 0;
  let healthCheckDurationMs = 0;
  let proxySwitchStart = 0;
  let proxySwitchDurationMs = 0;

  try {
    // ── CANCELLATION CHECK 1: Before Start ───────────────────────────────────
    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled before start. Aborting.');
      return;
    }

    const project = await ProjectModel.findById(projectId);
    const nextVersion = (project?.latestReleaseVersion || 0) + 1;

    // ── STAGE 1: SOURCE CLONE & BUILD (Skipped if Rollback) ───────────────────
    if (isRollback && rollbackToDeploymentId) {
      await log('[DEPLOYHUB] ──────────────────────────────────────────');
      await log(`[DEPLOYHUB] 🔄 Initializing Zero-Downtime Rollback Pipeline...`);
      await log(`[DEPLOYHUB] 📦 Target release artifact: ${rollbackToDeploymentId}`);

      const targetDep = await DeploymentModel.findById(rollbackToDeploymentId);
      if (!targetDep || !targetDep.imageName) {
        throw new Error(`Rollback target deployment ${rollbackToDeploymentId} has no valid container image.`);
      }

      builtImageName = targetDep.imageName;
      await updateDeployment(deploymentId, {
        status: 'DEPLOYING',
        isRollback: true,
        rollbackToDeploymentId: targetDep._id,
        commitHash: targetDep.commitHash,
        commitAuthor: targetDep.commitAuthor,
        commitMessage: `Rollback to release ${targetDep.releaseVersion || ''} (${targetDep.commitHash.slice(0, 7)})`,
        projectType: targetDep.projectType as ProjectType,
        imageName: builtImageName,
        releaseVersion: nextVersion,
      });
      await job.updateProgress(40);
    } else {
      const buildStartedAt = new Date();
      await updateDeployment(deploymentId, {
        status: 'BUILDING',
        buildStartedAt,
        releaseVersion: nextVersion,
        lastHeartbeatAt: new Date(),
      });

      await log('[DEPLOYHUB] ──────────────────────────────────────────');
      await log(`[DEPLOYHUB] 📦 Stage 1/4: Initializing workspace and fetching source...`);
      await job.updateProgress(10);

      cloneStart = Date.now();
      const cloneResult = await cloneRepository(repositoryUrl, branch, deploymentId, log);
      cloneDurationMs = Date.now() - cloneStart;
      repoPath = cloneResult.repoPath;

      // ── CANCELLATION CHECK 2: After Clone ──────────────────────────────────
      if (await isDeploymentCancelled(deploymentId)) {
        await log('[DEPLOYHUB] 🛑 Deployment was cancelled after repository clone. Aborting.');
        return;
      }

      await updateDeployment(deploymentId, {
        commitHash: cloneResult.commitHash,
        commitAuthor: cloneResult.commitAuthor,
        commitMessage: cloneResult.commitMessage,
        lastHeartbeatAt: new Date(),
      });
      await job.updateProgress(25);

      // ── STAGE 2: PROJECT DETECTION & DOCKERFILE PREPARATION ────────────────
      await log('[DEPLOYHUB] ──────────────────────────────────────────');
      await log(`[DEPLOYHUB] 🔍 Stage 2/4: Detecting project framework & runtime...`);

      const detection = await ProjectDetector.detect(repoPath);
      await log(
        `[DEPLOYHUB] Detected Type: "${detection.type}" (Framework: ${
          detection.framework || 'Generic'
        })`
      );

      if (detection.type === 'unknown') {
        throw new Error(
          'Could not detect a supported application structure. Please provide a Dockerfile, package.json, or index.html.'
        );
      }

      // ── CANCELLATION CHECK 3: Before Docker Build ──────────────────────────
      if (await isDeploymentCancelled(deploymentId)) {
        await log('[DEPLOYHUB] 🛑 Deployment was cancelled before build. Aborting.');
        return;
      }

      await updateDeployment(deploymentId, { projectType: detection.type, lastHeartbeatAt: new Date() });
      await DockerService.prepareDockerfile(repoPath, detection, log);
      await job.updateProgress(40);

      // ── STAGE 3: DOCKER IMAGE BUILD ────────────────────────────────────────
      await log('[DEPLOYHUB] ──────────────────────────────────────────');
      await log(`[DEPLOYHUB] 🐳 Stage 3/4: Building isolated container image...`);

      const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const sanitizedDeploymentId = deploymentId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      builtImageName = `deployhub-${sanitizedProjectId}-${sanitizedDeploymentId}`.slice(0, 50);

      buildStart = Date.now();
      await DockerService.buildDockerImage(
        repoPath,
        builtImageName,
        log,
        600000,
        buildAbortController.signal
      );
      buildDurationMs = Date.now() - buildStart;
      const buildFinishedAt = new Date();

      // ── CANCELLATION CHECK 4: After Docker Build ───────────────────────────
      if (await isDeploymentCancelled(deploymentId)) {
        await log('[DEPLOYHUB] 🛑 Deployment was cancelled during/after build. Cleaning up image.');
        if (builtImageName) await DockerService.removeImage(builtImageName);
        return;
      }

      await updateDeployment(deploymentId, {
        imageName: builtImageName,
        buildFinishedAt,
        lastHeartbeatAt: new Date(),
      });
      await job.updateProgress(70);
    }

    // ── STAGE 4: DEPLOYING & PORT ALLOCATION ─────────────────────────────────
    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled before port allocation. Aborting.');
      return;
    }

    const deployStartedAt = new Date();
    await updateDeployment(deploymentId, {
      status: 'DEPLOYING',
      deployStartedAt,
      lastHeartbeatAt: new Date(),
    });

    await log('[DEPLOYHUB] ──────────────────────────────────────────');
    await log(`[DEPLOYHUB] 🚀 Stage 4/4: Allocating host port & starting container (Zero-Downtime)...`);

    allocatedPort = await PortManager.allocatePort(undefined, undefined, deploymentId);
    await log(`[DEPLOYHUB] Allocated isolated host port :${allocatedPort}`);

    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled before container creation. Releasing port.');
      await PortManager.releasePort(allocatedPort);
      return;
    }

    const sanitizedDeploymentId = deploymentId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    createdContainerName = `deployhub-${sanitizedDeploymentId}`.slice(0, 50);

    containerStartupStart = Date.now();
    const runResult = await DockerService.runDockerContainer(
      {
        imageName: builtImageName!,
        containerName: createdContainerName,
        hostPort: allocatedPort,
        containerPort: 3000,
        projectId,
        deploymentId,
        envVars,
      },
      log
    );
    containerStartupDurationMs = Date.now() - containerStartupStart;

    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled after container start. Tearing down container.');
      await DockerService.stopAndRemoveContainer(runResult.containerId);
      await PortManager.releasePort(allocatedPort);
      return;
    }

    await job.updateProgress(85);

    // ── STAGE 5: HEALTH & READINESS VERIFICATION ─────────────────────────────
    const healthCheckStartedAt = new Date();
    await updateDeployment(deploymentId, {
      status: 'HEALTH_CHECKING',
      healthCheckStartedAt,
      lastHeartbeatAt: new Date(),
    });

    healthCheckStart = Date.now();
    await DockerService.checkContainerHealth(runResult.containerId, allocatedPort, 25000, log);
    healthCheckDurationMs = Date.now() - healthCheckStart;

    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled during health check. Tearing down container.');
      await DockerService.stopAndRemoveContainer(runResult.containerId);
      await PortManager.releasePort(allocatedPort);
      return;
    }

    await job.updateProgress(90);

    // ── STAGE 6: ZERO-DOWNTIME TRAFFIC SWITCH ────────────────────────────────
    await log('[DEPLOYHUB] ──────────────────────────────────────────');
    await log(`[DEPLOYHUB] 🔀 Switching reverse proxy traffic to new container :${allocatedPort}...`);

    proxySwitchStart = Date.now();
    await ProxyService.switchTraffic(projectId, allocatedPort, deploymentId);
    proxySwitchDurationMs = Date.now() - proxySwitchStart;

    await log(`[DEPLOYHUB] ✅ Traffic successfully switched to release v${nextVersion} (Port :${allocatedPort})`);
    await job.updateProgress(95);

    // ── STAGE 7: RETIRE OLD ACTIVE & UPDATE METADATA ─────────────────────────
    const runningAt = new Date();
    const totalDurationMs = Date.now() - jobStartTime;

    const timings: DeploymentTimings = {
      queueWaitMs,
      cloneDurationMs,
      buildDurationMs,
      containerStartupDurationMs,
      healthCheckDurationMs,
      proxySwitchDurationMs,
      totalDurationMs,
    };

    // Find previous active deployment to transition to PREVIOUS
    const previousActive = await DeploymentModel.findOne({
      projectId,
      _id: { $ne: deploymentId },
      status: { $in: ['RUNNING', 'ACTIVE'] },
    });

    // Mark previous deployment as PREVIOUS
    if (previousActive) {
      await DeploymentModel.findByIdAndUpdate(previousActive._id, {
        status: 'PREVIOUS',
      });
      await log(`[DEPLOYHUB] Previous active deployment ${previousActive._id} marked as PREVIOUS.`);

      // Gracefully stop previous container now that new container is active & serving traffic
      await DockerService.stopPreviousProjectContainers(projectId, deploymentId, log);
      if (previousActive.containerPort) {
        await PortManager.releasePort(previousActive.containerPort);
      }
    }

    // Atomic conditional update: Transition new deployment to ACTIVE / RUNNING
    const updateResult = await DeploymentModel.findOneAndUpdate(
      { _id: deploymentId, status: { $ne: 'STOPPED' } },
      {
        $set: {
          status: 'RUNNING', // Note: 'RUNNING' preserves full M1-M3.5 compatibility while acting as active release
          healthStatus: 'HEALTHY',
          containerId: runResult.containerId,
          containerPort: allocatedPort,
          releaseVersion: nextVersion,
          runningAt,
          finishedAt: runningAt,
          timings,
          lastHeartbeatAt: new Date(),
        },
      },
      { new: true }
    );

    if (!updateResult || updateResult.status === 'STOPPED') {
      await log('[DEPLOYHUB] 🛑 Concurrent STOP detected during final transition. Releasing resources.');
      await DockerService.stopAndRemoveContainer(runResult.containerId);
      await PortManager.releasePort(allocatedPort);
      return;
    }

    // Update project active deployment references
    await ProjectModel.findByIdAndUpdate(projectId, {
      activeDeploymentId: deploymentId,
      previousDeploymentId: previousActive ? previousActive._id : undefined,
      latestReleaseVersion: nextVersion,
    });

    // Clean obsolete images (keeping active container images safe)
    await DockerService.cleanupObsoleteProjectImages(projectId, builtImageName!, log);

    await log('[DEPLOYHUB] ──────────────────────────────────────────');
    await log(`[DEPLOYHUB] ✅ Release v${nextVersion} is LIVE and healthy (ACTIVE)!`);
    await log(`[DEPLOYHUB] 🌐 Host URL: http://localhost:${allocatedPort}`);
    await log(`[DEPLOYHUB] 🌐 Proxy Gateway: http://localhost:8080/p/${projectId}`);
    await log(`[DEPLOYHUB] ⏱️ Timings: Build ${Math.round(buildDurationMs / 1000)}s | Total ${Math.round(totalDurationMs / 1000)}s`);
    await job.updateProgress(100);

    console.log(
      `✅ Deployment ${deploymentId} (v${nextVersion}) successfully ACTIVE on port ${allocatedPort} (${Math.round(totalDurationMs / 1000)}s)`
    );
  } catch (err: any) {
    buildAbortController.abort();

    const isCancelled = await isDeploymentCancelled(deploymentId);
    const errorMessage = err.message || 'Unknown deployment failure';

    if (!isCancelled) {
      console.error(`❌ Deployment ${deploymentId} failed:`, errorMessage);
      await log(`[DEPLOYHUB] ❌ DEPLOYMENT FAILED: ${errorMessage}`);
      await log(`[DEPLOYHUB] 🛡️ Zero-Downtime Protection: Prior active deployment remains unaffected.`);
    } else {
      console.log(`🛑 Deployment ${deploymentId} was aborted/stopped:`, errorMessage);
      await log(`[DEPLOYHUB] 🛑 DEPLOYMENT STOPPED: ${errorMessage}`);
    }

    // Clean up ONLY new unverified resources; NEVER touch old active resources!
    if (allocatedPort) {
      await PortManager.releasePort(allocatedPort);
    }

    if (createdContainerName) {
      await DockerService.stopAndRemoveContainer(createdContainerName);
    }

    if (builtImageName && !isRollback) {
      await DockerService.cleanupFailedDeploymentImage(builtImageName);
    }

    const totalDurationMs = Date.now() - jobStartTime;
    const timings: DeploymentTimings = {
      queueWaitMs,
      cloneDurationMs,
      buildDurationMs,
      containerStartupDurationMs,
      healthCheckDurationMs,
      proxySwitchDurationMs,
      totalDurationMs,
    };

    if (!isCancelled) {
      await DeploymentModel.findOneAndUpdate(
        { _id: deploymentId, status: { $ne: 'STOPPED' } },
        {
          $set: {
            status: 'FAILED',
            healthStatus: 'UNHEALTHY',
            error: errorMessage,
            finishedAt: new Date(),
            timings,
            lastHeartbeatAt: new Date(),
          },
        }
      );
    }
  } finally {
    if (repoPath) {
      await cleanupRepo(repoPath);
    }
    await logBuffer.flush();
  }
}
