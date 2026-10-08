import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { ProjectDetector } from '../apps/worker/src/services/project-detector.service';
import { ComposeParser } from '../apps/worker/src/services/compose-parser.service';
import { DockerService } from '../apps/worker/src/services/docker.service';

interface TestCaseResult {
  testNumber: number;
  title: string;
  passed: boolean;
  details: string;
  error?: string;
}

const testResults: TestCaseResult[] = [];

function recordResult(testNumber: number, title: string, passed: boolean, details: string, error?: string) {
  testResults.push({ testNumber, title, passed, details, error });
  const statusIcon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusIcon}] Test ${testNumber}: ${title}`);
  if (details) console.log(`   Evidence: ${details}`);
  if (error) console.log(`   Error: ${error}`);
}

async function runTests() {
  const baseTestDir = path.join(os.tmpdir(), `deployhub_test_${Date.now()}`);
  await fs.mkdir(baseTestDir, { recursive: true });

  console.log(`=======================================================`);
  console.log(`🚀 DEPLOYHUB DOCKER COMPOSE & DETECTOR TEST SUITE`);
  console.log(`   Workspace: ${baseTestDir}`);
  console.log(`=======================================================\n`);

  try {
    // ─────────────────────────────────────────────────────────────
    // TEST 1: Root Dockerfile
    // ─────────────────────────────────────────────────────────────
    const test1Dir = path.join(baseTestDir, 't1-root-dockerfile');
    await fs.mkdir(test1Dir, { recursive: true });
    await fs.writeFile(path.join(test1Dir, 'Dockerfile'), 'FROM node:18-alpine\nCMD ["npm", "start"]\n');

    const d1 = await ProjectDetector.detect(test1Dir);
    const pass1 = d1.type === 'docker' && d1.hasDockerfile === true;
    recordResult(1, 'Root Dockerfile Detection', pass1, `Detected Type: ${d1.type}, hasDockerfile: ${d1.hasDockerfile}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Root docker-compose.yml
    // ─────────────────────────────────────────────────────────────
    const test2Dir = path.join(baseTestDir, 't2-root-docker-compose-yml');
    await fs.mkdir(test2Dir, { recursive: true });
    await fs.writeFile(
      path.join(test2Dir, 'docker-compose.yml'),
      `version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
`
    );

    const d2 = await ProjectDetector.detect(test2Dir);
    const pass2 = d2.type === 'docker-compose' && d2.composeInfo?.services.length === 1 && d2.composeInfo?.services[0].name === 'web';
    recordResult(2, 'Root docker-compose.yml Detection', pass2, `Detected Type: ${d2.type}, Services: ${d2.composeInfo?.services.map(s => s.name).join(', ')}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Root docker-compose.yaml
    // ─────────────────────────────────────────────────────────────
    const test3Dir = path.join(baseTestDir, 't3-root-docker-compose-yaml');
    await fs.mkdir(test3Dir, { recursive: true });
    await fs.writeFile(
      path.join(test3Dir, 'docker-compose.yaml'),
      `version: '3.8'
services:
  api:
    image: node:20-alpine
    ports:
      - "3000:3000"
`
    );

    const d3 = await ProjectDetector.detect(test3Dir);
    const pass3 = d3.type === 'docker-compose' && d3.composeInfo?.services[0].name === 'api';
    recordResult(3, 'Root docker-compose.yaml Detection', pass3, `Detected Type: ${d3.type}, File: ${d3.composeInfo?.composeFile}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Root compose.yml
    // ─────────────────────────────────────────────────────────────
    const test4Dir = path.join(baseTestDir, 't4-root-compose-yml');
    await fs.mkdir(test4Dir, { recursive: true });
    await fs.writeFile(
      path.join(test4Dir, 'compose.yml'),
      `services:
  server:
    image: redis:alpine
    ports:
      - "6379:6379"
`
    );

    const d4 = await ProjectDetector.detect(test4Dir);
    const pass4 = d4.type === 'docker-compose' && d4.composeInfo?.services[0].name === 'server';
    recordResult(4, 'Root compose.yml Detection', pass4, `Detected Type: ${d4.type}, File: ${d4.composeInfo?.composeFile}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Root compose.yaml
    // ─────────────────────────────────────────────────────────────
    const test5Dir = path.join(baseTestDir, 't5-root-compose-yaml');
    await fs.mkdir(test5Dir, { recursive: true });
    await fs.writeFile(
      path.join(test5Dir, 'compose.yaml'),
      `services:
  app:
    image: python:3.11-alpine
    ports:
      - "5000:5000"
`
    );

    const d5 = await ProjectDetector.detect(test5Dir);
    const pass5 = d5.type === 'docker-compose' && d5.composeInfo?.services[0].name === 'app';
    recordResult(5, 'Root compose.yaml Detection', pass5, `Detected Type: ${d5.type}, File: ${d5.composeInfo?.composeFile}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 6: Compose with Nested Dockerfiles (e.g. FRONTEND/ & BACKEND/)
    // ─────────────────────────────────────────────────────────────
    const test6Dir = path.join(baseTestDir, 't6-nested-dockerfiles');
    await fs.mkdir(path.join(test6Dir, 'FRONTEND'), { recursive: true });
    await fs.mkdir(path.join(test6Dir, 'BACKEND'), { recursive: true });
    await fs.writeFile(path.join(test6Dir, 'FRONTEND', 'Dockerfile'), 'FROM nginx:alpine\nEXPOSE 80\n');
    await fs.writeFile(path.join(test6Dir, 'BACKEND', 'Dockerfile'), 'FROM node:18-alpine\nEXPOSE 8000\n');
    await fs.writeFile(
      path.join(test6Dir, 'docker-compose.yml'),
      `version: '3.8'
services:
  backend:
    build: ./BACKEND
    ports:
      - "8000:8000"
  frontend:
    build: ./FRONTEND
    ports:
      - "3000:80"
    depends_on:
      - backend
`
    );

    const d6 = await ProjectDetector.detect(test6Dir);
    const pass6 =
      d6.type === 'docker-compose' &&
      d6.composeInfo?.services.length === 2 &&
      d6.composeInfo?.services.find(s => s.name === 'frontend')?.resolvedDockerfile === path.normalize('FRONTEND/Dockerfile') &&
      d6.composeInfo?.services.find(s => s.name === 'backend')?.resolvedDockerfile === path.normalize('BACKEND/Dockerfile');
    recordResult(6, 'Compose with Nested Dockerfiles Resolution', pass6, `Services: ${d6.composeInfo?.services.map(s => `${s.name} -> ${s.resolvedDockerfile}`).join(', ')}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 7: package.json-only Node Project (SPA vs Backend)
    // ─────────────────────────────────────────────────────────────
    const test7aDir = path.join(baseTestDir, 't7a-node-spa');
    await fs.mkdir(test7aDir, { recursive: true });
    await fs.writeFile(
      path.join(test7aDir, 'package.json'),
      JSON.stringify({ name: 'vite-app', dependencies: { react: '^18.0.0', vite: '^5.0.0' }, scripts: { build: 'vite build' } })
    );
    const d7a = await ProjectDetector.detect(test7aDir);
    const pass7a = (d7a.type === 'nodejs-spa' || d7a.type === 'node-frontend') && d7a.framework === 'Vite';

    const test7bDir = path.join(baseTestDir, 't7b-node-backend');
    await fs.mkdir(test7bDir, { recursive: true });
    await fs.writeFile(
      path.join(test7bDir, 'package.json'),
      JSON.stringify({ name: 'express-app', dependencies: { express: '^4.18.0' }, scripts: { start: 'node server.js' } })
    );
    const d7b = await ProjectDetector.detect(test7bDir);
    const pass7b = (d7b.type === 'nodejs-backend' || d7b.type === 'node-backend') && d7b.framework === 'Express';

    const pass7 = pass7a && pass7b;
    recordResult(7, 'package.json Ecosystem Detection (SPA & Backend)', pass7, `SPA: ${d7a.type} (${d7a.framework}), Backend: ${d7b.type} (${d7b.framework})`);

    // ─────────────────────────────────────────────────────────────
    // TEST 8: Static HTML / index.html Project
    // ─────────────────────────────────────────────────────────────
    const test8Dir = path.join(baseTestDir, 't8-static-html');
    await fs.mkdir(test8Dir, { recursive: true });
    await fs.writeFile(path.join(test8Dir, 'index.html'), '<!DOCTYPE html><html><body><h1>Portfolio</h1></body></html>');

    const d8 = await ProjectDetector.detect(test8Dir);
    const pass8 = d8.type === 'static-html' || d8.type === 'static';
    recordResult(8, 'Static index.html Portfolio Detection', pass8, `Detected Type: ${d8.type}, Framework: ${d8.framework}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 9: Invalid Compose File (Syntax Error)
    // ─────────────────────────────────────────────────────────────
    const test9Dir = path.join(baseTestDir, 't9-invalid-compose-syntax');
    await fs.mkdir(test9Dir, { recursive: true });
    await fs.writeFile(path.join(test9Dir, 'docker-compose.yml'), 'services:\n  web: [invalid yaml syntax here: :::');

    let pass9 = false;
    let err9Msg = '';
    try {
      await ProjectDetector.detect(test9Dir);
    } catch (e: any) {
      pass9 = e.message.includes('Docker Compose validation failed');
      err9Msg = e.message;
    }
    recordResult(9, 'Invalid Compose YAML Syntax Handling', pass9, `Caught diagnostic: ${err9Msg}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 10: Compose referencing Missing Dockerfile
    // ─────────────────────────────────────────────────────────────
    const test10Dir = path.join(baseTestDir, 't10-missing-dockerfile');
    await fs.mkdir(path.join(test10Dir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(test10Dir, 'docker-compose.yml'),
      `version: '3.8'
services:
  web:
    build:
      context: ./src
      dockerfile: NonExistent.Dockerfile
`
    );

    let pass10 = false;
    let err10Msg = '';
    try {
      await ProjectDetector.detect(test10Dir);
    } catch (e: any) {
      pass10 = e.message.includes('non-existent Dockerfile');
      err10Msg = e.message;
    }
    recordResult(10, 'Compose Referencing Missing Dockerfile', pass10, `Caught diagnostic: ${err10Msg}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 11: Compose referencing Missing Build Context Directory
    // ─────────────────────────────────────────────────────────────
    const test11Dir = path.join(baseTestDir, 't11-missing-context');
    await fs.mkdir(test11Dir, { recursive: true });
    await fs.writeFile(
      path.join(test11Dir, 'docker-compose.yml'),
      `version: '3.8'
services:
  web:
    build: ./NON_EXISTENT_DIR
`
    );

    let pass11 = false;
    let err11Msg = '';
    try {
      await ProjectDetector.detect(test11Dir);
    } catch (e: any) {
      pass11 = e.message.includes('non-existent build context directory');
      err11Msg = e.message;
    }
    recordResult(11, 'Compose Referencing Missing Build Context', pass11, `Caught diagnostic: ${err11Msg}`);

    // ─────────────────────────────────────────────────────────────
    // TEST 12: Real FuzzTube Repository Structure Emulation
    // ─────────────────────────────────────────────────────────────
    const test12Dir = path.join(baseTestDir, 't12-fuzztube-structure');
    await fs.mkdir(path.join(test12Dir, 'BACKEND'), { recursive: true });
    await fs.mkdir(path.join(test12Dir, 'FRONTEND'), { recursive: true });
    await fs.writeFile(
      path.join(test12Dir, 'BACKEND', 'Dockerfile'),
      'FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8000\nCMD ["node", "src/index.js"]\n'
    );
    await fs.writeFile(
      path.join(test12Dir, 'FRONTEND', 'Dockerfile'),
      'FROM nginx:alpine\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n'
    );
    await fs.writeFile(
      path.join(test12Dir, 'docker-compose.yml'),
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
    await fs.writeFile(
      path.join(test12Dir, 'README.md'),
      `# FuzzTube
## Environment Variables
\`\`\`env
PORT=8000
MONGODB_URI=
ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
\`\`\`
`
    );

    const d12 = await ProjectDetector.detect(test12Dir);
    const pass12 =
      d12.type === 'docker-compose' &&
      d12.composeInfo?.services.length === 2 &&
      d12.composeInfo?.primaryService === 'frontend' &&
      d12.composeInfo?.primaryPort === 3000 &&
      d12.detectedEnvVars?.some(v => v.key === 'MONGODB_URI' && v.isSecret) === true &&
      d12.missingRequiredEnvVars?.includes('MONGODB_URI') === true;

    recordResult(
      12,
      'FuzzTube Multi-Service Compose Detection & Env Preflight',
      pass12,
      `Type: ${d12.type}, Services: [${d12.composeInfo?.services.map(s => s.name).join(', ')}], Primary: ${d12.composeInfo?.primaryService} (port ${d12.composeInfo?.primaryPort}), Missing Secrets: [${d12.missingRequiredEnvVars?.join(', ')}]`
    );

    // ─────────────────────────────────────────────────────────────
    // TEST 13: Secret Masking Security Verification
    // ─────────────────────────────────────────────────────────────
    const sampleSecret = process.env.TEST_SAMPLE_SECRET || 'TEST_ONLY_PLACEHOLDER_PASS';
    const sampleApiKey = process.env.TEST_SAMPLE_API_KEY || 'TEST_ONLY_KEY_VAL';
    const testUser = 'root';
    const testAuthHost = '127.0.0.1:27017';
    const rawLogLine = `Connecting to mongodb://${testUser}:${sampleSecret}@${testAuthHost}/fuzztubedb with API_KEY=${sampleApiKey}`;
    const masked = DockerService.maskSecrets(rawLogLine, { MONGODB_URI: sampleSecret, API_KEY: sampleApiKey });
    const pass13 = !masked.includes(sampleSecret) && !masked.includes(sampleApiKey) && masked.includes('[HIDDEN');
    recordResult(13, 'Secret Masking & Security Log Redaction', pass13, `Masked Log: "${masked}"`);

    // ─────────────────────────────────────────────────────────────
    // TEST 14: Compose Environment & Port Override Generation
    // ─────────────────────────────────────────────────────────────
    const prepResult = await DockerService.prepareComposeEnvironment(
      test12Dir,
      d12,
      { MONGODB_URI: 'mongodb://127.0.0.1:27017/test', ACCESS_TOKEN_SECRET: 'TEST_ONLY_ACCESS_TOKEN' },
      4186
    );
    const overrideExists = (await fs.stat(path.join(test12Dir, prepResult.preparedComposeFile))).isFile();
    const missingEnvFileCreated = (await fs.stat(path.join(test12Dir, 'BACKEND', '.env'))).isFile();
    const pass14 = overrideExists && missingEnvFileCreated;
    recordResult(
      14,
      'Compose Environment Preparation & Dynamic Port Remapping',
      pass14,
      `Override created: ${overrideExists}, Missing env_file created: ${missingEnvFileCreated}`
    );
    // ─────────────────────────────────────────────────────────────
    // TEST 15: Real Cloned FuzzTube Repo Test (if cloned in TEMP)
    // ─────────────────────────────────────────────────────────────
    const realFuzzTubePath = path.join(os.tmpdir(), 'test_fuzztube_inspect');
    try {
      const stat = await fs.stat(realFuzzTubePath);
      if (stat.isDirectory()) {
        const d15 = await ProjectDetector.detect(realFuzzTubePath);
        const pass15 =
          d15.type === 'docker-compose' &&
          d15.composeInfo?.services.length === 2 &&
          d15.composeInfo?.primaryService === 'frontend';
        recordResult(
          15,
          'Real GitHub FuzzTube Repository Detection (Direct Clone)',
          pass15,
          `Type: ${d15.type}, Services: [${d15.composeInfo?.services.map(s => s.name).join(', ')}], Primary: ${d15.composeInfo?.primaryService}`
        );
      }
    } catch {
      // Skipped if temp directory not present
    }

  } finally {
    // Cleanup temporary test directory
    try {
      await fs.rm(baseTestDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n=======================================================`);
  const total = testResults.length;
  const passed = testResults.filter(r => r.passed).length;
  console.log(`📊 FINAL RESULTS: ${passed} / ${total} tests passed (${Math.round((passed / total) * 100)}%)`);
  console.log(`=======================================================\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
