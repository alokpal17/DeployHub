import { useState, useEffect } from 'react';
import type { User, GitHubAuthStatus } from '@deployhub/shared';
import { githubApi } from '../../services/api';
import {
  X,
  User as UserIcon,
  Shield,
  Key,
  Check,
  Copy,
  LogOut,
  Sparkles,
} from 'lucide-react';
import { Github } from '../ui/Icons';

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onLogout: () => void;
}

export function AccountModal({ isOpen, onClose, user, onLogout }: AccountModalProps) {
  const [copied, setCopied] = useState(false);
  const [ghStatus, setGhStatus] = useState<GitHubAuthStatus>({ connected: false });
  const [loadingGh, setLoadingGh] = useState(false);

  const token = localStorage.getItem('token') || '';

  useEffect(() => {
    if (isOpen) {
      setLoadingGh(true);
      githubApi
        .status()
        .then((s) => setGhStatus(s))
        .catch(() => setGhStatus({ connected: false }))
        .finally(() => setLoadingGh(false));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const displayUser = user || {
    id: 'local-demo-user',
    username: 'Developer',
    email: 'dev@deployhub.local',
    avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=Developer',
    role: 'Admin',
    createdAt: new Date().toISOString(),
  };

  const copyToken = () => {
    if (token) {
      navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-lg bg-[#0e111a] border border-white/10 rounded-2xl shadow-2xl overflow-hidden text-slate-100 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
              <UserIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Account & Profile Settings
              </h2>
              <p className="text-xs text-slate-400">Manage identity, permissions, and connected accounts</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* User Profile Card */}
          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 flex items-center gap-4">
            <img
              src={displayUser.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${displayUser.username}`}
              alt={displayUser.username}
              className="w-14 h-14 rounded-2xl bg-indigo-950 border border-indigo-500/30 ring-2 ring-white/10 shadow-lg object-cover"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-base text-white truncate">{displayUser.username}</h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Active
                </span>
              </div>
              <p className="text-xs font-mono text-slate-400 truncate mt-0.5">{displayUser.email}</p>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] font-medium text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-md flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  Personal Workspace
                </span>
                <span className="text-[11px] font-mono text-slate-500">ID: {String((displayUser as any)._id || (displayUser as any).id || 'usr_default').slice(-8)}</span>
              </div>
            </div>
          </div>

          {/* Account Details Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500 font-mono flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-indigo-400" />
                Access Role
              </span>
              <p className="text-xs font-semibold text-slate-200">Owner & Administrator</p>
            </div>

            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/5 space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500 font-mono flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5 text-violet-400" />
                API Connection
              </span>
              <p className="text-xs font-semibold text-emerald-400">:3001 Active</p>
            </div>
          </div>

          {/* GitHub Integration Status */}
          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#161b22] border border-white/10 flex items-center justify-center">
                  <Github className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-slate-200">GitHub Integration</h4>
                  <p className="text-[11px] text-slate-400">Sync repositories & branch deployments</p>
                </div>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                  ghStatus.connected
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-slate-800 text-slate-400 border-white/10'
                }`}
              >
                {loadingGh ? 'Checking...' : ghStatus.connected ? `Connected (@${ghStatus.username})` : 'Not Connected'}
              </span>
            </div>
          </div>

          {/* Session Token Inspector */}
          <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5 text-indigo-400" />
                JWT Auth Bearer Token
              </span>
              <button
                onClick={copyToken}
                className="text-[11px] font-medium text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied!' : 'Copy Token'}
              </button>
            </div>
            <div className="p-2.5 rounded-lg bg-black/50 border border-white/5 font-mono text-[11px] text-slate-400 break-all select-all">
              {token ? `${token.slice(0, 32)}...${token.slice(-16)}` : 'No active token found in session'}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-white/10 bg-white/[0.02] flex items-center justify-between">
          <button
            onClick={() => {
              onClose();
              onLogout();
            }}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium text-rose-400 hover:bg-rose-500/10 border border-rose-500/20 transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/20 text-white transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
