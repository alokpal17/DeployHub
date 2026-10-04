import { Response } from 'express';
import crypto from 'crypto';
import { ProjectModel, DeploymentModel, normalizeRepoIdentifier } from '../models';
import { AuthRequest } from '../middleware/auth';
import { removeProjectMetrics } from '../services/metrics.service';
import type { EnvVar } from '@deployhub/shared';

const BRANCH_REGEX = /^[a-zA-Z0-9_./-]+$/;
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// GET /api/projects
export async function getProjects(req: AuthRequest, res: Response): Promise<void> {
  try {
    const projects = await ProjectModel.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json({ success: true, data: projects });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch projects' });
  }
}

// GET /api/projects/:id
export async function getProject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }
    res.json({ success: true, data: project });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch project' });
  }
}

// POST /api/projects
export async function createProject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const {
      name,
      repositoryUrl,
      branch = 'main',
      framework = '',
      envVars = [],
      autoDeploy = true,
      productionBranch,
      allowManualDeploy = true,
    } = req.body;

    if (!name || !repositoryUrl) {
      res.status(400).json({ success: false, error: 'name and repositoryUrl are required' });
      return;
    }

    const cleanName = String(name).trim();
    const cleanRepoUrl = String(repositoryUrl).trim().replace(/\/+$/, '');
    const cleanBranch = String(branch).trim() || 'main';
    const cleanFramework = String(framework).trim();
    const cleanProdBranch = String(productionBranch || cleanBranch).trim();

    // Check for dangerous shell metacharacters in repository URL
    if (/[;&|`$]/.test(cleanRepoUrl)) {
      res.status(400).json({ success: false, error: 'Invalid characters in repository URL' });
      return;
    }

    // Validate URL format (GitHub URL, valid git URL, or local file path in dev/test)
    const isValidUrl =
      /^https?:\/\/[\w.-]+(\/[\w.-]+)+(\.git)?\/?$/i.test(cleanRepoUrl) ||
      /^file:\/\/.+$/i.test(cleanRepoUrl) ||
      /^[a-zA-Z]:[\\/].+$/.test(cleanRepoUrl);

    if (!isValidUrl) {
      res.status(400).json({ success: false, error: 'Invalid repository URL or path' });
      return;
    }

    // Validate branch name against shell injection
    if (!BRANCH_REGEX.test(cleanBranch)) {
      res.status(400).json({
        success: false,
        error: `Invalid branch name "${cleanBranch}". Must only contain letters, numbers, hyphens, underscores, dots, or slashes.`,
      });
      return;
    }

    if (!BRANCH_REGEX.test(cleanProdBranch)) {
      res.status(400).json({
        success: false,
        error: `Invalid production branch name "${cleanProdBranch}".`,
      });
      return;
    }

    // Validate initial environment variables if provided
    const validEnvVars: EnvVar[] = [];
    if (Array.isArray(envVars)) {
      for (const item of envVars) {
        if (item?.key) {
          const key = String(item.key).trim();
          if (!ENV_KEY_REGEX.test(key)) {
            res.status(400).json({
              success: false,
              error: `Invalid environment variable key: "${key}". Must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
            });
            return;
          }
          validEnvVars.push({
            key,
            value: String(item.value ?? ''),
            isSecret: Boolean(item.isSecret),
          });
        }
      }
    }

    const project = await ProjectModel.create({
      userId: req.userId,
      name: cleanName,
      repositoryUrl: cleanRepoUrl,
      branch: cleanBranch,
      framework: cleanFramework,
      envVars: validEnvVars,
      autoDeploy: Boolean(autoDeploy),
      productionBranch: cleanProdBranch,
      allowManualDeploy: Boolean(allowManualDeploy),
      webhookSecret: crypto.randomBytes(16).toString('hex'),
    });

    res.status(201).json({ success: true, data: project });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to create project' });
  }
}

// PUT /api/projects/:id
export async function updateProject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { name, branch, framework, autoDeploy, productionBranch, allowManualDeploy } = req.body;
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });

    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    if (name) project.name = String(name).trim();
    if (branch) {
      const cleanBranch = String(branch).trim();
      if (!BRANCH_REGEX.test(cleanBranch)) {
        res.status(400).json({ success: false, error: 'Invalid branch name' });
        return;
      }
      project.branch = cleanBranch;
    }
    if (productionBranch !== undefined) {
      const cleanProd = String(productionBranch).trim();
      if (!BRANCH_REGEX.test(cleanProd)) {
        res.status(400).json({ success: false, error: 'Invalid production branch name' });
        return;
      }
      project.productionBranch = cleanProd;
    }
    if (framework !== undefined) project.framework = String(framework).trim();
    if (autoDeploy !== undefined) project.autoDeploy = Boolean(autoDeploy);
    if (allowManualDeploy !== undefined) project.allowManualDeploy = Boolean(allowManualDeploy);

    await project.save();
    res.json({ success: true, data: project });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to update project' });
  }
}

// POST /api/projects/:id/rotate-webhook-secret
export async function rotateWebhookSecret(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    project.webhookSecret = crypto.randomBytes(16).toString('hex');
    await project.save();

    res.json({ success: true, data: { webhookSecret: project.webhookSecret } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to rotate secret' });
  }
}

// DELETE /api/projects/:id
export async function deleteProject(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }
    // Clean up deployments too
    await DeploymentModel.deleteMany({ projectId: req.params.id });
    // Clean up Prometheus metrics for deleted project
    removeProjectMetrics(req.params.id);
    res.json({ success: true, data: { message: 'Project deleted' } });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to delete project' });
  }
}
