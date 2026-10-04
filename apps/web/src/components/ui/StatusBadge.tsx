import type { DeploymentStatus } from '@deployhub/shared';
import { CheckCircle2, Clock, Loader2, AlertCircle, StopCircle, RefreshCw } from 'lucide-react';

const STATUS_CONFIG: Record<
  DeploymentStatus,
  { label: string; bg: string; text: string; border: string; dot: string; icon: any }
> = {
  QUEUED: {
    label: 'Queued',
    bg: 'bg-zinc-800/60',
    text: 'text-zinc-300',
    border: 'border-zinc-700/60',
    dot: 'bg-zinc-400',
    icon: Clock,
  },
  BUILDING: {
    label: 'Building Image',
    bg: 'bg-amber-500/10',
    text: 'text-amber-300',
    border: 'border-amber-500/30',
    dot: 'bg-amber-400',
    icon: RefreshCw,
  },
  DEPLOYING: {
    label: 'Deploying',
    bg: 'bg-sky-500/10',
    text: 'text-sky-300',
    border: 'border-sky-500/30',
    dot: 'bg-sky-400',
    icon: Loader2,
  },
  RUNNING: {
    label: 'Active & Live',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-300',
    border: 'border-emerald-500/30',
    dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
    icon: CheckCircle2,
  },
  ACTIVE: {
    label: 'Active Release',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-300',
    border: 'border-emerald-500/30',
    dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
    icon: CheckCircle2,
  },
  HEALTH_CHECKING: {
    label: 'Health Probing',
    bg: 'bg-indigo-500/10',
    text: 'text-indigo-300',
    border: 'border-indigo-500/30',
    dot: 'bg-indigo-400',
    icon: Loader2,
  },
  ROLLING_BACK: {
    label: 'Rolling Back',
    bg: 'bg-amber-500/10',
    text: 'text-amber-300',
    border: 'border-amber-500/30',
    dot: 'bg-amber-400',
    icon: RefreshCw,
  },
  PREVIOUS: {
    label: 'Previous Release',
    bg: 'bg-zinc-800/60',
    text: 'text-zinc-400',
    border: 'border-zinc-700/60',
    dot: 'bg-zinc-500',
    icon: Clock,
  },
  FAILED: {
    label: 'Failed',
    bg: 'bg-rose-500/10',
    text: 'text-rose-300',
    border: 'border-rose-500/30',
    dot: 'bg-rose-400',
    icon: AlertCircle,
  },
  STOPPED: {
    label: 'Stopped',
    bg: 'bg-zinc-900/80',
    text: 'text-zinc-400',
    border: 'border-zinc-700/60',
    dot: 'bg-zinc-500',
    icon: StopCircle,
  },
};

export function StatusBadge({ status, size = 'md' }: { status: DeploymentStatus; size?: 'sm' | 'md' }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.FAILED;
  const Icon = cfg.icon;
  const isSpinning = status === 'BUILDING' || status === 'DEPLOYING';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium border ${cfg.bg} ${cfg.text} ${cfg.border} ${
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${isSpinning ? 'animate-spin' : ''}`} />
      <span>{cfg.label}</span>
    </span>
  );
}

