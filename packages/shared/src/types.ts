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
  | 'docker-compose'
  | 'docker'
  | 'dockerfile'
  | 'node-frontend'
  | 'nodejs-spa'
  | 'node-backend'
  | 'nodejs-backend'
  | 'node-fullstack'
  | 'python-web'
  | 'python-job'
  | 'python-ml'
  | 'java'
  | 'go'
  | 'static'
  | 'static-html'
  | 'monorepo'
  | 'unknown';

export type DeploymentMode =
  | 'web'
  | 'service'
  | 'job'
  | 'static'
  | 'multi-service'
  | 'unsupported'
  | 'ambiguous';

export interface ComposeServiceBuildInfo {
  context?: string;
  dockerfile?: string;
  args?: Record<string, string>;
  target?: string;
}

export interface ComposeServiceInfo {
  name: string;
  image?: string;
  build?: ComposeServiceBuildInfo;
  ports?: string[];
  environment?: Record<string, string>;
  envFile?: string[];
  dependsOn?: string[];
  healthcheck?: any;
  resolvedDockerfile?: string;
}

export interface DetectedEnvVar {
  key: string;
  defaultValue?: string;
  isSecret: boolean;
  isRequired: boolean;
  service?: string;
  description?: string;
  source: 'compose' | 'env_file' | 'example_file' | 'dockerfile' | 'readme' | 'source_code';
}

export interface ComposeDetectionInfo {
  composeFile: string;
  services: ComposeServiceInfo[];
  detectedEnvVars?: DetectedEnvVar[];
  missingRequiredEnvVars?: string[];
  primaryService?: string;
  primaryPort?: number;
  internalPort?: number;
}

export interface ServiceCandidate {
  name: string;
  path: string;
  type: ProjectType;
  framework?: string;
  runtime?: string;
  deploymentMode: DeploymentMode;
  entrypoint?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  packageManager?: string;
  installCommand?: string;
  hasLockfile?: boolean;
  buildContext?: string;
  dockerfilePath?: string;
  detectedPorts?: number[];
  detectedEnvVars?: DetectedEnvVar[];
  evidence: string[];
}

export type StartupFailureType =
  | 'MISSING_ENV_VAR'
  | 'PORT_BIND_FAILURE'
  | 'MISSING_DEPENDENCY'
  | 'DATABASE_FAILURE'
  | 'PERMISSION_FAILURE'
  | 'OOM_KILLED'
  | 'SYNTAX_ERROR'
  | 'RUNTIME_TOOLCHAIN_MISSING'
  | 'DEPLOYMENT_CONFIGURATION_ERROR'
  | 'APPLICATION_CRASH'
  | 'UNKNOWN';

export interface RuntimeDiagnosticResult {
  failureType: StartupFailureType;
  classification: string;
  exitCode?: number;
  oomKilled?: boolean;
  rawError?: string;
  stackTrace?: string;
  rootCauseMessage: string;
  suggestedFix?: string;
  tailLogs: string[];
}

export interface ProjectDetectionResult {
  type: ProjectType;
  framework?: string;
  runtime?: string;
  deploymentMode?: DeploymentMode;
  rootPath?: string;
  servicePath?: string;
  buildContext?: string;
  outputDirectory?: string;
  confidence?: number;
  entrypoint?: string;
  internalPort: number;
  detectedPorts?: number[];
  buildCommand?: string;
  startCommand?: string;
  mainFile?: string;
  packageManager?: string;
  installCommand?: string;
  hasLockfile?: boolean;
  dependencyFile?: string;
  hasDockerfile: boolean;
  dockerfilePath?: string;
  composeInfo?: ComposeDetectionInfo;
  candidates?: ServiceCandidate[];
  detectedEnvVars?: DetectedEnvVar[];
  missingRequiredEnvVars?: string[];
  evidence?: string[];
  diagnostics?: string[];
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
  deploymentMode?: DeploymentMode;
  servicePath?: string;
  diagnostics?: RuntimeDiagnosticResult;
  detection?: ProjectDetectionResult;
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
  servicePath?: string;
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
  servicePath?: string;
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
