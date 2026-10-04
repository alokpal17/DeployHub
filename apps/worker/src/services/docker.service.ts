import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import http from 'http';
import type { ProjectDetectionResult } from '@deployhub/shared';

const execAsync = promisify(exec);

export interface DockerBuildResult {
  imageName: string;
  logs: string[];
}

export interface DockerRunOptions {
  imageName: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  projectId: string;
  deploymentId: string;
  envVars?: Record<string, string>;
}

export interface DockerRunResult {
  containerId: string;
  port: number;
}

export class DockerService {
  /**
   * Generates a suitable Dockerfile if none exists in the repository.
   */
  static async prepareDockerfile(
    repoPath: string,
    detection: ProjectDetectionResult,
    log: (line: string) => void
  ): Promise<void> {
    const dockerfilePath = path.join(repoPath, 'Dockerfile');

    if (detection.hasDockerfile && existsSync(dockerfilePath)) {
      log('[DOCKER] Using existing Dockerfile from repository.');
      return;
    }

    log(`[DOCKER] Generating optimized Dockerfile for ${detection.framework || detection.type}...`);

    let dockerfileContent = '';

    switch (detection.type) {
      case 'static-html':
        dockerfileContent = `FROM node:20-alpine
WORKDIR /app
RUN npm install -g serve
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["serve", "-s", ".", "-l", "3000"]
`;
        break;

      case 'nodejs-spa':
        dockerfileContent = `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
${detection.buildCommand ? `RUN ${detection.buildCommand}` : ''}

FROM node:20-alpine
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app ./
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "if [ -d dist ]; then serve -s dist -l 3000; elif [ -d build ]; then serve -s build -l 3000; else serve -s . -l 3000; fi"]
`;
        break;

      case 'nodejs-backend':
        const startCmd = detection.startCommand || 'npm start';
        dockerfileContent = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
${detection.buildCommand ? `RUN ${detection.buildCommand}` : ''}
ENV PORT=3000
EXPOSE 3000
CMD [${startCmd.split(' ').map((s) => `"${s}"`).join(', ')}]
`;
        break;

      case 'unknown':
      default:
        throw new Error(
          'Unsupported project type. Could not find a Dockerfile, package.json, or index.html in the repository root.'
        );
    }

    await fs.writeFile(dockerfilePath, dockerfileContent, 'utf8');
    log('[DOCKER] ✅ Dockerfile prepared successfully.');
  }

  /**
   * Builds the Docker image while streaming stdout & stderr in real-time, supporting AbortSignal for fast cancellation.
   */
  static buildDockerImage(
    repoPath: string,
    imageName: string,
    onLog: (line: string) => void,
    timeoutMs = 600000, // 10 minutes timeout
    abortSignal?: AbortSignal
  ): Promise<DockerBuildResult> {
    const logs: string[] = [];

    const log = (line: string) => {
      logs.push(line);
      onLog(line);
    };

    log(`[DOCKER] Building image: ${imageName}`);
    log(`[DOCKER] Build context: ${repoPath}`);

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        return reject(new Error('Build aborted before start'));
      }

      const buildProcess = spawn('docker', ['build', '-t', imageName, '.'], {
        cwd: repoPath,
        shell: false,
      });

      let isClosed = false;

      const onAbort = () => {
        if (!isClosed) {
          log('[DOCKER] 🛑 Docker build aborted by cancellation request.');
          try {
            buildProcess.kill('SIGKILL');
          } catch {}
          reject(new Error('Docker build aborted'));
        }
      };

      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
        if (!isClosed) {
          try {
            buildProcess.kill('SIGKILL');
          } catch {}
          const timeoutErr = new Error(`Docker build timed out after ${timeoutMs / 1000} seconds`);
          log(`[DOCKER] ❌ ${timeoutErr.message}`);
          reject(timeoutErr);
        }
      }, timeoutMs);

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        const lines = text.split('\n');
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (line) {
            log(`[DOCKER] ${line}`);
          }
        }
      };

      buildProcess.stdout?.on('data', handleOutput);
      buildProcess.stderr?.on('data', handleOutput);

      buildProcess.on('error', (err) => {
        isClosed = true;
        clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        log(`[DOCKER] ❌ Process execution failed: ${err.message}`);
        reject(new Error(`Docker build spawn failed: ${err.message}`));
      });

      buildProcess.on('close', (code) => {
        isClosed = true;
        clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

        if (code === 0) {
          log(`[DOCKER] ✅ Image ${imageName} built successfully.`);
          resolve({ imageName, logs });
        } else {
          const errMsg = abortSignal?.aborted
            ? 'Docker build aborted by user request'
            : `Docker build failed with exit code ${code}`;
          log(`[DOCKER] ❌ ${errMsg}`);
          reject(new Error(errMsg));
        }
      });
    });
  }

  /**
   * Runs the Docker container with memory and CPU constraints, passing environment variables safely.
   */
  static async runDockerContainer(
    options: DockerRunOptions,
    onLog: (line: string) => void
  ): Promise<DockerRunResult> {
    const { imageName, containerName, hostPort, containerPort, projectId, deploymentId, envVars } =
      options;

    onLog(`[DOCKER] Launching container: ${containerName}`);
    onLog(`[DOCKER] Port mapping: host ${hostPort} -> container ${containerPort}`);

    // Remove any lingering container with the same name
    try {
      await execAsync(`docker rm -f ${containerName}`);
    } catch {
      // Ignored
    }

    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      `deployhub.project=${projectId}`,
      '--label',
      `deployhub.deployment=${deploymentId}`,
      '-p',
      `${hostPort}:${containerPort}`,
      '-e',
      `PORT=${containerPort}`,
      '-e',
      `HOST=0.0.0.0`,
      '--memory=512m',
      '--cpus=1.0',
      '--restart=no',
    ];

    if (envVars) {
      for (const [k, v] of Object.entries(envVars)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          args.push('-e', `${k}=${v}`);
        }
      }
    }

    args.push(imageName);

    // Create a safe log line with env values masked
    const maskedArgs = args.map((arg, idx) => {
      if (
        idx > 0 &&
        args[idx - 1] === '-e' &&
        !arg.startsWith('PORT=') &&
        !arg.startsWith('HOST=')
      ) {
        const eqIdx = arg.indexOf('=');
        return eqIdx !== -1 ? `${arg.slice(0, eqIdx)}=[HIDDEN]` : arg;
      }
      return arg;
    });

    onLog(`[DOCKER] Executing: docker ${maskedArgs.join(' ')}`);

    return new Promise((resolve, reject) => {
      const runProcess = spawn('docker', args, { shell: false });

      let stdoutData = '';
      let stderrData = '';

      runProcess.stdout?.on('data', (data) => {
        stdoutData += data.toString();
      });

      runProcess.stderr?.on('data', (data) => {
        stderrData += data.toString();
      });

      runProcess.on('error', (err) => {
        const msg = `Container launch process error: ${err.message}`;
        onLog(`[DOCKER] ❌ ${msg}`);
        reject(new Error(msg));
      });

      runProcess.on('close', (code) => {
        if (code === 0) {
          const containerId = stdoutData.trim().substring(0, 12);
          onLog(`[DOCKER] ✅ Container spawned: ${containerId}`);
          resolve({ containerId, port: hostPort });
        } else {
          const errorMsg = stderrData.trim() || `docker run exited with code ${code}`;
          onLog(`[DOCKER] ❌ Container start failed: ${errorMsg}`);
          reject(new Error(`Failed to start container: ${errorMsg}`));
        }
      });
    });
  }

  /**
   * Probes the newly started container to verify it is active and responding.
   */
  static async checkContainerHealth(
    containerId: string,
    hostPort: number,
    maxWaitMs = 25000,
    onLog?: (line: string) => void
  ): Promise<void> {
    const log = (msg: string) => onLog && onLog(msg);
    log(`[HEALTH] Verifying container liveness on port ${hostPort}...`);

    const startTime = Date.now();
    let isHealthy = false;

    // Allow container process a brief moment to initialize
    await new Promise((r) => setTimeout(r, 1500));

    while (Date.now() - startTime < maxWaitMs) {
      // 1. Inspect container process state
      try {
        const { stdout } = await execAsync(
          `docker inspect -f "{{.State.Running}} {{.State.ExitCode}} {{.State.Status}}" ${containerId}`
        );
        const [runningStr, exitCodeStr, statusStr] = stdout.trim().split(' ');
        const isRunning = runningStr === 'true';
        const exitCode = parseInt(exitCodeStr || '0', 10);

        if (!isRunning || statusStr === 'exited' || statusStr === 'dead') {
          // Container crashed! Fetch tail logs
          const { stdout: containerLogs } = await execAsync(
            `docker logs --tail 50 ${containerId}`
          ).catch(() => ({ stdout: '' }));
          log(`[HEALTH] ❌ Container crashed with exit code ${exitCode}.`);
          if (containerLogs) {
            log(`[CONTAINER LOGS]\n${containerLogs.trim()}`);
          }
          throw new Error(
            `Application container crashed immediately upon launch (exit code ${exitCode}). ${containerLogs.trim()}`
          );
        }
      } catch (inspectErr: any) {
        if (inspectErr.message.includes('crashed')) {
          throw inspectErr;
        }
      }

      // 2. Perform HTTP probe to verify web server readiness
      const isHttpReady = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${hostPort}/`, { timeout: 1500 }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(true));
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });

      if (isHttpReady) {
        isHealthy = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!isHealthy) {
      // Re-verify if container died right at the end
      const { stdout } = await execAsync(
        `docker inspect -f "{{.State.Running}} {{.State.ExitCode}}" ${containerId}`
      ).catch(() => ({ stdout: 'false 1' }));
      const [runningStr, exitCodeStr] = stdout.trim().split(' ');
      if (runningStr !== 'true') {
        const { stdout: containerLogs } = await execAsync(
          `docker logs --tail 50 ${containerId}`
        ).catch(() => ({ stdout: '' }));
        throw new Error(
          `Application container crashed after startup (exit code ${exitCodeStr}). ${containerLogs.trim()}`
        );
      }
      log(
        `[HEALTH] ⚠️ Container did not respond with HTTP 200 within ${
          maxWaitMs / 1000
        }s, but process is running.`
      );
    } else {
      log(`[HEALTH] ✅ Liveness probe succeeded on http://localhost:${hostPort}`);
    }
  }

  /**
   * Stops and removes a specific container by ID or name.
   */
  static async stopAndRemoveContainer(containerIdOrName: string): Promise<void> {
    if (!containerIdOrName) return;
    try {
      await execAsync(`docker stop ${containerIdOrName}`);
    } catch {}
    try {
      await execAsync(`docker rm -f ${containerIdOrName}`);
    } catch {}
  }

  /**
   * Stops and cleans up previous running containers for a project.
   */
  static async stopPreviousProjectContainers(
    projectId: string,
    currentDeploymentId: string,
    onLog?: (line: string) => void
  ): Promise<void> {
    try {
      const { stdout } = await execAsync(
        `docker ps -q --filter "label=deployhub.project=${projectId}"`
      );
      const containerIds = stdout.trim().split('\n').filter(Boolean);

      for (const cId of containerIds) {
        // Inspect deployment label to avoid stopping the current active deployment if same
        try {
          const { stdout: labelOut } = await execAsync(
            `docker inspect -f "{{index .Config.Labels \\"deployhub.deployment\\"}}" ${cId}`
          );
          if (labelOut.trim() !== currentDeploymentId) {
            onLog?.(
              `[DOCKER] Stopping previous container ${cId.substring(
                0,
                12
              )} for project ${projectId}...`
            );
            await this.stopAndRemoveContainer(cId);
          }
        } catch {
          await this.stopAndRemoveContainer(cId);
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Safely removes obsolete Docker images for a project while NEVER deleting any image
   * currently used by any running container.
   */
  static async cleanupObsoleteProjectImages(
    projectId: string,
    keepImageName?: string,
    onLog?: (line: string) => void
  ): Promise<{ removedCount: number }> {
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    const prefix = `deployhub-${sanitizedProjectId}-`;
    let removedCount = 0;

    try {
      // 1. Get images currently used by ANY running container across the system
      const { stdout: runningImagesOut } = await execAsync('docker ps --format "{{.Image}}"').catch(() => ({ stdout: '' }));
      const activeRunningImages = new Set(runningImagesOut.trim().split('\n').filter(Boolean));

      // 2. Query MongoDB for active or previous deployment image artifacts to keep for rollback
      const retainedDeploymentImages = new Set<string>();
      try {
        const { DeploymentModel } = await import('@deployhub/shared');
        const activeAndPrevious = await DeploymentModel.find({
          projectId,
          status: { $in: ['RUNNING', 'ACTIVE', 'PREVIOUS'] },
          imageName: { $exists: true, $ne: null },
        })
          .sort({ startedAt: -1 })
          .limit(10);
        for (const dep of activeAndPrevious) {
          if (dep.imageName) {
            retainedDeploymentImages.add(dep.imageName);
            retainedDeploymentImages.add(dep.imageName.replace(/:latest$/, ''));
          }
        }
      } catch {}

      // 3. List all images for this project
      const { stdout: imagesOut } = await execAsync(`docker images --format "{{.Repository}}:{{.Tag}}" --filter "reference=${prefix}*"`).catch(() => ({ stdout: '' }));
      const projectImages = imagesOut.trim().split('\n').filter(Boolean);

      for (const img of projectImages) {
        // Normalize image name (strip :latest if implicit)
        const baseName = img.replace(/:latest$/, '');
        const keepBaseName = keepImageName ? keepImageName.replace(/:latest$/, '') : '';

        if (baseName === keepBaseName || img === keepImageName) {
          continue; // Keep the active image
        }

        if (activeRunningImages.has(img) || activeRunningImages.has(baseName)) {
          continue; // Currently running in an active container
        }

        if (retainedDeploymentImages.has(img) || retainedDeploymentImages.has(baseName)) {
          continue; // Retained release artifact for instant rollback
        }

        try {
          await execAsync(`docker rmi -f ${img}`);
          removedCount++;
          onLog?.(`[DOCKER] 🧹 Cleaned obsolete project image: ${img}`);
        } catch (rmiErr: any) {
          // Non-fatal if image is locked or already removed
        }
      }
    } catch (err: any) {
      onLog?.(`[DOCKER] Note: Image cleanup skipped: ${err.message}`);
    }

    return { removedCount };
  }

  /**
   * Safely removes a failed deployment image if not used by any running container.
   */
  static async cleanupFailedDeploymentImage(imageName: string): Promise<void> {
    if (!imageName) return;
    try {
      const { stdout: runningImagesOut } = await execAsync('docker ps --format "{{.Image}}"').catch(() => ({ stdout: '' }));
      const activeRunningImages = new Set(runningImagesOut.trim().split('\n').filter(Boolean));

      const baseName = imageName.replace(/:latest$/, '');
      if (!activeRunningImages.has(imageName) && !activeRunningImages.has(baseName)) {
        await execAsync(`docker rmi -f ${imageName}`).catch(() => {});
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Best-effort removal of built Docker images.
   */
  static async removeImage(imageName: string): Promise<void> {
    if (!imageName) return;
    try {
      await execAsync(`docker rmi -f ${imageName}`);
    } catch {}
  }
}
