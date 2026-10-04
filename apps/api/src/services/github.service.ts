import { UserModel, UserDoc } from '../models';
import type { GitHubRepo, GitHubBranch, GitHubAuthStatus } from '@deployhub/shared';

const GITHUB_API_BASE = 'https://api.github.com';

const DEMO_REPOSITORIES: GitHubRepo[] = [
  {
    id: 101,
    name: 'express-microservice',
    fullName: 'deployhub/express-microservice',
    owner: 'deployhub',
    isPrivate: false,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/expressjs/express',
    description: 'Production-ready Node.js REST API with zero config',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 102,
    name: 'vite-react-dashboard',
    fullName: 'deployhub/vite-react-dashboard',
    owner: 'deployhub',
    isPrivate: false,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/vitejs/vite',
    description: 'High-performance React SPA built with Vite',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 103,
    name: 'hono-edge-api',
    fullName: 'deployhub/hono-edge-api',
    owner: 'deployhub',
    isPrivate: false,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/honojs/starter-node',
    description: 'Ultra-fast web service designed for cloud edge',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 104,
    name: 'fastify-backend',
    fullName: 'deployhub/fastify-backend',
    owner: 'deployhub',
    isPrivate: false,
    defaultBranch: 'master',
    htmlUrl: 'https://github.com/fastify/fastify-example-twitter',
    description: 'High-throughput containerized web service',
    updatedAt: new Date().toISOString(),
  },
];

export class GitHubService {
  /**
   * Get GitHub connection status for a user
   */
  static async getStatus(userId: string): Promise<GitHubAuthStatus> {
    const user = await UserModel.findById(userId);
    if (!user || !user.githubAccessToken) {
      return { connected: false };
    }
    return {
      connected: true,
      username: user.githubUsername || user.username,
      avatarUrl: user.avatarUrl,
    };
  }

  /**
   * Connect user account using Personal Access Token (PAT) or OAuth Access Token
   */
  static async connect(userId: string, token: string): Promise<GitHubAuthStatus> {
    const cleanToken = token.trim();
    if (!cleanToken) {
      throw new Error('Access token is required');
    }

    // Validate token by querying GitHub user profile
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'DeployHub-App',
      },
    });

    if (!response.ok) {
      throw new Error(`Invalid GitHub token (GitHub returned ${response.status})`);
    }

    const ghUser: any = await response.json();

    const user = await UserModel.findByIdAndUpdate(
      userId,
      {
        githubAccessToken: cleanToken,
        githubUsername: ghUser.login,
        avatarUrl: ghUser.avatar_url || '',
      },
      { new: true }
    );

    if (!user) {
      throw new Error('User not found');
    }

    return {
      connected: true,
      username: user.githubUsername,
      avatarUrl: user.avatarUrl,
    };
  }

  /**
   * Disconnect GitHub account
   */
  static async disconnect(userId: string): Promise<void> {
    await UserModel.findByIdAndUpdate(userId, {
      githubAccessToken: '',
      githubUsername: '',
    });
  }

  /**
   * List accessible repositories for connected user, with optional search filter
   */
  static async listRepositories(userId: string, query?: string): Promise<GitHubRepo[]> {
    const user = await UserModel.findById(userId);

    let repos: GitHubRepo[] = [];

    if (user?.githubAccessToken) {
      try {
        const response = await fetch(`${GITHUB_API_BASE}/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator`, {
          headers: {
            Authorization: `Bearer ${user.githubAccessToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'DeployHub-App',
          },
        });

        if (response.ok) {
          const rawRepos = (await response.json()) as any[];
          repos = rawRepos.map((r) => ({
            id: r.id,
            name: r.name,
            fullName: r.full_name,
            owner: r.owner?.login || '',
            isPrivate: Boolean(r.private),
            defaultBranch: r.default_branch || 'main',
            htmlUrl: r.html_url,
            description: r.description || '',
            updatedAt: r.updated_at,
          }));
        } else {
          console.warn(`GitHub API returned ${response.status}, falling back to demo repositories`);
          repos = DEMO_REPOSITORIES;
        }
      } catch (err) {
        console.warn('Failed to contact GitHub API, using demo list:', err);
        repos = DEMO_REPOSITORIES;
      }
    } else {
      // Fallback demo repositories for quick testing
      repos = DEMO_REPOSITORIES;
    }

    if (query) {
      const q = query.toLowerCase().trim();
      return repos.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.fullName.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q)
      );
    }

    return repos;
  }

  /**
   * List available branches for a repository
   */
  static async listBranches(userId: string, owner: string, repo: string): Promise<GitHubBranch[]> {
    const user = await UserModel.findById(userId);

    if (user?.githubAccessToken) {
      try {
        // Fetch default branch
        let defaultBranchName = 'main';
        const repoRes = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
          headers: {
            Authorization: `Bearer ${user.githubAccessToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'DeployHub-App',
          },
        });

        if (repoRes.ok) {
          const repoData: any = await repoRes.json();
          defaultBranchName = repoData.default_branch || 'main';
        }

        // Fetch branch list
        const response = await fetch(
          `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
          {
            headers: {
              Authorization: `Bearer ${user.githubAccessToken}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'DeployHub-App',
            },
          }
        );

        if (response.ok) {
          const rawBranches = (await response.json()) as any[];
          return rawBranches.map((b) => ({
            name: b.name,
            isDefault: b.name === defaultBranchName,
            sha: b.commit?.sha?.slice(0, 7),
          }));
        }
      } catch (err) {
        console.warn('Failed to list branches from GitHub:', err);
      }
    }

    // Default branches fallback
    return [
      { name: 'main', isDefault: true },
      { name: 'master', isDefault: false },
      { name: 'develop', isDefault: false },
    ];
  }
}
