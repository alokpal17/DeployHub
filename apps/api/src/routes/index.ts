import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import * as authController from '../controllers/auth.controller';
import * as projectsController from '../controllers/projects.controller';
import * as envController from '../controllers/env.controller';
import * as deploymentsController from '../controllers/deployments.controller';
import * as githubController from '../controllers/github.controller';
import * as webhookController from '../controllers/webhook.controller';
import { getPrometheusMetrics } from '../services/metrics.service';
import { ContainerMonitorService } from '../services/container-monitor.service';
import { ProxyService } from '../services/proxy.service';

const router = Router();

// ─── Prometheus Metrics ───────────────────────────────────────────────────────
router.get('/metrics', async (_req, res) => {
  try {
    const metrics = await getPrometheusMetrics();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics);
  } catch (err: any) {
    res.status(500).send(`Error collecting metrics: ${err.message}`);
  }
});

// ─── GitHub Webhook Receiver ──────────────────────────────────────────────────
router.post('/webhooks/github', webhookController.handleGitHubWebhook);

// ─── Auth ─────────────────────────────────────────────────────────────────────
router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);
router.get('/auth/me', authMiddleware, authController.getMe);

// ─── GitHub Integration ───────────────────────────────────────────────────────
router.get('/github/status', authMiddleware, githubController.getStatus);
router.post('/github/connect', authMiddleware, githubController.connect);
router.post('/github/disconnect', authMiddleware, githubController.disconnect);
router.get('/github/repos', authMiddleware, githubController.getRepositories);
router.get('/github/repos/:owner/:repo/branches', authMiddleware, githubController.getBranches);

// ─── Projects ─────────────────────────────────────────────────────────────────
router.get('/projects', authMiddleware, projectsController.getProjects);
router.get('/projects/:id', authMiddleware, projectsController.getProject);
router.post('/projects', authMiddleware, projectsController.createProject);
router.put('/projects/:id', authMiddleware, projectsController.updateProject);
router.post('/projects/:id/rotate-webhook-secret', authMiddleware, projectsController.rotateWebhookSecret);
router.delete('/projects/:id', authMiddleware, projectsController.deleteProject);

// ─── Project Resources & Monitoring (M4) ──────────────────────────────────────
router.get('/projects/:projectId/resources', authMiddleware, async (req, res) => {
  try {
    const stats = await ContainerMonitorService.getProjectContainerStats(req.params.projectId);
    if (!stats) {
      res.json({ success: true, data: null, message: 'No active container currently running' });
      return;
    }
    res.json({ success: true, data: stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch resource stats' });
  }
});

// ─── Project Environment Variables ────────────────────────────────────────────
router.get('/projects/:id/env', authMiddleware, envController.getEnvVars);
router.post('/projects/:id/env', authMiddleware, envController.setEnvVars);
router.put('/projects/:id/env/:key', authMiddleware, envController.updateEnvVar);
router.delete('/projects/:id/env/:key', authMiddleware, envController.deleteEnvVar);

// ─── Project Deployments ──────────────────────────────────────────────────────
router.get('/projects/:projectId/deployments', authMiddleware, deploymentsController.getDeployments);
router.post('/projects/:projectId/deployments', authMiddleware, deploymentsController.triggerDeployment);
router.get('/projects/:projectId/active-deployment', authMiddleware, deploymentsController.getActiveDeployment);
router.post('/projects/:projectId/rollback/:targetDeploymentId', authMiddleware, deploymentsController.rollbackDeployment);
router.post('/projects/:projectId/rollback', authMiddleware, deploymentsController.rollbackDeployment);
router.get('/projects/:projectId/deployments/:deploymentId', authMiddleware, deploymentsController.getDeployment);
router.post('/projects/:projectId/deployments/:deploymentId/redeploy', authMiddleware, deploymentsController.redeploy);
router.get('/projects/:projectId/deployments/:deploymentId/logs', authMiddleware, deploymentsController.getDeploymentLogs);
router.get('/projects/:projectId/deployments/:deploymentId/logs/stream', deploymentsController.streamDeploymentLogs);
router.post('/projects/:projectId/deployments/:deploymentId/stop', authMiddleware, deploymentsController.stopDeployment);

// ─── Direct Deployment Routes (Phase 8 & M4) ──────────────────────────────────
router.get('/deployments/:id', authMiddleware, deploymentsController.getDeployment);
router.post('/deployments/:id/redeploy', authMiddleware, deploymentsController.redeploy);
router.post('/deployments/:id/rollback', authMiddleware, deploymentsController.rollbackDeployment);
router.get('/deployments/:id/logs', authMiddleware, deploymentsController.getDeploymentLogs);
router.get('/deployments/:id/logs/stream', deploymentsController.streamDeploymentLogs);
router.post('/deployments/:id/stop', authMiddleware, deploymentsController.stopDeployment);

// ─── Project Proxy Routing ───────────────────────────────────────────────────
router.all('/proxy/:projectId/*', (req, res) => {
  ProxyService.handleProxyRequest(req, res, req.params.projectId);
});
router.all('/proxy/:projectId', (req, res) => {
  ProxyService.handleProxyRequest(req, res, req.params.projectId);
});

// ─── Health ───────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;

