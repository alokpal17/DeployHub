import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { authApi, healthApi } from '../../services/api';
import type { User } from '@deployhub/shared';
import { AccountModal } from '../account/AccountModal';
import {
  Boxes,
  Activity,
  Server,
  LogOut,
  Sparkles,
  User as UserIcon,
  Settings,
} from 'lucide-react';
import { Github } from '../ui/Icons';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Projects', icon: Boxes },
];

export function Sidebar() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [apiOnline, setApiOnline] = useState(true);
  const [showAccountModal, setShowAccountModal] = useState(false);

  useEffect(() => {
    // Check actual API server health
    healthApi
      .check()
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false));

    // Fetch user profile with local demo fallback
    authApi
      .me()
      .then((u) => setUser(u))
      .catch(() => {
        const stored = localStorage.getItem('demo_user');
        if (stored) {
          try {
            setUser(JSON.parse(stored));
            return;
          } catch {}
        }
        setUser({
          id: 'user_dev',
          username: 'Developer',
          email: 'admin@deployhub.local',
          avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=Developer',
        } as any);
      });
  }, []);

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('demo_user');
    navigate('/login');
  }

  const currentUser = user || {
    id: 'user_dev',
    username: 'Developer',
    email: 'admin@deployhub.local',
    avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=Developer',
  };

  return (
    <>
      <aside className="w-72 shrink-0 bg-[#0c0e15] border-r border-white/10 flex flex-col justify-between select-none z-20">
        <div>
          {/* Top Branding */}
          <div className="p-5 border-b border-white/10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/25 ring-1 ring-white/20">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <span className="font-extrabold text-base tracking-tight text-white flex items-center gap-1">
                    Deploy<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-violet-400">Hub</span>
                  </span>
                  <p className="text-[11px] font-mono text-slate-400">Local Cloud Engine</p>
                </div>
              </div>

              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                v1.0
              </span>
            </div>

            {/* Active Workspace Selector */}
            <div
              onClick={() => setShowAccountModal(true)}
              className="mt-4 p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex items-center justify-between text-xs text-slate-300 hover:bg-white/[0.06] cursor-pointer transition-colors"
              title="Click to view Account Details"
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                <span className="font-medium text-slate-200">Default Team</span>
              </div>
              <span className="text-[10px] font-mono text-slate-500 uppercase bg-black/40 px-2 py-0.5 rounded">Personal</span>
            </div>
          </div>

          {/* Navigation Section */}
          <nav className="p-3 space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2 font-mono">
              Platform
            </p>

            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      isActive
                        ? 'bg-gradient-to-r from-indigo-600/20 to-violet-600/10 text-indigo-300 border border-indigo-500/30 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 text-indigo-400" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}

            <button
              onClick={() => setShowAccountModal(true)}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-all text-left"
            >
              <Github className="w-4 h-4 text-indigo-400" />
              <span>GitHub &amp; Repositories</span>
            </button>

            <button
              onClick={() => setShowAccountModal(true)}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-all text-left"
            >
              <UserIcon className="w-4 h-4 text-indigo-400" />
              <span>Account &amp; Settings</span>
            </button>
          </nav>
        </div>

        {/* System Telemetry & User Controls */}
        <div className="p-4 border-t border-white/10 space-y-3 bg-[#0a0c12]">
          {/* Real-time Service Status */}
          <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 font-medium flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-slate-500" />
                Docker Core
              </span>
              <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Ready
              </span>
            </div>

            <div className="flex items-center justify-between text-xs pt-1 border-t border-white/5">
              <span className="text-slate-400 font-medium flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-slate-500" />
                API Service
              </span>
              <span
                className={`flex items-center gap-1 text-[11px] font-semibold ${
                  apiOnline ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    apiOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                  }`}
                />
                {apiOnline ? ':3001 Connected' : 'Offline'}
              </span>
            </div>
          </div>

          {/* User Profile Card */}
          <div className="flex items-center justify-between p-2 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors">
            <div
              onClick={() => setShowAccountModal(true)}
              className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
              title="Click to view Account Details"
            >
              <img
                src={currentUser.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${currentUser.username}`}
                alt={currentUser.username}
                className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-500/30 ring-1 ring-white/10"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-200 truncate hover:text-indigo-300 transition-colors">
                  {currentUser.username}
                </p>
                <p className="text-[11px] font-mono text-slate-500 truncate">{currentUser.email}</p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowAccountModal(true)}
                className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-indigo-500/10 rounded-lg transition-colors"
                title="Account Settings"
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                onClick={logout}
                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Account Details Modal */}
      <AccountModal
        isOpen={showAccountModal}
        onClose={() => setShowAccountModal(false)}
        user={currentUser as any}
        onLogout={logout}
      />
    </>
  );
}



