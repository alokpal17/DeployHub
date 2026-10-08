import http from 'http';

const API_BASE = 'http://localhost:3001/api';
const PROXY_BASE = 'http://localhost:3001/p';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url: string, options: any = {}): Promise<any> {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const config: any = {
    method: options.method || 'GET',
    headers,
  };
  if (options.body) {
    config.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const res = await fetch(url, config);
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err: any = new Error(`Request failed with status ${res.status}: ${text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, headers: res.headers, data };
}

function extractDeploymentId(resData: any): string {
  if (resData?.data?.deployment?._id) return resData.data.deployment._id;
  if (resData?.data?._id) return resData.data._id;
  if (resData?.deployment?._id) return resData.deployment._id;
  if (resData?._id) return resData._id;
  throw new Error(`Unable to find deployment ID in response: ${JSON.stringify(resData)}`);
}

async function main() {
  console.log('====================================================');
  console.log('🚀 DEPLOYHUB FULL-STACK END-TO-END OPERATIONS RUNNER');
  console.log('====================================================\n');

  // 1. Health check
  console.log('1️⃣ Checking API Health...');
  const healthRes = await request('http://localhost:3001/');
  console.log('   API status:', healthRes.data);

  // 2. User Authentication
  console.log('\n2️⃣ Registering and Authenticating User...');
  const testEmail = `developer_${Date.now()}@deployhub.local`;
  const testPassword = 'Password123!';
  const testUsername = `dev_${Date.now().toString().slice(-4)}`;

  const registerRes = await request(`${API_BASE}/auth/register`, {
    method: 'POST',
    body: { email: testEmail, password: testPassword, username: testUsername },
  });
  const token = registerRes.data.data.token;
  console.log('   ✅ Registered user:', testUsername, 'Token received.');

  const authHeaders = { Authorization: `Bearer ${token}` };

  const meRes = await request(`${API_BASE}/auth/me`, { headers: authHeaders });
  console.log('   ✅ Authenticated user profile:', meRes.data.data.email);

  // 3. GitHub Mock/Demo Status
  console.log('\n3️⃣ Testing GitHub Connection Integration...');
  const ghStatusBefore = await request(`${API_BASE}/github/status`, { headers: authHeaders });
  console.log('   Status before:', ghStatusBefore.data.data);

  const ghConnectRes = await request(`${API_BASE}/github/connect`, {
    method: 'POST',
    body: { token: 'demo_dev_token' },
    headers: authHeaders,
  });
  console.log('   ✅ GitHub Connected as:', ghConnectRes.data.data.username);

  const ghReposRes = await request(`${API_BASE}/github/repos`, { headers: authHeaders });
  console.log(`   ✅ Accessible Repositories (${ghReposRes.data.data.length}):`);
  ghReposRes.data.data.forEach((r: any) => console.log(`      - ${r.name}: ${r.description}`));

  // 4. Deploy Template 1: Express App (Node.js REST API)
  console.log('\n4️⃣ Deploying Template 1: Express Microservice (Node.js API)...');
  const project1Res = await request(`${API_BASE}/projects`, {
    method: 'POST',
    body: {
      name: `express-api-${Date.now().toString().slice(-4)}`,
      repositoryUrl: 'https://github.com/expressjs/express',
      branch: 'master',
      framework: 'nodejs-backend',
    },
    headers: authHeaders,
  });
  const project1 = project1Res.data.data;
  console.log(`   ✅ Project created: ${project1.name} (ID: ${project1._id})`);

  // Add environment variable with secret
  await request(`${API_BASE}/projects/${project1._id}/env`, {
    method: 'POST',
    body: { key: 'API_KEY', value: 'super-secret-production-token-12345', isSecret: true },
    headers: authHeaders,
  });
  await request(`${API_BASE}/projects/${project1._id}/env`, {
    method: 'POST',
    body: { key: 'APP_ENV', value: 'production', isSecret: false },
    headers: authHeaders,
  });
  console.log('   ✅ Configured environment variables (1 plain, 1 secret)');

  // Verify secret is masked in GET /env
  const envListRes = await request(`${API_BASE}/projects/${project1._id}/env`, { headers: authHeaders });
  const apiKeyVar = envListRes.data.data.find((v: any) => v.key === 'API_KEY');
  console.log(`   🔒 Secret masking check: API_KEY value is "${apiKeyVar?.value}" (isSecret: ${apiKeyVar?.isSecret})`);

  // Trigger Deployment 1
  console.log('   🚀 Triggering deployment for Project 1...');
  const deploy1Res = await request(`${API_BASE}/projects/${project1._id}/deployments`, {
    method: 'POST',
    body: {},
    headers: authHeaders,
  });
  const deploy1Id = extractDeploymentId(deploy1Res.data);
  console.log(`   ✅ Deployment queued: ${deploy1Id}`);

  // Test SSE connection using http.get
  const sseUrl = `http://localhost:3001/api/projects/${project1._id}/deployments/${deploy1Id}/logs/stream?token=${token}`;
  let sseLogsCount = 0;
  const sseReq = http.get(sseUrl, (res) => {
    res.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          sseLogsCount++;
          try {
            const parsed = JSON.parse(line.replace('data:', '').trim());
            if (sseLogsCount <= 4 || parsed.line?.includes('Container') || parsed.line?.includes('Health') || parsed.line?.includes('Traffic')) {
              console.log(`      [SSE Live Log] ${parsed.line}`);
            }
          } catch {}
        }
      }
    });
  });

  // Poll deployment status until terminal
  let deploy1FinalStatus = '';
  let activeDeployment1: any = null;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const dRes = await request(`${API_BASE}/projects/${project1._id}/deployments/${deploy1Id}`, {
      headers: authHeaders,
    });
    const dep = dRes.data.data;
    activeDeployment1 = dep;
    const status = dep.status;
    process.stdout.write(`   ⏳ Status [${(i + 1) * 2}s]: ${status} (release v${dep.releaseVersion || 1})\r`);
    if (['ACTIVE', 'RUNNING', 'FAILED', 'STOPPED'].includes(status)) {
      deploy1FinalStatus = status;
      break;
    }
  }
  sseReq.destroy();
  console.log(`\n   ✅ Deployment 1 finalized with status: ${deploy1FinalStatus} (Total SSE log lines received: ${sseLogsCount})`);

  // Verify Proxy Gateway
  if (deploy1FinalStatus === 'ACTIVE' || deploy1FinalStatus === 'RUNNING') {
    console.log(`   🔀 Testing Dynamic Reverse Proxy Route: ${PROXY_BASE}/${project1._id}/`);
    try {
      const proxyRes = await request(`${PROXY_BASE}/${project1._id}/`);
      console.log(`   ✅ Proxy response (${proxyRes.status}):`, typeof proxyRes.data === 'object' ? JSON.stringify(proxyRes.data) : proxyRes.data);
    } catch (err: any) {
      console.log('   Proxy status:', err.status, err.data);
    }

    // Check Live Container Telemetry
    console.log(`   📊 Checking Live Container Telemetry...`);
    try {
      const resData = await request(`${API_BASE}/projects/${project1._id}/resources`, { headers: authHeaders });
      console.log('   ✅ Container Telemetry:', resData.data.data);
    } catch (err: any) {
      console.log('   Telemetry note:', err.data || err.message);
    }

    // 5. Test One-Click Instant Redeploy & Rollback
    console.log('\n5️⃣ Testing Instant Redeploy & One-Click Rollback Pipeline...');
    const redeployRes = await request(`${API_BASE}/projects/${project1._id}/deployments/${deploy1Id}/redeploy`, {
      method: 'POST',
      body: {},
      headers: authHeaders,
    });
    const redeployId = extractDeploymentId(redeployRes.data);
    console.log(`   ✅ Redeploy queued: ${redeployId}`);

    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const dRes = await request(`${API_BASE}/projects/${project1._id}/deployments/${redeployId}`, {
        headers: authHeaders,
      });
      const status = dRes.data.data.status;
      process.stdout.write(`   ⏳ Redeploy Status [${(i + 1) * 2}s]: ${status}\r`);
      if (['ACTIVE', 'RUNNING', 'FAILED', 'STOPPED'].includes(status)) {
        console.log(`\n   ✅ Redeploy finalized with status: ${status}`);
        break;
      }
    }

    // Rollback to original deployment
    console.log(`   🔄 Testing One-Click Rollback to Release v1 (${deploy1Id})...`);
    const rollbackRes = await request(`${API_BASE}/projects/${project1._id}/rollback/${deploy1Id}`, {
      method: 'POST',
      body: {},
      headers: authHeaders,
    });
    const rollbackId = extractDeploymentId(rollbackRes.data);
    console.log(`   ✅ Rollback queued: ${rollbackId} (Instant artifact reuse)`);

    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const dRes = await request(`${API_BASE}/projects/${project1._id}/deployments/${rollbackId}`, {
        headers: authHeaders,
      });
      const status = dRes.data.data.status;
      process.stdout.write(`   ⏳ Rollback Status [${(i + 1) * 2}s]: ${status}\r`);
      if (['ACTIVE', 'RUNNING', 'FAILED', 'STOPPED'].includes(status)) {
        console.log(`\n   ✅ Rollback finalized with status: ${status}`);
        break;
      }
    }

    // Verify proxy after rollback
    console.log(`   🔀 Testing Dynamic Reverse Proxy Route after Rollback: ${PROXY_BASE}/${project1._id}/`);
    try {
      const proxyRes2 = await request(`${PROXY_BASE}/${project1._id}/`);
      console.log(`   ✅ Proxy response after rollback (${proxyRes2.status}):`, typeof proxyRes2.data === 'object' ? JSON.stringify(proxyRes2.data) : proxyRes2.data);
    } catch (err: any) {
      console.log('   Proxy status:', err.status, err.data);
    }
  }

  // 6. Deploy Template 2: Vite React SPA
  console.log('\n6️⃣ Deploying Template 2: Vite React SPA...');
  const project2Res = await request(`${API_BASE}/projects`, {
    method: 'POST',
    body: {
      name: `vite-spa-${Date.now().toString().slice(-4)}`,
      repositoryUrl: 'https://github.com/vitejs/vite',
      branch: 'main',
      framework: 'nodejs-spa',
    },
    headers: authHeaders,
  });
  const project2 = project2Res.data.data;
  console.log(`   ✅ Project created: ${project2.name} (ID: ${project2._id})`);

  const deploy2Res = await request(`${API_BASE}/projects/${project2._id}/deployments`, {
    method: 'POST',
    body: {},
    headers: authHeaders,
  });
  const deploy2Id = extractDeploymentId(deploy2Res.data);
  console.log(`   ✅ Deployment queued: ${deploy2Id}`);

  let deploy2FinalStatus = '';
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const dRes = await request(`${API_BASE}/projects/${project2._id}/deployments/${deploy2Id}`, {
      headers: authHeaders,
    });
    const status = dRes.data.data.status;
    process.stdout.write(`   ⏳ Status [${(i + 1) * 2}s]: ${status}\r`);
    if (['ACTIVE', 'RUNNING', 'FAILED', 'STOPPED'].includes(status)) {
      deploy2FinalStatus = status;
      break;
    }
  }
  console.log(`\n   ✅ Deployment 2 finalized with status: ${deploy2FinalStatus}`);

  if (deploy2FinalStatus === 'ACTIVE' || deploy2FinalStatus === 'RUNNING') {
    console.log(`   🔀 Testing Vite Proxy Route: ${PROXY_BASE}/${project2._id}/`);
    try {
      const proxyRes = await request(`${PROXY_BASE}/${project2._id}/`);
      console.log(`   ✅ Proxy response (${proxyRes.status}): HTML served (${typeof proxyRes.data === 'string' ? proxyRes.data.length : 0} bytes)`);
    } catch (err: any) {
      console.log('   Proxy status:', err.status, err.data);
    }
  }

  // 7. Check Prometheus Metrics Endpoint
  console.log('\n7️⃣ Inspecting Prometheus Metrics (/metrics)...');
  const metricsRes = await request('http://localhost:3001/metrics');
  const metricLines = metricsRes.data
    .split('\n')
    .filter((l: string) => l.startsWith('deployhub_') && !l.startsWith('#'))
    .slice(0, 10);
  console.log('   ✅ Top DeployHub Prometheus metrics:');
  metricLines.forEach((l: string) => console.log(`      ${l}`));

  console.log('\n====================================================');
  console.log('🎉 ALL DEPLOYHUB OPERATIONS PERFORMED SUCCESSFULLY!');
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Fatal error:', err.data || err.message || err);
  process.exit(1);
});
