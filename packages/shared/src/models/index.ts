import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';
import type { DeploymentStatus, DeploymentTrigger, DeploymentTimings, EnvVar } from '../types';

/**
 * Normalizes repository URL to a canonical identifier: e.g. "github.com/org/repo"
 */
export function normalizeRepoIdentifier(url: string): string {
  if (!url) return '';
  return url
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^git@github\.com:/, 'github.com/')
    .replace(/^github\.com\//, 'github.com/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

// ─── User ─────────────────────────────────────────────────────────────────────
export interface UserDoc extends Document {
  githubId: string;
  username: string;
  email: string;
  avatarUrl: string;
  githubAccessToken?: string;
  githubUsername?: string;
  createdAt: Date;
}

export const UserSchema = new Schema<UserDoc>({
  githubId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  email: { type: String, required: true },
  avatarUrl: { type: String, default: '' },
  githubAccessToken: { type: String, default: '' },
  githubUsername: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

export const UserModel: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc>) ||
  mongoose.model<UserDoc>('User', UserSchema);

// ─── Project ──────────────────────────────────────────────────────────────────
export interface ProjectDoc extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  repositoryUrl: string;
  repoIdentifier: string;
  branch: string;
  framework?: string;
  envVars: EnvVar[];
  autoDeploy: boolean;
  productionBranch: string;
  allowManualDeploy: boolean;
  webhookSecret: string;
  activeDeploymentId?: mongoose.Types.ObjectId;
  previousDeploymentId?: mongoose.Types.ObjectId;
  latestReleaseVersion: number;
  autoRecovery: boolean;
  maxRestartAttempts: number;
  createdAt: Date;
}

export const EnvVarSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    isSecret: { type: Boolean, default: false },
  },
  { _id: false }
);

export const ProjectSchema = new Schema<ProjectDoc>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  slug: { type: String, default: '' },
  repositoryUrl: { type: String, required: true },
  repoIdentifier: { type: String, required: true },
  branch: { type: String, required: true, default: 'main' },
  framework: { type: String, default: '' },
  envVars: { type: [EnvVarSchema], default: [] },
  autoDeploy: { type: Boolean, default: true },
  productionBranch: { type: String, default: 'main' },
  allowManualDeploy: { type: Boolean, default: true },
  webhookSecret: {
    type: String,
    default: () => crypto.randomBytes(16).toString('hex'),
  },
  activeDeploymentId: { type: Schema.Types.ObjectId, ref: 'Deployment' },
  previousDeploymentId: { type: Schema.Types.ObjectId, ref: 'Deployment' },
  latestReleaseVersion: { type: Number, default: 0 },
  autoRecovery: { type: Boolean, default: true },
  maxRestartAttempts: { type: Number, default: 3 },
  createdAt: { type: Date, default: Date.now },
});

// Index for user projects query
ProjectSchema.index({ userId: 1, createdAt: -1 });
// Index for webhook fast lookup
ProjectSchema.index({ repoIdentifier: 1 });
// Index for slug lookup
ProjectSchema.index({ slug: 1 });

// Pre-save hook to ensure repoIdentifier and slug are set
ProjectSchema.pre('validate', function (next) {
  if (this.repositoryUrl && !this.repoIdentifier) {
    this.repoIdentifier = normalizeRepoIdentifier(this.repositoryUrl);
  }
  if (this.name && !this.slug) {
    this.slug = this.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  }
  next();
});

export const ProjectModel: Model<ProjectDoc> =
  (mongoose.models.Project as Model<ProjectDoc>) ||
  mongoose.model<ProjectDoc>('Project', ProjectSchema);

// ─── Deployment ───────────────────────────────────────────────────────────────
export interface DeploymentDoc extends Document {
  projectId: mongoose.Types.ObjectId;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  commitHash: string;
  commitAuthor: string;
  commitMessage: string;
  projectType: string;
  imageName: string;
  containerId: string;
  containerPort: number;
  releaseVersion: number;
  healthStatus: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
  isRollback: boolean;
  rollbackFromDeploymentId?: mongoose.Types.ObjectId;
  rollbackToDeploymentId?: mongoose.Types.ObjectId;
  restartCount: number;
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
  timings?: DeploymentTimings;
  deploymentMode?: string;
  servicePath?: string;
  diagnostics?: any;
  detection?: any;
}

export const TimingsSchema = new Schema(
  {
    queueWaitMs: { type: Number, default: 0 },
    cloneDurationMs: { type: Number, default: 0 },
    buildDurationMs: { type: Number, default: 0 },
    containerStartupDurationMs: { type: Number, default: 0 },
    healthCheckDurationMs: { type: Number, default: 0 },
    proxySwitchDurationMs: { type: Number, default: 0 },
    totalDurationMs: { type: Number, default: 0 },
  },
  { _id: false }
);

export const DeploymentSchema = new Schema<DeploymentDoc>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  status: {
    type: String,
    enum: [
      'QUEUED',
      'BUILDING',
      'DEPLOYING',
      'HEALTH_CHECKING',
      'RUNNING',
      'ACTIVE',
      'PREVIOUS',
      'FAILED',
      'STOPPED',
      'ROLLING_BACK',
    ],
    default: 'QUEUED',
    index: true,
  },
  trigger: {
    type: String,
    enum: ['MANUAL', 'WEBHOOK', 'RETRY', 'RECONCILIATION', 'ROLLBACK'],
    default: 'MANUAL',
    index: true,
  },
  commitHash: { type: String, default: '' },
  commitAuthor: { type: String, default: '' },
  commitMessage: { type: String, default: '' },
  projectType: { type: String, default: '' },
  deploymentMode: { type: String, default: 'web' },
  servicePath: { type: String, default: '' },
  imageName: { type: String, default: '' },
  containerId: { type: String, default: '' },
  containerPort: { type: Number, default: 0 },
  releaseVersion: { type: Number, default: 1 },
  healthStatus: {
    type: String,
    enum: ['HEALTHY', 'UNHEALTHY', 'UNKNOWN'],
    default: 'UNKNOWN',
  },
  isRollback: { type: Boolean, default: false },
  rollbackFromDeploymentId: { type: Schema.Types.ObjectId, ref: 'Deployment' },
  rollbackToDeploymentId: { type: Schema.Types.ObjectId, ref: 'Deployment' },
  restartCount: { type: Number, default: 0 },
  lastRestartAt: { type: Date },
  error: { type: String, default: '' },
  logs: { type: [String], default: [] },
  startedAt: { type: Date, default: Date.now },
  queuedAt: { type: Date, default: Date.now },
  buildStartedAt: { type: Date },
  buildFinishedAt: { type: Date },
  deployStartedAt: { type: Date },
  healthCheckStartedAt: { type: Date },
  runningAt: { type: Date },
  finishedAt: { type: Date },
  lastHeartbeatAt: { type: Date, default: Date.now },
  timings: { type: TimingsSchema, default: () => ({}) },
  diagnostics: { type: Schema.Types.Mixed },
  detection: { type: Schema.Types.Mixed },
});

// Compound indexes for DeployHub query patterns
// 1. Deployment history list: { projectId: 1, startedAt: -1 }
DeploymentSchema.index({ projectId: 1, startedAt: -1 });

// 2. Webhook deduplication: { projectId: 1, commitHash: 1, startedAt: -1 }
DeploymentSchema.index({ projectId: 1, commitHash: 1, startedAt: -1 });

// 3. Worker reconciliation engine: { status: 1, lastHeartbeatAt: 1 }
DeploymentSchema.index({ status: 1, lastHeartbeatAt: 1 });

// 4. Active release lookup: { projectId: 1, status: 1 }
DeploymentSchema.index({ projectId: 1, status: 1 });

export const DeploymentModel: Model<DeploymentDoc> =
  (mongoose.models.Deployment as Model<DeploymentDoc>) ||
  mongoose.model<DeploymentDoc>('Deployment', DeploymentSchema);
