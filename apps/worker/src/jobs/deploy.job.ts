import path from 'path';
import { existsSync } from 'fs';
import { Job } from 'bullmq';
import { DeploymentModel, ProjectModel } from '@deployhub/shared';
import type { DeployJobData, DeploymentStatus, ProjectType, DeploymentTimings } from '@deployhub/shared';
import { cloneRepository, cleanupRepo } from '../services/git.service';
import { ProjectDetector } from '../services/project-detector.service';
import { DockerService } from '../services/docker.service';
import { PortManager } from '../services/port-manager.service';
import { ProxyService } from '../services/proxy.service';
import { RuntimeDiagnosticsService } from '../services/runtime-diagnostics.service';
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
    deploymentMode: any;
    servicePath: string;
    detection: any;
    diagnostics: any;
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
    servicePath: requestedServicePath,
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
  let composeProjectName: string | null = null;
  let builtImageName: string | null = prebuiltImageName || null;
  let finalContainerId = '';
  let detectedType: ProjectType = 'unknown';
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
      detectedType = targetDep.projectType as ProjectType;
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

      // ── STAGE 2: PROJECT DETECTION & PREFLIGHT VALIDATION ───────────────────
      await log('[DEPLOYHUB] ──────────────────────────────────────────');
      await log(`[DEPLOYHUB] 🔍 Stage 2/4: Universal Repository Detection & Classification`);

      const detection = await ProjectDetector.detect(repoPath, envVars, requestedServicePath);
      detectedType = detection.type;

      await log(`[DEPLOYHUB]   • Project Type:     ${detection.type}`);
      await log(`[DEPLOYHUB]   • Framework:        ${detection.framework || 'Generic'}`);
      await log(`[DEPLOYHUB]   • Runtime:          ${detection.runtime || 'Container'}`);
      await log(`[DEPLOYHUB]   • Deployment Mode:  ${detection.deploymentMode || 'web'}`);
      if (detection.servicePath) {
        await log(`[DEPLOYHUB]   • Service Path:     ${detection.servicePath}`);
      }
      if (detection.entrypoint) {
        await log(`[DEPLOYHUB]   • Entrypoint:       ${detection.entrypoint}`);
      }
      if (detection.buildCommand) {
        await log(`[DEPLOYHUB]   • Build Command:    ${detection.buildCommand}`);
      }
      if (detection.startCommand) {
        await log(`[DEPLOYHUB]   • Start Command:    ${detection.startCommand}`);
      }
      if (detection.detectedPorts && detection.detectedPorts.length > 0) {
        await log(`[DEPLOYHUB]   • Detected Port(s): ${detection.detectedPorts.join(', ')}`);
      }

      if (detection.evidence && detection.evidence.length > 0) {
        await log(`[DEPLOYHUB] 📋 Classification Evidence:`);
        for (const ev of detection.evidence) {
          await log(`[DEPLOYHUB]   ✓ ${ev}`);
        }
      }

      if (detection.diagnostics && detection.diagnostics.length > 0) {
        for (const diag of detection.diagnostics) {
          await log(`[DEPLOYHUB] ${diag}`);
        }
      }

      await updateDeployment(deploymentId, {
        projectType: detection.type,
        deploymentMode: detection.deploymentMode,
        servicePath: detection.servicePath,
        detection: detection,
        lastHeartbeatAt: new Date(),
      });

      if (detection.type === 'unknown' || detection.deploymentMode === 'unsupported') {
        await log('[DEPLOYHUB] ──────────────────────────────────────────');
        await log(`[DEPLOYHUB] ❌ DEPLOYMENT_CONFIGURATION_ERROR: Unsupported application structure or no persistent HTTP runtime found.`);
        await log(`[DEPLOYHUB]   • Buildable: ${detection.buildCommand ? 'YES' : 'NO'}`);
        await log(`[DEPLOYHUB]   • Deployable as HTTP service: NO`);
        throw new Error(
          `DEPLOYMENT_CONFIGURATION_ERROR: Project can be built (${detection.buildCommand || 'none'}), but no persistent HTTP runtime was detected. Please provide a start script or server entrypoint.`
        );
      }

      // If web/service deployment has no start command and is not static (e.g. build-only project)
      if (
        (detection.deploymentMode === 'web' || detection.deploymentMode === 'service') &&
        !detection.startCommand &&
        detection.type !== 'docker-compose' &&
        detection.type !== 'docker'
      ) {
        await log('[DEPLOYHUB] ──────────────────────────────────────────');
        await log(`[DEPLOYHUB] ❌ DEPLOYMENT_CONFIGURATION_ERROR: No persistent HTTP runtime detected.`);
        await log(`[DEPLOYHUB]   • Buildable: ${detection.buildCommand ? 'YES' : 'NO'}`);
        await log(`[DEPLOYHUB]   • Deployable as HTTP service: NO`);
        await log(`[DEPLOYHUB]   • Reason: Project contains build configuration, but no production start script or HTTP server entrypoint was found.`);
        throw new Error(
          `DEPLOYMENT_CONFIGURATION_ERROR: Project can be built, but no persistent HTTP runtime was detected. Please provide a start script or server entrypoint in package.json.`
        );
      }

      // If multiple independent services exist without compose (e.g. Speak-AI scenario) and no explicit selection was made
      if (detection.type === 'monorepo' && detection.candidates && detection.candidates.length > 1 && !requestedServicePath) {
        await log('[DEPLOYHUB] ──────────────────────────────────────────');
        await log(`[DEPLOYHUB] 📋 Multiple deployable services detected in repository (${detection.candidates.length}):`);
        for (const cand of detection.candidates) {
          await log(`[DEPLOYHUB]   • Service "${cand.name}" [${cand.path}]: ${cand.type} (${cand.framework || 'Generic'}) — Mode: ${cand.deploymentMode}`);
        }
        await log(`[DEPLOYHUB] 🛑 Multiple independent services detected. Please select a specific service to deploy (e.g. "Deploy ${detection.candidates[0].name}").`);
        throw new Error(
          `Multiple deployable services detected (${detection.candidates.map((c) => c.path).join(', ')}). Please select a service to deploy.`
        );
      }

      // If standalone job / ML project without web framework (Predictive-Model-Titanic scenario)
      if (detection.deploymentMode === 'job') {
        await log('[DEPLOYHUB] ──────────────────────────────────────────');
        await log(`[DEPLOYHUB] ⚠️ Standalone ${detection.type === 'python-ml' ? 'Python ML' : 'Job / Script'} Project Detected.`);
        await log(`[DEPLOYHUB] ℹ️ Deployment Mode: Job | HTTP Web Service: Not detected.`);
        await log(`[DEPLOYHUB] DeployHub currently hosts persistent HTTP web services. Standalone jobs/scripts do not expose an HTTP port.`);
        throw new Error(
          `${detection.type === 'python-ml' ? 'Python ML job' : 'Job/script'} detected (${detection.framework}). This repository does not expose a persistent HTTP web service.`
        );
      }

      // Resolve and strictly validate Build Context
      const serviceRelPath = detection.servicePath || requestedServicePath || '.';
      const buildContext = detection.buildContext || (serviceRelPath && serviceRelPath !== '.' ? path.resolve(repoPath, serviceRelPath) : repoPath);
      const repoResolved = path.resolve(repoPath);

      if (!buildContext.startsWith(repoResolved)) {
        throw new Error(`Invalid servicePath: Path traversal detected ("${serviceRelPath}")`);
      }

      if (!existsSync(buildContext)) {
        throw new Error(`DEPLOYMENT_CONFIGURATION_ERROR: Build context directory does not exist: "${buildContext}"`);
      }

      // Pre-build dependency file validation inside buildContext
      if (detection.type === 'node-frontend' || detection.type === 'node-backend' || detection.type === 'node-fullstack' || detection.type === 'nodejs-spa' || detection.type === 'nodejs-backend') {
        const pkgFile = path.join(buildContext, 'package.json');
        if (!existsSync(pkgFile)) {
          throw new Error(`DEPLOYMENT_CONFIGURATION_ERROR: package.json not found at "${pkgFile}". Verify the selected service directory.`);
        }
      } else if (detection.type === 'python-web' || detection.type === 'python-ml' || detection.type === 'python-job') {
        const hasReq = existsSync(path.join(buildContext, 'requirements.txt'));
        const hasPyproject = existsSync(path.join(buildContext, 'pyproject.toml'));
        const hasPipfile = existsSync(path.join(buildContext, 'Pipfile'));
        const hasSetup = existsSync(path.join(buildContext, 'setup.py'));
        const hasPy = existsSync(path.join(buildContext, detection.entrypoint || 'main.py'));
        if (!hasReq && !hasPyproject && !hasPipfile && !hasSetup && !hasPy) {
          throw new Error(`DEPLOYMENT_CONFIGURATION_ERROR: No Python dependency file or entrypoint script found at "${buildContext}".`);
        }
      }

      // Docker Compose specifics in detection
      if (detection.type === 'docker-compose' && detection.composeInfo) {
        const svcNames = detection.composeInfo.services.map((s) => s.name).join(', ');
        await log(`[COMPOSE] 📋 Services detected (${detection.composeInfo.services.length}): ${svcNames}`);
        for (const s of detection.composeInfo.services) {
          if (s.build) {
            await log(`[COMPOSE]   • Service "${s.name}": Build from ${s.resolvedDockerfile || s.build.context || '.'}`);
          } else if (s.image) {
            await log(`[COMPOSE]   • Service "${s.name}": Image "${s.image}"`);
          }
        }
        await log(
          `[COMPOSE] 🌐 Primary routing service: "${detection.composeInfo.primaryService}" (Port: ${detection.composeInfo.primaryPort})`
        );
      }

      // Environment Variable Preflight Analysis
      if (detection.detectedEnvVars && detection.detectedEnvVars.length > 0) {
        await log('[DEPLOYHUB] ──────────────────────────────────────────');
        await log(`[PREFLIGHT] 📋 Environment Requirements Preflight Check:`);

        // Group by service (e.g., Backend, Frontend, Global)
        const servicesMap = new Map<string, typeof detection.detectedEnvVars>();
        for (const ev of detection.detectedEnvVars) {
          const svcName = ev.service || 'General / Global';
          const list = servicesMap.get(svcName) || [];
          list.push(ev);
          servicesMap.set(svcName, list);
        }

        for (const [svcName, vars] of servicesMap.entries()) {
          await log(`[PREFLIGHT] 📦 ${svcName.toUpperCase()}:`);
          for (const v of vars) {
            const isProvided = envVars[v.key] !== undefined && envVars[v.key].trim() !== '';
            const statusIcon = isProvided ? '✅' : v.isRequired ? '❌' : 'ℹ️';
            const reqLabel = v.isRequired ? 'required' : 'optional';
            const secretLabel = v.isSecret ? ' [Secret]' : '';
            const defaultLabel = v.defaultValue ? ` (default: ${v.defaultValue})` : '';
            await log(
              `[PREFLIGHT]   ${statusIcon} ${v.key}${secretLabel} — ${reqLabel}${defaultLabel} (${
                isProvided ? 'Provided' : 'Missing'
              })`
            );
          }
        }

        // If any required environment variable is missing, block deployment before building/starting containers
        if (detection.missingRequiredEnvVars && detection.missingRequiredEnvVars.length > 0) {
          await log('[DEPLOYHUB] ──────────────────────────────────────────');
          await log(
            `[DEPLOYHUB] 🛑 DEPLOYMENT BLOCKED: Missing ${detection.missingRequiredEnvVars.length} required environment variable(s).`
          );
          await log(`[DEPLOYHUB] The following required variables must be configured before starting the containers:`);
          for (const missingKey of detection.missingRequiredEnvVars) {
            await log(`[DEPLOYHUB]   ❌ ${missingKey}`);
          }
          await log(
            `[DEPLOYHUB] ℹ️ ACTION REQUIRED: Please navigate to Project Settings ➔ Environment Variables, configure the missing values, and trigger a Redeploy.`
          );
          await log(`[DEPLOYHUB] 🛡️ Zero-Downtime Protection: Prior active deployment remains unaffected.`);

          throw new Error(
            `Environment configuration required: Missing required environment variable(s): ${detection.missingRequiredEnvVars.join(
              ', '
            )}. Please configure them in Project Settings and redeploy.`
          );
        }
      }

      // ── CANCELLATION CHECK 3: Before Build ──────────────────────────────────
      if (await isDeploymentCancelled(deploymentId)) {
        await log('[DEPLOYHUB] 🛑 Deployment was cancelled before build. Aborting.');
        return;
      }

      await updateDeployment(deploymentId, { projectType: detection.type, lastHeartbeatAt: new Date() });

      // ── STAGE 3: BUILD IMAGE / COMPOSE PROJECT ─────────────────────────────
      await log('[DEPLOYHUB] ──────────────────────────────────────────');
      await log('[DEPLOYHUB] 📋 Deployment Configuration:');
      await log(`[DEPLOYHUB]   • Selected Service: ${detection.servicePath || (serviceRelPath !== '.' ? serviceRelPath : 'root')}`);
      await log(`[DEPLOYHUB]   • Service Root:     ${serviceRelPath}`);
      await log(`[DEPLOYHUB]   • Build Context:    ${buildContext}`);
      await log(`[DEPLOYHUB]   • Package Manager:  ${detection.packageManager || (detection.type.startsWith('python') ? 'pip' : 'npm')}`);
      await log(`[DEPLOYHUB]   • Install Strategy: ${detection.installCommand || (detection.hasLockfile ? 'npm ci' : 'npm install')}`);
      await log(`[DEPLOYHUB]   • Dockerfile:       ${detection.hasDockerfile ? 'custom' : 'generated'}`);
      await log(`[DEPLOYHUB]   • Build Command:    ${detection.buildCommand || 'none'}`);
      await log(`[DEPLOYHUB]   • Start Command:    ${detection.startCommand || (detection.deploymentMode === 'static' ? 'static server (_deployhub_serve.cjs)' : 'default')}`);
      await log(`[DEPLOYHUB]   • Deployment Mode:  ${detection.deploymentMode || 'web'}`);
      await log('[DEPLOYHUB] ──────────────────────────────────────────');

      const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const sanitizedDeploymentId = deploymentId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();

      if (detection.type === 'docker-compose') {
        await log(`[DEPLOYHUB] 🐳 Stage 3/4: Building multi-service Docker Compose project...`);
        composeProjectName = `deployhub-${sanitizedDeploymentId}`;

        // Pre-allocate host port for primary service routing
        allocatedPort = await PortManager.allocatePort(undefined, undefined, deploymentId);
        await log(`[DEPLOYHUB] Allocated isolated host port :${allocatedPort}`);

        await DockerService.prepareComposeEnvironment(repoPath, detection, envVars, allocatedPort, projectId, deploymentId, log);

        buildStart = Date.now();
        await DockerService.buildComposeProject(
          repoPath,
          detection.composeInfo!.composeFile,
          composeProjectName,
          log,
          600000,
          buildAbortController.signal
        );
        buildDurationMs = Date.now() - buildStart;
      } else {
        await log(`[DEPLOYHUB] 🐳 Stage 3/4: Building isolated container image...`);
        await DockerService.prepareDockerfile(buildContext, detection, log);

        builtImageName = `deployhub-${sanitizedProjectId}-${sanitizedDeploymentId}`.slice(0, 50);

        buildStart = Date.now();
        await DockerService.buildDockerImage(
          buildContext,
          builtImageName,
          log,
          600000,
          buildAbortController.signal
        );
        buildDurationMs = Date.now() - buildStart;
      }

      const buildFinishedAt = new Date();

      // ── CANCELLATION CHECK 4: After Build ───────────────────────────────────
      if (await isDeploymentCancelled(deploymentId)) {
        await log('[DEPLOYHUB] 🛑 Deployment was cancelled during/after build. Cleaning up.');
        if (builtImageName) await DockerService.removeImage(builtImageName);
        if (composeProjectName && repoPath) await DockerService.stopAndRemoveComposeProject(repoPath, composeProjectName);
        if (allocatedPort) await PortManager.releasePort(allocatedPort);
        return;
      }

      await updateDeployment(deploymentId, {
        imageName: builtImageName || composeProjectName || undefined,
        buildFinishedAt,
        lastHeartbeatAt: new Date(),
      });
      await job.updateProgress(70);
    }

    // ── STAGE 4: DEPLOYING & STARTUP ─────────────────────────────────────────
    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled before start. Aborting.');
      if (allocatedPort) await PortManager.releasePort(allocatedPort);
      return;
    }

    const deployStartedAt = new Date();
    await updateDeployment(deploymentId, {
      status: 'DEPLOYING',
      deployStartedAt,
      lastHeartbeatAt: new Date(),
    });

    await log('[DEPLOYHUB] ──────────────────────────────────────────');
    await log(`[DEPLOYHUB] 🚀 Stage 4/4: Starting application containers (Zero-Downtime)...`);

    finalContainerId = '';

    if (detectedType === 'docker-compose') {
      containerStartupStart = Date.now();
      const composeResult = await DockerService.runComposeProject(
        {
          repoPath: repoPath!,
          composeFile: 'docker-compose.yml',
          projectName: composeProjectName!,
          hostPort: allocatedPort!,
          projectId,
          deploymentId,
          envVars,
        },
        log
      );
      containerStartupDurationMs = Date.now() - containerStartupStart;
      finalContainerId = composeResult.projectName;
    } else {
      if (!allocatedPort) {
        allocatedPort = await PortManager.allocatePort(undefined, undefined, deploymentId);
        await log(`[DEPLOYHUB] Allocated isolated host port :${allocatedPort}`);
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
      finalContainerId = runResult.containerId;
    }

    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled after start. Tearing down.');
      if (detectedType === 'docker-compose' && repoPath && composeProjectName) {
        await DockerService.stopAndRemoveComposeProject(repoPath, composeProjectName);
      } else if (finalContainerId) {
        await DockerService.stopAndRemoveContainer(finalContainerId);
      }
      if (allocatedPort) await PortManager.releasePort(allocatedPort);
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
    if (detectedType === 'docker-compose') {
      await DockerService.checkComposeHealth(repoPath!, 'docker-compose.yml', composeProjectName!, allocatedPort!, 30000, log);
    } else {
      await DockerService.checkContainerHealth(finalContainerId, allocatedPort!, 25000, log);
    }
    healthCheckDurationMs = Date.now() - healthCheckStart;

    if (await isDeploymentCancelled(deploymentId)) {
      await log('[DEPLOYHUB] 🛑 Deployment was cancelled during health check. Tearing down.');
      if (detectedType === 'docker-compose' && repoPath && composeProjectName) {
        await DockerService.stopAndRemoveComposeProject(repoPath, composeProjectName);
      } else if (finalContainerId) {
        await DockerService.stopAndRemoveContainer(finalContainerId);
      }
      if (allocatedPort) await PortManager.releasePort(allocatedPort);
      return;
    }

    await job.updateProgress(90);

    // ── STAGE 6: ZERO-DOWNTIME TRAFFIC SWITCH ────────────────────────────────
    await log('[DEPLOYHUB] ──────────────────────────────────────────');
    await log(`[DEPLOYHUB] 🔀 Switching reverse proxy traffic to port :${allocatedPort}...`);

    proxySwitchStart = Date.now();
    await ProxyService.switchTraffic(projectId, allocatedPort!, deploymentId);
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

    // Mark previous deployment as PREVIOUS and clean up its containers
    if (previousActive) {
      await DeploymentModel.findByIdAndUpdate(previousActive._id, {
        status: 'PREVIOUS',
      });
      await log(`[DEPLOYHUB] Previous active deployment ${previousActive._id} marked as PREVIOUS.`);

      // Gracefully stop previous compose releases or single containers
      await DockerService.stopPreviousComposeProjects(projectId, deploymentId, log);
      await DockerService.stopPreviousProjectContainers(projectId, deploymentId, log);

      if (previousActive.containerPort) {
        await PortManager.releasePort(previousActive.containerPort);
      }
    }

    // Atomic update: Transition new deployment to RUNNING
    const updateResult = await DeploymentModel.findOneAndUpdate(
      { _id: deploymentId, status: { $ne: 'STOPPED' } },
      {
        $set: {
          status: 'RUNNING',
          healthStatus: 'HEALTHY',
          containerId: finalContainerId,
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

    if (updateResult) {
      await ProjectModel.findByIdAndUpdate(projectId, {
        activeDeploymentId: deploymentId,
        previousDeploymentId: previousActive?._id,
        latestReleaseVersion: nextVersion,
        framework: detectedType,
      });
    }

    // Clean up older project images
    await DockerService.cleanupObsoleteProjectImages(projectId, builtImageName || undefined, log);

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

    // 1. Capture diagnostics BEFORE deleting any containers
    let diag = err.diagnostics;
    if (!diag && (createdContainerName || finalContainerId)) {
      diag = await RuntimeDiagnosticsService.diagnoseContainerCrash(
        createdContainerName || finalContainerId,
        undefined,
        envVars
      ).catch(() => null);
    }

    if (diag) {
      await log(`[DIAGNOSTICS] Classification: ${diag.classification} (${diag.failureType})`);
      await log(`[DIAGNOSTICS] Root Cause: ${diag.rootCauseMessage}`);
      if (diag.tailLogs && diag.tailLogs.length > 0) {
        await log(`[RUNTIME] Container logs:\n${diag.tailLogs.slice(-20).join('\n')}`);
      }
    }

    // 2. Clean up ONLY new unverified resources; NEVER touch old active resources!
    if (allocatedPort) {
      await PortManager.releasePort(allocatedPort);
    }

    if (createdContainerName) {
      await DockerService.stopAndRemoveContainer(createdContainerName);
    }

    if (composeProjectName && repoPath) {
      await DockerService.stopAndRemoveComposeProject(repoPath, composeProjectName);
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
            diagnostics: diag || undefined,
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
