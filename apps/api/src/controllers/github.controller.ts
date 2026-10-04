import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { GitHubService } from '../services/github.service';

// GET /api/github/status
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const status = await GitHubService.getStatus(req.userId);
    res.json({ success: true, data: status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to check GitHub status' });
  }
}

// POST /api/github/connect
export async function connect(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ success: false, error: 'GitHub personal access token is required' });
      return;
    }
    const status = await GitHubService.connect(req.userId, token);
    res.json({ success: true, data: status });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to connect GitHub' });
  }
}

// POST /api/github/disconnect
export async function disconnect(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    await GitHubService.disconnect(req.userId);
    res.json({ success: true, data: { connected: false } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to disconnect GitHub' });
  }
}

// GET /api/github/repos
export async function getRepositories(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const query = req.query.q as string | undefined;
    const repos = await GitHubService.listRepositories(req.userId, query);
    res.json({ success: true, data: repos });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch repositories' });
  }
}

// GET /api/github/repos/:owner/:repo/branches
export async function getBranches(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    const { owner, repo } = req.params;
    if (!owner || !repo) {
      res.status(400).json({ success: false, error: 'Owner and repo are required' });
      return;
    }
    const branches = await GitHubService.listBranches(req.userId, owner, repo);
    res.json({ success: true, data: branches });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch branches' });
  }
}
