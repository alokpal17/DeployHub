import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import crypto from 'crypto';
import simpleGit from 'simple-git';

import { UserModel as User, ProjectModel as Project, DeploymentModel as Deployment } from '../apps/api/src/models';
import { processDeployJob } from '../apps/worker/src/jobs/deploy.job';
import { processStopJob } from '../apps/worker/src/jobs/stop.job';
import { ReconciliationService } from '../apps/worker/src/services/reconciliation.service';
import { verifyGitHubSignature, handleGitHubWebhook } from '../apps/api/src/controllers/webhook.controller';
import { getPrometheusMetrics } from '../apps/api/src/services/metrics.service';
import type { DeployJobData } from '@deployhub/shared';

const execAsync = promisify(exec);

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/deployhub_m3_test';
const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures/m3');

interface TestResult {
  name: string;
  passed: boolean;
  evidence: string;
  error?: string;
}

const results: TestResult[] = [];

function createMockJob<T>(data: T): any {
  return {
    id: (data as any).deploymentId || 'mock-job-id',
    data,
    updateProgress: async () => {},
    opts: { attempts: 1 },
  };
}

async function makeHttpReq(url: string, retries = 4): Promise<{ status: number; body: string }> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('HTTP request timed out'));
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

function computeSignature(payload: any, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return `sha256=${hmac.digest('hex')}`;
}

async function setupFixtures() {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });

  const appDir = path.join(FIXTURES_DIR, 'webhook-test-app');
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'webhook-test-app',
        version: '1.0.0',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { express: '^4.18.2' },
      },
      null,
      2
    )
  );

  await fs.writeFile(
    path.join(appDir, 'server.js'),
    `const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Hello from Webhook Triggered App!' }));
app.listen(port, '0.0.0.0', () => console.log('Listening on ' + port));
`
  );

  const git = simpleGit(appDir);
  await git.init();
  await git.addConfig('user.name', 'M3 Webhook Test Runner');
  await git.addConfig('user.email', 'm3test@deployhub.local');
  await git.add('.');
  await git.commit('Initial automated webhook app commit');
}

async function runMilestone3Tests() {
  console.log('\n========================================================================================');
  console.log('🚀 RUNNING MILESTONE 3 AUTOMATED DEPLOYMENTS & OBSERVABILITY TEST SUITE');
  console.log('========================================================================================\n');

  await mongoose.connect(MONGODB_URI);
  await setupFixtures();

  // Clean collections
  await User.deleteMany({ email: { $regex: /m3test/ } });
  await Project.deleteMany({ name: { $regex: /m3/ } });
  await Deployment.deleteMany({});

  const user = await User.create({
    githubId: 'm3_user_1',
    username: 'dev_m3',
    email: 'dev@m3test.local',
  });

  const webhookSecret = 'secret_webhook_key_778899aabbcc';
  const repoUrl = 'https://github.com/deployhub-org/webhook-demo-repo';

  const project = await Project.create({
    userId: user._id,
    name: 'm3-auto-deploy-project',
    repositoryUrl: repoUrl,
    branch: 'main',
    productionBranch: 'main',
    autoDeploy: true,
    allowManualDeploy: true,
    webhookSecret,
  });

  // Mock Request / Response helper for Webhook Controller
  function mockWebhookRequest(payload: any, signature?: string, event = 'push') {
    let statusCode = 200;
    let responseBody: any = null;

    const req: any = {
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': event,
        'x-github-delivery': `del_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      },
      body: payload,
      rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    };

    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: any) => {
        responseBody = data;
        return res;
      },
    };

    return {
      execute: () => handleGitHubWebhook(req, res),
      getStatusCode: () => statusCode,
      getBody: () => responseBody,
    };
  }

  // =========================================================================
  // TEST 1 — Valid GitHub Webhook Queues Deployment
  // =========================================================================
  console.log('--- TEST 1: Valid GitHub Webhook Trigger ---');
  try {
    const payload = {
      ref: 'refs/heads/main',
      after: 'a1b2c3d4e5f67890123456789abcdef012345678',
      repository: {
        name: 'webhook-demo-repo',
        full_name: 'deployhub-org/webhook-demo-repo',
        html_url: repoUrl,
        clone_url: `${repoUrl}.git`,
      },
      head_commit: {
        id: 'a1b2c3d4e5f67890123456789abcdef012345678',
        message: 'feat: live automatic webhook deployment',
        author: { name: 'Alice Developer', email: 'alice@example.com' },
      },
    };

    const signature = computeSignature(payload, webhookSecret);
    const mock = mockWebhookRequest(payload, signature);
    await mock.execute();

    const statusCode = mock.getStatusCode();
    const body = mock.getBody();

    const createdDeployment = await Deployment.findOne({
      projectId: project._id,
      commitHash: 'a1b2c3d4e5f67890123456789abcdef012345678',
    });

    const passed =
      statusCode === 202 &&
      body?.success === true &&
      createdDeployment !== null &&
      createdDeployment.trigger === 'WEBHOOK';

    results.push({
      name: 'TEST 1: Valid GitHub Webhook Trigger',
      passed,
      evidence: `HTTP Status: ${statusCode}, Response: ${JSON.stringify(body?.data?.message)}, Trigger recorded: ${createdDeployment?.trigger}`,
    });
    console.log(passed ? '✅ TEST 1 PASSED' : '❌ TEST 1 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 1: Valid GitHub Webhook Trigger', passed: false, evidence: err.message });
    console.log('❌ TEST 1 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 2 — Invalid Webhook Signature Rejected
  // =========================================================================
  console.log('\n--- TEST 2: Invalid Webhook Signature Rejected ---');
  try {
    const payload = {
      ref: 'refs/heads/main',
      repository: { html_url: repoUrl },
      head_commit: { id: 'invalid_sig_commit' },
    };

    const invalidSignature = 'sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const mock = mockWebhookRequest(payload, invalidSignature);
    await mock.execute();

    const statusCode = mock.getStatusCode();
    const body = mock.getBody();
    const passed = statusCode === 401 && body?.success === false;

    results.push({
      name: 'TEST 2: Invalid Webhook Signature Rejection',
      passed,
      evidence: `HTTP Status: ${statusCode}, Error: ${body?.error}`,
    });
    console.log(passed ? '✅ TEST 2 PASSED' : '❌ TEST 2 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 2: Invalid Webhook Signature Rejection', passed: false, evidence: err.message });
    console.log('❌ TEST 2 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 3 — Wrong Repository Ignored / Rejected
  // =========================================================================
  console.log('\n--- TEST 3: Wrong Repository Ignored / Rejected ---');
  try {
    const payload = {
      ref: 'refs/heads/main',
      repository: {
        name: 'unrelated-repo-xyz',
        html_url: 'https://github.com/unrelated/unrelated-repo-xyz',
      },
    };

    const signature = computeSignature(payload, webhookSecret);
    const mock = mockWebhookRequest(payload, signature);
    await mock.execute();

    const statusCode = mock.getStatusCode();
    const body = mock.getBody();
    const passed = statusCode === 404 && body?.success === false;

    results.push({
      name: 'TEST 3: Unrelated Repository Ignored / 404',
      passed,
      evidence: `HTTP Status: ${statusCode}, Response: ${JSON.stringify(body?.error)}`,
    });
    console.log(passed ? '✅ TEST 3 PASSED' : '❌ TEST 3 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 3: Unrelated Repository Ignored / 404', passed: false, evidence: err.message });
    console.log('❌ TEST 3 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 4 — Wrong Branch Ignored (No Deployment Created)
  // =========================================================================
  console.log('\n--- TEST 4: Wrong Branch Ignored ---');
  try {
    const payload = {
      ref: 'refs/heads/feature-experimental-branch',
      repository: { html_url: repoUrl },
      head_commit: { id: 'feature_branch_commit_999' },
    };

    const signature = computeSignature(payload, webhookSecret);
    const mock = mockWebhookRequest(payload, signature);
    await mock.execute();

    const statusCode = mock.getStatusCode();
    const body = mock.getBody();

    const wrongBranchDep = await Deployment.findOne({ commitHash: 'feature_branch_commit_999' });
    const passed = statusCode === 200 && body?.message?.includes('branch mismatch') && wrongBranchDep === null;

    results.push({
      name: 'TEST 4: Non-Production Branch Ignored',
      passed,
      evidence: `HTTP Status: ${statusCode}, Message: ${body?.message}, Deployment Created: ${wrongBranchDep !== null}`,
    });
    console.log(passed ? '✅ TEST 4 PASSED' : '❌ TEST 4 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 4: Non-Production Branch Ignored', passed: false, evidence: err.message });
    console.log('❌ TEST 4 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 5 — Valid Push End-to-End Execution
  // =========================================================================
  console.log('\n--- TEST 5: Valid Push End-to-End Container Lifecycle ---');
  let validPushDep: any;
  try {
    validPushDep = await Deployment.create({
      projectId: project._id,
      status: 'QUEUED',
      trigger: 'WEBHOOK',
      commitHash: 'c7d8e9f01234',
    });

    await processDeployJob(
      createMockJob<DeployJobData>({
        deploymentId: validPushDep._id.toString(),
        projectId: project._id.toString(),
        repositoryUrl: path.join(FIXTURES_DIR, 'webhook-test-app'),
        branch: 'master',
        trigger: 'WEBHOOK',
        queuedAt: new Date(Date.now() - 500).toISOString(),
      })
    );

    const updated = await Deployment.findById(validPushDep._id);
    const port = updated?.containerPort;

    const httpRes = await makeHttpReq(`http://localhost:${port}/`);
    const isRunning = updated?.status === 'RUNNING';
    const isWebhookTrigger = updated?.trigger === 'WEBHOOK';

    const passed = isRunning && isWebhookTrigger && httpRes.status === 200;
    results.push({
      name: 'TEST 5: Valid Push End-to-End Execution',
      passed,
      evidence: `Status: ${updated?.status}, Trigger: ${updated?.trigger}, Port: :${port}, HTTP: ${httpRes.status}`,
    });
    console.log(passed ? '✅ TEST 5 PASSED' : '❌ TEST 5 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 5: Valid Push End-to-End Execution', passed: false, evidence: err.message });
    console.log('❌ TEST 5 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 6 — Duplicate Webhook Delivery Deduplication
  // =========================================================================
  console.log('\n--- TEST 6: Duplicate Webhook Delivery Deduplication ---');
  try {
    const payload = {
      ref: 'refs/heads/main',
      after: 'dedup_commit_hash_112233',
      repository: { html_url: repoUrl },
      head_commit: { id: 'dedup_commit_hash_112233' },
    };

    const signature = computeSignature(payload, webhookSecret);

    // 1st delivery
    const mock1 = mockWebhookRequest(payload, signature);
    await mock1.execute();

    // 2nd duplicate delivery
    const mock2 = mockWebhookRequest(payload, signature);
    await mock2.execute();

    const secondBody = mock2.getBody();
    const count = await Deployment.countDocuments({ commitHash: 'dedup_commit_hash_112233' });

    const passed = count === 1 && secondBody?.message?.includes('Duplicate webhook');
    results.push({
      name: 'TEST 6: Duplicate Webhook Delivery Deduplication',
      passed,
      evidence: `Total deployments for commit: ${count} (expected: 1), 2nd response: ${secondBody?.message}`,
    });
    console.log(passed ? '✅ TEST 6 PASSED' : '❌ TEST 6 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 6: Duplicate Webhook Delivery Deduplication', passed: false, evidence: err.message });
    console.log('❌ TEST 6 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 7 — Auto Deploy OFF Setting
  // =========================================================================
  console.log('\n--- TEST 7: Auto Deploy OFF Setting ---');
  try {
    project.autoDeploy = false;
    await project.save();

    const payload = {
      ref: 'refs/heads/main',
      after: 'auto_deploy_off_commit_445566',
      repository: { html_url: repoUrl },
      head_commit: { id: 'auto_deploy_off_commit_445566' },
    };

    const signature = computeSignature(payload, webhookSecret);
    const mock = mockWebhookRequest(payload, signature);
    await mock.execute();

    const body = mock.getBody();
    const createdDep = await Deployment.findOne({ commitHash: 'auto_deploy_off_commit_445566' });

    const passed = body?.message?.includes('Auto-deploy is disabled') && createdDep === null;
    results.push({
      name: 'TEST 7: Auto Deploy OFF Setting Disables Automatic Webhook Build',
      passed,
      evidence: `Response: ${body?.message}, Deployment Created: ${createdDep !== null}`,
    });
    console.log(passed ? '✅ TEST 7 PASSED' : '❌ TEST 7 FAILED');

    // Restore autoDeploy to true
    project.autoDeploy = true;
    await project.save();
  } catch (err: any) {
    results.push({ name: 'TEST 7: Auto Deploy OFF Setting Disables Automatic Webhook Build', passed: false, evidence: err.message });
    console.log('❌ TEST 7 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 8 — Stale Deployment Reconciliation
  // =========================================================================
  console.log('\n--- TEST 8: Stale Deployment Reconciliation ---');
  try {
    // Create a stuck deployment simulated 10 minutes ago
    const staleDeployment = await Deployment.create({
      projectId: project._id,
      status: 'BUILDING',
      trigger: 'MANUAL',
      startedAt: new Date(Date.now() - 600000),
      lastHeartbeatAt: new Date(Date.now() - 600000),
    });

    // Run reconciliation with 5 min threshold
    const reconResult = await ReconciliationService.reconcileStaleDeployments(300000);
    const recoveredDep = await Deployment.findById(staleDeployment._id);

    const isRecovered =
      recoveredDep?.status === 'FAILED' &&
      recoveredDep?.error?.includes('reconciliation') &&
      reconResult.recoveredDeploymentIds.includes(staleDeployment._id.toString());

    const passed = isRecovered;
    results.push({
      name: 'TEST 8: Stale Deployment Auto-Reconciliation',
      passed,
      evidence: `Recovered Count: ${reconResult.reconciledCount}, New Status: ${recoveredDep?.status}, Error: "${recoveredDep?.error}"`,
    });
    console.log(passed ? '✅ TEST 8 PASSED' : '❌ TEST 8 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 8: Stale Deployment Auto-Reconciliation', passed: false, evidence: err.message });
    console.log('❌ TEST 8 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 9 — Prometheus /metrics Endpoint
  // =========================================================================
  console.log('\n--- TEST 9: Prometheus /metrics Endpoint ---');
  try {
    const metricsOutput = await getPrometheusMetrics();

    const hasDeploymentsTotal = metricsOutput.includes('deployhub_deployments_total');
    const hasSuccessTotal = metricsOutput.includes('deployhub_deployments_success_total');
    const hasRunningContainers = metricsOutput.includes('deployhub_running_containers');
    const hasDurationSeconds = metricsOutput.includes('deployhub_deployment_duration_seconds');
    const hasActiveDeployments = metricsOutput.includes('deployhub_active_deployments');

    const passed =
      hasDeploymentsTotal &&
      hasSuccessTotal &&
      hasRunningContainers &&
      hasDurationSeconds &&
      hasActiveDeployments;

    results.push({
      name: 'TEST 9: Prometheus Metrics Exposition (/metrics format)',
      passed,
      evidence: `Contains total (${hasDeploymentsTotal}), success (${hasSuccessTotal}), containers (${hasRunningContainers}), duration (${hasDurationSeconds}), active (${hasActiveDeployments})`,
    });
    console.log(passed ? '✅ TEST 9 PASSED' : '❌ TEST 9 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 9: Prometheus Metrics Exposition', passed: false, evidence: err.message });
    console.log('❌ TEST 9 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 10 — Deployment Performance Timings Verification
  // =========================================================================
  console.log('\n--- TEST 10: Deployment Performance Timings Breakdown ---');
  try {
    const finishedDep = await Deployment.findById(validPushDep._id);
    const timings = finishedDep?.timings;

    const hasBuildDuration = Boolean(timings && timings.buildDurationMs > 0);
    const hasContainerStartup = Boolean(timings && timings.containerStartupDurationMs > 0);
    const hasTotalDuration = Boolean(timings && timings.totalDurationMs > 0);

    const passed = hasBuildDuration && hasContainerStartup && hasTotalDuration;
    results.push({
      name: 'TEST 10: Detailed Deployment Timings & Latency Breakdown',
      passed,
      evidence: `Build: ${timings?.buildDurationMs}ms, Startup: ${timings?.containerStartupDurationMs}ms, Health: ${timings?.healthCheckDurationMs}ms, Total: ${timings?.totalDurationMs}ms`,
    });
    console.log(passed ? '✅ TEST 10 PASSED' : '❌ TEST 10 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 10: Detailed Deployment Timings & Latency Breakdown', passed: false, evidence: err.message });
    console.log('❌ TEST 10 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 11 — Prometheus & Grafana Provisioning Files Verification
  // =========================================================================
  console.log('\n--- TEST 11: Prometheus & Grafana Provisioning Files Verification ---');
  try {
    const promYmlExists = (await fs.stat(path.resolve(__dirname, '../infrastructure/prometheus/prometheus.yml'))).isFile();
    const grafanaDatasourceExists = (await fs.stat(path.resolve(__dirname, '../infrastructure/grafana/provisioning/datasources/prometheus.yml'))).isFile();
    const grafanaDashboardJsonExists = (await fs.stat(path.resolve(__dirname, '../infrastructure/grafana/dashboards/deployhub-overview.json'))).isFile();

    const rawDashboard = await fs.readFile(path.resolve(__dirname, '../infrastructure/grafana/dashboards/deployhub-overview.json'), 'utf8');
    const parsedDashboard = JSON.parse(rawDashboard);
    const hasPanels = parsedDashboard.panels && parsedDashboard.panels.length >= 8;

    const passed = promYmlExists && grafanaDatasourceExists && grafanaDashboardJsonExists && hasPanels;
    results.push({
      name: 'TEST 11: Grafana & Prometheus Provisioning Architecture',
      passed,
      evidence: `Prometheus Config: ${promYmlExists}, Grafana Datasource: ${grafanaDatasourceExists}, Dashboard Panels: ${parsedDashboard.panels?.length}`,
    });
    console.log(passed ? '✅ TEST 11 PASSED' : '❌ TEST 11 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 11: Grafana & Prometheus Provisioning Architecture', passed: false, evidence: err.message });
    console.log('❌ TEST 11 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 12 — Milestone 1 Core Deployment Engine Regression
  // =========================================================================
  console.log('\n--- TEST 12: Milestone 1 Deployment Engine Regression ---');
  try {
    const m1Dep = await Deployment.create({
      projectId: project._id,
      status: 'QUEUED',
      trigger: 'MANUAL',
    });

    await processDeployJob(
      createMockJob<DeployJobData>({
        deploymentId: m1Dep._id.toString(),
        projectId: project._id.toString(),
        repositoryUrl: path.join(FIXTURES_DIR, 'webhook-test-app'),
        branch: 'master',
        trigger: 'MANUAL',
      })
    );

    const checkM1 = await Deployment.findById(m1Dep._id);
    const passed = checkM1?.status === 'RUNNING' && checkM1?.containerPort > 0;

    results.push({
      name: 'TEST 12: Milestone 1 Core Deployment Engine Regression',
      passed,
      evidence: `Status: ${checkM1?.status}, Container Port: :${checkM1?.containerPort}`,
    });
    console.log(passed ? '✅ TEST 12 PASSED' : '❌ TEST 12 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 12: Milestone 1 Core Deployment Engine Regression', passed: false, evidence: err.message });
    console.log('❌ TEST 12 FAILED:', err.message);
  }

  // =========================================================================
  // TEST 13 — Milestone 2 GitHub / Manual & Secret Masking Regression
  // =========================================================================
  console.log('\n--- TEST 13: Milestone 2 Developer Workflow & Secrets Regression ---');
  try {
    const m2Dep = await Deployment.create({
      projectId: project._id,
      status: 'QUEUED',
      trigger: 'MANUAL',
    });

    await processDeployJob(
      createMockJob<DeployJobData>({
        deploymentId: m2Dep._id.toString(),
        projectId: project._id.toString(),
        repositoryUrl: path.join(FIXTURES_DIR, 'webhook-test-app'),
        branch: 'master',
        trigger: 'MANUAL',
        envVars: {
          REGRESSION_TEST_KEY: 'reg_val_123',
          TOP_SECRET_PASSPHRASE: 'secret_jwt_payload_987654321',
        },
      })
    );

    const checkM2 = await Deployment.findById(m2Dep._id);
    const logsJoined = (checkM2?.logs || []).join('\n');
    const secretExposed = logsJoined.includes('secret_jwt_payload_987654321');

    const passed = checkM2?.status === 'RUNNING' && !secretExposed;
    results.push({
      name: 'TEST 13: Milestone 2 Developer Workflow & Secrets Masking Regression',
      passed,
      evidence: `Status: ${checkM2?.status}, Secret exposed in build logs: ${secretExposed}`,
    });
    console.log(passed ? '✅ TEST 13 PASSED' : '❌ TEST 13 FAILED');
  } catch (err: any) {
    results.push({ name: 'TEST 13: Milestone 2 Developer Workflow & Secrets Masking Regression', passed: false, evidence: err.message });
    console.log('❌ TEST 13 FAILED:', err.message);
  }

  // ── Clean up stopped test containers ───────────────────────────────────────
  try {
    if (validPushDep) {
      await processStopJob(createMockJob({ deploymentId: validPushDep._id.toString(), projectId: project._id.toString() }));
    }
  } catch {}

  // ── Print Final Summary Table ─────────────────────────────────────────────
  console.log('\n========================================================================================');
  console.log('🏁 MILESTONE 3 TEST MATRIX SUMMARY');
  console.log('========================================================================================');
  console.table(
    results.map((r) => ({
      Test: r.name,
      Result: r.passed ? 'PASS' : 'FAIL',
      Evidence: r.evidence,
    }))
  );

  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? '\n🎉 ALL 13 MILESTONE 3 TESTS PASSED!' : '\n❌ SOME MILESTONE 3 TESTS FAILED!');

  await mongoose.disconnect();
  try {
    const { PortManager } = await import('../apps/worker/src/services/port-manager.service');
    PortManager.getRedis().disconnect();
  } catch {}

  process.exit(allPassed ? 0 : 1);
}

runMilestone3Tests().catch((err) => {
  console.error('Test runner failure:', err);
  process.exit(1);
});
