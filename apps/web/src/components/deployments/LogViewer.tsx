import { useEffect, useRef, useState } from 'react';
import {
  Terminal,
  Search,
  Copy,
  Check,
  ArrowDown,
  Download,
  Maximize2,
  Minimize2,
  Layers,
} from 'lucide-react';

interface LogViewerProps {
  logs: string[];
  isLive?: boolean;
}

function colorize(line: string) {
  if (line.includes('❌') || line.includes('FAILED') || line.includes('Error') || line.includes('error')) {
    return 'text-rose-400 font-semibold bg-rose-500/10 px-1 rounded';
  }
  if (line.includes('✅') || line.includes('RUNNING') || line.includes('success')) {
    return 'text-emerald-400 font-medium bg-emerald-500/10 px-1 rounded';
  }
  if (line.includes('[GIT]')) return 'text-sky-400';
  if (line.includes('[DOCKER]')) return 'text-cyan-400';
  if (line.includes('[DEPLOYHUB]')) return 'text-indigo-400 font-medium';
  if (line.includes('Stage')) return 'text-amber-300 font-semibold';
  return 'text-slate-300';
}

export function LogViewer({ logs, isLive = false }: LogViewerProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<'ALL' | 'DOCKER' | 'GIT' | 'ERRORS'>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((l) => {
    const matchesSearch = filter ? l.toLowerCase().includes(filter.toLowerCase()) : true;
    if (!matchesSearch) return false;

    if (category === 'DOCKER') return l.includes('[DOCKER]');
    if (category === 'GIT') return l.includes('[GIT]');
    if (category === 'ERRORS') return l.includes('❌') || l.includes('Error') || l.includes('FAILED');
    return true;
  });

  function copyAll() {
    navigator.clipboard.writeText(logs.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadLogs() {
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deployhub-build-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className={`relative terminal-window rounded-2xl overflow-hidden flex flex-col transition-all duration-300 ${
        fullscreen ? 'fixed inset-4 z-50 shadow-2xl ring-1 ring-indigo-500/50' : 'shadow-xl'
      }`}
    >
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-[#0d0f17] border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-rose-500/80 shadow-[0_0_8px_rgba(244,63,94,0.4)]" />
            <span className="w-3 h-3 rounded-full bg-amber-500/80 shadow-[0_0_8px_rgba(245,158,11,0.4)]" />
            <span className="w-3 h-3 rounded-full bg-emerald-500/80 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
          </div>

          <div className="h-4 w-px bg-white/10 mx-1" />

          <div className="flex items-center gap-1.5 text-xs text-slate-300 font-mono font-medium">
            <Terminal className="w-3.5 h-3.5 text-indigo-400" />
            <span>console.stdout</span>
          </div>

          {isLive && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live Streaming
            </span>
          )}
        </div>

        {/* Filter Pills & Actions */}
        <div className="flex items-center gap-2">
          {/* Category Tabs */}
          <div className="hidden sm:flex rounded-lg bg-black/40 border border-white/5 p-0.5 text-xs">
            {(['ALL', 'GIT', 'DOCKER', 'ERRORS'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`px-2 py-1 rounded-md font-medium transition-all ${
                  category === cat
                    ? 'bg-indigo-600/80 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search logs..."
              className="bg-black/60 border border-white/10 rounded-lg pl-8 pr-3 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-32 md:w-40 transition-all"
            />
          </div>

          {/* Auto Scroll Toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll((v) => !v)}
            className={`p-1.5 rounded-lg border text-xs transition-colors ${
              autoScroll
                ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                : 'bg-black/40 border-white/5 text-slate-500 hover:text-slate-300'
            }`}
            title={autoScroll ? 'Auto-scroll is ON' : 'Auto-scroll is OFF'}
          >
            <ArrowDown className={`w-3.5 h-3.5 ${autoScroll ? 'text-indigo-400' : ''}`} />
          </button>

          {/* Copy Button */}
          <button
            type="button"
            onClick={copyAll}
            className="flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-colors"
            title="Copy all logs"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
          </button>

          {/* Download Button */}
          <button
            type="button"
            onClick={downloadLogs}
            className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white rounded-lg text-xs transition-colors"
            title="Download full raw log file"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Fullscreen Button */}
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white rounded-lg text-xs transition-colors"
            title={fullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal Content Body */}
      <div
        className={`p-4 font-mono text-xs leading-relaxed overflow-y-auto bg-[#06070a] select-text space-y-1 ${
          fullscreen ? 'flex-1 h-[calc(100%-60px)]' : 'h-[440px]'
        }`}
      >
        {filteredLogs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-slate-500">
              <Layers className="w-6 h-6 opacity-40" />
            </div>
            <p className="text-xs font-medium text-slate-400">
              {filter ? `No log lines matching "${filter}"` : 'Initializing build pipeline... Waiting for output...'}
            </p>
          </div>
        ) : (
          filteredLogs.map((line, i) => (
            <div
              key={i}
              className="flex items-start hover:bg-white/[0.03] rounded-md px-1.5 py-0.5 transition-colors group font-mono"
            >
              <span className="text-slate-600 group-hover:text-slate-500 select-none mr-3 w-8 text-right shrink-0 font-mono text-[11px] opacity-70">
                {i + 1}
              </span>
              <span className={`break-all whitespace-pre-wrap flex-1 ${colorize(line)}`}>{line}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}


