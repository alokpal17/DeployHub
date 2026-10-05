import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { projectsApi, deploymentsApi, envApi } from '../services/api';
import type { Project, Deployment, EnvVar, ContainerResourceStats } from '@deployhub/shared';
import { StatusBadge } from '../components/ui/StatusBadge';
import { LogViewer } from '../components/deployments/LogViewer';
import { formatDistanceToNow } from 'date-fns';
import {
  GitBranch,
  Globe,
  Copy,
  Check,
  StopCircle,
  Terminal,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Box,
  History,
  KeyRound,
  Trash2,
  Plus,
  Eye,
  EyeOff,
  Clock,
  AlertCircle,
  RotateCw,
  RefreshCw,
  Settings,
  Webhook,
  Sliders,
  Zap,
  ShieldCheck,
  Timer,
  Undo2,
  Activity,
  Cpu,
  HardDrive,
  Radio,
} from 'lucide-react';
import { Github } from '../components/ui/Icons';

const LIVE_STATUSES = new Set(['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING', 'ROLLING_BACK']);

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selected, setSelected] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'console' | 'history' | 'env' | 'resources' | 'settings'>('console');
  const [deleting, setDeleting] = useState(false);

  // Action states
  const [triggering, setTriggering] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedProxyUrl, setCopiedProxyUrl] = useState(false);
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);

  // Resource stats
  const [resourceStats, setResourceStats] = useState<ContainerResourceStats | null>(null);
  const [resourceLoading, setResourceLoading] = useState(false);

  // Environment variables state
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);
  const [envSuccessMsg, setEnvSuccessMsg] = useState('');
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [envError, setEnvError] = useState('');

  // Settings state
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [productionBranch, setProductionBranch] = useState('main');
  const [allowManualDeploy, setAllowManualDeploy] = useState(true);
  const [autoRecovery, setAutoRecovery] = useState(true);
  const [maxRestartAttempts, setMaxRestartAttempts] = useState(3);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSuccessMsg, setSettingsSuccessMsg] = useState('');

  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchDeployments = useCallback(async () => {
    if (!id) return;
    try {
      const data = await deploymentsApi.list(id);
      setDeployments(data || []);
      if (data && data.length > 0) {
        setSelected((curr) => {
          if (!curr) return data[0];
          const found = data.find((d) => d._id === curr._id);
          return found || data[0];
        });
      }
    } catch (err) {
      console.error('Failed to fetch deployments', err);
    }
  }, [id]);

  const fetchEnvVars = useCallback(async () => {
    if (!id) return;
    setEnvLoading(true);
    try {
      const data = await envApi.list(id);
      setEnvVars(data || []);
    } catch (err) {
      console.error('Failed to fetch environment variables', err);
    } finally {
      setEnvLoading(false);
    }
  }, [id]);

  const fetchResourceStats = useCallback(async () => {
    if (!id) return;
    setResourceLoading(true);
    try {
      const stats = await projectsApi.getResources(id);
      setResourceStats(stats);
    } catch (err) {
      console.error('Failed to fetch resource stats', err);
    } finally {
      setResourceLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    projectsApi
      .get(id)
      .then((p) => {
        setProject(p);
        setAutoDeploy(p.autoDeploy !== false);
        setProductionBranch(p.productionBranch || p.branch || 'main');
        setAllowManualDeploy(p.allowManualDeploy !== false);
        setAutoRecovery(p.autoRecovery !== false);
        setMaxRestartAttempts(p.maxRestartAttempts || 3);
      })
      .catch(console.error);

    fetchDeployments();
    fetchEnvVars();
    fetchResourceStats();
  }, [id, fetchDeployments, fetchEnvVars, fetchResourceStats]);

  // Periodic resource stats fetch
  useEffect(() => {
    if (!id) return;
    const interval = setInterval(fetchResourceStats, 8000);
    return () => clearInterval(interval);
  }, [id, fetchResourceStats]);

  // SSE Live Log Stream with auto-reconnect and fallback
  useEffect(() => {
    if (!selected || !id) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const isLive = LIVE_STATUSES.has(selected.status);

    if (typeof EventSource !== 'undefined') {
      const streamUrl = deploymentsApi.getStreamUrl(id, selected._id);
      const es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      es.addEventListener('init', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          setLogs(payload.logs || []);
          setSseConnected(true);
        } catch {}
      });

      es.addEventListener('log', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.line) {
            setLogs((prev) => [...prev, payload.line]);
          }
        } catch {}
      });

      es.addEventListener('end', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.status) {
            setDeployments((prev) =>
              prev.map((d) => (d._id === selected._id ? { ...d, status: payload.status } : d))
            );
            setSelected((prev) => (prev ? { ...prev, status: payload.status } : prev));
          }
        } catch {}
        setSseConnected(false);
        es.close();
      });

      es.onerror = () => {
        setSseConnected(false);
      };
    }

    // Polling fallback / terminal sync
    const fetchLogsFallback = async () => {
      try {
        const result = await deploymentsApi.logs(id, selected._id);
        if (result.logs && result.logs.length >= logs.length) {
          setLogs(result.logs);
        }
        if (result.status !== selected.status) {
          setDeployments((prev) =>
            prev.map((d) => (d._id === selected._id ? { ...d, status: result.status as any } : d))
          );
          setSelected((prev) => (prev ? { ...prev, status: result.status as any } : prev));
        }
      } catch {}
    };

    fetchLogsFallback();

    if (!isLive) return;

    const interval = setInterval(fetchLogsFallback, 2500);
    return () => {
      clearInterval(interval);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [selected?._id, selected?.status, id]);

  // Trigger new deployment / redeploy
  async function handleRedeploy() {
    if (!id) return;
    setTriggering(true);
    try {
      const { deployment } = await deploymentsApi.trigger(id);
      setDeployments((prev) => [deployment, ...prev]);
      setSelected(deployment);
      setLogs([]);
      setActiveTab('console');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to trigger deployment');
    } finally {
      setTriggering(false);
    }
  }

  // Rollback to specific deployment
  async function handleRollback(targetDeploymentId: string, versionLabel?: string) {
    if (!id) return;
    const confirmMsg = `Initiate Zero-Downtime Rollback to ${versionLabel || 'selected release'}?\n\nThis will instantly deploy the existing image artifact and switch traffic once health check passes without taking down the active release.`;
    if (!confirm(confirmMsg)) return;

    setRollingBack(true);
    try {
      const res = await deploymentsApi.rollback(id, targetDeploymentId);
      if (res.deployment) {
        setDeployments((prev) => [res.deployment, ...prev]);
        setSelected(res.deployment);
        setLogs([]);
        setActiveTab('console');
      }
    } catch (err: any) {
      alert(err.response?.data?.error || 'Rollback failed to initiate');
    } finally {
      setRollingBack(false);
    }
  }

  // Stop running deployment
  async function handleStopDeploy(dId: string) {
    if (!id) return;
    setStopping(true);
    try {
      const updated = await deploymentsApi.stop(id, dId);
      setDeployments((prev) => prev.map((d) => (d._id === dId ? updated : d)));
      if (selected?._id === dId) {
        setSelected(updated);
      }
    } catch (err) {
      console.error('Error stopping deployment', err);
    } finally {
      setStopping(false);
    }
  }

  // Add environment variable
  async function handleAddEnvVar(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !newEnvKey.trim()) return;
    const cleanKey = newEnvKey.trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) {
      setEnvError('Variable key must match /^[A-Za-z_][A-Za-z0-9_]*$/');
      return;
    }

    setEnvSaving(true);
    setEnvError('');
    setEnvSuccessMsg('');

    try {
      const updated = await envApi.set(id, {
        key: cleanKey,
        value: newEnvValue,
        isSecret: newEnvSecret,
      });
      setEnvVars(updated);
      setNewEnvKey('');
      setNewEnvValue('');
      setNewEnvSecret(false);
      setEnvSuccessMsg(`Environment variable "${cleanKey}" saved.`);
      setTimeout(() => setEnvSuccessMsg(''), 3000);
    } catch (err: any) {
      setEnvError(err.response?.data?.error || 'Failed to save environment variable');
    } finally {
      setEnvSaving(false);
    }
  }

  // Delete environment variable
  async function handleDeleteEnvVar(key: string) {
    if (!id) return;
    if (!confirm(`Delete variable "${key}"?`)) return;
    try {
      const result = await envApi.delete(id, key);
      setEnvVars(result.envVars);
      setEnvSuccessMsg(`Deleted variable "${key}".`);
      setTimeout(() => setEnvSuccessMsg(''), 3000);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete variable');
    }
  }

  // Save project trigger & recovery settings
  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setSettingsSaving(true);
    setSettingsSuccessMsg('');
    try {
      const updated = await projectsApi.update(id, {
        autoDeploy,
        productionBranch,
        allowManualDeploy,
        autoRecovery,
        maxRestartAttempts: Number(maxRestartAttempts) || 3,
      });
      setProject(updated);
      setSettingsSuccessMsg('Project settings saved successfully.');
      setTimeout(() => setSettingsSuccessMsg(''), 3000);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save settings');
    } finally {
      setSettingsSaving(false);
    }
  }

  // Rotate webhook secret
  async function handleRotateSecret() {
    if (!id) return;
    if (!confirm('Rotate webhook secret? You must update GitHub webhook settings with the new secret.')) return;
    try {
      const res = await projectsApi.rotateWebhookSecret(id);
      if (project) {
        setProject({ ...project, webhookSecret: res.webhookSecret });
      }
      setSettingsSuccessMsg('Webhook secret rotated.');
      setTimeout(() => setSettingsSuccessMsg(''), 3000);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to rotate secret');
    }
  }

  // Delete project
  async function handleDeleteProject() {
    if (!id || !project) return;
    if (!confirm(`Are you sure you want to permanently delete "${project.name}" and all associated deployments & logs? This action cannot be undone.`)) return;

    setDeleting(true);
    try {
      await projectsApi.delete(id);
      navigate('/dashboard');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete project');
      setDeleting(false);
    }
  }

  function copyAppUrl(port: number) {
    const url = `http://localhost:${port}`;
    navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  }

  function copyProxyUrl(projectId: string) {
    const url = `http://localhost:8080/p/${projectId}`;
    navigator.clipboard.writeText(url);
    setCopiedProxyUrl(true);
    setTimeout(() => setCopiedProxyUrl(false), 2000);
  }

  const getWebhookUrl = () => {
    if (typeof window === 'undefined') return '/api/webhooks/github';
    const envApiVal = (import.meta as any).env?.VITE_API_URL;
    if (envApiVal) {
      return `${envApiVal.replace(/\/+$/, '')}/api/webhooks/github`;
    }
    if (window.location.port === '5173') {
      return 'http://localhost:3001/api/webhooks/github';
    }
    return `${window.location.origin}/api/webhooks/github`;
  };

  function copyWebhookUrl() {
    const webhookUrl = getWebhookUrl();
    navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhookUrl(true);
    setTimeout(() => setCopiedWebhookUrl(false), 2000);
  }

  function copySecret(secret: string) {
    navigator.clipboard.writeText(secret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  }

  function formatDuration(startedAt: Date | string, finishedAt?: Date | string) {
    if (!finishedAt) return 'Running...';
    const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m ${remSec}s`;
  }

  if (!project) {
    return (
      <div className="p-16 flex flex-col items-center justify-center min-h-[450px] space-y-3">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-slate-400 text-sm font-medium">Loading project environment...</span>
      </div>
    );
  }

  const isLive = selected ? LIVE_STATUSES.has(selected.status) : false;

  const currentStep = !selected
    ? 0
    : selected.status === 'QUEUED'
    ? 1
    : selected.status === 'BUILDING'
    ? 2
    : selected.status === 'DEPLOYING' || selected.status === 'ROLLING_BACK'
    ? 3
    : selected.status === 'HEALTH_CHECKING'
    ? 4
    : selected.status === 'RUNNING' || selected.status === 'ACTIVE' || selected.status === 'PREVIOUS'
    ? 5
    : selected.status === 'FAILED'
    ? -1
    : 0;

  const webhookPayloadUrl = getWebhookUrl();

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-8 font-sans">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
        <Link to="/dashboard" className="hover:text-indigo-400 transition-colors">
          Projects
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
        <span className="text-white font-semibold">{project.name}</span>
      </div>

      {/* Hero Project Header Card */}
      <div className="glass-card rounded-3xl p-8 relative overflow-hidden shadow-2xl">
        <div className="absolute right-0 top-0 w-80 h-80 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-600 flex items-center justify-center text-white text-2xl font-bold shadow-lg shadow-indigo-600/30 ring-1 ring-white/20 shrink-0">
              {project.name[0]?.toUpperCase()}
            </div>

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  {project.name}
                </h1>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium bg-black/40 text-indigo-300 border border-indigo-500/20">
                  <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                  {project.productionBranch || project.branch || 'main'}
                </span>
                {project.latestReleaseVersion && (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    Release v{project.latestReleaseVersion}
                  </span>
                )}
                {project.autoDeploy && (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                    <Zap className="w-3 h-3 text-emerald-400" />
                    Auto-Deploy ON
                  </span>
                )}
                {project.framework && (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono bg-white/5 text-slate-300 border border-white/10">
                    {project.framework}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400">
                <a
                  href={project.repositoryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-indigo-300 inline-flex items-center gap-1.5 transition-colors"
                >
                  <Github className="w-3.5 h-3.5" />
                  <span>{project.repositoryUrl.replace('https://github.com/', '')}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>

                {/* Gateway Proxy Route Link */}
                <div className="inline-flex items-center gap-1.5 text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded-lg border border-indigo-500/20">
                  <Globe className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Gateway: /p/{project._id}</span>
                  <button
                    onClick={() => copyProxyUrl(project._id)}
                    className="hover:text-white transition-colors"
                    title="Copy Gateway URL"
                  >
                    {copiedProxyUrl ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Action Strip */}
          <div className="flex flex-wrap items-center gap-3">
            {selected?.status === 'RUNNING' && selected.containerPort && (
              <a
                href={`http://localhost:${selected.containerPort}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-4 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-2xl text-xs font-bold transition-all shadow-md shadow-emerald-500/10"
              >
                <Globe className="w-4 h-4 text-emerald-400" />
                <span>Open App (:{selected.containerPort})</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}

            {(isLive || selected?.status === 'RUNNING') && (
              <button
                onClick={() => selected && handleStopDeploy(selected._id)}
                disabled={stopping}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-2xl text-xs font-semibold transition-all disabled:opacity-50"
              >
                <StopCircle className="w-4 h-4 text-rose-400" />
                <span>{stopping ? 'Stopping...' : 'Stop Container'}</span>
              </button>
            )}

            <button
              onClick={handleRedeploy}
              disabled={triggering || rollingBack}
              className="flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50 text-white text-xs font-semibold px-5 py-2.5 rounded-2xl shadow-xl shadow-indigo-600/30 hover:shadow-indigo-600/50 transition-all active:scale-95 shrink-0"
            >
              {triggering ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Queuing Build...</span>
                </>
              ) : (
                <>
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>Deploy New Release</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Live Pipeline Visualizer */}
        {selected && (
          <div className="mt-8 pt-6 border-t border-white/10">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono flex items-center gap-2">
                <span>Deployment Pipeline Status</span>
                {selected.isRollback && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                    <Undo2 className="w-3 h-3" />
                    Zero-Downtime Rollback
                  </span>
                )}
              </span>
              <span className="text-xs font-mono text-slate-400 flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] text-indigo-300">
                  Trigger: {selected.trigger || 'MANUAL'}
                </span>
                <span>Release {selected.releaseVersion ? `v${selected.releaseVersion}` : `#${selected._id.slice(-6)}`}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              {[
                { stage: 1, label: '1. Queue Accepted', desc: 'BullMQ job enqueued' },
                { stage: 2, label: selected.isRollback ? '2. Image Artifact' : '2. Shallow Git Clone', desc: selected.isRollback ? 'Instant image restore' : 'Fetch branch HEAD' },
                { stage: 3, label: '3. Docker Sandbox', desc: 'Isolated container build/run' },
                { stage: 4, label: '4. Health Verification', desc: 'Readiness probe pass' },
                { stage: 5, label: '5. Zero-Downtime Switch', desc: 'Atomic proxy cutover' },
              ].map((step) => {
                const isPassed = currentStep > step.stage || currentStep === 5;
                const isCurrent = currentStep === step.stage;
                const isFailed = currentStep === -1 && step.stage === 3;

                return (
                  <div
                    key={step.stage}
                    className={`p-3.5 rounded-2xl border transition-all ${
                      isFailed
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                        : isCurrent
                        ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500/40 shadow-lg shadow-indigo-500/10'
                        : isPassed
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        : 'bg-black/30 border-white/5 text-slate-500'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold font-mono">{step.label}</span>
                      {isPassed ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      ) : isCurrent ? (
                        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-slate-700" />
                      )}
                    </div>
                    <p className="text-[11px] opacity-75">{step.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Tabs Navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-3">
        <button
          onClick={() => setActiveTab('console')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'console'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'bg-white/5 text-slate-400 hover:text-white'
          }`}
        >
          <Terminal className="w-4 h-4" />
          <span>Console &amp; Live Logs</span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'history'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'bg-white/5 text-slate-400 hover:text-white'
          }`}
        >
          <History className="w-4 h-4" />
          <span>Release History ({deployments.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('resources')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'resources'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'bg-white/5 text-slate-400 hover:text-white'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Live Resource Monitor</span>
        </button>

        <button
          onClick={() => setActiveTab('env')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'env'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'bg-white/5 text-slate-400 hover:text-white'
          }`}
        >
          <KeyRound className="w-4 h-4" />
          <span>Environment Variables ({envVars.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            activeTab === 'settings'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
              : 'bg-white/5 text-slate-400 hover:text-white'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>Settings &amp; Webhooks</span>
        </button>
      </div>

      {/* TAB 1: Console & Live Logs */}
      {activeTab === 'console' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Quick Deployment Selector */}
          <div className="lg:col-span-4 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono">
                Releases &amp; Builds
              </h2>
              <button
                onClick={fetchDeployments}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-mono"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Sync</span>
              </button>
            </div>

            {deployments.length === 0 ? (
              <div className="glass-card rounded-2xl p-8 text-center text-slate-500 space-y-2">
                <Box className="w-8 h-8 mx-auto text-slate-600" />
                <p className="text-sm font-semibold text-slate-300">No deployments found</p>
                <p className="text-xs text-slate-500">Click &apos;Deploy New Release&apos; to trigger a build.</p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[640px] overflow-y-auto pr-1">
                {deployments.map((d) => {
                  const isSelected = selected?._id === d._id;
                  const isActive = d.status === 'RUNNING' || d.status === 'ACTIVE';
                  const isPrev = d.status === 'PREVIOUS';

                  return (
                    <button
                      key={d._id}
                      onClick={() => {
                        setSelected(d);
                        setLogs(d.logs || []);
                      }}
                      className={`w-full text-left rounded-2xl border p-4 transition-all duration-200 ${
                        isSelected
                          ? 'bg-gradient-to-r from-indigo-950/70 to-slate-900 border-indigo-500/60 shadow-lg shadow-indigo-500/10 ring-1 ring-indigo-500/40'
                          : 'bg-[#0d0f17] border-white/5 hover:border-white/20 hover:bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={d.status} size="sm" />
                          {isActive && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                              ACTIVE
                            </span>
                          )}
                          {isPrev && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700/50 text-slate-300 border border-white/10">
                              PREVIOUS
                            </span>
                          )}
                          {d.releaseVersion && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                              v{d.releaseVersion}
                            </span>
                          )}
                        </div>
                        <span className="text-slate-500 text-[11px] font-mono">
                          {formatDistanceToNow(new Date(d.startedAt), { addSuffix: true })}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xs text-slate-400 mt-3 pt-2 border-t border-white/5 font-mono">
                        <span className="text-[11px] bg-black/50 px-2 py-0.5 rounded border border-white/5 text-slate-300 truncate max-w-[140px]">
                          {d.commitHash ? d.commitHash.slice(0, 7) : 'HEAD'}
                          {d.commitAuthor ? ` (${d.commitAuthor})` : ''}
                        </span>

                        {d.containerPort && (d.status === 'RUNNING' || d.status === 'ACTIVE') && (
                          <span className="text-emerald-400 font-semibold flex items-center gap-1 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            :{d.containerPort}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Active Deployment Console & Telemetry */}
          <div className="lg:col-span-8 space-y-5">
            {selected ? (
              <>
                {/* Telemetry Status Strip */}
                <div className="glass-card rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4 shadow-xl">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge status={selected.status} />

                    {selected.releaseVersion && (
                      <span className="text-xs text-indigo-300 font-bold font-mono bg-indigo-950/60 px-2.5 py-1 rounded-lg border border-indigo-500/30">
                        Release v{selected.releaseVersion}
                      </span>
                    )}

                    <span className="text-xs text-slate-400 font-mono bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
                      #{selected._id.slice(-8)}
                    </span>

                    <span className="text-xs text-indigo-300 font-mono bg-indigo-950/40 px-2.5 py-1 rounded-lg border border-indigo-500/20">
                      Trigger: {selected.trigger || 'MANUAL'}
                    </span>

                    {selected.commitHash && (
                      <span className="text-xs text-slate-300 font-mono bg-black/40 px-2.5 py-1 rounded-lg border border-white/5">
                        {selected.commitHash.slice(0, 7)}
                      </span>
                    )}

                    {sseConnected && (
                      <span className="text-[11px] text-emerald-400 font-mono bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/30 flex items-center gap-1.5">
                        <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
                        SSE Live Stream
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5">
                    {/* Rollback button if this is a previous release with an image */}
                    {(selected.status === 'PREVIOUS' || (selected.status === 'STOPPED' && selected.imageName)) && (
                      <button
                        onClick={() => handleRollback(selected._id, selected.releaseVersion ? `v${selected.releaseVersion}` : selected._id.slice(-6))}
                        disabled={rollingBack}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-xl text-xs font-bold transition-all shadow-md shadow-amber-500/10"
                      >
                        <Undo2 className="w-3.5 h-3.5 text-amber-400" />
                        <span>{rollingBack ? 'Rolling Back...' : 'Rollback to this Release'}</span>
                      </button>
                    )}

                    {selected.status === 'RUNNING' && selected.containerPort && (
                      <>
                        <a
                          href={`http://localhost:${selected.containerPort}`}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-xl text-xs font-bold transition-all shadow-md shadow-emerald-500/10 group"
                        >
                          <Globe className="w-3.5 h-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
                          <span>:{selected.containerPort}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>

                        <button
                          onClick={() => copyAppUrl(selected.containerPort!)}
                          className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white rounded-xl text-xs transition-colors"
                          title="Copy Localhost URL"
                        >
                          {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Performance Timings Breakdown Card */}
                {selected.timings && (
                  <div className="glass-card rounded-2xl p-4 border border-white/10">
                    <div className="flex items-center gap-2 mb-3 text-slate-300 font-mono text-xs font-bold">
                      <Timer className="w-4 h-4 text-indigo-400" />
                      <span>Deployment Performance Breakdown</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-center text-xs font-mono">
                      <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                        <span className="text-[10px] text-slate-500 block">Queue Wait</span>
                        <span className="text-white font-bold">{selected.timings.queueWaitMs || 0}ms</span>
                      </div>
                      <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                        <span className="text-[10px] text-slate-500 block">Git Clone</span>
                        <span className="text-white font-bold">{selected.timings.cloneDurationMs || 0}ms</span>
                      </div>
                      <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                        <span className="text-[10px] text-slate-500 block">Docker Build</span>
                        <span className="text-white font-bold">{selected.timings.buildDurationMs || 0}ms</span>
                      </div>
                      <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                        <span className="text-[10px] text-slate-500 block">Startup</span>
                        <span className="text-white font-bold">{selected.timings.containerStartupDurationMs || 0}ms</span>
                      </div>
                      <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                        <span className="text-[10px] text-slate-500 block">Proxy Switch</span>
                        <span className="text-indigo-300 font-bold">{selected.timings.proxySwitchDurationMs || 0}ms</span>
                      </div>
                      <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                        <span className="text-[10px] text-slate-500 block">Total Runtime</span>
                        <span className="text-emerald-400 font-bold">{Math.round((selected.timings.totalDurationMs || 0) / 1000)}s</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Error Banner */}
                {selected.status === 'FAILED' && selected.error && (
                  <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-semibold text-rose-200">Deployment Error</p>
                      <p className="font-mono text-[11px] text-rose-300/90">{selected.error}</p>
                    </div>
                  </div>
                )}

                {/* Terminal Logs */}
                <LogViewer logs={logs} isLive={isLive} />
              </>
            ) : (
              <div className="glass-card rounded-2xl h-[450px] flex flex-col items-center justify-center text-slate-500 space-y-3">
                <Terminal className="w-10 h-10 text-slate-600" />
                <p className="text-sm font-semibold text-slate-300">Select a release from the list</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Full Deployment History & Rollbacks */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Release &amp; Deployment History
            </h2>
            <button
              onClick={handleRedeploy}
              disabled={triggering || rollingBack}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition-all shadow-md shadow-indigo-600/30"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Deploy New Release</span>
            </button>
          </div>

          <div className="glass-card rounded-2xl overflow-hidden border border-white/10 shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 bg-black/40 text-slate-400 font-mono uppercase text-[10px]">
                    <th className="py-3 px-4">Release</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Trigger</th>
                    <th className="py-3 px-4">Commit / Author</th>
                    <th className="py-3 px-4">Branch</th>
                    <th className="py-3 px-4">Duration</th>
                    <th className="py-3 px-4">Triggered</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-medium text-slate-300">
                  {deployments.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        No deployments recorded yet.
                      </td>
                    </tr>
                  ) : (
                    deployments.map((d) => {
                      const isActive = d.status === 'RUNNING' || d.status === 'ACTIVE';
                      const isPrev = d.status === 'PREVIOUS';
                      const canRollback = (isPrev || (d.status === 'STOPPED' && d.imageName)) && !isActive;

                      return (
                        <tr key={d._id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 font-mono">
                            <span className="px-2 py-0.5 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-500/20 font-bold">
                              {d.releaseVersion ? `v${d.releaseVersion}` : `#${d._id.slice(-6)}`}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-1.5">
                              <StatusBadge status={d.status} size="sm" />
                              {isActive && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                                  ACTIVE
                                </span>
                              )}
                              {isPrev && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-700/50 text-slate-300 border border-white/10">
                                  PREVIOUS
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                                d.trigger === 'WEBHOOK'
                                  ? 'bg-purple-500/10 text-purple-300 border-purple-500/20'
                                  : d.trigger === 'ROLLBACK'
                                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                                  : d.trigger === 'RETRY'
                                  ? 'bg-blue-500/10 text-blue-300 border-blue-500/20'
                                  : 'bg-white/5 text-slate-400 border-white/10'
                              }`}
                            >
                              {d.trigger || 'MANUAL'}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-col">
                              <span className="font-mono text-white text-xs font-semibold">
                                {d.commitHash ? d.commitHash.slice(0, 7) : 'HEAD'}
                              </span>
                              {d.commitMessage && (
                                <span className="text-[11px] text-slate-400 truncate max-w-xs">
                                  {d.commitMessage}
                                </span>
                              )}
                              {d.commitAuthor && (
                                <span className="text-[10px] text-slate-500 font-mono">
                                  by {d.commitAuthor}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-400">
                            {project.productionBranch || project.branch || 'main'}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-400">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="w-3 h-3 text-slate-500" />
                              {formatDuration(d.startedAt, d.finishedAt)}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-400">
                            {formatDistanceToNow(new Date(d.startedAt), { addSuffix: true })}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {canRollback && (
                                <button
                                  onClick={() => handleRollback(d._id, d.releaseVersion ? `v${d.releaseVersion}` : d._id.slice(-6))}
                                  disabled={rollingBack}
                                  className="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-lg font-mono text-[11px] font-bold flex items-center gap-1 transition-colors"
                                  title="Instant Zero-Downtime Rollback to this release"
                                >
                                  <Undo2 className="w-3 h-3" />
                                  <span>Rollback</span>
                                </button>
                              )}

                              {isActive && d.containerPort && (
                                <a
                                  href={`http://localhost:${d.containerPort}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="p-1.5 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                                  title="Open Live App"
                                >
                                  <Globe className="w-3.5 h-3.5" />
                                </a>
                              )}

                              <button
                                onClick={() => {
                                  setSelected(d);
                                  setLogs(d.logs || []);
                                  setActiveTab('console');
                                }}
                                className="px-2.5 py-1 bg-white/5 hover:bg-white/10 rounded-lg text-slate-300 hover:text-white font-mono text-[11px] transition-colors"
                              >
                                Logs
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Live Resource Monitor */}
      {activeTab === 'resources' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider font-mono flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-400" />
                <span>Active Container Resource Telemetry</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Real-time telemetry gathered from Docker daemon and Prometheus instrumentation.
              </p>
            </div>
            <button
              onClick={fetchResourceStats}
              disabled={resourceLoading}
              className="text-xs font-mono text-indigo-400 hover:text-indigo-300 flex items-center gap-1 px-3 py-1.5 bg-white/5 rounded-xl border border-white/10"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${resourceLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>

          {resourceStats ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* CPU Usage Card */}
              <div className="glass-card rounded-2xl p-5 border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                    <Cpu className="w-4 h-4 text-indigo-400" />
                    CPU Utilization
                  </span>
                  <span className="text-xs font-bold font-mono text-indigo-300">
                    {resourceStats.cpuPercentage.toFixed(2)}%
                  </span>
                </div>
                <div className="w-full bg-black/50 h-2 rounded-full overflow-hidden border border-white/5">
                  <div
                    className="bg-gradient-to-r from-indigo-500 to-violet-500 h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.max(2, resourceStats.cpuPercentage))}%` }}
                  />
                </div>
                <span className="text-[11px] text-slate-500 font-mono block">Capped at 1.0 host CPU core</span>
              </div>

              {/* Memory Usage Card */}
              <div className="glass-card rounded-2xl p-5 border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    Memory Usage
                  </span>
                  <span className="text-xs font-bold font-mono text-emerald-300">
                    {Math.round(resourceStats.memoryUsageBytes / (1024 * 1024))} MB /{' '}
                    {Math.round(resourceStats.memoryLimitBytes / (1024 * 1024))} MB
                  </span>
                </div>
                <div className="w-full bg-black/50 h-2 rounded-full overflow-hidden border border-white/5">
                  <div
                    className="bg-gradient-to-r from-emerald-500 to-teal-500 h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.max(2, resourceStats.memoryPercentage))}%` }}
                  />
                </div>
                <span className="text-[11px] text-slate-500 font-mono block">
                  {resourceStats.memoryPercentage.toFixed(1)}% of 512MB quota
                </span>
              </div>

              {/* Container Uptime Card */}
              <div className="glass-card rounded-2xl p-5 border border-white/10 space-y-2">
                <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-amber-400" />
                  Container Uptime
                </span>
                <p className="text-xl font-bold font-mono text-white">
                  {Math.floor(resourceStats.uptimeSeconds / 60)}m {resourceStats.uptimeSeconds % 60}s
                </p>
                <span className="text-[11px] text-slate-500 font-mono block">
                  Status: <span className="text-emerald-400 uppercase font-bold">{resourceStats.status}</span>
                </span>
              </div>

              {/* Restarts & Self-Healing Card */}
              <div className="glass-card rounded-2xl p-5 border border-white/10 space-y-2">
                <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-purple-400" />
                  Auto-Recovery Restarts
                </span>
                <p className="text-xl font-bold font-mono text-white">
                  {resourceStats.restartCount || 0}{' '}
                  <span className="text-xs font-normal text-slate-500">/ {project.maxRestartAttempts || 3} max</span>
                </p>
                <span className="text-[11px] text-slate-500 font-mono block">
                  Container: {resourceStats.containerName || resourceStats.containerId.slice(0, 12)}
                </span>
              </div>
            </div>
          ) : (
            <div className="glass-card rounded-2xl p-12 text-center text-slate-500 space-y-3">
              <Box className="w-10 h-10 mx-auto text-slate-600" />
              <p className="text-sm font-semibold text-slate-300">No Active Container Currently Running</p>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Trigger a deployment to launch a container and stream real-time CPU, memory, and telemetry.
              </p>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: Environment Variables */}
      {activeTab === 'env' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                Environment Variables
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Variables are injected into the Docker container during build &amp; execution. Secrets are masked in deployment logs.
              </p>
            </div>
          </div>

          {envSuccessMsg && (
            <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-400" />
              <span>{envSuccessMsg}</span>
            </div>
          )}

          {envError && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400" />
              <span>{envError}</span>
            </div>
          )}

          {/* Add Variable Form Card */}
          <div className="glass-card rounded-2xl p-5 border border-white/10 space-y-4">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono">
              Add New Variable
            </h3>
            <form onSubmit={handleAddEnvVar} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-4">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Key Name</label>
                <input
                  required
                  value={newEnvKey}
                  onChange={(e) => setNewEnvKey(e.target.value)}
                  placeholder="e.g. DATABASE_URL"
                  className="w-full bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="sm:col-span-5">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">Value</label>
                <input
                  required
                  value={newEnvValue}
                  onChange={(e) => setNewEnvValue(e.target.value)}
                  placeholder="e.g. mongodb://localhost:27017/mydb"
                  className="w-full bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="sm:col-span-3 flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={newEnvSecret}
                    onChange={(e) => setNewEnvSecret(e.target.checked)}
                    className="rounded border-white/10 text-indigo-600"
                  />
                  <span>Mask / Secret</span>
                </label>

                <button
                  type="submit"
                  disabled={envSaving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl shadow-md shadow-indigo-600/30 transition-all flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
              </div>
            </form>
          </div>

          {/* Variables Table */}
          <div className="glass-card rounded-2xl overflow-hidden border border-white/10 shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 bg-black/40 text-slate-400 font-mono uppercase text-[10px]">
                    <th className="py-3 px-4">Key</th>
                    <th className="py-3 px-4">Value</th>
                    <th className="py-3 px-4">Type</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-slate-300">
                  {envLoading ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-500 font-sans">
                        Loading environment variables...
                      </td>
                    </tr>
                  ) : envVars.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-500 font-sans">
                        No environment variables defined for this project.
                      </td>
                    </tr>
                  ) : (
                    envVars.map((ev) => {
                      const isRevealed = Boolean(showSecrets[ev.key]);
                      return (
                        <tr key={ev.key} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 font-bold text-indigo-300">{ev.key}</td>
                          <td className="py-3 px-4 font-mono text-slate-300 max-w-md truncate">
                            {ev.isSecret && !isRevealed ? '••••••••••••••••' : ev.value}
                          </td>
                          <td className="py-3 px-4">
                            {ev.isSecret ? (
                              <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px]">
                                Secret
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-white/5 text-slate-400 border border-white/10 text-[10px]">
                                Plaintext
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {ev.isSecret && (
                                <button
                                  onClick={() =>
                                    setShowSecrets((prev) => ({
                                      ...prev,
                                      [ev.key]: !prev[ev.key],
                                    }))
                                  }
                                  className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
                                  title={isRevealed ? 'Hide' : 'Reveal'}
                                >
                                  {isRevealed ? (
                                    <EyeOff className="w-3.5 h-3.5" />
                                  ) : (
                                    <Eye className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}

                              <button
                                onClick={() => handleDeleteEnvVar(ev.key)}
                                className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors"
                                title="Delete Variable"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: Settings & Webhooks */}
      {activeTab === 'settings' && (
        <div className="space-y-8">
          {settingsSuccessMsg && (
            <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-400" />
              <span>{settingsSuccessMsg}</span>
            </div>
          )}

          {/* Deployment Trigger & Recovery Controls */}
          <div className="glass-card rounded-3xl p-6 md:p-8 border border-white/10 space-y-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Sliders className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">Platform &amp; Release Policies</h2>
                <p className="text-xs text-slate-400">Configure continuous delivery, trigger policies, and automatic self-healing.</p>
              </div>
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Auto Deploy Toggle */}
                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 flex items-center justify-between">
                  <div className="space-y-1">
                    <label className="text-sm font-semibold text-white flex items-center gap-2">
                      <Zap className="w-4 h-4 text-emerald-400" />
                      Automatic Deployment on Push
                    </label>
                    <p className="text-xs text-slate-400">Automatically trigger zero-downtime build on git push.</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoDeploy}
                      onChange={(e) => setAutoDeploy(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>

                {/* Allow Manual Deploy Toggle */}
                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 flex items-center justify-between">
                  <div className="space-y-1">
                    <label className="text-sm font-semibold text-white flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-indigo-400" />
                      Allow Manual Trigger
                    </label>
                    <p className="text-xs text-slate-400">Allow users to click Redeploy button from the console.</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowManualDeploy}
                      onChange={(e) => setAllowManualDeploy(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>

                {/* Auto Container Recovery Toggle */}
                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 flex items-center justify-between">
                  <div className="space-y-1">
                    <label className="text-sm font-semibold text-white flex items-center gap-2">
                      <Activity className="w-4 h-4 text-amber-400" />
                      Auto-Recovery Self Healing
                    </label>
                    <p className="text-xs text-slate-400">Automatically restart active container if it crashes.</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRecovery}
                      onChange={(e) => setAutoRecovery(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-600"></div>
                  </label>
                </div>

                {/* Max Restart Attempts */}
                <div className="p-4 rounded-2xl bg-black/40 border border-white/5 space-y-2">
                  <label className="text-xs font-semibold text-slate-300 font-mono">Max Restart Attempts</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={maxRestartAttempts}
                    onChange={(e) => setMaxRestartAttempts(parseInt(e.target.value, 10) || 3)}
                    className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <p className="text-[11px] text-slate-500">Container marked UNHEALTHY if restarts exceed this limit.</p>
                </div>

                {/* Production Branch Input */}
                <div className="md:col-span-2 space-y-2">
                  <label className="text-xs font-semibold text-slate-300 font-mono">Production Deployment Branch</label>
                  <input
                    value={productionBranch}
                    onChange={(e) => setProductionBranch(e.target.value)}
                    placeholder="main"
                    className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <p className="text-[11px] text-slate-500">Pushes to other branches will be ignored by the webhook trigger.</p>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={settingsSaving}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
                >
                  {settingsSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </form>
          </div>

          {/* GitHub Webhook Setup Guide & Secret */}
          <div className="glass-card rounded-3xl p-6 md:p-8 border border-white/10 space-y-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <Webhook className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">GitHub Webhook Integration</h2>
                <p className="text-xs text-slate-400">Configure GitHub Webhook to automatically trigger continuous deployments on git push.</p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-mono">
              {/* Payload URL */}
              <div className="space-y-1.5">
                <label className="text-slate-400 font-semibold">Payload URL (POST)</label>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={webhookPayloadUrl}
                    className="w-full bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-white text-xs select-all"
                  />
                  <button
                    onClick={copyWebhookUrl}
                    className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-slate-300 hover:text-white transition-colors shrink-0"
                    title="Copy URL"
                  >
                    {copiedWebhookUrl ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Secret Token */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-slate-400 font-semibold">Webhook Secret (HMAC-SHA256)</label>
                  <button
                    onClick={handleRotateSecret}
                    className="text-[11px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-sans"
                  >
                    <RotateCw className="w-3 h-3" />
                    <span>Rotate Secret</span>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    type={showWebhookSecret ? 'text' : 'password'}
                    value={project.webhookSecret || '••••••••••••••••••••••••••••••••'}
                    className="w-full bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-white text-xs font-mono select-all"
                  />
                  <button
                    onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                    className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-slate-300 hover:text-white transition-colors shrink-0"
                    title={showWebhookSecret ? 'Hide' : 'Show'}
                  >
                    {showWebhookSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => project.webhookSecret && copySecret(project.webhookSecret)}
                    className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-slate-300 hover:text-white transition-colors shrink-0"
                    title="Copy Secret"
                  >
                    {copiedSecret ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* GitHub instructions box */}
              <div className="p-4 rounded-2xl bg-black/40 border border-white/5 space-y-2 text-slate-300 font-sans text-xs">
                <p className="font-semibold text-white">How to set up GitHub Webhook:</p>
                <ol className="list-decimal list-inside space-y-1 text-slate-400">
                  <li>Go to your GitHub repository &gt; <strong>Settings</strong> &gt; <strong>Webhooks</strong> &gt; <strong>Add webhook</strong></li>
                  <li>Paste the <strong>Payload URL</strong> above into GitHub</li>
                  <li>Set <strong>Content type</strong> to <code className="text-indigo-300 bg-white/5 px-1 py-0.5 rounded">application/json</code></li>
                  <li>Paste the <strong>Secret</strong> into the Secret field</li>
                  <li>Select <strong>Just the push event</strong> and click <strong>Add webhook</strong></li>
                </ol>
              </div>
            </div>
          </div>

          {/* Danger Zone: Delete Project */}
          <div className="glass-card rounded-3xl p-6 md:p-8 border border-rose-500/30 bg-rose-950/10 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">Danger Zone</h2>
                <p className="text-xs text-slate-400">Permanently remove this project, container instances, build history, and environment variables.</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-rose-500/20">
              <div className="text-xs text-slate-400">
                <p className="font-semibold text-slate-300">Delete this project</p>
                <p className="text-[11px] text-slate-500">Once deleted, your active container will be stopped and deleted permanently.</p>
              </div>

              <button
                type="button"
                onClick={handleDeleteProject}
                disabled={deleting}
                className="px-4 py-2.5 bg-rose-600/90 hover:bg-rose-600 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-lg shadow-rose-600/20 transition-all flex items-center justify-center gap-2 shrink-0"
              >
                <Trash2 className="w-4 h-4" />
                <span>{deleting ? 'Deleting Project...' : 'Delete Entire Project'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
