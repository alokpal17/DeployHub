import axios from 'axios';
import type {
  Project,
  Deployment,
  EnvVar,
  GitHubAuthStatus,
  GitHubRepo,
  GitHubBranch,
  DeploymentTrigger,
  ContainerResourceStats,
} from '@deployhub/shared';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Redirect to login on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && window.location.pathname !== '/login') {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// ─── Health ───────────────────────────────────────────────────────────────────
export const healthApi = {
  check: () => api.get('/health').then((r) => r.data),
};

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  register: (username: string, email: string) =>
    api.post('/auth/register', { username, email }).then((r) => r.data.data),
  login: (email: string) =>
    api.post('/auth/login', { email }).then((r) => r.data.data),
  me: () =>
    api.get('/auth/me').then((r) => r.data.data),
};

// ─── GitHub ───────────────────────────────────────────────────────────────────
export const githubApi = {
  status: (): Promise<GitHubAuthStatus> =>
    api.get('/github/status').then((r) => r.data.data),
  connect: (token: string): Promise<GitHubAuthStatus> =>
    api.post('/github/connect', { token }).then((r) => r.data.data),
  disconnect: (): Promise<{ connected: boolean }> =>
    api.post('/github/disconnect').then((r) => r.data.data),
  repos: (query?: string): Promise<GitHubRepo[]> =>
    api.get('/github/repos', { params: { q: query } }).then((r) => r.data.data),
  branches: (owner: string, repo: string): Promise<GitHubBranch[]> =>
    api.get(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`).then((r) => r.data.data),
};

// ─── Environment Variables ────────────────────────────────────────────────────
export const envApi = {
  list: (projectId: string): Promise<EnvVar[]> =>
    api.get(`/projects/${projectId}/env`).then((r) => r.data.data),
  saveAll: (projectId: string, envVars: EnvVar[]): Promise<EnvVar[]> =>
    api.post(`/projects/${projectId}/env`, { envVars }).then((r) => r.data.data),
  set: (projectId: string, item: { key: string; value: string; isSecret?: boolean }): Promise<EnvVar[]> =>
    api.post(`/projects/${projectId}/env`, item).then((r) => r.data.data),
  update: (
    projectId: string,
    key: string,
    payload: { value?: string; isSecret?: boolean; newKey?: string }
  ): Promise<EnvVar> =>
    api.put(`/projects/${projectId}/env/${encodeURIComponent(key)}`, payload).then((r) => r.data.data),
  delete: (projectId: string, key: string): Promise<{ message: string; envVars: EnvVar[] }> =>
    api.delete(`/projects/${projectId}/env/${encodeURIComponent(key)}`).then((r) => r.data.data),
};

// ─── Projects ─────────────────────────────────────────────────────────────────
export const projectsApi = {
  list: (): Promise<Project[]> =>
    api.get('/projects').then((r) => r.data.data),
  get: (id: string): Promise<Project> =>
    api.get(`/projects/${id}`).then((r) => r.data.data),
  getResources: (projectId: string): Promise<ContainerResourceStats | null> =>
    api.get(`/projects/${projectId}/resources`).then((r) => r.data.data),
  create: (payload: {
    name: string;
    repositoryUrl: string;
    branch: string;
    framework?: string;
    envVars?: EnvVar[];
    autoDeploy?: boolean;
    productionBranch?: string;
    allowManualDeploy?: boolean;
    autoRecovery?: boolean;
    maxRestartAttempts?: number;
  }): Promise<Project> =>
    api.post('/projects', payload).then((r) => r.data.data),
  update: (
    id: string,
    payload: {
      name?: string;
      branch?: string;
      framework?: string;
      autoDeploy?: boolean;
      productionBranch?: string;
      allowManualDeploy?: boolean;
      autoRecovery?: boolean;
      maxRestartAttempts?: number;
    }
  ): Promise<Project> =>
    api.put(`/projects/${id}`, payload).then((r) => r.data.data),
  rotateWebhookSecret: (id: string): Promise<{ webhookSecret: string }> =>
    api.post(`/projects/${id}/rotate-webhook-secret`).then((r) => r.data.data),
  delete: (id: string) =>
    api.delete(`/projects/${id}`).then((r) => r.data.data),
};

// ─── Deployments ──────────────────────────────────────────────────────────────
export const deploymentsApi = {
  list: (projectId: string): Promise<Deployment[]> =>
    api.get(`/projects/${projectId}/deployments`).then((r) => r.data.data),
  getActive: (projectId: string): Promise<Deployment | null> =>
    api.get(`/projects/${projectId}/active-deployment`).then((r) => r.data.data),
  get: (projectId: string, deploymentId: string): Promise<Deployment> =>
    api.get(`/projects/${projectId}/deployments/${deploymentId}`).then((r) => r.data.data),
  trigger: (projectId: string, commitHash?: string, trigger?: DeploymentTrigger): Promise<{ deployment: Deployment }> =>
    api.post(`/projects/${projectId}/deployments`, { commitHash, trigger }).then((r) => r.data.data),
  redeploy: (projectId: string, deploymentId: string): Promise<{ deployment: Deployment }> =>
    api.post(`/projects/${projectId}/deployments/${deploymentId}/redeploy`).then((r) => r.data.data),
  rollback: (projectId: string, targetDeploymentId: string): Promise<{ deployment: Deployment; message: string }> =>
    api.post(`/projects/${projectId}/rollback/${targetDeploymentId}`).then((r) => r.data.data),
  logs: (projectId: string, deploymentId: string): Promise<{ logs: string[]; status: string; error?: string }> =>
    api.get(`/projects/${projectId}/deployments/${deploymentId}/logs`).then((r) => r.data.data),
  getStreamUrl: (projectId: string, deploymentId: string): string => {
    const token = localStorage.getItem('token') || '';
    return `/api/projects/${projectId}/deployments/${deploymentId}/logs/stream?token=${encodeURIComponent(token)}`;
  },
  stop: (projectId: string, deploymentId: string): Promise<Deployment> =>
    api.post(`/projects/${projectId}/deployments/${deploymentId}/stop`).then((r) => r.data.data),
};
