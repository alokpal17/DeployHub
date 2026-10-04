// ─── Deployment States & Triggers ─────────────────────────────────────────────
export type DeploymentStatus =
  | 'QUEUED'
  | 'BUILDING'
  | 'DEPLOYING'
  | 'HEALTH_CHECKING'
  | 'RUNNING'
  | 'ACTIVE'
  | 'PREVIOUS'
  | 'FAILED'
  | 'STOPPED'
  | 'ROLLING_BACK';

export type DeploymentTrigger =
  | 'MANUAL'
  | 'WEBHOOK'
  | 'RETRY'
  | 'RECONCILIATION'
  | 'ROLLBACK';

export type ProjectType =
  | 'static-html'
  | 'nodejs-spa'
  | 'nodejs-backend'
  | 'dockerfile'
  | 'unknown';

export interface ProjectDetectionResult {
  type: ProjectType;
  framework?: string;
  internalPort: number;
  buildCommand?: string;
  startCommand?: string;
  mainFile?: string;
  hasDockerfile: boolean;
}

// ─── Environment Variables ────────────────────────────────────────────────────
export interface EnvVar {
  key: string;
  value: string;
  isSecret?: boolean;
}

// ─── GitHub Types ─────────────────────────────────────────────────────────────
export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string;
  updatedAt: string;
}

export interface GitHubBranch {
  name: string;
  isDefault: boolean;
  sha?: string;
}

export interface GitHubAuthStatus {
  connected: boolean;
  username?: string;
  avatarUrl?: string;
}

// ─── Container Resource Metrics ───────────────────────────────────────────────
export interface ContainerResourceStats {
  projectId: string;
  deploymentId: string;
  containerId: string;
  containerName: string;
  status: string;
  cpuPercentage: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercentage: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeSeconds: number;
  restartCount: number;
}

// ─── Database Models ──────────────────────────────────────────────────────────
export interface User {
  _id: string;
  githubId: string;
  username: string;
  email: string;
  avatarUrl: string;
  githubAccessToken?: string;
  githubUsername?: string;
  createdAt: Date;
}

export interface Project {
  _id: string;
  userId: string;
  name: string;
  repositoryUrl: string;
  repoIdentifier?: string;
  branch: string;
  framework?: string;
  envVars?: EnvVar[];
  autoDeploy: boolean;
  productionBranch: string;
  allowManualDeploy: boolean;
  webhookSecret: string;
  activeDeploymentId?: string;
  previousDeploymentId?: string;
  latestReleaseVersion?: number;
  autoRecovery?: boolean;
  maxRestartAttempts?: number;
  slug?: string;
  createdAt: Date;
}

export interface DeploymentTimings {
  queueWaitMs?: number;
  cloneDurationMs?: number;
  buildDurationMs?: number;
  containerStartupDurationMs?: number;
  healthCheckDurationMs?: number;
  proxySwitchDurationMs?: number;
  totalDurationMs?: number;
}

export interface Deployment {
  _id: string;
  projectId: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  commitHash?: string;
  commitAuthor?: string;
  commitMessage?: string;
  projectType?: ProjectType;
  imageName?: string;
  containerId?: string;
  containerPort?: number;
  releaseVersion?: number;
  healthStatus?: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  isRollback?: boolean;
  rollbackFromDeploymentId?: string;
  rollbackToDeploymentId?: string;
  restartCount?: number;
  lastRestartAt?: Date;
  error?: string;
  logs: string[];
  startedAt: Date;
  queuedAt?: Date;
  buildStartedAt?: Date;
  buildFinishedAt?: Date;
  deployStartedAt?: Date;
  healthCheckStartedAt?: Date;
  runningAt?: Date;
  finishedAt?: Date;
  lastHeartbeatAt?: Date;
  durationMs?: number;
  timings?: DeploymentTimings;
}

// ─── API Payloads ─────────────────────────────────────────────────────────────
export interface CreateProjectPayload {
  name: string;
  repositoryUrl: string;
  branch: string;
  framework?: string;
  envVars?: EnvVar[];
  autoDeploy?: boolean;
  productionBranch?: string;
  allowManualDeploy?: boolean;
  autoRecovery?: boolean;
}

export interface UpdateProjectPayload {
  name?: string;
  branch?: string;
  framework?: string;
  autoDeploy?: boolean;
  productionBranch?: string;
  allowManualDeploy?: boolean;
  autoRecovery?: boolean;
}

export interface TriggerDeploymentPayload {
  projectId: string;
  commitHash?: string;
  trigger?: DeploymentTrigger;
}

export interface RollbackPayload {
  targetDeploymentId: string;
}

// ─── Job Queue ────────────────────────────────────────────────────────────────
export interface DeployJobData {
  deploymentId: string;
  projectId: string;
  repositoryUrl: string;
  branch: string;
  commitHash?: string;
  trigger?: DeploymentTrigger;
  envVars?: Record<string, string>;
  queuedAt?: string;
  isRollback?: boolean;
  rollbackToDeploymentId?: string;
  imageName?: string;
}

export interface StopJobData {
  deploymentId: string;
  containerId?: string;
  projectId: string;
}

// ─── API Responses ────────────────────────────────────────────────────────────
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
