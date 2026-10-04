import { Request, Response } from 'express';
import crypto from 'crypto';
import { ProjectModel, DeploymentModel, normalizeRepoIdentifier } from '../models';
import { deployQueue } from '../config/queue';

/**
 * Verifies GitHub HMAC-SHA256 signature using timing-safe comparison
 */
export function verifyGitHubSignature(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    return false;
  }

  const expectedSignature = parts[1];
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const calculatedSignature = hmac.digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const calculatedBuffer = Buffer.from(calculatedSignature, 'hex');

  if (expectedBuffer.length !== calculatedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, calculatedBuffer);
}

// POST /api/webhooks/github
export async function handleGitHubWebhook(req: Request, res: Response): Promise<void> {
  try {
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const event = (req.headers['x-github-event'] as string) || 'push';
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    // Reject missing signature
    if (!signatureHeader) {
      res.status(401).json({ success: false, error: 'Missing X-Hub-Signature-256 header' });
      return;
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ success: false, error: 'Invalid webhook payload' });
      return;
    }

    // Extract repository identifiers from GitHub payload
    const repoData = payload.repository;
    if (!repoData) {
      res.status(400).json({ success: false, error: 'No repository information in payload' });
      return;
    }

    const candidates = [
      repoData.html_url,
      repoData.clone_url,
      repoData.ssh_url,
      repoData.full_name ? `https://github.com/${repoData.full_name}` : null,
      repoData.name,
    ].filter(Boolean) as string[];

    const normalizedCandidates = candidates.map(normalizeRepoIdentifier);

    // Find matching projects directly in database using indexed repoIdentifier
    const matchingProjects = await ProjectModel.find({
      repoIdentifier: { $in: normalizedCandidates },
    });

    if (matchingProjects.length === 0) {
      res.status(404).json({ success: false, error: 'No DeployHub project matched the repository in webhook' });
      return;
    }

    // Serialize payload to verify HMAC signature against candidate project secret
    const rawPayloadBuffer = (req as any).rawBody || Buffer.from(JSON.stringify(payload), 'utf8');

    // Find the project whose secret validates the HMAC signature
    const authenticatedProject = matchingProjects.find((p) =>
      verifyGitHubSignature(rawPayloadBuffer, signatureHeader, p.webhookSecret)
    );

    if (!authenticatedProject) {
      res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      return;
    }

    // Handle GitHub "ping" test event
    if (event === 'ping') {
      res.status(200).json({
        success: true,
        message: `Webhook configured successfully for project "${authenticatedProject.name}"`,
      });
      return;
    }

    // Only process "push" events for deployment trigger
    if (event !== 'push') {
      res.status(200).json({
        success: true,
        message: `Event "${event}" ignored (only push events trigger deployment)`,
      });
      return;
    }

    // ── Check Auto Deploy Setting ───────────────────────────────────────────
    if (authenticatedProject.autoDeploy === false) {
      res.status(200).json({
        success: true,
        message: `Auto-deploy is disabled for project "${authenticatedProject.name}"`,
      });
      return;
    }

    // ── Check Branch Filter ─────────────────────────────────────────────────
    const targetBranch = authenticatedProject.productionBranch || authenticatedProject.branch || 'main';
    const pushedRef = String(payload.ref || '');
    const expectedRef = `refs/heads/${targetBranch}`;

    if (pushedRef !== expectedRef) {
      res.status(200).json({
        success: true,
        message: `Push ignored (branch mismatch): pushed ref "${pushedRef}" does not match configured production branch "${targetBranch}"`,
      });
      return;
    }

    // ── Deduplication Check ─────────────────────────────────────────────────
    const headCommit = payload.head_commit || payload.commits?.[0] || {};
    const commitHash = headCommit.id || payload.after || '';
    const commitAuthor = headCommit.author?.name || payload.pusher?.name || 'GitHub Webhook';
    const commitMessage = headCommit.message || `Automated push to ${targetBranch}`;

    if (commitHash) {
      // Check if a deployment for this exact commit was queued within the last 60 seconds
      const recentDeployment = await DeploymentModel.findOne({
        projectId: authenticatedProject._id,
        commitHash,
        startedAt: { $gte: new Date(Date.now() - 60000) },
      });

      if (recentDeployment) {
        res.status(200).json({
          success: true,
          message: `Duplicate webhook delivery ignored: deployment ${recentDeployment._id} already queued for commit ${commitHash.substring(0, 7)}`,
        });
        return;
      }
    }

    // ── Unified Deployment Pipeline Execution ───────────────────────────────
    // Build env variables map
    const envVarsMap: Record<string, string> = {};
    if (authenticatedProject.envVars && authenticatedProject.envVars.length > 0) {
      for (const ev of authenticatedProject.envVars) {
        if (ev.key) {
          envVarsMap[ev.key] = ev.value;
        }
      }
    }

    const deployment = await DeploymentModel.create({
      projectId: authenticatedProject._id,
      status: 'QUEUED',
      trigger: 'WEBHOOK',
      commitHash,
      commitAuthor,
      commitMessage,
      queuedAt: new Date(),
    });

    await deployQueue.add(
      'deploy',
      {
        deploymentId: deployment._id.toString(),
        projectId: authenticatedProject._id.toString(),
        repositoryUrl: authenticatedProject.repositoryUrl,
        branch: targetBranch,
        commitHash,
        trigger: 'WEBHOOK',
        envVars: envVarsMap,
        queuedAt: new Date().toISOString(),
      },
      { jobId: deployment._id.toString() }
    );

    console.log(`\n🔔 Webhook triggered deployment ${deployment._id} for project "${authenticatedProject.name}" (commit ${commitHash.substring(0, 7)})`);

    res.status(202).json({
      success: true,
      data: {
        deploymentId: deployment._id,
        projectId: authenticatedProject._id,
        projectName: authenticatedProject.name,
        branch: targetBranch,
        commitHash,
        message: 'Deployment queued via GitHub webhook',
      },
    });
  } catch (err: any) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ success: false, error: err.message || 'Webhook internal error' });
  }
}
