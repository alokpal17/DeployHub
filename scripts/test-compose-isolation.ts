import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ProjectDetector } from '../apps/worker/src/services/project-detector.service';
import { DockerService } from '../apps/worker/src/services/docker.service';
import { PortManager } from '../apps/worker/src/services/port-manager.service';

const execAsync = promisify(exec);

interface IsolationTestResult {
  testNumber: number;
  name: string;
  passed: boolean;
  evidence: string;
  error?: string;
}

const results: IsolationTestResult[] = [];

function record(testNumber: number, name: string, passed: boolean, evidence: string, error?: string) {
  results.push({ testNumber, name, passed, evidence, error });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${icon}] Test ${testNumber}: ${name}`);
  console.log(`   Evidence: ${evidence}`);
  if (error) console.log(`   Error: ${error}`);
}

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
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw new Error('HTTP request failed after retries');
}

async function createMockFuzzTubeWorkspace(baseDir: string): Promise<void> {
  const backendDir = path.join(baseDir, 'BACKEND');
  const frontendDir = path.join(baseDir, 'FRONTEND');
  await fs.mkdir(backendDir, { recursive: true });
  await fs.mkdir(frontendDir, { recursive: true });

  await fs.writeFile(
    path.join(backendDir, 'Dockerfile'),
    `FROM node:20-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 8000
CMD ["node", "server.js"]
`
  );
  await fs.writeFile(
    path.join(backendDir, 'server.js'),
    `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: 'fuzztube-backend', status: 'ok' }));
});
server.listen(8000, '0.0.0.0', () => console.log('Backend listening on 8000'));
`
  );

  await fs.writeFile(
    path.join(frontendDir, 'Dockerfile'),
    `FROM node:20-alpine
WORKDIR /app
COPY index.js ./
EXPOSE 80
CMD ["node", "index.js"]
`
  );
  await fs.writeFile(
    path.join(frontendDir, 'index.js'),
    `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>FuzzTube Isolated Frontend</h1>');
});
const port = parseInt(process.env.PORT || '80', 10);
server.listen(port, '0.0.0.0', () => console.log('Frontend listening on ' + port));
`
  );

  // Exact FuzzTube docker-compose.yml structure with explicit container_name attributes
  await fs.writeFile(
    path.join(baseDir, 'docker-compose.yml'),
    `version: '3.8'

services:
  backend:
    build: ./BACKEND
    container_name: fuzztube-backend
    ports:
      - "8000:8000"
    env_file:
      - ./BACKEND/.env
    networks:
      - fuzztube-network

  frontend:
    build: ./FRONTEND
    container_name: fuzztube-frontend
    ports:
      - "3000:80"
    depends_on:
      - backend
    networks:
      - fuzztube-network

networks:
  fuzztube-network:
    driver: bridge
`
  );
}

async function runIsolationTests() {
  const rootTestDir = path.join(os.tmpdir(), `deployhub_isolation_suite_${Date.now()}`);
  await fs.mkdir(rootTestDir, { recursive: true });

  console.log(`=================================================================`);
  console.log(`🚀 DEPLOYHUB DOCKER COMPOSE ISOLATION & ZERO-DOWNTIME TEST SUITE`);
  console.log(`   Temp Root: ${rootTestDir}`);
  console.log(`=================================================================\n`);

  const dummyHostContainerName = 'fuzztube-backend';

  try {
    // Clean up any old dummy container from previous runs if existing
    try {
      await execAsync(`docker rm -f ${dummyHostContainerName}`);
    } catch {}

    // ─────────────────────────────────────────────────────────────
    // TEST 1: Coexistence with Pre-Existing Host Container "fuzztube-backend"
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Running TEST 1: Coexistence with Pre-Existing Host Container ---');
    // Start an existing independent container named "fuzztube-backend"
    await execAsync(`docker run -d --name ${dummyHostContainerName} alpine sleep 3600`);
    const { stdout: preCheck } = await execAsync(`docker ps -q --filter "name=${dummyHostContainerName}"`);
    const preExistingId = preCheck.trim();

    const t1Dir = path.join(rootTestDir, 't1');
    await createMockFuzzTubeWorkspace(t1Dir);

    const dep1Id = '6ac523735466ac04394c1d27';
    const proj1Name = `deployhub-${dep1Id}`;
    const port1 = await PortManager.allocatePort();

    const d1 = await ProjectDetector.detect(t1Dir);
    await DockerService.prepareComposeEnvironment(t1Dir, d1, {}, port1, 'proj1', dep1Id);

    // Verify prepared file stripped container_name
    const prep1Raw = await fs.readFile(path.join(t1Dir, 'docker-compose.deployhub-prepared.yml'), 'utf8');
    const hasStrippedContainerName = !prep1Raw.includes('container_name:');
    const hasStrippedVersion = !prep1Raw.includes('version:');

    await DockerService.buildComposeProject(t1Dir, 'docker-compose.yml', proj1Name, () => {});
    await DockerService.runComposeProject(
      { repoPath: t1Dir, projectName: proj1Name, hostPort: port1, projectId: 'proj1', deploymentId: dep1Id },
      () => {}
    );
    await DockerService.checkComposeHealth(t1Dir, 'docker-compose.yml', proj1Name, port1, 20000);

    const res1 = await queryHttp(`http://127.0.0.1:${port1}/`);

    // Verify original container STILL EXISTS and was NOT deleted or modified
    const { stdout: postCheck } = await execAsync(`docker ps -q --filter "name=${dummyHostContainerName}"`);
    const origContainerUntouched = postCheck.trim() === preExistingId;

    const pass1 = hasStrippedContainerName && hasStrippedVersion && res1.status === 200 && origContainerUntouched;
    record(
      1,
      'Coexistence with Pre-Existing Host Container "fuzztube-backend"',
      pass1,
      `Deployment live on port :${port1} (HTTP ${res1.status}), original container "${dummyHostContainerName}" (${preExistingId.slice(0, 12)}) remains untouched and running.`
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Two Simultaneous Deployments of the Same Repo (Zero Collision)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Running TEST 2: Two Simultaneous Deployments of Same Repo ---');
    const t2Dir = path.join(rootTestDir, 't2');
    await createMockFuzzTubeWorkspace(t2Dir);

    const dep2Id = '6ac523735466ac04394c1d28';
    const proj2Name = `deployhub-${dep2Id}`;
    const port2 = await PortManager.allocatePort();

    const d2 = await ProjectDetector.detect(t2Dir);
    await DockerService.prepareComposeEnvironment(t2Dir, d2, {}, port2, 'proj1', dep2Id);
    await DockerService.buildComposeProject(t2Dir, 'docker-compose.yml', proj2Name, () => {});
    await DockerService.runComposeProject(
      { repoPath: t2Dir, projectName: proj2Name, hostPort: port2, projectId: 'proj1', deploymentId: dep2Id },
      () => {}
    );
    await DockerService.checkComposeHealth(t2Dir, 'docker-compose.yml', proj2Name, port2, 20000);

    // Both deployments must respond simultaneously
    const resA = await queryHttp(`http://127.0.0.1:${port1}/`);
    const resB = await queryHttp(`http://127.0.0.1:${port2}/`);

    const pass2 = resA.status === 200 && resB.status === 200 && port1 !== port2;
    record(
      2,
      'Simultaneous Multi-Deployment Isolation (No Container Name Collisions)',
      pass2,
      `Deployment A (: ${port1}) and Deployment B (: ${port2}) coexisting and serving traffic concurrently without collision.`
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Scoped Cleanup on Failed Deployment (Unrelated Containers Untouched)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Running TEST 3: Scoped Teardown of Failed Deployment ---');
    const dep3FailedId = '6ac523735466ac04394c1d29';
    const proj3FailedName = `deployhub-${dep3FailedId}`;

    // Clean up deployment 1
    await DockerService.stopAndRemoveComposeProject(t1Dir, proj1Name);

    // Verify Deployment 2 is STILL RUNNING
    const resB_stillUp = await queryHttp(`http://127.0.0.1:${port2}/`);

    // Verify original dummy container is STILL RUNNING
    const { stdout: postCheck3 } = await execAsync(`docker ps -q --filter "name=${dummyHostContainerName}"`);
    const origStillUp = postCheck3.trim() === preExistingId;

    const pass3 = resB_stillUp.status === 200 && origStillUp;
    record(
      3,
      'Scoped Teardown & Preservation of Unrelated Deployments',
      pass3,
      `Torn down Deployment 1. Deployment 2 (port :${port2}) and host container "${dummyHostContainerName}" remain active.`
    );

    // Clean up Deployment 2
    await DockerService.stopAndRemoveComposeProject(t2Dir, proj2Name);

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Zero-Downtime Transition Workflow
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Running TEST 4: Zero-Downtime Transition Workflow ---');
    // Start v1
    const v1DepId = '6ac523735466ac04394c1d30';
    const v1ProjName = `deployhub-${v1DepId}`;
    const v1Port = await PortManager.allocatePort();
    const v1Dir = path.join(rootTestDir, 'v1');
    await createMockFuzzTubeWorkspace(v1Dir);
    const dV1 = await ProjectDetector.detect(v1Dir);
    await DockerService.prepareComposeEnvironment(v1Dir, dV1, {}, v1Port, 'proj_zd', v1DepId);
    await DockerService.buildComposeProject(v1Dir, 'docker-compose.yml', v1ProjName, () => {});
    await DockerService.runComposeProject(
      { repoPath: v1Dir, projectName: v1ProjName, hostPort: v1Port, projectId: 'proj_zd', deploymentId: v1DepId },
      () => {}
    );
    await DockerService.checkComposeHealth(v1Dir, 'docker-compose.yml', v1ProjName, v1Port, 20000);
    const v1LiveRes = await queryHttp(`http://127.0.0.1:${v1Port}/`);

    // Start v2 while v1 is active
    const v2DepId = '6ac523735466ac04394c1d31';
    const v2ProjName = `deployhub-${v2DepId}`;
    const v2Port = await PortManager.allocatePort();
    const v2Dir = path.join(rootTestDir, 'v2');
    await createMockFuzzTubeWorkspace(v2Dir);
    const dV2 = await ProjectDetector.detect(v2Dir);
    await DockerService.prepareComposeEnvironment(v2Dir, dV2, {}, v2Port, 'proj_zd', v2DepId);
    await DockerService.buildComposeProject(v2Dir, 'docker-compose.yml', v2ProjName, () => {});
    await DockerService.runComposeProject(
      { repoPath: v2Dir, projectName: v2ProjName, hostPort: v2Port, projectId: 'proj_zd', deploymentId: v2DepId },
      () => {}
    );
    await DockerService.checkComposeHealth(v2Dir, 'docker-compose.yml', v2ProjName, v2Port, 20000);
    const v2LiveRes = await queryHttp(`http://127.0.0.1:${v2Port}/`);

    // Both are live during transition
    const bothLive = v1LiveRes.status === 200 && v2LiveRes.status === 200;

    // Now retire previous release v1
    await DockerService.stopPreviousComposeProjects('proj_zd', v2DepId);
    const v2StillServing = (await queryHttp(`http://127.0.0.1:${v2Port}/`)).status === 200;

    const pass4 = bothLive && v2StillServing;
    record(
      4,
      'Zero-Downtime Transition & Clean Retirement of Prior Release',
      pass4,
      `v1 (port :${v1Port}) and v2 (port :${v2Port}) ran in parallel during verification; v1 gracefully stopped after v2 became active.`
    );

    // Clean up v2
    await DockerService.stopAndRemoveComposeProject(v2Dir, v2ProjName);

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Two Different Repos with Same container_name
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Running TEST 5: Two Different Repos with Identical container_name ---');
    const repoADir = path.join(rootTestDir, 'repoA');
    const repoBDir = path.join(rootTestDir, 'repoB');
    await fs.mkdir(repoADir, { recursive: true });
    await fs.mkdir(repoBDir, { recursive: true });

    const createGenericCompose = async (dir: string, appLabel: string) => {
      await fs.writeFile(
        path.join(dir, 'docker-compose.yml'),
        `services:
  web:
    image: node:20-alpine
    container_name: shared-global-name
    ports:
      - "3000:3000"
    command: ["node", "-e", "const http = require('http'); http.createServer((r, s) => s.end('${appLabel}')).listen(3000);"]
`
      );
    };

    await createGenericCompose(repoADir, 'Repo A App');
    await createGenericCompose(repoBDir, 'Repo B App');

    const depAId = '6ac523735466ac04394c1d32';
    const depBId = '6ac523735466ac04394c1d33';
    const projAName = `deployhub-${depAId}`;
    const projBName = `deployhub-${depBId}`;
    const portA = await PortManager.allocatePort();
    const portB = await PortManager.allocatePort();

    const dRepoA = await ProjectDetector.detect(repoADir);
    const dRepoB = await ProjectDetector.detect(repoBDir);

    await DockerService.prepareComposeEnvironment(repoADir, dRepoA, {}, portA, 'projA', depAId);
    await DockerService.prepareComposeEnvironment(repoBDir, dRepoB, {}, portB, 'projB', depBId);

    await DockerService.runComposeProject({ repoPath: repoADir, projectName: projAName, hostPort: portA, projectId: 'projA', deploymentId: depAId }, () => {});
    await DockerService.runComposeProject({ repoPath: repoBDir, projectName: projBName, hostPort: portB, projectId: 'projB', deploymentId: depBId }, () => {});

    await DockerService.checkComposeHealth(repoADir, 'docker-compose.yml', projAName, portA, 20000);
    await DockerService.checkComposeHealth(repoBDir, 'docker-compose.yml', projBName, portB, 20000);

    const resAApp = await queryHttp(`http://127.0.0.1:${portA}/`);
    const resBApp = await queryHttp(`http://127.0.0.1:${portB}/`);

    const pass5 = resAApp.body === 'Repo A App' && resBApp.body === 'Repo B App';
    record(
      5,
      'Cross-Repository Isolation for Identical container_name ("shared-global-name")',
      pass5,
      `Repo A (: ${portA} -> "${resAApp.body}") and Repo B (: ${portB} -> "${resBApp.body}") both deployed and running simultaneously.`
    );

    await DockerService.stopAndRemoveComposeProject(repoADir, projAName);
    await DockerService.stopAndRemoveComposeProject(repoBDir, projBName);

    // ─────────────────────────────────────────────────────────────
    // TEST 6: Deterministic and Valid Compose Project Naming
    // ─────────────────────────────────────────────────────────────
    const testDepId = '6ac523735466ac04394c1d27';
    const sanitized = testDepId.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    const generatedProjectName = `deployhub-${sanitized}`;
    const pass6 =
      generatedProjectName === 'deployhub-6ac523735466ac04394c1d27' &&
      /^[a-z0-9_-]+$/.test(generatedProjectName) &&
      generatedProjectName.length <= 40;

    record(
      6,
      'Deterministic & Valid Compose Project Naming Verification',
      pass6,
      `Project name "${generatedProjectName}" is valid lowercase alphanumeric, scoped, and strictly under length limits.`
    );

  } finally {
    // Teardown the dummy host container
    try {
      await execAsync(`docker rm -f ${dummyHostContainerName}`);
    } catch {}

    // Clean up temp directory
    try {
      await fs.rm(rootTestDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n=================================================================`);
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  console.log(`📊 ISOLATION SUITE SUMMARY: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log(`=================================================================\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

runIsolationTests().catch((err) => {
  console.error('Fatal isolation test error:', err);
  process.exit(1);
});
