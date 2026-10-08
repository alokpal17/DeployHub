import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { ProjectDetector } from '../apps/worker/src/services/project-detector.service';
import { PackageAnalyzer } from '../apps/worker/src/services/package-analyzer.service';
import { PythonDetector } from '../apps/worker/src/services/python-detector.service';
import { ServiceScanner } from '../apps/worker/src/services/service-scanner.service';
import { RuntimeDiagnosticsService } from '../apps/worker/src/services/runtime-diagnostics.service';
import { DockerService } from '../apps/worker/src/services/docker.service';

async function main() {
  console.log('===============================================================');
  console.log('🚀 RUNNING UNIVERSAL REPOSITORY DETECTION & DIAGNOSTICS SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;
  const tempDirsToClean: string[] = [];

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      if (detail) console.error(`     Detail: ${detail}`);
      failed++;
    }
  };

  const createTempDir = async (name: string) => {
    const dir = path.join(os.tmpdir(), `deployhub_test_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    await fs.mkdir(dir, { recursive: true });
    tempDirsToClean.push(dir);
    return dir;
  };

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Portfolio (Root Vite frontend)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Portfolio (Root Vite Frontend SPA) ---');
  const dir1 = await createTempDir('portfolio');
  await fs.writeFile(
    path.join(dir1, 'package.json'),
    JSON.stringify({
      name: 'portfolio-alok',
      version: '1.0.0',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        'lucide-react': '^0.263.1',
      },
      devDependencies: {
        vite: '^4.4.5',
      },
    })
  );
  await fs.writeFile(path.join(dir1, 'vite.config.ts'), 'export default {}');
  await fs.writeFile(path.join(dir1, 'index.html'), '<!DOCTYPE html><html><body><div id="root"></div></body></html>');

  const res1 = await ProjectDetector.detect(dir1);
  assert(res1.type === 'node-frontend', 'Portfolio detected as node-frontend', `Got: ${res1.type}`);
  assert(res1.framework === 'Vite', 'Portfolio framework detected as Vite', `Got: ${res1.framework}`);
  assert(res1.deploymentMode === 'static', 'Portfolio deploymentMode is static', `Got: ${res1.deploymentMode}`);
  assert(res1.outputDirectory === 'dist', 'Portfolio outputDirectory is dist', `Got: ${res1.outputDirectory}`);

  // Test Dockerfile generation for Vite frontend
  const logs1: string[] = [];
  await DockerService.prepareDockerfile(dir1, res1, (l) => logs1.push(l));
  const generatedDocker1 = await fs.readFile(path.join(dir1, 'Dockerfile'), 'utf8');
  assert(!generatedDocker1.includes('react-is'), 'react-is hack is completely removed from Vite Dockerfile');
  assert(generatedDocker1.includes('_deployhub_serve.cjs'), 'Static web server used for Vite deployment');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: FuzzTube (Docker Compose Multi-Service)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 2: FuzzTube (Docker Compose Multi-Service) ---');
  const dir2 = await createTempDir('fuzztube');
  await fs.writeFile(
    path.join(dir2, 'docker-compose.yml'),
    `version: '3.8'
services:
  backend:
    build:
      context: ./BACKEND
      dockerfile: Dockerfile
    container_name: fuzztube-backend
    ports:
      - "8000:8000"
    env_file: ./BACKEND/.env
  frontend:
    build:
      context: ./FRONTEND
      dockerfile: Dockerfile
    container_name: fuzztube-frontend
    ports:
      - "5173:5173"
    depends_on:
      - backend
`
  );
  await fs.mkdir(path.join(dir2, 'BACKEND'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'BACKEND', 'Dockerfile'), 'FROM node:20-alpine\nWORKDIR /app\nEXPOSE 8000');
  await fs.writeFile(
    path.join(dir2, 'BACKEND', '.env.sample'),
    'PORT=8000\nMONGODB_URI=\nACCESS_TOKEN_SECRET=\nREFRESH_TOKEN_SECRET=\nCLOUDINARY_CLOUD_NAME=\nCLOUDINARY_API_KEY=\nCLOUDINARY_API_SECRET=\n'
  );
  await fs.mkdir(path.join(dir2, 'FRONTEND'), { recursive: true });
  await fs.writeFile(path.join(dir2, 'FRONTEND', 'Dockerfile'), 'FROM node:20-alpine\nWORKDIR /app\nEXPOSE 5173');

  const res2 = await ProjectDetector.detect(dir2);
  assert(res2.type === 'docker-compose', 'FuzzTube detected as docker-compose', `Got: ${res2.type}`);
  assert(res2.deploymentMode === 'multi-service', 'FuzzTube mode is multi-service', `Got: ${res2.deploymentMode}`);
  assert(res2.composeInfo?.services.length === 2, 'FuzzTube detected 2 compose services');
  assert(
    res2.missingRequiredEnvVars && res2.missingRequiredEnvVars.includes('MONGODB_URI'),
    'FuzzTube preflight blocks missing MONGODB_URI'
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Predictive-Model-Titanic (Python ML Project / Job)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 3: Predictive-Model-Titanic (Python ML / Job) ---');
  const dir3 = await createTempDir('titanic');
  await fs.writeFile(
    path.join(dir3, 'requirements.txt'),
    'pandas>=1.5.0\nnumpy>=1.23.0\nscikit-learn>=1.2.0\nxgboost>=1.7.0\nmatplotlib>=3.6.0\n'
  );
  await fs.writeFile(path.join(dir3, 'train.py'), 'import pandas as pd\nimport sklearn\nprint("Training model...")\n');
  await fs.writeFile(path.join(dir3, 'model.pkl'), 'MODEL_BYTES_MOCK');

  const res3 = await ProjectDetector.detect(dir3);
  assert(res3.type === 'python-ml', 'Titanic detected as python-ml', `Got: ${res3.type}`);
  assert(res3.deploymentMode === 'job', 'Titanic deploymentMode is job (NOT web)', `Got: ${res3.deploymentMode}`);
  assert(res3.detectedPorts.length === 0, 'Titanic has NO target ports assigned (detectedPorts is empty [])', `Got: ${JSON.stringify(res3.detectedPorts)}`);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: RevAstra_AI_Studio (Vite + Node.js Fullstack)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 4: RevAstra_AI_Studio (Vite + Node.js Fullstack) ---');
  const dir4 = await createTempDir('revastra');
  await fs.writeFile(
    path.join(dir4, 'package.json'),
    JSON.stringify({
      name: 'revastra-ai-studio',
      version: '0.1.0',
      scripts: {
        dev: 'concurrently "vite" "tsx watch server.ts"',
        build: 'vite build && esbuild server.ts --bundle --platform=node --format=cjs --outfile=dist/server.cjs',
        start: 'cross-env NODE_ENV=production node dist/server.cjs',
      },
      dependencies: {
        '@google/genai': '^0.1.1',
        express: '^4.19.2',
        react: '^18.3.1',
        'react-dom': '^18.3.1',
      },
      devDependencies: {
        esbuild: '^0.20.0',
        vite: '^5.2.0',
        tsx: '^4.7.0',
      },
    })
  );
  await fs.writeFile(path.join(dir4, 'server.ts'), 'import express from "express"; const app = express();');
  await fs.writeFile(path.join(dir4, 'vite.config.ts'), 'export default {}');
  await fs.writeFile(path.join(dir4, 'index.html'), '<html><body></body></html>');

  const res4 = await ProjectDetector.detect(dir4);
  assert(res4.type === 'node-fullstack', 'RevAstra detected as node-fullstack', `Got: ${res4.type}`);
  assert(res4.framework === 'Vite + Node.js', 'RevAstra framework is Vite + Node.js', `Got: ${res4.framework}`);
  assert(res4.deploymentMode === 'web', 'RevAstra deploymentMode is web', `Got: ${res4.deploymentMode}`);
  assert(res4.buildCommand === 'npm run build', 'RevAstra buildCommand is npm run build', `Got: ${res4.buildCommand}`);
  assert(res4.startCommand === 'npm start', 'RevAstra startCommand is npm start', `Got: ${res4.startCommand}`);

  // Test Dockerfile generation for RevAstra
  await DockerService.prepareDockerfile(dir4, res4, () => {});
  const generatedDocker4 = await fs.readFile(path.join(dir4, 'Dockerfile'), 'utf8');
  assert(!generatedDocker4.includes('react-is'), 'react-is hack is completely removed from fullstack Dockerfile');
  assert(generatedDocker4.includes('RUN npm run build'), 'Dockerfile includes build command');
  assert(generatedDocker4.includes('CMD ["npm", "start"]'), 'Dockerfile includes start command');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: E.D.I.T.H. Nested Build Context (Frontend in nested directory)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 5: E.D.I.T.H. Nested Frontend Build Context ---');
  const dir5 = await createTempDir('edith');
  await fs.mkdir(path.join(dir5, 'frontend'), { recursive: true });
  await fs.writeFile(
    path.join(dir5, 'frontend', 'package.json'),
    JSON.stringify({
      name: 'edith-frontend',
      scripts: { build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.0.0', vite: '^4.0.0' },
    })
  );
  await fs.writeFile(path.join(dir5, 'frontend', 'index.html'), '<html><body></body></html>');

  // Single candidate nested detection
  const res5 = await ProjectDetector.detect(dir5);
  assert(res5.type === 'node-frontend', 'Nested frontend detected as node-frontend', `Got: ${res5.type}`);
  assert(res5.servicePath === 'frontend', 'Nested servicePath is frontend', `Got: ${res5.servicePath}`);
  const expectedContext = path.resolve(dir5, 'frontend');
  assert(res5.buildContext === expectedContext, 'buildContext is <workspace>/frontend', `Got: ${res5.buildContext}`);

  // Prepare Dockerfile in buildContext
  await DockerService.prepareDockerfile(res5.buildContext!, res5, () => {});
  const dockerExists = await fs.stat(path.join(expectedContext, 'Dockerfile')).then(() => true).catch(() => false);
  const serveExists = await fs.stat(path.join(expectedContext, '_deployhub_serve.cjs')).then(() => true).catch(() => false);
  assert(dockerExists, 'Dockerfile placed inside frontend/ directory');
  assert(serveExists, 'Static serve script placed inside frontend/ directory');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 6: Speak-AI (Monorepo Multi-Candidate & Service Selection Flow)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 6: Speak-AI (Monorepo Detection & Explicit Service Selection) ---');
  const dir6 = await createTempDir('speak_ai');
  await fs.mkdir(path.join(dir6, 'backend'), { recursive: true });
  await fs.writeFile(
    path.join(dir6, 'backend', 'package.json'),
    JSON.stringify({
      name: 'speak-ai-backend',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.18.2' },
    })
  );
  await fs.writeFile(path.join(dir6, 'backend', 'server.js'), 'const express = require("express");');

  await fs.mkdir(path.join(dir6, 'frontend'), { recursive: true });
  await fs.writeFile(
    path.join(dir6, 'frontend', 'package.json'),
    JSON.stringify({
      name: 'speak-ai-frontend',
      scripts: { build: 'next build', start: 'next start' },
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    })
  );
  await fs.writeFile(path.join(dir6, 'frontend', 'next.config.js'), 'module.exports = {};');

  // Unscoped detection: should identify monorepo and return candidates without arbitrary choice
  const res6Unscoped = await ProjectDetector.detect(dir6);
  assert(res6Unscoped.type === 'monorepo', 'Speak-AI detected as monorepo', `Got: ${res6Unscoped.type}`);
  assert(res6Unscoped.deploymentMode === 'multi-service', 'Speak-AI mode is multi-service');
  assert(res6Unscoped.candidates?.length === 2, 'Found 2 candidates (backend & frontend)');
  assert(res6Unscoped.detectedPorts?.length === 0, 'No global target port assigned before service selection');

  // Next.js in frontend without 'output: export' must be SSR web mode, not static!
  const frontendCand = res6Unscoped.candidates?.find((c) => c.name === 'frontend');
  assert(frontendCand?.type === 'node-frontend', 'Frontend candidate is node-frontend');
  assert(frontendCand?.deploymentMode === 'web', 'Next.js SSR candidate deploymentMode is web (NOT static)', `Got: ${frontendCand?.deploymentMode}`);

  // Scoped selection: Select backend
  const res6Backend = await ProjectDetector.detect(dir6, {}, 'backend');
  assert(res6Backend.type === 'node-backend', 'Selected backend detected as node-backend', `Got: ${res6Backend.type}`);
  assert(res6Backend.servicePath === 'backend', 'servicePath is backend', `Got: ${res6Backend.servicePath}`);
  assert(res6Backend.buildContext === path.resolve(dir6, 'backend'), 'buildContext is <workspace>/backend');

  // Scoped selection: Select frontend
  const res6Frontend = await ProjectDetector.detect(dir6, {}, 'frontend');
  assert(res6Frontend.type === 'node-frontend', 'Selected frontend detected as node-frontend', `Got: ${res6Frontend.type}`);
  assert(res6Frontend.servicePath === 'frontend', 'servicePath is frontend', `Got: ${res6Frontend.servicePath}`);
  assert(res6Frontend.buildContext === path.resolve(dir6, 'frontend'), 'buildContext is <workspace>/frontend');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 7: Next.js Static Export vs SSR Server Mode
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 7: Next.js Static Export vs SSR Server Mode ---');
  const dir7Static = await createTempDir('next_static');
  await fs.writeFile(
    path.join(dir7Static, 'package.json'),
    JSON.stringify({
      name: 'next-static-app',
      scripts: { build: 'next build' },
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    })
  );
  await fs.writeFile(path.join(dir7Static, 'next.config.mjs'), "export default { output: 'export' };");

  const res7Static = await ProjectDetector.detect(dir7Static);
  assert(res7Static.deploymentMode === 'static', 'Next.js with output: "export" classified as static', `Got: ${res7Static.deploymentMode}`);
  assert(res7Static.outputDirectory === 'out', 'Static Next.js outputDirectory is out', `Got: ${res7Static.outputDirectory}`);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 8: Package Manager Consistency & Install Strategy (npm, pnpm, Yarn, Bun)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 8: Package Manager Consistency & Install Strategy ---');

  // 8A: Bun with lockfile
  const dir8Bun = await createTempDir('bun_app');
  await fs.writeFile(
    path.join(dir8Bun, 'package.json'),
    JSON.stringify({
      name: 'bun-api',
      packageManager: 'bun@1.0.0',
      scripts: { start: 'bun run index.ts' },
      dependencies: { hono: '^3.0.0' },
    })
  );
  await fs.writeFile(path.join(dir8Bun, 'bun.lockb'), '');
  await fs.writeFile(path.join(dir8Bun, 'index.ts'), 'export default { port: 3000 };');

  const res8Bun = await ProjectDetector.detect(dir8Bun);
  assert(res8Bun.packageManager === 'bun', 'Bun package manager detected', `Got: ${res8Bun.packageManager}`);
  assert(res8Bun.hasLockfile === true, 'Bun lockfile detected');
  assert(res8Bun.installCommand === 'bun install --frozen-lockfile', 'Bun install command is frozen-lockfile', `Got: ${res8Bun.installCommand}`);
  await DockerService.prepareDockerfile(dir8Bun, res8Bun, () => {});
  const dockerfileBun = await fs.readFile(path.join(dir8Bun, 'Dockerfile'), 'utf8');
  assert(dockerfileBun.includes('FROM oven/bun:1-alpine'), 'Bun uses oven/bun:1-alpine base image');
  assert(dockerfileBun.includes('RUN bun install --frozen-lockfile'), 'Bun uses bun install --frozen-lockfile without fallback chain');
  assert(!dockerfileBun.includes('|| bun install'), 'No fallback chain in Bun Dockerfile');

  // 8B: pnpm with lockfile
  const dir8Pnpm = await createTempDir('pnpm_app');
  await fs.writeFile(
    path.join(dir8Pnpm, 'package.json'),
    JSON.stringify({
      name: 'pnpm-api',
      packageManager: 'pnpm@8.6.12',
      scripts: { build: 'tsc', start: 'node dist/index.js' },
      dependencies: { fastify: '^4.0.0' },
    })
  );
  await fs.writeFile(path.join(dir8Pnpm, 'pnpm-lock.yaml'), '');
  await fs.writeFile(path.join(dir8Pnpm, 'server.js'), 'const fastify = require("fastify")();');

  const res8Pnpm = await ProjectDetector.detect(dir8Pnpm);
  assert(res8Pnpm.packageManager === 'pnpm', 'pnpm package manager detected', `Got: ${res8Pnpm.packageManager}`);
  assert(res8Pnpm.hasLockfile === true, 'pnpm lockfile detected');
  assert(res8Pnpm.installCommand === 'pnpm install --frozen-lockfile', 'pnpm install command is frozen-lockfile');
  await DockerService.prepareDockerfile(dir8Pnpm, res8Pnpm, () => {});
  const dockerfilePnpm = await fs.readFile(path.join(dir8Pnpm, 'Dockerfile'), 'utf8');
  assert(dockerfilePnpm.includes('corepack enable'), 'pnpm provisions Corepack');
  assert(dockerfilePnpm.includes('RUN pnpm install --frozen-lockfile'), 'pnpm uses frozen-lockfile without fallback chain');
  assert(!dockerfilePnpm.includes('|| pnpm install'), 'No fallback chain in pnpm Dockerfile');

  // 8C: Yarn with lockfile
  const dir8Yarn = await createTempDir('yarn_app');
  await fs.writeFile(
    path.join(dir8Yarn, 'package.json'),
    JSON.stringify({
      name: 'yarn-api',
      scripts: { build: 'yarn build', start: 'node server.js' },
      dependencies: { express: '^4.18.0' },
    })
  );
  await fs.writeFile(path.join(dir8Yarn, 'yarn.lock'), '');
  await fs.writeFile(path.join(dir8Yarn, 'server.js'), 'const express = require("express");');

  const res8Yarn = await ProjectDetector.detect(dir8Yarn);
  assert(res8Yarn.packageManager === 'yarn', 'yarn package manager detected', `Got: ${res8Yarn.packageManager}`);
  assert(res8Yarn.hasLockfile === true, 'yarn lockfile detected');
  assert(res8Yarn.installCommand === 'yarn install --frozen-lockfile', 'yarn install command is frozen-lockfile');
  await DockerService.prepareDockerfile(dir8Yarn, res8Yarn, () => {});
  const dockerfileYarn = await fs.readFile(path.join(dir8Yarn, 'Dockerfile'), 'utf8');
  assert(dockerfileYarn.includes('corepack enable'), 'yarn provisions Corepack');
  assert(dockerfileYarn.includes('RUN yarn install --frozen-lockfile'), 'yarn uses frozen-lockfile without fallback chain');
  assert(!dockerfileYarn.includes('|| yarn install'), 'No fallback chain in yarn Dockerfile');

  // 8D: npm WITH package-lock.json (npm ci)
  const dir8NpmLock = await createTempDir('npm_lock');
  await fs.writeFile(
    path.join(dir8NpmLock, 'package.json'),
    JSON.stringify({
      name: 'npm-locked-app',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.18.2' },
    })
  );
  await fs.writeFile(path.join(dir8NpmLock, 'package-lock.json'), JSON.stringify({ name: 'npm-locked-app', lockfileVersion: 3 }));
  await fs.writeFile(path.join(dir8NpmLock, 'server.js'), 'const express = require("express");');

  const res8NpmLock = await ProjectDetector.detect(dir8NpmLock);
  assert(res8NpmLock.packageManager === 'npm', 'npm detected');
  assert(res8NpmLock.hasLockfile === true, 'npm package-lock.json detected');
  assert(res8NpmLock.installCommand === 'npm ci', 'Install strategy is npm ci when package-lock.json exists', `Got: ${res8NpmLock.installCommand}`);
  await DockerService.prepareDockerfile(dir8NpmLock, res8NpmLock, () => {});
  const dockerfileNpmLock = await fs.readFile(path.join(dir8NpmLock, 'Dockerfile'), 'utf8');
  assert(dockerfileNpmLock.includes('RUN npm ci'), 'Dockerfile uses RUN npm ci');
  assert(!dockerfileNpmLock.includes('npm ci || npm install'), 'No fallback chain in locked npm Dockerfile');

  // 8E: npm WITHOUT package-lock.json (npm install)
  const dir8NpmNoLock = await createTempDir('npm_nolock');
  await fs.writeFile(
    path.join(dir8NpmNoLock, 'package.json'),
    JSON.stringify({
      name: 'npm-nolock-app',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.18.2' },
    })
  );
  await fs.writeFile(path.join(dir8NpmNoLock, 'server.js'), 'const express = require("express");');

  const res8NpmNoLock = await ProjectDetector.detect(dir8NpmNoLock);
  assert(res8NpmNoLock.hasLockfile === false, 'No lockfile detected');
  assert(res8NpmNoLock.installCommand === 'npm install', 'Install strategy is npm install when lockfile is absent', `Got: ${res8NpmNoLock.installCommand}`);
  await DockerService.prepareDockerfile(dir8NpmNoLock, res8NpmNoLock, () => {});
  const dockerfileNpmNoLock = await fs.readFile(path.join(dir8NpmNoLock, 'Dockerfile'), 'utf8');
  assert(dockerfileNpmNoLock.includes('RUN npm install'), 'Dockerfile uses RUN npm install');
  assert(!dockerfileNpmNoLock.includes('npm ci || npm install'), 'No fallback chain in unlocked npm Dockerfile');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 9: Build-Only Projects & Runtime Validation (Separation of Build vs Runtime)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 9: Build-Only Projects & Runtime Validation ---');

  // 9A: Build-only library without HTTP server or HTML
  const dir9BuildOnly = await createTempDir('build_only_lib');
  await fs.writeFile(
    path.join(dir9BuildOnly, 'package.json'),
    JSON.stringify({
      name: 'math-utils-lib',
      scripts: { build: 'tsc' },
      devDependencies: { typescript: '^5.0.0' },
      main: 'dist/index.js',
    })
  );
  const res9BuildOnly = await ProjectDetector.detect(dir9BuildOnly);
  assert(res9BuildOnly.deploymentMode === 'job', 'Build-only project classified as job (not web)', `Got: ${res9BuildOnly.deploymentMode}`);
  assert(res9BuildOnly.detectedPorts.length === 0, 'Build-only project has detectedPorts: []', `Got: ${JSON.stringify(res9BuildOnly.detectedPorts)}`);
  assert(!res9BuildOnly.startCommand, 'Build-only project has no startCommand');

  // 9B: Backend missing start script -> unsupported web mode
  const dir9NoStart = await createTempDir('backend_nostart');
  await fs.writeFile(
    path.join(dir9NoStart, 'package.json'),
    JSON.stringify({
      name: 'missing-start-backend',
      dependencies: { express: '^4.18.2' },
    })
  );
  const res9NoStart = await ProjectDetector.detect(dir9NoStart);
  assert(res9NoStart.deploymentMode === 'unsupported', 'Backend without start script classified as unsupported', `Got: ${res9NoStart.deploymentMode}`);
  assert(res9NoStart.detectedPorts.length === 0, 'No port allocated for backend without start command');

  let failedDockerfileWithoutStart = false;
  try {
    await DockerService.prepareDockerfile(dir9NoStart, res9NoStart, () => {});
  } catch (err: any) {
    if (err.message.includes('DEPLOYMENT_CONFIGURATION_ERROR')) failedDockerfileWithoutStart = true;
  }
  assert(failedDockerfileWithoutStart, 'prepareDockerfile rejects web backend missing start command with DEPLOYMENT_CONFIGURATION_ERROR');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 10: Inspection of Actual valid-vite Fixture
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 10: Actual valid-vite Fixture Classification & Serving ---');
  const validViteFixturePath = path.resolve(__dirname, '../test-fixtures/valid-vite');
  const resValidVite = await ProjectDetector.detect(validViteFixturePath);
  assert(resValidVite.type === 'node-frontend', 'valid-vite classified as node-frontend (SPA)', `Got: ${resValidVite.type}`);
  assert(resValidVite.deploymentMode === 'static', 'valid-vite deploymentMode is static', `Got: ${resValidVite.deploymentMode}`);
  assert(resValidVite.outputDirectory === 'dist', 'valid-vite outputDirectory is dist', `Got: ${resValidVite.outputDirectory}`);
  assert(resValidVite.hasLockfile === false, 'valid-vite lockfile is absent');
  assert(resValidVite.installCommand === 'npm install', 'valid-vite uses npm install');

  const dirVitePrep = await createTempDir('valid_vite_prep');
  await fs.cp(validViteFixturePath, dirVitePrep, { recursive: true });
  await DockerService.prepareDockerfile(dirVitePrep, resValidVite, () => {});
  const validViteDockerfile = await fs.readFile(path.join(dirVitePrep, 'Dockerfile'), 'utf8');
  assert(validViteDockerfile.includes('RUN npm install'), 'valid-vite Dockerfile contains RUN npm install');
  assert(validViteDockerfile.includes('_deployhub_serve.cjs'), 'valid-vite Dockerfile serves static dist via _deployhub_serve.cjs');
  assert(!validViteDockerfile.includes('react-is'), 'valid-vite Dockerfile has no react-is hack');
  assert(!validViteDockerfile.includes('npm ci || npm install'), 'valid-vite Dockerfile has no fallback chain');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 11: Path Traversal Security Verification
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 11: Path Traversal Security Checks ---');
  const dir11Sec = await createTempDir('security_checks');
  let rejectedTraversal1 = false;
  try {
    await ProjectDetector.detect(dir11Sec, {}, '../../etc/passwd');
  } catch (err: any) {
    if (err.message.includes('Path traversal detected')) rejectedTraversal1 = true;
  }
  assert(rejectedTraversal1, 'ProjectDetector rejects ../ traversal path');

  let rejectedTraversal2 = false;
  try {
    await ProjectDetector.detect(dir11Sec, {}, 'nonexistent_service_dir');
  } catch (err: any) {
    if (err.message.includes('DEPLOYMENT_CONFIGURATION_ERROR')) rejectedTraversal2 = true;
  }
  assert(rejectedTraversal2, 'ProjectDetector returns DEPLOYMENT_CONFIGURATION_ERROR on non-existent service');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 12: Runtime Diagnostics - Missing Toolchain, Missing Script & Crash Classifications
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 12: Runtime Diagnostics Classifications ---');

  // 12A: Missing Toolchain (e.g. bun: not found)
  const bunMissingLog = `
/bin/sh: bun: not found
`;
  const diagBun = await RuntimeDiagnosticsService.diagnoseContainerCrash('mock-c-1', bunMissingLog);
  assert(diagBun.failureType === 'RUNTIME_TOOLCHAIN_MISSING', 'bun: not found classified as RUNTIME_TOOLCHAIN_MISSING', `Got: ${diagBun.failureType}`);

  // 12B: Missing dependency (MODULE_NOT_FOUND)
  const depMissingLog = `
node:internal/modules/cjs/loader:1147
  throw err;
  ^
Error: Cannot find module 'react-is'
Require stack:
- /app/dist/server.cjs
`;
  const diagDep = await RuntimeDiagnosticsService.diagnoseContainerCrash('mock-c-2', depMissingLog);
  assert(diagDep.failureType === 'MISSING_DEPENDENCY', 'Cannot find module classified as MISSING_DEPENDENCY', `Got: ${diagDep.failureType}`);
  assert(diagDep.rootCauseMessage.includes('react-is'), 'Extracted missing module name react-is', `Got: ${diagDep.rootCauseMessage}`);

  // 12C: Missing start script in package.json
  const missingScriptLog = `
npm error Missing script: "start"
npm error 
npm error To see a list of scripts, run:
npm error   npm run
`;
  const diagMissingScript = await RuntimeDiagnosticsService.diagnoseContainerCrash('mock-c-3', missingScriptLog);
  assert(diagMissingScript.failureType === 'DEPLOYMENT_CONFIGURATION_ERROR', 'Missing start script classified as DEPLOYMENT_CONFIGURATION_ERROR', `Got: ${diagMissingScript.failureType}`);
  assert(diagMissingScript.classification.includes('start script'), 'Classification identifies missing start script');

  // 12D: Database connection failure
  const dbCrashLog = `
MONGODB connection FAILED: MongooseServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017
`;
  const diagDb = await RuntimeDiagnosticsService.diagnoseContainerCrash('mock-c-4', dbCrashLog);
  assert(diagDb.failureType === 'DATABASE_FAILURE', 'Database connection error classified as DATABASE_FAILURE', `Got: ${diagDb.failureType}`);

  // 12E: Deployment configuration error
  const configErrLog = `
Error: DEPLOYMENT_CONFIGURATION_ERROR: package.json not found at /app/package.json
`;
  const diagConfig = await RuntimeDiagnosticsService.diagnoseContainerCrash('mock-c-5', configErrLog);
  assert(diagConfig.failureType === 'DEPLOYMENT_CONFIGURATION_ERROR', 'Config error classified as DEPLOYMENT_CONFIGURATION_ERROR', `Got: ${diagConfig.failureType}`);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 13: MyPortfolio Multi-Service Monorepo with Root Coordinator package.json
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- TEST 13: MyPortfolio (Root Coordinator + Nested Backend & Frontend) ---');
  const dir13 = await createTempDir('my_portfolio_monorepo');
  await fs.writeFile(
    path.join(dir13, 'package.json'),
    JSON.stringify({
      name: 'kartik-portfolio',
      version: '1.0.0',
      private: true,
      scripts: {
        dev: 'concurrently "npm run dev --prefix frontend" "npm run dev --prefix backend" --names "FE,BE" --prefix-colors "green,yellow"',
        'install:all': 'npm install --prefix frontend && npm install --prefix backend',
        build: 'npm run build --prefix frontend',
      },
      devDependencies: {
        concurrently: '^8.2.2',
      },
    })
  );

  // Backend in subfolder
  await fs.mkdir(path.join(dir13, 'backend', 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir13, 'backend', 'package.json'),
    JSON.stringify({
      name: 'kartik-portfolio-backend',
      version: '1.0.0',
      main: 'src/server.js',
      type: 'module',
      scripts: {
        dev: 'node --watch src/server.js',
        start: 'node src/server.js',
      },
      dependencies: {
        cors: '^2.8.5',
        dotenv: '^16.4.5',
        express: '^4.19.2',
      },
    })
  );
  await fs.writeFile(path.join(dir13, 'backend', 'src', 'server.js'), 'import express from "express";');

  // Frontend in subfolder
  await fs.mkdir(path.join(dir13, 'frontend'), { recursive: true });
  await fs.writeFile(
    path.join(dir13, 'frontend', 'package.json'),
    JSON.stringify({
      name: 'kartik-portfolio-frontend',
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
      },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
      },
      devDependencies: {
        vite: '^5.3.1',
      },
    })
  );
  await fs.writeFile(path.join(dir13, 'frontend', 'index.html'), '<html><body></body></html>');

  // Unscoped detection: should NOT be classified as a standalone job, but as a monorepo!
  const res13Unscoped = await ProjectDetector.detect(dir13);
  assert(res13Unscoped.type === 'monorepo', 'MyPortfolio detected as monorepo (NOT standalone job)', `Got: ${res13Unscoped.type}`);
  assert(res13Unscoped.deploymentMode === 'multi-service', 'MyPortfolio mode is multi-service', `Got: ${res13Unscoped.deploymentMode}`);
  assert(res13Unscoped.candidates?.length === 2, 'Found 2 candidates (backend & frontend)', `Got: ${res13Unscoped.candidates?.length}`);

  // Scoped detection: backend
  const res13Backend = await ProjectDetector.detect(dir13, {}, 'backend');
  assert(res13Backend.type === 'node-backend', 'Selected backend detected as node-backend', `Got: ${res13Backend.type}`);
  assert(res13Backend.framework === 'Express', 'Selected backend framework is Express', `Got: ${res13Backend.framework}`);
  assert(res13Backend.deploymentMode === 'service', 'Backend deploymentMode is service', `Got: ${res13Backend.deploymentMode}`);
  assert(res13Backend.buildContext === path.resolve(dir13, 'backend'), 'buildContext is <workspace>/backend');

  // Scoped detection: frontend
  const res13Frontend = await ProjectDetector.detect(dir13, {}, 'frontend');
  assert(res13Frontend.type === 'node-frontend', 'Selected frontend detected as node-frontend', `Got: ${res13Frontend.type}`);
  assert(res13Frontend.framework === 'Vite', 'Selected frontend framework is Vite', `Got: ${res13Frontend.framework}`);
  assert(res13Frontend.deploymentMode === 'static', 'Frontend deploymentMode is static', `Got: ${res13Frontend.deploymentMode}`);
  assert(res13Frontend.buildContext === path.resolve(dir13, 'frontend'), 'buildContext is <workspace>/frontend');

  // Clean up all temp directories
  for (const d of tempDirsToClean) {
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n===============================================================');
  console.log(`🏁 TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test suite runner failed:', err);
  process.exit(1);
});
