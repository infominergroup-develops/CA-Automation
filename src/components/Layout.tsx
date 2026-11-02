import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Building2, ListChecks, ClipboardCheck, Timer, Users, History, ShieldCheck, LogOut, Square, Menu, X, FileText, Lock, BarChart3, RefreshCcw,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api';
import { useAuth, type Role } from '../auth';
import { InfominerLogo } from './InfominerLogo';
import { Avatar } from './ui';
import { prefersReducedMotion } from '../motion';

interface NavItem { to: string; label: string; icon: LucideIcon; roles: Role[]; badge?: 'review' }
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Workspace',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['director', 'manager', 'employee'] },
      { to: '/', label: 'Home', icon: LayoutDashboard, roles: ['client'] },
      { to: '/clients', label: 'Clients', icon: Building2, roles: ['director', 'manager'] },
      { to: '/tasks', label: 'Tasks', icon: ListChecks, roles: ['director', 'manager', 'employee'] },
      { to: '/review', label: 'Review', icon: ClipboardCheck, roles: ['director', 'manager'], badge: 'review' },
      { to: '/reports', label: 'Reports', icon: BarChart3, roles: ['client'] },
      { to: '/requests', label: 'Requests & status', icon: FileText, roles: ['client'] },
      { to: '/time', label: 'Time', icon: Timer, roles: ['director', 'manager', 'employee'] },
    ],
  },
  {
    group: 'Firm',
    items: [
      { to: '/team', label: 'Team', icon: Users, roles: ['director', 'manager'] },
      { to: '/tally', label: 'Tally sync', icon: RefreshCcw, roles: ['director', 'manager'] },
      { to: '/audit', label: 'Audit trail', icon: History, roles: ['director'] },
    ],
  },
  { group: 'Account', items: [{ to: '/privacy', label: 'Privacy & data', icon: ShieldCheck, roles: ['director', 'manager', 'employee', 'client'] }] },
];

interface Running { id: string; started_at: string; idle_seconds: number; category: string | null; task?: { title: string; company: string } }

/** Keeps the running timer honest: a beat every minute, flagged idle after 15 minutes without input. */
function useTimer(enabled: boolean) {
  const [running, setRunning] = useState<Running | null>(null);
  const lastInput = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => api<{ running: Running | null }>('/time/current').then((r) => setRunning(r.running)).catch(() => {});
    refresh();
    const mark = () => { lastInput.current = Date.now(); };
    const events = ['mousemove', 'keydown', 'pointerdown', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    window.addEventListener('timer-changed', refresh);
    const beat = setInterval(() => {
      api<{ running: boolean }>('/time/heartbeat', { body: { idle: Date.now() - lastInput.current > 15 * 60e3 } })
        .then((r) => { if (!r.running) setRunning(null); }).catch(() => {});
    }, 60e3);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      window.removeEventListener('timer-changed', refresh);
      clearInterval(beat);
      clearInterval(clock);
    };
  }, [enabled]);
  return running;
}

/** Count of items waiting on a manager, shown on the Review link. */
function useReviewCount(enabled: boolean) {
  const [n, setN] = useState(0);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!enabled) return;
    api<{ toReview: number; accessRequests: number; clientRequests: number }>('/dashboard')
      .then((d) => setN(d.toReview + d.accessRequests + d.clientRequests)).catch(() => {});
  }, [enabled, pathname]);
  return n;
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const u = me!.user!;
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const running = useTimer(u.role !== 'client');
  const reviewCount = useReviewCount(u.role === 'director' || u.role === 'manager');

  useEffect(() => setOpen(false), [pathname]);

  const elapsed = running ? Math.max(0, (Date.now() - Date.parse(running.started_at)) / 1000 - running.idle_seconds) : 0;
  const clock = `${Math.floor(elapsed / 3600)}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;
  const stop = async () => { await api('/time/stop', { body: {} }); window.dispatchEvent(new Event('timer-changed')); };
  const signOut = () => logout().then(() => nav('/'));

  const navRef = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  // The active-link highlight glides between links instead of jumping.
  useLayoutEffect(() => {
    const box = navRef.current, el = pill.current;
    const active = box?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!box || !el) return;
    if (!active) { gsap.set(el, { autoAlpha: 0 }); return; }
    const y = active.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const first = gsap.getProperty(el, 'opacity') === 0;
    gsap.to(el, { y, height: active.offsetHeight, autoAlpha: 1, duration: first || prefersReducedMotion() ? 0 : 0.55, ease: 'expo.out' });
  }, [pathname, open]);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-[68px] items-center justify-between px-5">
        <NavLink to="/" aria-label="Infominer home"><InfominerLogo size="sm" /></NavLink>
        <button onClick={() => setOpen(false)} className="lg:hidden grid place-items-center size-9 -mr-2 rounded-full text-slate-500 hover:bg-ink/[0.05]" aria-label="Close menu"><X className="size-5" /></button>
      </div>
      <nav ref={navRef} className="relative flex-1 overflow-y-auto px-3 pb-4 space-y-6" aria-label="Main">
        <span ref={pill} aria-hidden className="pointer-events-none absolute left-3 right-3 top-0 rounded-xl bg-gradient-to-r from-brand-50 to-white ring-1 ring-brand-200/70 shadow-[0_4px_14px_-8px_rgb(235_138_35/0.6)] opacity-0" />
        {NAV.map((g) => {
          const items = g.items.filter((i) => i.roles.includes(u.role));
          if (!items.length) return null;
          return (
            <div key={g.group}>
              <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{g.group}</div>
              <ul className="space-y-0.5">
                {items.map((i) => (
                  <li key={i.label}>
                    <NavLink to={i.to} end={i.to === '/'}
                      className={({ isActive }) => `group relative z-[1] flex items-center gap-3 h-10 px-3 rounded-xl text-sm font-medium transition-colors duration-300 ease-(--ease-fluid) ${
                        isActive ? 'text-ink' : 'text-slate-600 hover:bg-ink/[0.04] hover:text-ink'}`}>
                      {({ isActive }) => (
                        <>
                          <i.icon className={`size-[18px] transition-colors duration-300 ${isActive ? 'text-brand-700' : 'text-slate-400 group-hover:text-ink'}`} aria-hidden />
                          <span className="flex-1">{i.label}</span>
                          {i.badge === 'review' && reviewCount > 0 && (
                            <span className="min-w-5 h-5 px-1.5 rounded-full bg-brand-500 text-ink-900 text-[11px] font-bold grid place-items-center tabular-nums">
                              {reviewCount}<span className="sr-only"> waiting</span>
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="p-2">
        <div className="flex items-center gap-3 rounded-2xl bg-canvas/80 ring-1 ring-ink/[0.05] px-2.5 py-2.5">
          <Avatar name={u.name} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink truncate">{u.name}</div>
            <div className="text-xs text-slate-500 capitalize">{u.role}</div>
          </div>
          <button onClick={signOut} className="grid place-items-center size-9 rounded-full text-slate-500 hover:bg-white hover:text-ink hover:shadow-card transition-all duration-300" aria-label="Sign out" title="Sign out"><LogOut className="size-[18px]" /></button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:pl-[17.5rem]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-[70] focus:top-3 focus:left-3 focus:bg-white focus:px-4 focus:py-2 focus:rounded-full focus:shadow-pop">Skip to content</a>

      {/* Desktop sidebar: a floating panel */}
      <aside className="hidden lg:block fixed top-3 bottom-3 left-3 w-64 z-30 bezel rounded-[26px]!">
        <div className="bezel-core h-full rounded-[22px]!">{sidebar}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-ink-900/35 backdrop-blur-sm animate-fade-in" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute top-2 bottom-2 left-2 w-72 max-w-[85vw] bezel rounded-[26px]! shadow-pop animate-slide-in" aria-label="Menu">
            <div className="bezel-core h-full rounded-[22px]!">{sidebar}</div>
          </aside>
        </div>
      )}

      {/* Floating top bar */}
      <header className="sticky top-3 z-20 px-3 lg:px-8">
        <div className="max-w-7xl mx-auto h-14 flex items-center gap-3 rounded-full bg-white/75 backdrop-blur-xl ring-1 ring-ink/[0.06] shadow-card pl-2 pr-2 lg:pl-5">
          <button onClick={() => setOpen(true)} className="lg:hidden grid place-items-center size-10 rounded-full text-ink hover:bg-ink/[0.05]" aria-label="Open menu"><Menu className="size-5" /></button>
          <div className="lg:hidden"><InfominerLogo size="sm" /></div>
          <span className="hidden lg:inline text-sm text-slate-500">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
          <div className="flex-1" />
          {running && (
            <div className="flex items-center gap-2 h-10 rounded-full bg-ink text-white pl-3.5 pr-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_6px_16px_-8px_rgb(30_41_59/0.7)]" role="timer" aria-label="Running timer">
              <span className="relative flex size-2"><span className="absolute inline-flex size-full rounded-full bg-brand-500 opacity-60 animate-ping" /><span className="relative size-2 rounded-full bg-brand-500" /></span>
              <span className="hidden sm:block text-xs text-slate-300 max-w-52 truncate">{running.task?.title ?? running.category}</span>
              <span className="font-mono text-sm tabular-nums">{clock}</span>
              <button onClick={stop} className="grid place-items-center size-8 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 transition" aria-label="Stop timer" title="Stop timer"><Square className="size-3 fill-current" /></button>
            </div>
          )}
          <span className="hidden md:inline-flex items-center gap-1.5 h-8 rounded-full bg-emerald-50 px-3 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200/70" title="Encrypted connection; every access is logged">
            <Lock className="size-3.5" aria-hidden />Secure session
          </span>
        </div>
      </header>

      <main id="main" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-10 lg:pt-10" key={pathname}>{children}</main>
      <footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 text-xs text-slate-500">
        Confidential client information. Every view and download is recorded. · <NavLink to="/privacy" className="underline underline-offset-2 hover:text-ink">Privacy notice</NavLink>
      </footer>
    </div>
  );
}
