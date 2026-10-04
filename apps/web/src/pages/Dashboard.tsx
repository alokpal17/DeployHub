import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { projectsApi, githubApi, deploymentsApi } from '../services/api';
import type { Project, GitHubRepo, GitHubBranch, GitHubAuthStatus, EnvVar } from '@deployhub/shared';
import { formatDistanceToNow } from 'date-fns';
import {
  Plus,
  Search,
  GitBranch,
  Trash2,
  Boxes,
  Activity,
  Cpu,
  ArrowUpRight,
  Sparkles,
  Rocket,
  X,
  Lock,
  Eye,
  EyeOff,
  Check,
  RefreshCw,
  Code2,
  KeyRound,
} from 'lucide-react';
import { Github } from '../components/ui/Icons';

const SAMPLE_REPOS = [
  {
    name: 'express-microservice',
    repositoryUrl: 'https://github.com/expressjs/express',
    branch: 'master',
    framework: 'nodejs-backend',
    desc: 'Production-ready Node.js REST API with zero config',
    badge: 'Node.js',
  },
  {
    name: 'vite-react-spa',
    repositoryUrl: 'https://github.com/vitejs/vite',
    branch: 'main',
    framework: 'nodejs-spa',
    desc: 'Ultra-fast React single-page frontend application',
    badge: 'React / Vite',
  },
  {
    name: 'hono-edge-service',
    repositoryUrl: 'https://github.com/honojs/starter-node',
    branch: 'main',
    framework: 'nodejs-backend',
    desc: 'High-throughput containerized web service',
    badge: 'TypeScript',
  },
];

const FRAMEWORK_OPTIONS = [
  { id: '', label: '⚡ Auto-Detect Framework', desc: 'DeployHub analyzes package.json / Dockerfile' },
  { id: 'nodejs-backend', label: 'Node.js Backend / API', desc: 'Express, Fastify, Nest, Hono' },
  { id: 'nodejs-spa', label: 'Single Page App (SPA)', desc: 'React, Vue, Vite, Svelte, Angular' },
  { id: 'static-html', label: 'Static HTML / Web', desc: 'HTML5, CSS, vanilla JS' },
  { id: 'dockerfile', label: 'Custom Dockerfile', desc: 'Build using repository Dockerfile' },
];

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showGitHubModal, setShowGitHubModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // GitHub State
  const [ghStatus, setGhStatus] = useState<GitHubAuthStatus>({ connected: false });
  const [ghTokenInput, setGhTokenInput] = useState('');
  const [ghConnecting, setGhConnecting] = useState(false);
  const [ghRepos, setGhRepos] = useState<GitHubRepo[]>([]);
  const [ghRepoSearch, setGhRepoSearch] = useState('');
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Form State
  const [creationMode, setCreationMode] = useState<'github' | 'manual'>('github');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [form, setForm] = useState({
    name: '',
    repositoryUrl: '',
    branch: 'main',
    framework: '',
  });
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<number, boolean>>({});

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Initial Load
  useEffect(() => {
    loadProjects();
    checkGitHubStatus();
  }, []);

  async function loadProjects() {
    setLoading(true);
    try {
      const data = await projectsApi.list();
      setProjects(data || []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }

  async function checkGitHubStatus() {
    try {
      const status = await githubApi.status();
      setGhStatus(status);
      if (status.connected) {
        fetchGitHubRepos();
      }
    } catch {
      setGhStatus({ connected: false });
    }
  }

  async function fetchGitHubRepos(query?: string) {
    setLoadingRepos(true);
    try {
      const repos = await githubApi.repos(query);
      setGhRepos(repos || []);
    } catch {
      setGhRepos([]);
    } finally {
      setLoadingRepos(false);
    }
  }

  async function handleConnectGitHub(e: React.FormEvent) {
    e.preventDefault();
    if (!ghTokenInput.trim()) return;
    setGhConnecting(true);
    setError('');
    try {
      const status = await githubApi.connect(ghTokenInput.trim());
      setGhStatus(status);
      setGhTokenInput('');
      setShowGitHubModal(false);
      fetchGitHubRepos();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to connect GitHub token');
    } finally {
      setGhConnecting(false);
    }
  }

  async function handleDisconnectGitHub() {
    if (!confirm('Disconnect your GitHub account?')) return;
    try {
      await githubApi.disconnect();
      setGhStatus({ connected: false });
      setGhRepos([]);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSelectRepo(repo: GitHubRepo) {
    setSelectedRepo(repo);
    setForm((prev) => ({
      ...prev,
      name: repo.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      repositoryUrl: repo.htmlUrl,
      branch: repo.defaultBranch || 'main',
    }));

    // Fetch branches for this repo
    setLoadingBranches(true);
    try {
      const branchList = await githubApi.branches(repo.owner, repo.name);
      setBranches(branchList);
    } catch {
      setBranches([{ name: repo.defaultBranch || 'main', isDefault: true }]);
    } finally {
      setLoadingBranches(false);
    }
  }

  function handleAddEnvVar() {
    if (!newEnvKey.trim()) return;
    const key = newEnvKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setError('Environment variable key must match /^[A-Za-z_][A-Za-z0-9_]*$/');
      return;
    }
    setEnvVars((prev) => [
      ...prev.filter((v) => v.key !== key),
      { key, value: newEnvValue, isSecret: newEnvSecret },
    ]);
    setNewEnvKey('');
    setNewEnvValue('');
    setNewEnvSecret(false);
    setError('');
  }

  function handleRemoveEnvVar(index: number) {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  }

  function applyPreset(preset: { name: string; repositoryUrl: string; branch: string; framework: string }) {
    setForm({
      name: preset.name,
      repositoryUrl: preset.repositoryUrl,
      branch: preset.branch,
      framework: preset.framework,
    });
    setCreationMode('manual');
    setSelectedRepo(null);
  }

  async function createProjectAndDeploy(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError('');

    try {
      const project = await projectsApi.create({
        name: form.name,
        repositoryUrl: form.repositoryUrl,
        branch: form.branch || 'main',
        framework: form.framework || undefined,
        envVars,
      });

      // Automatically trigger initial deployment
      try {
        await deploymentsApi.trigger(project._id);
      } catch (deployErr) {
        console.warn('Deployment trigger error:', deployErr);
      }

      setProjects((prev) => [project, ...prev]);
      setShowModal(false);
      resetModalForm();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }

  function resetModalForm() {
    setForm({ name: '', repositoryUrl: '', branch: 'main', framework: '' });
    setSelectedRepo(null);
    setEnvVars([]);
    setNewEnvKey('');
    setNewEnvValue('');
    setError('');
  }

  async function deleteProject(id: string, name: string) {
    if (!confirm(`Are you sure you want to delete "${name}" and all of its deployments?`)) return;
    try {
      await projectsApi.delete(id);
      setProjects((prev) => prev.filter((p) => p._id !== id));
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete project');
    }
  }

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.repositoryUrl.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-8 font-sans">
      {/* Top Welcome Banner */}
      <div className="relative rounded-3xl p-8 overflow-hidden border border-white/10 bg-gradient-to-r from-indigo-950/50 via-[#0e111a] to-[#0c0e16] shadow-2xl">
        <div className="absolute right-0 top-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />
        <div className="absolute -left-10 -bottom-10 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>Developer Cloud Platform</span>
              </div>

              {ghStatus.connected ? (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                  <Github className="w-3.5 h-3.5" />
                  <span>@{ghStatus.username}</span>
                  <button
                    onClick={handleDisconnectGitHub}
                    className="ml-1 text-slate-400 hover:text-rose-400"
                    title="Disconnect"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setShowGitHubModal(true);
                    setError('');
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition-colors"
                >
                  <Github className="w-3.5 h-3.5" />
                  <span>Connect GitHub</span>
                </button>
              )}
            </div>

            <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight">
              Projects &amp; Deployments
            </h1>
            <p className="text-slate-400 text-sm max-w-xl">
              Connect Git repositories, configure environment variables, and manage container lifecycle with automated builds.
            </p>
          </div>

          <button
            onClick={() => {
              setShowModal(true);
              resetModalForm();
            }}
            className="flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-sm font-semibold px-6 py-3 rounded-2xl shadow-xl shadow-indigo-600/30 hover:shadow-indigo-600/40 transition-all active:scale-95 shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>New Project</span>
          </button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-card rounded-2xl p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Active Projects</span>
            <Boxes className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="text-2xl font-bold text-white font-mono">{projects.length}</p>
          <p className="text-[11px] text-slate-500 font-mono">Isolated environments</p>
        </div>

        <div className="glass-card rounded-2xl p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>GitHub Sync</span>
            <Github className="w-4 h-4 text-slate-300" />
          </div>
          <p className="text-2xl font-bold text-slate-200 font-mono">
            {ghStatus.connected ? 'Connected' : 'Manual / Demo'}
          </p>
          <p className="text-[11px] text-slate-500 font-mono">
            {ghStatus.connected ? `@${ghStatus.username}` : 'OAuth / PAT ready'}
          </p>
        </div>

        <div className="glass-card rounded-2xl p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Worker Queue</span>
            <Activity className="w-4 h-4 text-sky-400" />
          </div>
          <p className="text-2xl font-bold text-sky-400 font-mono">BullMQ Active</p>
          <p className="text-[11px] text-slate-500 font-mono">Concurrent sandbox builds</p>
        </div>

        <div className="glass-card rounded-2xl p-5 space-y-1">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Container Sandboxes</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-bold text-emerald-400 font-mono">Docker Native</p>
          <p className="text-[11px] text-slate-500 font-mono">Resource &amp; port isolation</p>
        </div>
      </div>

      {/* Projects Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Your Projects</h2>
          <p className="text-slate-500 text-xs mt-0.5">
            Select a project to inspect live container status, build history, and environment variables.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search projects or repos..."
            className="w-full bg-[#0d0f17] border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-medium"
          />
        </div>
      </div>

      {/* Projects List */}
      {loading ? (
        <div className="p-16 flex flex-col items-center justify-center text-slate-500 text-sm space-y-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span>Loading projects...</span>
        </div>
      ) : projects.length === 0 ? (
        <div className="glass-card rounded-3xl p-12 text-center text-slate-500 space-y-4 border border-dashed border-white/10">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <Boxes className="w-8 h-8" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <p className="text-lg font-bold text-slate-200">No projects created yet</p>
            <p className="text-xs text-slate-400">
              Connect a GitHub repository or use one of the 1-click test templates to create your first deployment.
            </p>
          </div>
          <button
            onClick={() => {
              setShowModal(true);
              resetModalForm();
            }}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-5 py-2.5 rounded-xl shadow-lg shadow-indigo-600/20 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>Create New Project</span>
          </button>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-16 text-slate-500 text-sm">
          No projects matching &quot;{searchQuery}&quot;
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredProjects.map((project) => (
            <div
              key={project._id}
              className="glass-card glass-card-hover rounded-2xl p-6 flex flex-col justify-between group relative overflow-hidden"
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-indigo-950 to-slate-900 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-base shadow-sm ring-1 ring-white/5">
                      {project.name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <Link
                        to={`/projects/${project._id}`}
                        className="text-white font-bold text-base hover:text-indigo-400 transition-colors truncate block"
                      >
                        {project.name}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400">
                          <GitBranch className="w-3 h-3 text-indigo-400" />
                          {project.branch || 'main'}
                        </span>
                        {project.framework && (
                          <span className="text-[10px] font-mono bg-white/5 px-2 py-0.5 rounded text-slate-400 border border-white/5">
                            {project.framework}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <a
                    href={project.repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
                    title="Open GitHub repository"
                  >
                    <Github className="w-4 h-4" />
                  </a>
                </div>

                {/* Repo Pill */}
                <div className="p-2.5 rounded-xl bg-black/40 border border-white/5 font-mono text-xs text-slate-400 truncate flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                  <span className="truncate">{project.repositoryUrl.replace('https://github.com/', '')}</span>
                </div>

                {/* Env Vars Badge */}
                {project.envVars && project.envVars.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                    <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                    <span>{project.envVars.length} Environment Variables</span>
                  </div>
                )}
              </div>

              {/* Card Footer */}
              <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between">
                <span className="text-slate-500 text-[11px] font-mono">
                  {formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}
                </span>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => deleteProject(project._id, project.name)}
                    className="p-2 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all"
                    title="Delete project"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  <Link
                    to={`/projects/${project._id}`}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-md shadow-indigo-600/30 transition-all active:scale-95"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    <span>Deploy &amp; Inspect</span>
                    <ArrowUpRight className="w-3.5 h-3.5 opacity-70" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* GitHub Connect Modal */}
      {showGitHubModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="glass-card rounded-3xl p-7 max-w-lg w-full space-y-5 shadow-2xl border border-white/10 relative">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                  <Github className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">Connect GitHub Account</h2>
                  <p className="text-xs text-slate-400">Authenticate to import and select your repositories.</p>
                </div>
              </div>
              <button
                onClick={() => setShowGitHubModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/5"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConnectGitHub} className="space-y-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-300">
                  GitHub Personal Access Token (PAT)
                </label>
                <input
                  type="password"
                  required
                  value={ghTokenInput}
                  onChange={(e) => setGhTokenInput(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full bg-black/60 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Generate a token in GitHub Settings &gt; Developer Settings &gt; Personal access tokens with <code className="text-indigo-300">repo</code> scope.
                </p>
              </div>

              {error && (
                <div className="text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 rounded-xl p-3">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowGitHubModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={ghConnecting}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold px-5 py-2.5 rounded-xl shadow-lg shadow-indigo-600/30 transition-all flex items-center gap-2"
                >
                  {ghConnecting ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : (
                    'Connect Account'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Project Creation Flow Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
          <div className="glass-card rounded-3xl p-7 max-w-3xl w-full space-y-6 shadow-2xl border border-white/10 relative max-h-[92vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                  <Rocket className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">Create &amp; Deploy Project</h2>
                  <p className="text-xs text-slate-400">Configure repository source, runtime, and environment variables.</p>
                </div>
              </div>

              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/5"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick 1-Click Templates Strip */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-mono font-semibold uppercase tracking-wider text-indigo-400">
                  ⚡ 1-Click Quick Templates
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {SAMPLE_REPOS.map((sample) => (
                  <button
                    type="button"
                    key={sample.name}
                    onClick={() => applyPreset(sample)}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      form.name === sample.name
                        ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500/40'
                        : 'bg-black/40 border-white/5 hover:border-white/20 text-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-xs font-bold text-white truncate">{sample.name}</span>
                      <span className="text-[10px] font-mono bg-white/10 px-1.5 py-0.5 rounded text-slate-300">
                        {sample.badge}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 truncate">{sample.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Source Mode Tabs */}
            <div className="flex items-center gap-2 border-b border-white/10 pb-3">
              <button
                type="button"
                onClick={() => setCreationMode('github')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                  creationMode === 'github'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'bg-white/5 text-slate-400 hover:text-white'
                }`}
              >
                <Github className="w-4 h-4" />
                <span>GitHub Repositories</span>
                {ghStatus.connected && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
              </button>

              <button
                type="button"
                onClick={() => setCreationMode('manual')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                  creationMode === 'manual'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'bg-white/5 text-slate-400 hover:text-white'
                }`}
              >
                <Code2 className="w-4 h-4" />
                <span>Custom Git URL</span>
              </button>
            </div>

            <form onSubmit={createProjectAndDeploy} className="space-y-5">
              {/* GitHub Repository Selector */}
              {creationMode === 'github' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-300">Select Repository</label>
                    <button
                      type="button"
                      onClick={() => fetchGitHubRepos(ghRepoSearch)}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-mono"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Refresh</span>
                    </button>
                  </div>

                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={ghRepoSearch}
                      onChange={(e) => {
                        setGhRepoSearch(e.target.value);
                        fetchGitHubRepos(e.target.value);
                      }}
                      placeholder="Search accessible repositories..."
                      className="w-full bg-black/60 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-medium"
                    />
                  </div>

                  <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1 border border-white/5 rounded-xl p-2 bg-black/30">
                    {loadingRepos ? (
                      <div className="py-6 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
                        <span className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                        <span>Fetching repositories...</span>
                      </div>
                    ) : ghRepos.length === 0 ? (
                      <div className="py-6 text-center text-slate-500 text-xs">
                        No repositories found. Connect your GitHub token above or use Custom Git URL.
                      </div>
                    ) : (
                      ghRepos.map((repo) => {
                        const isChosen = selectedRepo?.id === repo.id;
                        return (
                          <button
                            key={repo.id}
                            type="button"
                            onClick={() => handleSelectRepo(repo)}
                            className={`w-full p-2.5 rounded-lg text-left flex items-center justify-between transition-colors ${
                              isChosen
                                ? 'bg-indigo-600/30 border border-indigo-500/50 text-white'
                                : 'hover:bg-white/5 text-slate-300'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold font-mono text-white truncate">
                                  {repo.fullName}
                                </span>
                                {repo.isPrivate && (
                                  <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                                )}
                              </div>
                              {repo.description && (
                                <p className="text-[11px] text-slate-400 truncate mt-0.5">
                                  {repo.description}
                                </p>
                              )}
                            </div>

                            {isChosen && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* Project Name & Branch Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">Project Name</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. backend-api"
                    className="w-full bg-black/60 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-medium"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {loadingBranches ? 'Fetching Branches...' : 'Branch'}
                  </label>
                  {branches.length > 0 ? (
                    <select
                      value={form.branch}
                      onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
                      className="w-full bg-black/60 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                    >
                      {branches.map((b) => (
                        <option key={b.name} value={b.name} className="bg-[#0e111a] text-white">
                          {b.name} {b.isDefault ? '(default)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      required
                      value={form.branch}
                      onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
                      placeholder="main"
                      className="w-full bg-black/60 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                    />
                  )}
                </div>
              </div>

              {/* Repository URL Input (if manual mode or for review) */}
              {creationMode === 'manual' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">Git Repository URL</label>
                  <input
                    required
                    value={form.repositoryUrl}
                    onChange={(e) => setForm((f) => ({ ...f, repositoryUrl: e.target.value }))}
                    placeholder="https://github.com/org/repo or local fixture path"
                    className="w-full bg-black/60 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              )}

              {/* Framework / Runtime Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Framework / Runtime Detection
                </label>
                <select
                  value={form.framework}
                  onChange={(e) => setForm((f) => ({ ...f, framework: e.target.value }))}
                  className="w-full bg-black/60 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-medium"
                >
                  {FRAMEWORK_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id} className="bg-[#0e111a] text-white">
                      {opt.label} — {opt.desc}
                    </option>
                  ))}
                </select>
              </div>

              {/* Environment Variables Editor */}
              <div className="space-y-3 pt-2 border-t border-white/10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="text-xs font-semibold text-slate-300">Environment Variables</span>
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono">{envVars.length} added</span>
                </div>

                {/* List of defined env vars */}
                {envVars.length > 0 && (
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {envVars.map((ev, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-lg bg-black/40 border border-white/5 font-mono text-xs"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className="text-indigo-300 font-bold">{ev.key}</span>
                          <span className="text-slate-500">=</span>
                          <span className="text-slate-300 truncate">
                            {ev.isSecret && !showSecrets[idx] ? '••••••••' : ev.value}
                          </span>
                          {ev.isSecret && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                              secret
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1">
                          {ev.isSecret && (
                            <button
                              type="button"
                              onClick={() =>
                                setShowSecrets((prev) => ({ ...prev, [idx]: !prev[idx] }))
                              }
                              className="p-1 text-slate-500 hover:text-slate-300"
                            >
                              {showSecrets[idx] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveEnvVar(idx)}
                            className="p-1 text-slate-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add new env var input row */}
                <div className="grid grid-cols-12 gap-2">
                  <input
                    value={newEnvKey}
                    onChange={(e) => setNewEnvKey(e.target.value)}
                    placeholder="KEY (e.g. API_URL)"
                    className="col-span-4 bg-black/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <input
                    value={newEnvValue}
                    onChange={(e) => setNewEnvValue(e.target.value)}
                    placeholder="value"
                    className="col-span-5 bg-black/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <div className="col-span-3 flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={newEnvSecret}
                        onChange={(e) => setNewEnvSecret(e.target.checked)}
                        className="rounded border-white/10 text-indigo-600"
                      />
                      <span>Secret</span>
                    </label>
                    <button
                      type="button"
                      onClick={handleAddEnvVar}
                      className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold rounded-lg transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>

              {error && (
                <div className="text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 flex items-center gap-2">
                  <span>⚠️</span>
                  <span>{error}</span>
                </div>
              )}

              {/* Modal Action Buttons */}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || (!form.repositoryUrl && !selectedRepo)}
                  className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50 text-white text-xs font-semibold px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-600/30 transition-all flex items-center gap-2"
                >
                  {creating ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Creating &amp; Queuing Build...</span>
                    </>
                  ) : (
                    <>
                      <Rocket className="w-3.5 h-3.5" />
                      <span>Deploy Project</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
