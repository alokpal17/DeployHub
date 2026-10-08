import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import http from 'http';
import { ProjectDetector } from '../apps/worker/src/services/project-detector.service';
import { DockerService } from '../apps/worker/src/services/docker.service';
import { PortManager } from '../apps/worker/src/services/port-manager.service';

async function queryHttp(url: string, retries = 5): Promise<{ status: number; body: string }> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => {
          req.destroy();
          reject(new Error('HTTP timeout'));
        });
      });
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('HTTP request failed after retries');
}

async function runEndToEndComposeTest() {
  const baseTestDir = path.join(os.tmpdir(), `deployhub_compose_e2e_${Date.now()}`);
  await fs.mkdir(baseTestDir, { recursive: true });

  console.log(`=======================================================`);
  console.log(`🚀 DEPLOYHUB END-TO-END DOCKER COMPOSE DEPLOYMENT TEST`);
  console.log(`   Workspace: ${baseTestDir}`);
  console.log(`=======================================================\n`);

  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(line);
    console.log(`  [E2E] ${line}`);
  };

  const projectName = `deployhub-testproj-testdep${Date.now().toString().slice(-4)}`;
  let allocatedPort: number | null = null;

  try {
    // 1. Create a full-stack multi-service Compose project (API + Web Frontend)
    const backendDir = path.join(baseTestDir, 'backend');
    const frontendDir = path.join(baseTestDir, 'frontend');
    await fs.mkdir(backendDir, { recursive: true });
    await fs.mkdir(frontendDir, { recursive: true });

    // Backend Dockerfile & server
    await fs.writeFile(
      path.join(backendDir, 'Dockerfile'),
      `FROM node:20-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
`
    );
    await fs.writeFile(
      path.join(backendDir, 'server.js'),
      `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'backend-api', env: process.env.API_SECRET || 'none' }));
});
server.listen(8080, '0.0.0.0', () => console.log('Backend listening on 8080'));
`
    );

    // Frontend Dockerfile & server
    await fs.writeFile(
      path.join(frontendDir, 'Dockerfile'),
      `FROM node:20-alpine
WORKDIR /app
COPY index.js ./
EXPOSE 3000
CMD ["node", "index.js"]
`
    );
    await fs.writeFile(
      path.join(frontendDir, 'index.js'),
      `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>DeployHub FullStack Compose App</h1><p>Status: Healthy</p>');
});
const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log('Frontend listening on ' + port));
`
    );

    // docker-compose.yml
    await fs.writeFile(
      path.join(baseTestDir, 'docker-compose.yml'),
      `version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - "8080:8080"
    env_file:
      - ./backend/.env
    environment:
      API_SECRET: \${API_SECRET}

  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
    depends_on:
      - backend
`
    );

    // 2. Run Project Detection
    log('Step 1: Running Project Detection...');
    const detection = await ProjectDetector.detect(baseTestDir, { API_SECRET: 'my_top_secret_token_123' });
    if (detection.type !== 'docker-compose') {
      throw new Error(`Expected detection type "docker-compose", got "${detection.type}"`);
    }
    log(`✅ Project detected as "${detection.type}" with ${detection.composeInfo?.services.length} services.`);

    // 3. Allocate Host Port
    allocatedPort = await PortManager.allocatePort();
    log(`✅ Host port allocated: :${allocatedPort}`);

    // 4. Prepare Compose Environment (missing env_file creation, dynamic port mapping)
    log('Step 2: Preparing Compose Environment...');
    await DockerService.prepareComposeEnvironment(
      baseTestDir,
      detection,
      { API_SECRET: 'my_top_secret_token_123' },
      allocatedPort,
      'testproj',
      'testdep',
      log
    );

    // 5. Build Compose Project
    log('Step 3: Building Docker Compose Project...');
    await DockerService.buildComposeProject(
      baseTestDir,
      'docker-compose.yml',
      projectName,
      log,
      300000
    );
    log('✅ Docker Compose build completed successfully.');

    // 6. Run Compose Project
    log('Step 4: Launching Docker Compose Services...');
    await DockerService.runComposeProject(
      {
        repoPath: baseTestDir,
        composeFile: 'docker-compose.yml',
        projectName,
        hostPort: allocatedPort,
        projectId: 'testproj',
        deploymentId: 'testdep',
        envVars: { API_SECRET: 'my_top_secret_token_123' },
      },
      log
    );
    log('✅ Docker Compose services launched.');

    // 7. Verify Health on Host Port
    log('Step 5: Verifying Health on Host Port...');
    await DockerService.checkComposeHealth(
      baseTestDir,
      'docker-compose.yml',
      projectName,
      allocatedPort,
      25000,
      log
    );

    const httpRes = await queryHttp(`http://127.0.0.1:${allocatedPort}/`);
    log(`✅ HTTP probe response: HTTP ${httpRes.status} -> ${httpRes.body}`);
    if (httpRes.status !== 200 || !httpRes.body.includes('DeployHub FullStack Compose App')) {
      throw new Error(`Unexpected HTTP body: ${httpRes.body}`);
    }

    // 8. Teardown
    log('Step 6: Tearing down Compose Project...');
    await DockerService.stopAndRemoveComposeProject(baseTestDir, projectName, log);
    log('✅ Docker Compose project torn down cleanly.');

    console.log(`\n=======================================================`);
    console.log(`🎉 ALL END-TO-END DOCKER COMPOSE TESTS PASSED!`);
    console.log(`=======================================================\n`);
  } finally {
    if (allocatedPort) {
      await PortManager.releasePort(allocatedPort);
    }
    // Teardown project if still running
    try {
      await DockerService.stopAndRemoveComposeProject(baseTestDir, projectName);
    } catch {}
    // Clean directory
    try {
      await fs.rm(baseTestDir, { recursive: true, force: true });
    } catch {}
  }
}

runEndToEndComposeTest().catch((err) => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
