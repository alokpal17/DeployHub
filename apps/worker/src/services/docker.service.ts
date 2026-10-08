import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import http from 'http';
import YAML from 'yaml';
import type { ProjectDetectionResult } from '@deployhub/shared';
import { ComposeParser } from './compose-parser.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';

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

export interface ComposeRunOptions {
  repoPath: string;
  composeFile?: string;
  projectName: string;
  hostPort: number;
  projectId: string;
  deploymentId: string;
  envVars?: Record<string, string>;
}

export class DockerService {
  /**
   * Masks secret tokens in text before printing or storing logs.
   */
  static maskSecrets(text: string, envVars?: Record<string, string>): string {
    if (!text) return '';
    let result = text;

    // Mask specific secret values from user environment
    if (envVars) {
      for (const [key, val] of Object.entries(envVars)) {
        if (!val || val.length < 2) continue;
        const isSecretKey =
          /KEY|SECRET|PASSWORD|PASSWD|TOKEN|AUTH|PRIVATE|CREDENTIAL|CERT|MONGO|POSTGRES|DATABASE|DB_URI|REDIS_URL|API_KEY|CLIENT_SECRET|CLOUDINARY/i.test(
            key
          );
        if (isSecretKey) {
          result = result.split(val).join('[HIDDEN_SECRET]');
        }
      }
    }

    // Mask common secret key patterns in CLI commands or logs (e.g. KEY=xyz or --api-key xyz)
    result = result.replace(
      /([A-Za-z0-9_]*(?:KEY|SECRET|PASSWORD|PASSWD|TOKEN|AUTH|CREDENTIAL|PRIVATE)[A-Za-z0-9_]*)=([^\s"']+)/gi,
      '$1=[HIDDEN]'
    );

    // Mask database connection strings with credentials: mongodb://user:pass@host, mongodb+srv://..., postgres://...
    result = result.replace(
      /(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/([^:]+):([^@]+)@/gi,
      '$1://$2:[HIDDEN]@'
    );

    // Mask Bearer tokens
    result = result.replace(/Bearer\s+([A-Za-z0-9._~+/-]+)/gi, 'Bearer [HIDDEN_TOKEN]');

    return result;
  }

  /**
   * Generates a suitable Dockerfile if none exists in the repository.
   */
  static async prepareDockerfile(
    repoPath: string,
    detection: ProjectDetectionResult,
    log: (line: string) => void
  ): Promise<void> {
    const dockerfilePath = path.join(repoPath, 'Dockerfile');

    if ((detection.hasDockerfile || detection.type === 'docker' || detection.type === 'dockerfile') && existsSync(dockerfilePath)) {
      log('[DOCKER] Using existing Dockerfile from repository.');
      return;
    }

    // If a subdirectory Dockerfile was detected, copy it to the root
    if (detection.dockerfilePath && detection.dockerfilePath !== 'Dockerfile') {
      const subDockerfile = path.join(repoPath, detection.dockerfilePath);
      if (existsSync(subDockerfile)) {
        log(`[DOCKER] Using detected Dockerfile from ${detection.dockerfilePath}...`);
        await fs.copyFile(subDockerfile, dockerfilePath);
        return;
      }
    }

    log(`[DOCKER] Generating optimized Dockerfile for ${detection.framework || detection.type}...`);

    let dockerfileContent = '';

    const serveScriptPath = path.join(repoPath, '_deployhub_serve.cjs');
    const staticServerScript = `const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8'
};

const candidates = ['dist', 'build', 'out', 'public', '.'];
let dir = __dirname;
for (const c of candidates) {
  if (c !== '.') {
    const candidatePath = path.join(__dirname, c);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      dir = candidatePath;
      break;
    }
  }
}

const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsedUrl.pathname);
  let relativePath = pathname;
  while (relativePath.startsWith('/') || relativePath.startsWith('\\\\')) {
    relativePath = relativePath.slice(1);
  }
  if (!relativePath) relativePath = 'index.html';

  let targetPath = path.resolve(dir, relativePath);

  // Security check: prevent directory traversal
  if (!targetPath.startsWith(dir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(targetPath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      targetPath = path.join(targetPath, 'index.html');
    }

    fs.readFile(targetPath, (readErr, data) => {
      if (!readErr) {
        const ext = path.extname(targetPath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': data.length
        });
        return res.end(data);
      }

      // SPA Fallback for client-side routing (only for routes without file extension or .html)
      const ext = path.extname(pathname).toLowerCase();
      if (!ext || ext === '.html') {
        const indexPath = path.join(dir, 'index.html');
        fs.readFile(indexPath, (idxErr, indexData) => {
          if (!idxErr) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Length': indexData.length
            });
            return res.end(indexData);
          }
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Asset Not Found: ' + pathname);
      }
    });
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log('DeployHub static web server listening on port ' + port + ' (serving: ' + dir + ')');
});
`;

    const pm = (detection.packageManager as 'bun' | 'pnpm' | 'yarn' | 'npm') || 'npm';
    const isBun = pm === 'bun';
    const isPnpm = pm === 'pnpm';
    const isYarn = pm === 'yarn';

    const hasLock = Boolean(
      detection.hasLockfile ||
      (pm === 'npm' && existsSync(path.join(repoPath, 'package-lock.json'))) ||
      (pm === 'pnpm' && existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) ||
      (pm === 'yarn' && existsSync(path.join(repoPath, 'yarn.lock'))) ||
      (pm === 'bun' && (existsSync(path.join(repoPath, 'bun.lock')) || existsSync(path.join(repoPath, 'bun.lockb'))))
    );

    let installCmd = 'RUN npm install';
    let lockfileCopy = 'COPY package*.json ./\n';
    let prepToolchain = '';

    if (isBun) {
      lockfileCopy = hasLock ? 'COPY package*.json bun.lock* ./\n' : 'COPY package*.json ./\n';
      installCmd = hasLock ? 'RUN bun install --frozen-lockfile' : 'RUN bun install';
    } else if (isPnpm) {
      prepToolchain = 'RUN corepack enable && corepack prepare pnpm@latest --activate\n';
      lockfileCopy = hasLock ? 'COPY package*.json pnpm-lock.yaml* ./\n' : 'COPY package*.json ./\n';
      installCmd = hasLock ? 'RUN pnpm install --frozen-lockfile' : 'RUN pnpm install';
    } else if (isYarn) {
      prepToolchain = 'RUN corepack enable\n';
      lockfileCopy = hasLock ? 'COPY package*.json yarn.lock* ./\n' : 'COPY package*.json ./\n';
      installCmd = hasLock ? 'RUN yarn install --frozen-lockfile' : 'RUN yarn install';
    } else {
      lockfileCopy = 'COPY package*.json ./\n';
      installCmd = hasLock ? 'RUN npm ci' : 'RUN npm install';
    }

    const defaultBuildCmd = isBun ? 'bun run build' : isPnpm ? 'pnpm run build' : isYarn ? 'yarn build' : 'npm run build';
    const defaultStartCmd = isBun ? 'bun run start' : isPnpm ? 'pnpm start' : isYarn ? 'yarn start' : 'npm start';

    switch (detection.type) {
      case 'static':
      case 'static-html':
        await fs.writeFile(serveScriptPath, staticServerScript, 'utf8');
        dockerfileContent = `FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "_deployhub_serve.cjs"]
`;
        break;

      case 'node-frontend':
      case 'nodejs-spa':
        if (detection.deploymentMode === 'static') {
          await fs.writeFile(serveScriptPath, staticServerScript, 'utf8');
          const builderImage = isBun ? 'oven/bun:1-alpine' : 'node:20-alpine';
          dockerfileContent = `FROM ${builderImage} AS builder
WORKDIR /app
${prepToolchain}${lockfileCopy}ENV NODE_OPTIONS="--max-old-space-size=2048"
${installCmd}
COPY . .
${detection.buildCommand ? `RUN ${detection.buildCommand}` : `RUN ${defaultBuildCmd} || true`}

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "_deployhub_serve.cjs"]
`;
        } else {
          // SSR Web Mode (e.g. Next.js SSR server)
          const baseImage = isBun ? 'oven/bun:1-alpine' : 'node:20-alpine';
          const startCmd = detection.startCommand || defaultStartCmd;
          const buildCmd = detection.buildCommand || defaultBuildCmd;
          const startCmdTokens = startCmd.split(' ').filter(Boolean).map((s) => `"${s}"`).join(', ');

          dockerfileContent = `FROM ${baseImage}
WORKDIR /app
${prepToolchain}${lockfileCopy}ENV NODE_OPTIONS="--max-old-space-size=2048"
${installCmd}
COPY . .
RUN ${buildCmd}
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD [${startCmdTokens}]
`;
        }
        break;

      case 'node-fullstack': {
        const baseImage = isBun ? 'oven/bun:1-alpine' : 'node:20-alpine';
        const startCmd = detection.startCommand;
        if (!startCmd || startCmd === 'default') {
          throw new Error('DEPLOYMENT_CONFIGURATION_ERROR: Project can be built, but no persistent HTTP runtime was detected. Please provide a start script or server entrypoint.');
        }
        const buildCmd = detection.buildCommand || defaultBuildCmd;
        const startCmdTokens = startCmd.split(' ').filter(Boolean).map((s) => `"${s}"`).join(', ');

        dockerfileContent = `FROM ${baseImage}
WORKDIR /app
${prepToolchain}${lockfileCopy}ENV NODE_OPTIONS="--max-old-space-size=2048"
${installCmd}
COPY . .
RUN ${buildCmd}
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD [${startCmdTokens}]
`;
        break;
      }

      case 'node-backend':
      case 'nodejs-backend': {
        const baseImage = isBun ? 'oven/bun:1-alpine' : 'node:20-alpine';
        const startCmd = detection.startCommand;
        if (!startCmd || startCmd === 'default') {
          throw new Error('DEPLOYMENT_CONFIGURATION_ERROR: Project can be built, but no persistent HTTP runtime was detected. Please provide a start script or server entrypoint.');
        }
        const startCmdTokens = startCmd.split(' ').filter(Boolean).map((s) => `"${s}"`).join(', ');

        dockerfileContent = `FROM ${baseImage}
WORKDIR /app
${prepToolchain}${lockfileCopy}ENV NODE_OPTIONS="--max-old-space-size=2048"
${installCmd}
COPY . .
${detection.buildCommand ? `RUN ${detection.buildCommand}` : ''}
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD [${startCmdTokens}]
`;
        break;
      }

      case 'python-web': {
        const startCmd = detection.startCommand || 'uvicorn main:app --host 0.0.0.0 --port 8000';
        const port = detection.internalPort || 8000;
        const reqFile = detection.dependencyFile || 'requirements.txt';
        dockerfileContent = `FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PORT=${port}
ENV HOST=0.0.0.0
${existsSync(path.join(repoPath, reqFile)) ? `COPY ${reqFile} ./
RUN pip install --no-cache-dir -r ${reqFile}` : ''}
COPY . .
EXPOSE ${port}
CMD ${JSON.stringify(startCmd.split(' ').filter(Boolean))}
`;
        break;
      }

      case 'python-job':
      case 'python-ml': {
        const entry = detection.entrypoint || 'main.py';
        const reqFile = detection.dependencyFile || 'requirements.txt';
        dockerfileContent = `FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
${existsSync(path.join(repoPath, reqFile)) ? `COPY ${reqFile} ./
RUN pip install --no-cache-dir -r ${reqFile}` : ''}
COPY . .
CMD ["python", "${entry}"]
`;
        break;
      }

      case 'docker':
      case 'dockerfile':
        // If hasDockerfile was false or no Dockerfile existed, create default fallback
        if (!existsSync(dockerfilePath)) {
          dockerfileContent = `FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
`;
        }
        break;

      case 'unknown':
      default:
        throw new Error(
          'Unsupported project type. Could not find a Dockerfile, package.json, requirements.txt, or index.html in the repository.'
        );
    }

    if (dockerfileContent) {
      await fs.writeFile(dockerfilePath, dockerfileContent, 'utf8');
    }
    log('[DOCKER] ✅ Dockerfile prepared successfully.');
  }

  /**
   * Prepares the Docker Compose workspace: creates missing referenced env_files,
   * writes user environment variables to .env, and generates a prepared compose file
   * with proper port isolation and container labels.
   */
  static async prepareComposeEnvironment(
    repoPath: string,
    detection: ProjectDetectionResult,
    envVars?: Record<string, string>,
    allocatedPort?: number,
    projectId?: string,
    deploymentId?: string,
    log?: (line: string) => void
  ): Promise<{ preparedComposeFile: string }> {
    const composeInfo = detection.composeInfo;
    const origFileName = composeInfo?.composeFile || 'docker-compose.yml';
    const origFilePath = path.join(repoPath, origFileName);
    const onLog = (l: string) => log?.(l);

    onLog('[COMPOSE] ⚙️ Preparing Docker Compose environment and port configuration...');

    const userEnv = envVars || {};

    // 1. Ensure all referenced env_file paths exist and contain user environment variables
    if (composeInfo?.services) {
      for (const service of composeInfo.services) {
        if (service.envFile) {
          for (const relEf of service.envFile) {
            const efPath = path.resolve(repoPath, relEf);
            await fs.mkdir(path.dirname(efPath), { recursive: true });
            
            // Read existing lines if file exists
            const existingVars: Record<string, string> = {};
            if (existsSync(efPath)) {
              try {
                const content = await fs.readFile(efPath, 'utf8');
                for (const line of content.split('\n')) {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const eqIdx = trimmed.indexOf('=');
                    existingVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
                  }
                }
              } catch {}
            }

            // Merge with user env vars
            const merged = { ...existingVars, ...userEnv };
            const envLines: string[] = [];
            for (const [k, v] of Object.entries(merged)) {
              envLines.push(`${k}=${v}`);
            }
            await fs.writeFile(efPath, envLines.join('\n'), 'utf8');
            onLog(`[COMPOSE] Injected environment variables into env_file: ${relEf}`);
          }
        }
      }
    }

    // 2. Write root .env file with user environment variables
    const rootEnvPath = path.join(repoPath, '.env');
    const rootEnvLines: string[] = [];
    if (allocatedPort) {
      rootEnvLines.push(`PORT=${allocatedPort}`);
      rootEnvLines.push(`HOST=0.0.0.0`);
    }
    for (const [k, v] of Object.entries(userEnv)) {
      rootEnvLines.push(`${k}=${v}`);
    }
    await fs.writeFile(rootEnvPath, rootEnvLines.join('\n'), 'utf8');

    // 3. Parse original compose file and generate prepared standalone compose file
    let parsedDoc: any = {};
    try {
      const raw = await fs.readFile(origFilePath, 'utf8');
      parsedDoc = YAML.parse(raw) || {};
    } catch {
      parsedDoc = { services: {} };
    }

    // Remove obsolete top-level 'version' attribute to eliminate warnings
    if (parsedDoc.version) {
      delete parsedDoc.version;
    }

    const primaryService = composeInfo?.primaryService || Object.keys(parsedDoc.services || {})[0];
    const internalPort = composeInfo?.internalPort || 3000;

    // Check if internal database services exist
    const hasInternalMongo = Object.keys(parsedDoc.services || {}).some(
      (s) => /mongo/i.test(s) || (parsedDoc.services[s]?.image && /mongo/i.test(parsedDoc.services[s].image))
    );
    const hasInternalRedis = Object.keys(parsedDoc.services || {}).some(
      (s) => /redis/i.test(s) || (parsedDoc.services[s]?.image && /redis/i.test(parsedDoc.services[s].image))
    );
    const hasInternalPostgres = Object.keys(parsedDoc.services || {}).some(
      (s) => /postgres/i.test(s) || (parsedDoc.services[s]?.image && /postgres/i.test(parsedDoc.services[s].image))
    );

    for (const [sName, sCfg] of Object.entries<any>(parsedDoc.services || {})) {
      if (!sCfg || typeof sCfg !== 'object') continue;

      // ── CRITICAL: Remove hardcoded container_name for full deployment isolation ──
      if (sCfg.container_name) {
        onLog(`[COMPOSE] 🔒 Scoped container isolation: removed hardcoded container_name "${sCfg.container_name}" from service "${sName}".`);
        delete sCfg.container_name;
      }

      // Add DeployHub labels
      sCfg.labels = {
        ...(sCfg.labels || {}),
        'deployhub.project': projectId || 'default',
        'deployhub.deployment': deploymentId || 'default',
        'deployhub.service': sName,
        'deployhub.managed': 'true',
      };

      // Ensure environment object exists
      if (!sCfg.environment) {
        sCfg.environment = {};
      }

      // Inject user environment variables into service environment
      if (typeof sCfg.environment === 'object' && !Array.isArray(sCfg.environment)) {
        for (const [k, v] of Object.entries(userEnv)) {
          sCfg.environment[k] = v;
        }

        // Automatic internal service host resolution if database is internal and user did not specify custom URI
        if (hasInternalMongo && !userEnv.MONGODB_URI && !userEnv.MONGO_URI) {
          const mongoSvcName = Object.keys(parsedDoc.services).find((s) => /mongo/i.test(s)) || 'mongodb';
          sCfg.environment.MONGODB_URI = `mongodb://${mongoSvcName}:27017/${projectId || 'app'}`;
        }
        if (hasInternalRedis && !userEnv.REDIS_URL) {
          const redisSvcName = Object.keys(parsedDoc.services).find((s) => /redis/i.test(s)) || 'redis';
          sCfg.environment.REDIS_URL = `redis://${redisSvcName}:6379`;
        }
        if (hasInternalPostgres && !userEnv.DATABASE_URL) {
          const pgSvcName = Object.keys(parsedDoc.services).find((s) => /postgres/i.test(s)) || 'postgres';
          sCfg.environment.DATABASE_URL = `postgres://postgres@${pgSvcName}:5432/${projectId || 'app'}`;
        }
      } else if (Array.isArray(sCfg.environment)) {
        for (const [k, v] of Object.entries(userEnv)) {
          sCfg.environment.push(`${k}=${v}`);
        }
      }

      // Port configuration
      const isPrimary = sName === primaryService;
      if (isPrimary && allocatedPort) {
        // Map primary service exclusively to the allocated host port
        sCfg.ports = [`${allocatedPort}:${internalPort}`];
        if (typeof sCfg.environment === 'object' && !Array.isArray(sCfg.environment)) {
          sCfg.environment.PORT = String(internalPort);
        } else if (Array.isArray(sCfg.environment)) {
          sCfg.environment.push(`PORT=${internalPort}`);
        }
      } else if (sCfg.ports) {
        // For non-primary services, remove host bindings to avoid host port collisions
        const exposedPorts: string[] = [];
        for (const p of sCfg.ports) {
          const parsed = ComposeParser.parsePortMapping(String(p));
          exposedPorts.push(String(parsed.containerPort));
        }
        delete sCfg.ports;
        if (exposedPorts.length > 0) {
          sCfg.expose = [...(sCfg.expose || []), ...exposedPorts];
        }
      }
    }

    const preparedFileName = 'docker-compose.deployhub-prepared.yml';
    const preparedFilePath = path.join(repoPath, preparedFileName);
    await fs.writeFile(preparedFilePath, YAML.stringify(parsedDoc), 'utf8');
    onLog(`[COMPOSE] Generated isolated compose configuration: ${preparedFileName}`);

    return { preparedComposeFile: preparedFileName };
  }

  /**
   * Builds the Docker image while streaming stdout & stderr in real-time, supporting AbortSignal.
   */
  static buildDockerImage(
    repoPath: string,
    imageName: string,
    onLog: (line: string) => void,
    timeoutMs = 600000,
    abortSignal?: AbortSignal
  ): Promise<DockerBuildResult> {
    const logs: string[] = [];

    const log = (line: string) => {
      const masked = DockerService.maskSecrets(line);
      logs.push(masked);
      onLog(masked);
    };

    log(`[DOCKER] Building image: ${imageName}`);

    return new Promise((resolve, reject) => {
      const buildProcess = spawn('docker', ['build', '-t', imageName, '.'], {
        cwd: repoPath,
        shell: false,
      });

      let timeoutTimer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          log(`[DOCKER] ❌ Build timed out after ${timeoutMs / 1000}s`);
          try {
            buildProcess.kill('SIGKILL');
          } catch {}
          reject(new Error(`Docker build timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }

      const onAbort = () => {
        log('[DOCKER] 🛑 Docker build cancelled by user.');
        try {
          buildProcess.kill('SIGKILL');
        } catch {}
        reject(new Error('Docker build aborted by user request'));
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      let buffer = '';

      const handleData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) log(trimmed);
        }
      };

      buildProcess.stdout?.on('data', handleData);
      buildProcess.stderr?.on('data', handleData);

      buildProcess.on('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        log(`[DOCKER] ❌ Process error: ${err.message}`);
        reject(err);
      });

      buildProcess.on('close', (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

        if (buffer.trim()) {
          log(buffer.trimEnd());
        }

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
   * Resolves the active compose configuration file path in the workspace.
   */
  private static resolveComposeFile(repoPath: string, composeFile?: string): string {
    const preparedPath = path.join(repoPath, 'docker-compose.deployhub-prepared.yml');
    if (existsSync(preparedPath)) {
      return 'docker-compose.deployhub-prepared.yml';
    }
    return composeFile || 'docker-compose.yml';
  }

  /**
   * Builds all services in a Docker Compose project with real-time log streaming and cancellation.
   */
  static async buildComposeProject(
    repoPath: string,
    composeFile: string,
    projectName: string,
    onLog: (line: string) => void,
    timeoutMs = 600000,
    abortSignal?: AbortSignal
  ): Promise<{ logs: string[] }> {
    const logs: string[] = [];

    const log = (line: string) => {
      const masked = DockerService.maskSecrets(line);
      logs.push(masked);
      onLog(masked);
    };

    const targetComposeFile = this.resolveComposeFile(repoPath, composeFile);
    const args = ['compose', '-p', projectName, '-f', targetComposeFile, 'build'];

    log(`[COMPOSE] Executing: docker ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const buildProcess = spawn('docker', args, {
        cwd: repoPath,
        shell: false,
      });

      let timeoutTimer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          log(`[COMPOSE] ❌ Compose build timed out after ${timeoutMs / 1000}s`);
          try {
            buildProcess.kill('SIGKILL');
          } catch {}
          reject(new Error(`Docker Compose build timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }

      const onAbort = () => {
        log('[COMPOSE] 🛑 Compose build cancelled by user.');
        try {
          buildProcess.kill('SIGKILL');
        } catch {}
        reject(new Error('Docker Compose build aborted by user request'));
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      let buffer = '';

      const handleData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) log(trimmed);
        }
      };

      buildProcess.stdout?.on('data', handleData);
      buildProcess.stderr?.on('data', handleData);

      buildProcess.on('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        log(`[COMPOSE] ❌ Process error: ${err.message}`);
        reject(err);
      });

      buildProcess.on('close', (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

        if (buffer.trim()) {
          log(buffer.trimEnd());
        }

        if (code === 0) {
          log(`[COMPOSE] ✅ Compose project ${projectName} built successfully.`);
          resolve({ logs });
        } else {
          const errMsg = abortSignal?.aborted
            ? 'Docker Compose build aborted by user request'
            : `Docker Compose build failed with exit code ${code}`;
          log(`[COMPOSE] ❌ ${errMsg}`);
          reject(new Error(errMsg));
        }
      });
    });
  }

  /**
   * Launches a Docker Compose project in detached mode.
   */
  static async runComposeProject(
    options: ComposeRunOptions,
    onLog: (line: string) => void
  ): Promise<{ projectName: string; port: number }> {
    const { repoPath, composeFile, projectName, hostPort, envVars } = options;

    const log = (line: string) => {
      const masked = DockerService.maskSecrets(line, envVars);
      onLog(masked);
    };

    log(`[COMPOSE] Starting compose services for project "${projectName}" on port :${hostPort}...`);

    const targetComposeFile = this.resolveComposeFile(repoPath, composeFile);
    const args = ['compose', '-p', projectName, '-f', targetComposeFile, 'up', '-d', '--remove-orphans'];

    log(`[COMPOSE] Executing: docker ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const runProcess = spawn('docker', args, {
        cwd: repoPath,
        shell: false,
      });

      let stdoutData = '';
      let stderrData = '';

      runProcess.stdout?.on('data', (d) => {
        stdoutData += d.toString();
        log(d.toString().trim());
      });

      runProcess.stderr?.on('data', (d) => {
        stderrData += d.toString();
        log(d.toString().trim());
      });

      runProcess.on('error', (err) => {
        const msg = `Compose start process error: ${err.message}`;
        log(`[COMPOSE] ❌ ${msg}`);
        reject(new Error(msg));
      });

      runProcess.on('close', (code) => {
        if (code === 0) {
          log(`[COMPOSE] ✅ Compose services started successfully for project ${projectName}.`);
          resolve({ projectName, port: hostPort });
        } else {
          const errorMsg = stderrData.trim() || `docker compose up exited with code ${code}`;
          log(`[COMPOSE] ❌ Compose start failed: ${errorMsg}`);
          reject(new Error(`Failed to start Docker Compose project: ${errorMsg}`));
        }
      });
    });
  }

  /**
   * Verifies health of services in a Docker Compose project.
   */
  static async checkComposeHealth(
    repoPath: string,
    composeFile: string,
    projectName: string,
    hostPort: number,
    maxWaitMs = 30000,
    onLog?: (line: string) => void
  ): Promise<void> {
    const log = (msg: string) => onLog?.(DockerService.maskSecrets(msg));
    log(`[HEALTH] Verifying Compose service liveness on port ${hostPort}...`);

    const startTime = Date.now();
    let isHealthy = false;

    // Allow services a moment to initialize
    await new Promise((r) => setTimeout(r, 2000));

    while (Date.now() - startTime < maxWaitMs) {
      // 1. Check if any container in the compose project exited with error
      try {
        const targetFile = this.resolveComposeFile(repoPath, composeFile);
        const { stdout } = await execAsync(`docker compose -p ${projectName} -f ${targetFile} ps -a --format json`, {
          cwd: repoPath,
        }).catch(() => ({ stdout: '' }));

        if (stdout.trim()) {
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            try {
              const svc = JSON.parse(line);
              const state = (svc.State || '').toLowerCase();
              const exitCode = parseInt(svc.ExitCode || '0', 10);
              if (state === 'exited' && exitCode !== 0) {
                // Fetch tail logs
                const { stdout: rawLogs } = await execAsync(
                  `docker compose -p ${projectName} -f ${targetFile} logs --tail 100`,
                  { cwd: repoPath }
                ).catch(() => ({ stdout: '' }));

                const diag = await RuntimeDiagnosticsService.diagnoseContainerCrash(
                  svc.Name || svc.Service || '',
                  rawLogs
                );

                log(`[HEALTH] ❌ Compose service "${svc.Service || svc.Name}" crashed on startup (exit code ${exitCode}): ${diag.classification}`);
                log(`[HEALTH] 🛑 Root Cause: ${diag.rootCauseMessage}`);
                if (diag.stackTrace) {
                  log(`[HEALTH] 📋 Stack Trace:\n${diag.stackTrace}`);
                }
                if (diag.suggestedFix) {
                  log(`[HEALTH] 💡 Suggested Fix: ${diag.suggestedFix}`);
                }

                const composeErr: any = new Error(
                  `Compose service "${svc.Service || svc.Name}" crashed on startup (exit code ${exitCode}). ${diag.rootCauseMessage}`
                );
                composeErr.diagnostics = diag;
                throw composeErr;
              }
            } catch (jsonErr: any) {
              if (jsonErr.message.includes('crashed')) throw jsonErr;
            }
          }
        }
      } catch (inspectErr: any) {
        if (inspectErr.message.includes('crashed')) throw inspectErr;
      }

      // 2. Perform HTTP probe to verify primary port readiness
      const isHttpReady = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${hostPort}/`, { timeout: 2000 }, (res) => {
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

      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!isHealthy) {
      const targetFile = this.resolveComposeFile(repoPath, composeFile);
      const { stdout: composeLogs } = await execAsync(
        `docker compose -p ${projectName} -f ${targetFile} logs --tail 40`,
        { cwd: repoPath }
      ).catch(() => ({ stdout: '' }));

      log(
        `[HEALTH] ⚠️ Service did not respond with HTTP 200 within ${
          maxWaitMs / 1000
        }s, but containers are running.`
      );
      if (composeLogs) {
        log(`[CONTAINER LOGS]\n${composeLogs.trim()}`);
      }
    } else {
      log(`[HEALTH] ✅ Liveness probe succeeded on http://localhost:${hostPort}`);
    }
  }

  /**
   * Stops and tears down a Docker Compose project.
   */
  static async stopAndRemoveComposeProject(
    repoPath: string,
    projectName: string,
    onLog?: (line: string) => void
  ): Promise<void> {
    if (!projectName) return;
    try {
      onLog?.(`[COMPOSE] Tearing down compose project: ${projectName}...`);
      const targetFile = this.resolveComposeFile(repoPath);
      await execAsync(`docker compose -p ${projectName} -f ${targetFile} down -v --remove-orphans`, {
        cwd: repoPath,
      });
    } catch {
      try {
        await execAsync(`docker compose -p ${projectName} down -v --remove-orphans`);
      } catch {}
    }
  }

  /**
   * Stops previous Compose projects for a given project ID.
   */
  static async stopPreviousComposeProjects(
    projectId: string,
    currentDeploymentId: string,
    onLog?: (line: string) => void
  ): Promise<void> {
    try {
      const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const prefix = `deployhub-${sanitizedProjectId}-`;

      const { stdout } = await execAsync(
        `docker ps -q --filter "label=com.docker.compose.project"`
      ).catch(() => ({ stdout: '' }));

      const containerIds = stdout.trim().split('\n').filter(Boolean);
      const projectsToStop = new Set<string>();

      for (const cId of containerIds) {
        try {
          const { stdout: projOut } = await execAsync(
            `docker inspect -f "{{index .Config.Labels \\"com.docker.compose.project\\"}}" ${cId}`
          );
          const projName = projOut.trim();
          if (projName.startsWith(prefix) && !projName.includes(currentDeploymentId.toLowerCase())) {
            projectsToStop.add(projName);
          }
        } catch {}
      }

      for (const proj of projectsToStop) {
        onLog?.(`[COMPOSE] Stopping previous compose release: ${proj}...`);
        try {
          await execAsync(`docker compose -p ${proj} down -v --remove-orphans`);
        } catch {}
      }
    } catch {}
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
      '--memory=1024m',
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
    const log = (msg: string) => onLog && onLog(DockerService.maskSecrets(msg));
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
          // Container crashed! Run deterministic diagnostics
          const diag = await RuntimeDiagnosticsService.diagnoseContainerCrash(containerId);
          log(`[HEALTH] ❌ Container exited with code ${diag.exitCode ?? exitCode} (${diag.classification})`);
          if (diag.tailLogs && diag.tailLogs.length > 0) {
            log(`[RUNTIME] stderr/stdout:\n${diag.tailLogs.slice(-30).join('\n')}`);
          }
          log(`[DIAGNOSTICS]`);
          log(`  Category: ${diag.failureType}`);
          log(`  Root Cause: ${diag.rootCauseMessage}`);
          if (diag.stackTrace) {
            log(`  Stack Trace:\n${diag.stackTrace}`);
          }
          if (diag.suggestedFix) {
            log(`  💡 Suggested Fix: ${diag.suggestedFix}`);
          }
          const crashErr: any = new Error(
            `Application container crashed immediately upon launch (exit code ${exitCode}). ${diag.rootCauseMessage}`
          );
          crashErr.diagnostics = diag;
          throw crashErr;
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
        const diag = await RuntimeDiagnosticsService.diagnoseContainerCrash(containerId);
        log(`[HEALTH] ❌ Container exited with code ${diag.exitCode ?? exitCodeStr} (${diag.classification})`);
        if (diag.tailLogs && diag.tailLogs.length > 0) {
          log(`[RUNTIME] stderr/stdout:\n${diag.tailLogs.slice(-30).join('\n')}`);
        }
        log(`[DIAGNOSTICS]`);
        log(`  Category: ${diag.failureType}`);
        log(`  Root Cause: ${diag.rootCauseMessage}`);
        if (diag.stackTrace) {
          log(`  Stack Trace:\n${diag.stackTrace}`);
        }
        if (diag.suggestedFix) {
          log(`  💡 Suggested Fix: ${diag.suggestedFix}`);
        }
        const crashErr: any = new Error(
          `Application container crashed after startup (exit code ${exitCodeStr}). ${diag.rootCauseMessage}`
        );
        crashErr.diagnostics = diag;
        throw crashErr;
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
   * Safely removes obsolete Docker images for a project.
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
      const { stdout: runningImagesOut } = await execAsync('docker ps --format "{{.Image}}"').catch(() => ({ stdout: '' }));
      const activeRunningImages = new Set(runningImagesOut.trim().split('\n').filter(Boolean));

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

      const { stdout: imagesOut } = await execAsync(`docker images --format "{{.Repository}}:{{.Tag}}" --filter "reference=${prefix}*"`).catch(() => ({ stdout: '' }));
      const projectImages = imagesOut.trim().split('\n').filter(Boolean);

      for (const img of projectImages) {
        const baseName = img.replace(/:latest$/, '');
        const keepBaseName = keepImageName ? keepImageName.replace(/:latest$/, '') : '';

        if (baseName === keepBaseName || img === keepImageName) {
          continue;
        }

        if (activeRunningImages.has(img) || activeRunningImages.has(baseName)) {
          continue;
        }

        if (retainedDeploymentImages.has(img) || retainedDeploymentImages.has(baseName)) {
          continue;
        }

        try {
          await execAsync(`docker rmi -f ${img}`);
          removedCount++;
          onLog?.(`[DOCKER] 🧹 Cleaned obsolete project image: ${img}`);
        } catch {}
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
    } catch {}
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
