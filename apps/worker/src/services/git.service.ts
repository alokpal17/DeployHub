import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

export interface CloneResult {
  repoPath: string;
  commitHash: string;
  commitAuthor: string;
  commitMessage: string;
  logs: string[];
}

export async function cloneRepository(
  repositoryUrl: string,
  branch: string,
  deploymentId: string,
  onLog: (line: string) => void
): Promise<CloneResult> {
  const logs: string[] = [];

  const log = (line: string) => {
    logs.push(line);
    onLog(line);
  };

  // Determine base temporary directory across environments
  const baseTmp = process.env.DEPLOYHUB_TEMP_DIR || path.join(os.tmpdir(), 'deployhub');
  const repoPath = path.join(baseTmp, deploymentId);

  // Clean up if already exists
  await fs.rm(repoPath, { recursive: true, force: true });
  await fs.mkdir(repoPath, { recursive: true });

  const cleanUrl = repositoryUrl.trim();
  const cleanBranch = branch.trim() || 'main';

  log(`[GIT] Target branch: "${cleanBranch}"`);
  log(`[GIT] Fetching: ${cleanUrl}`);
  log(`[GIT] Workspace path: ${repoPath}`);

  try {
    const git = simpleGit({
      timeout: {
        block: 90000, // 90s timeout
      },
    });

    await git.clone(cleanUrl, repoPath, [
      '--branch', cleanBranch,
      '--depth', '1',
      '--single-branch',
    ]);

    log(`[GIT] ✅ Repository cloned successfully.`);

    // Extract commit details
    const repoGit = simpleGit(repoPath);
    const logInfo = await repoGit.log({ maxCount: 1 });
    const latest = logInfo.latest;

    const commitHash = latest?.hash?.substring(0, 7) || 'unknown';
    const commitAuthor = latest?.author_name || 'unknown';
    const commitMessage = latest?.message || '';

    log(`[GIT] Commit: ${commitHash}`);
    log(`[GIT] Author: ${commitAuthor}`);
    if (commitMessage) {
      log(`[GIT] Message: "${commitMessage}"`);
    }

    return {
      repoPath,
      commitHash,
      commitAuthor,
      commitMessage,
      logs,
    };
  } catch (err: any) {
    const errorMsg = err.message || 'Unknown git clone error';

    if (errorMsg.includes('Remote branch') && errorMsg.includes('not found')) {
      log(`[GIT] ❌ Branch "${cleanBranch}" does not exist in repository.`);
      throw new Error(`Git branch "${cleanBranch}" not found in repository.`);
    }

    if (errorMsg.includes('Repository not found') || errorMsg.includes('Authentication failed')) {
      log(`[GIT] ❌ Repository not found or is private.`);
      throw new Error(`Git repository "${cleanUrl}" is inaccessible or private.`);
    }

    log(`[GIT] ❌ Clone error: ${errorMsg}`);
    throw new Error(`Git clone failed: ${errorMsg}`);
  }
}

export async function cleanupRepo(repoPath: string): Promise<void> {
  if (!repoPath) return;
  try {
    await fs.rm(repoPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
