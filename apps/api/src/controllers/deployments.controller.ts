import { Response, Request } from 'express';
import Redis from 'ioredis';
import { ProjectModel, DeploymentModel, ProjectDoc, DeploymentDoc } from '../models';
import { deployQueue } from '../config/queue';
import { AuthRequest } from '../middleware/auth';
import { config } from '../config';
import jwt from 'jsonwebtoken';

/**
 * Helper to verify project ownership for a deployment
 */
async function verifyDeploymentOwnership(
  deploymentId: string,
  userId?: string
): Promise<{ deployment: DeploymentDoc; project: ProjectDoc } | null> {
  if (!userId) return null;
  const deployment = await DeploymentModel.findById(deploymentId);
  if (!deployment) return null;

  const project = await ProjectModel.findOne({ _id: deployment.projectId, userId });
  if (!project) return null;

  return { deployment, project };
}

// GET /api/projects/:projectId/deployments
export async function getDeployments(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const rawDeployments = await DeploymentModel.find({ projectId: req.params.projectId })
      .select('-logs')
      .sort({ startedAt: -1 })
      .limit(50);

    const deployments = rawDeployments.map((d: any) => {
      const obj = d.toObject();
      if (d.finishedAt && d.startedAt) {
        (obj as any).durationMs = new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime();
      }
      return obj;
    });

    res.json({ success: true, data: deployments });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch deployments' });
  }
}

// GET /api/projects/:projectId/active-deployment
export async function getActiveDeployment(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    let activeDep = null;
    if (project.activeDeploymentId) {
      activeDep = await DeploymentModel.findById(project.activeDeploymentId).select('-logs');
    }

    if (!activeDep) {
      activeDep = await DeploymentModel.findOne({
        projectId: project._id,
        status: { $in: ['RUNNING', 'ACTIVE'] },
      })
        .select('-logs')
        .sort({ startedAt: -1 });
    }

    res.json({
      success: true,
      data: activeDep ? activeDep.toObject() : null,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to fetch active deployment' });
  }
}

// GET /api/deployments/:deploymentId or GET /api/projects/:projectId/deployments/:deploymentId
export async function getDeployment(req: AuthRequest, res: Response): Promise<void> {
  try {
    const deploymentId = req.params.deploymentId || req.params.id;
    const authData = await verifyDeploymentOwnership(deploymentId, req.userId);

    if (!authData) {
      res.status(404).json({ success: false, error: 'Deployment not found' });
      return;
    }

    const { deployment } = authData;
    const obj = deployment.toObject();
    if (deployment.finishedAt && deployment.startedAt) {
      (obj as any).durationMs = new Date(deployment.finishedAt).getTime() - new Date(deployment.startedAt).getTime();
    }

    res.json({ success: true, data: obj });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch deployment' });
  }
}

// POST /api/projects/:projectId/deployments  → triggers a new deployment
export async function triggerDeployment(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.projectId, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    // Check project settings: allowManualDeploy
    if (project.allowManualDeploy === false) {
      res.status(403).json({
        success: false,
        error: 'Manual deployments are disabled for this project in deployment trigger settings',
      });
      return;
    }

    // Convert project envVars to key-value record for worker
    const envVarsMap: Record<string, string> = {};
    if (project.envVars && project.envVars.length > 0) {
      for (const ev of project.envVars) {
        if (ev.key) {
          envVarsMap[ev.key] = ev.value;
        }
      }
    }

    const targetBranch = req.body.branch || project.productionBranch || project.branch || 'main';

    // Create deployment record first
    const deployment = await DeploymentModel.create({
      projectId: project._id,
      status: 'QUEUED',
      trigger: req.body.trigger || 'MANUAL',
      commitHash: req.body.commitHash || '',
      queuedAt: new Date(),
    });

    // Push job to BullMQ queue — API returns immediately
    await deployQueue.add(
      'deploy',
      {
        deploymentId: deployment._id.toString(),
        projectId: project._id.toString(),
        repositoryUrl: project.repositoryUrl,
        branch: targetBranch,
        commitHash: req.body.commitHash,
        trigger: (req.body.trigger as any) || 'MANUAL',
        envVars: envVarsMap,
        queuedAt: new Date().toISOString(),
      },
      { jobId: deployment._id.toString() }
    );

    console.log(`📦 Manual Deployment ${deployment._id} queued for project ${project.name}`);

    res.status(202).json({
      success: true,
      data: {
        deployment,
        message: 'Deployment queued. Worker will pick it up shortly.',
      },
    });
  } catch (err) {
    console.error('Failed to trigger deployment:', err);
    res.status(500).json({ success: false, error: 'Failed to trigger deployment' });
  }
}

// POST /api/deployments/:id/redeploy or POST /api/projects/:projectId/deployments/:deploymentId/redeploy
export async function redeploy(req: AuthRequest, res: Response): Promise<void> {
  try {
    const deploymentId = req.params.deploymentId || req.params.id;
    const authData = await verifyDeploymentOwnership(deploymentId, req.userId);

    if (!authData) {
      res.status(404).json({ success: false, error: 'Deployment not found' });
      return;
    }

    const { project } = authData;

    // Convert latest project envVars to key-value record
    const envVarsMap: Record<string, string> = {};
    if (project.envVars && project.envVars.length > 0) {
      for (const ev of project.envVars) {
        if (ev.key) {
          envVarsMap[ev.key] = ev.value;
        }
      }
    }

    const targetBranch = project.productionBranch || project.branch || 'main';

    // Create a NEW deployment record (never mutate old deployment)
    const newDeployment = await DeploymentModel.create({
      projectId: project._id,
      status: 'QUEUED',
      trigger: 'RETRY',
      commitHash: req.body.commitHash || '',
      queuedAt: new Date(),
    });

    await deployQueue.add(
      'deploy',
      {
        deploymentId: newDeployment._id.toString(),
        projectId: project._id.toString(),
        repositoryUrl: project.repositoryUrl,
        branch: targetBranch,
        commitHash: req.body.commitHash,
        trigger: 'RETRY',
        envVars: envVarsMap,
        queuedAt: new Date().toISOString(),
      },
      { jobId: newDeployment._id.toString() }
    );

    console.log(`🔄 Redeployment ${newDeployment._id} queued for project ${project.name}`);

    res.status(202).json({
      success: true,
      data: {
        deployment: newDeployment,
        message: 'Redeployment queued. Worker will build latest commit with current environment variables.',
      },
    });
  } catch (err) {
    console.error('Failed to redeploy:', err);
    res.status(500).json({ success: false, error: 'Failed to queue redeploy' });
  }
}

// POST /api/projects/:projectId/rollback/:targetDeploymentId or POST /api/deployments/:id/rollback
export async function rollbackDeployment(req: AuthRequest, res: Response): Promise<void> {
  try {
    const targetDeploymentId = req.params.targetDeploymentId || req.params.id || req.body.targetDeploymentId;
    const projectId = req.params.projectId;

    if (!targetDeploymentId) {
      res.status(400).json({ success: false, error: 'targetDeploymentId is required' });
      return;
    }

    // Verify ownership of project
    let project = null;
    if (projectId) {
      project = await ProjectModel.findOne({ _id: projectId, userId: req.userId });
    }

    const targetDep = await DeploymentModel.findById(targetDeploymentId);
    if (!targetDep) {
      res.status(404).json({ success: false, error: 'Target rollback deployment not found' });
      return;
    }

    if (!project) {
      project = await ProjectModel.findOne({ _id: targetDep.projectId, userId: req.userId });
    }

    if (!project) {
      res.status(403).json({ success: false, error: 'Unauthorized to rollback this project' });
      return;
    }

    // Verify target deployment has an image artifact
    if (!targetDep.imageName) {
      res.status(400).json({
        success: false,
        error: 'Cannot rollback to this deployment: no valid image artifact exists.',
      });
      return;
    }

    // Build env vars
    const envVarsMap: Record<string, string> = {};
    if (project.envVars && project.envVars.length > 0) {
      for (const ev of project.envVars) {
        if (ev.key) {
          envVarsMap[ev.key] = ev.value;
        }
      }
    }

    // Create rollback deployment record
    const rollbackDeployment = await DeploymentModel.create({
      projectId: project._id,
      status: 'QUEUED',
      trigger: 'ROLLBACK',
      isRollback: true,
      rollbackToDeploymentId: targetDep._id,
      commitHash: targetDep.commitHash,
      commitAuthor: targetDep.commitAuthor,
      commitMessage: `Rollback to deployment ${targetDep._id} (commit ${targetDep.commitHash.slice(0, 7)})`,
      imageName: targetDep.imageName,
      projectType: targetDep.projectType,
      queuedAt: new Date(),
    });

    // Enqueue deploy job with isRollback flag
    await deployQueue.add(
      'deploy',
      {
        deploymentId: rollbackDeployment._id.toString(),
        projectId: project._id.toString(),
        repositoryUrl: project.repositoryUrl,
        branch: project.productionBranch || project.branch || 'main',
        commitHash: targetDep.commitHash,
        trigger: 'ROLLBACK',
        isRollback: true,
        rollbackToDeploymentId: targetDep._id.toString(),
        imageName: targetDep.imageName,
        envVars: envVarsMap,
        queuedAt: new Date().toISOString(),
      },
      { jobId: rollbackDeployment._id.toString() }
    );

    console.log(`🔄 Rollback deployment ${rollbackDeployment._id} queued for project ${project.name} (target: ${targetDep._id})`);

    res.status(202).json({
      success: true,
      data: {
        deployment: rollbackDeployment,
        message: `Rollback to release ${targetDep.releaseVersion || targetDep._id} queued. Zero-downtime switch will occur once health check passes.`,
      },
    });
  } catch (err: any) {
    console.error('Failed to execute rollback:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to trigger rollback' });
  }
}

// GET /api/deployments/:id/logs or GET /api/projects/:projectId/deployments/:deploymentId/logs
export async function getDeploymentLogs(req: AuthRequest, res: Response): Promise<void> {
  try {
    const deploymentId = req.params.deploymentId || req.params.id;
    const authData = await verifyDeploymentOwnership(deploymentId, req.userId);

    if (!authData) {
      res.status(404).json({ success: false, error: 'Deployment not found' });
      return;
    }

    const { deployment } = authData;
    res.json({
      success: true,
      data: {
        logs: deployment.logs,
        status: deployment.status,
        error: deployment.error,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
}

// GET /api/deployments/:id/logs/stream or GET /api/projects/:projectId/deployments/:deploymentId/logs/stream (SSE)
export async function streamDeploymentLogs(req: Request, res: Response): Promise<void> {
  try {
    const deploymentId = req.params.deploymentId || req.params.id;

    // Verify token from query or Authorization header
    let token = req.query.token as string | undefined;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      res.status(401).json({ success: false, error: 'Missing authentication token' });
      return;
    }

    let userId: string;
    try {
      const decoded: any = jwt.verify(token, config.jwt.secret);
      userId = decoded.userId;
    } catch {
      res.status(401).json({ success: false, error: 'Invalid authentication token' });
      return;
    }

    const authData = await verifyDeploymentOwnership(deploymentId, userId);
    if (!authData) {
      res.status(404).json({ success: false, error: 'Deployment not found or access denied' });
      return;
    }

    const { deployment } = authData;

    // Set Server-Sent Events headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering
    res.flushHeaders?.();

    // 1. Send initial batch of existing historical logs
    res.write(`event: init\ndata: ${JSON.stringify({ logs: deployment.logs || [], status: deployment.status })}\n\n`);

    // If already finished, close stream after init
    const isFinished = ['RUNNING', 'ACTIVE', 'PREVIOUS', 'FAILED', 'STOPPED'].includes(deployment.status);

    if (isFinished) {
      res.write(`event: end\ndata: ${JSON.stringify({ status: deployment.status })}\n\n`);
      res.end();
      return;
    }

    // 2. Subscribe to live Redis channel for this deployment
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;

    const subClient = new Redis({
      host,
      port,
      password,
      enableOfflineQueue: true,
    });

    const channelName = `deployhub:logs:${deploymentId}`;
    await subClient.subscribe(channelName);

    const onMessage = (_chan: string, message: string) => {
      res.write(`event: log\ndata: ${JSON.stringify({ line: message })}\n\n`);
    };

    subClient.on('message', onMessage);

    // Heartbeat every 15s to keep connection alive through proxies
    const heartbeatTimer = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    // Check periodically if deployment reached terminal state
    const statusCheckTimer = setInterval(async () => {
      try {
        const check = await DeploymentModel.findById(deploymentId, { status: 1 });
        if (check && ['RUNNING', 'ACTIVE', 'PREVIOUS', 'FAILED', 'STOPPED'].includes(check.status)) {
          res.write(`event: end\ndata: ${JSON.stringify({ status: check.status })}\n\n`);
          cleanup();
          res.end();
        }
      } catch {}
    }, 2000);

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      clearInterval(statusCheckTimer);
      subClient.removeListener('message', onMessage);
      subClient.unsubscribe(channelName).catch(() => {});
      subClient.quit().catch(() => {});
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message || 'SSE streaming failed' });
    }
  }
}

// POST /api/deployments/:id/stop or POST /api/projects/:projectId/deployments/:deploymentId/stop
export async function stopDeployment(req: AuthRequest, res: Response): Promise<void> {
  try {
    const deploymentId = req.params.deploymentId || req.params.id;
    const authData = await verifyDeploymentOwnership(deploymentId, req.userId);

    if (!authData) {
      res.status(404).json({ success: false, error: 'Deployment not found' });
      return;
    }

    const { deployment, project } = authData;

    // Enqueue stop job to BullMQ queue so worker handles container teardown & port release
    await deployQueue.add(
      'stop',
      {
        deploymentId: deployment._id.toString(),
        containerId: deployment.containerId,
        projectId: project._id.toString(),
      },
      { jobId: `stop-${deployment._id.toString()}-${Date.now()}` }
    );

    // Optimistically update status to STOPPED
    deployment.status = 'STOPPED';
    deployment.finishedAt = new Date();
    await deployment.save();

    res.json({ success: true, data: deployment });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to stop deployment' });
  }
}
