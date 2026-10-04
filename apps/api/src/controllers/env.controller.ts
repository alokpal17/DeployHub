import { Response } from 'express';
import { ProjectModel } from '../models';
import { AuthRequest } from '../middleware/auth';
import type { EnvVar } from '@deployhub/shared';

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// GET /api/projects/:id/env
export async function getEnvVars(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const envVars = project.envVars || [];
    res.json({ success: true, data: envVars });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch environment variables' });
  }
}

// POST /api/projects/:id/env  (Add single or bulk update environment variables)
export async function setEnvVars(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const { envVars, key, value, isSecret } = req.body;

    let updatedList: EnvVar[] = [...(project.envVars || [])];

    if (Array.isArray(envVars)) {
      // Bulk update
      for (const item of envVars) {
        if (!item.key || !ENV_KEY_REGEX.test(item.key.trim())) {
          res.status(400).json({
            success: false,
            error: `Invalid environment variable key: "${item?.key}". Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
          });
          return;
        }
      }

      // Replace or merge
      updatedList = envVars.map((v) => ({
        key: v.key.trim(),
        value: String(v.value ?? ''),
        isSecret: Boolean(v.isSecret),
      }));
    } else if (key) {
      const cleanKey = String(key).trim();
      if (!ENV_KEY_REGEX.test(cleanKey)) {
        res.status(400).json({
          success: false,
          error: `Invalid environment variable key: "${key}". Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
        });
        return;
      }

      const existingIndex = updatedList.findIndex((v) => v.key === cleanKey);
      const newVar: EnvVar = {
        key: cleanKey,
        value: String(value ?? ''),
        isSecret: Boolean(isSecret),
      };

      if (existingIndex >= 0) {
        updatedList[existingIndex] = newVar;
      } else {
        updatedList.push(newVar);
      }
    } else {
      res.status(400).json({ success: false, error: 'Either envVars array or key/value pair is required' });
      return;
    }

    project.envVars = updatedList;
    await project.save();

    res.json({ success: true, data: project.envVars });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to update environment variables' });
  }
}

// PUT /api/projects/:id/env/:key
export async function updateEnvVar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const targetKey = req.params.key;
    const { value, isSecret, newKey } = req.body;

    const list = project.envVars || [];
    const idx = list.findIndex((v: any) => v.key === targetKey);

    if (idx === -1) {
      res.status(404).json({ success: false, error: `Environment variable "${targetKey}" not found` });
      return;
    }

    const finalKey = (newKey ? String(newKey).trim() : targetKey);
    if (!ENV_KEY_REGEX.test(finalKey)) {
      res.status(400).json({
        success: false,
        error: `Invalid environment variable key: "${finalKey}". Must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
      });
      return;
    }

    list[idx] = {
      key: finalKey,
      value: value !== undefined ? String(value) : list[idx].value,
      isSecret: isSecret !== undefined ? Boolean(isSecret) : list[idx].isSecret,
    };

    project.envVars = list;
    await project.save();

    res.json({ success: true, data: list[idx] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to update environment variable' });
  }
}

// DELETE /api/projects/:id/env/:key
export async function deleteEnvVar(req: AuthRequest, res: Response): Promise<void> {
  try {
    const project = await ProjectModel.findOne({ _id: req.params.id, userId: req.userId });
    if (!project) {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }

    const targetKey = req.params.key;
    const beforeCount = project.envVars.length;
    project.envVars = project.envVars.filter((v: any) => v.key !== targetKey);

    if (project.envVars.length === beforeCount) {
      res.status(404).json({ success: false, error: `Environment variable "${targetKey}" not found` });
      return;
    }

    await project.save();
    res.json({ success: true, data: { message: `Variable "${targetKey}" deleted`, envVars: project.envVars } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to delete environment variable' });
  }
}
