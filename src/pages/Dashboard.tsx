import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import {
  AlarmClock, Building2, CalendarCheck, ChevronRight, CircleCheck, ClipboardCheck, FileSearch, FileText, Inbox, KeyRound,
  ListChecks, Plus, RotateCcw, Send, ShieldCheck, Upload,
} from 'lucide-react';
import { useState } from 'react';
import { api, fmtDate } from '../api';
import { useUser } from '../auth';
import { Button, Card, EmptyState, ErrorText, LoadingRows, PageHeader, Skeleton, Stat, StatusBadge, useLoad } from '../components/ui';
import { RaiseRequest } from './Clients';

interface StaffDash {
  myOpenTasks: number; myRework: number; toReview: number; accessRequests: number; clientRequests: number;
  pendingDocs: number; overdue: number; privacyOpen: number;
  upcoming: { id: string; title: string; status: string; due_date: string; company: string }[];
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const today = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

export function Dashboard() {
  return useUser().role === 'client' ? <ClientHome /> : <StaffDashboard />;
}

function DateTile({ date, late }: { date: string; late: boolean }) {
  const d = new Date(date);
  return (
    <span className={`flex flex-col items-center justify-center size-12 rounded-lg border shrink-0 ${late ? 'border-red-200 bg-red-50 text-red-700' : 'border-line bg-white text-ink'}`}>
      <span className="text-[10px] font-semibold uppercase leading-none">{d.toLocaleDateString('en-IN', { month: 'short' })}</span>
      <span className="text-lg font-bold leading-tight tabular-nums">{d.getDate()}</span>
    </span>
  );
}

function StaffDashboard() {
  const u = useUser();
  const nav = useNavigate();
  const [d, err] = useLoad(() => api<StaffDash>('/dashboard'));
  const managerial = u.role !== 'employee';
  const todayIso = new Date().toISOString().slice(0, 10);

  const attention = d ? [
    managerial && { n: d.toReview, label: 'Tasks submitted for your review', icon: ClipboardCheck, to: '/review' },
    managerial && { n: d.accessRequests, label: 'Document access requests', icon: KeyRound, to: '/review' },
    managerial && { n: d.clientRequests, label: 'New client requests to assign', icon: Inbox, to: '/review' },
    { n: d.myRework, label: 'Your tasks sent back for rework', icon: RotateCcw, to: '/tasks?view=mine&status=rework' },
    u.role === 'director' && { n: d.privacyOpen, label: 'Open privacy requests', icon: ShieldCheck, to: '/privacy' },
  ].filter((x): x is { n: number; label: string; icon: typeof Inbox; to: string } => !!x && x.n > 0) : [];

  return (
    <>
      <PageHeader eyebrow={`${u.role[0].toUpperCase()}${u.role.slice(1)} workspace`} title={`${greeting()}, ${u.name.split(' ')[0]}`}
        actions={managerial && (
          <>
            <Button variant="secondary" icon={Building2} onClick={() => nav('/clients?new=1')}>New client</Button>
            <Button icon={Plus} trailing={ArrowUpRight} onClick={() => nav('/tasks?new=1')}>New task</Button>
          </>
        )} />
      <ErrorText error={err} />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {!d ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[84px] rounded-xl" />) : (
          <>
            <Stat icon={ListChecks} label="My open tasks" value={d.myOpenTasks} onClick={() => nav('/tasks?view=mine')} />
            <Stat icon={AlarmClock} label="Overdue" value={d.overdue} tone="red" onClick={() => nav('/tasks')} />
            {managerial ? (
              <>
                <Stat icon={ClipboardCheck} label="Awaiting review" value={d.toReview + d.accessRequests} tone="brand" onClick={() => nav('/review')} />
                <Stat icon={FileSearch} label="Documents to check" value={d.pendingDocs} onClick={() => nav('/clients')} />
              </>
            ) : (
              <>
                <Stat icon={RotateCcw} label="Sent back for rework" value={d.myRework} tone="red" onClick={() => nav('/tasks?view=mine&status=rework')} />
                <Stat icon={CalendarCheck} label="Due soon" value={d.upcoming.length} onClick={() => nav('/tasks?view=mine')} />
              </>
            )}
          </>
        )}
      </div>

      <div className="grid lg:grid-cols-5 gap-6 mt-6 items-start">
        <Card title="Due soon" description="Open tasks with a due date, earliest first" className="lg:col-span-3" padded={false}>
          {!d ? <div className="p-5"><LoadingRows /></div> : !d.upcoming.length ? (
            <EmptyState icon={CalendarCheck} title="Nothing due">No open tasks have a due date.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {d.upcoming.map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition-colors">
                    <DateTile date={t.due_date} late={t.due_date < todayIso} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink truncate">{t.title}</span>
                      <span className="block text-[13px] text-slate-500 truncate">{t.company}</span>
                    </span>
                    <StatusBadge status={t.status} />
                    <ChevronRight className="size-4 text-slate-300 hidden sm:block" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Needs your attention" className="lg:col-span-2" padded={false}>
          {!d ? <div className="p-5"><LoadingRows rows={3} /></div> : !attention.length ? (
            <EmptyState icon={CircleCheck} title="All caught up">Nothing is waiting on you right now.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((a) => (
                <li key={a.label}>
                  <Link to={a.to} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                    <span className="grid place-items-center size-9 rounded-lg bg-brand-50 text-brand-700"><a.icon className="size-[18px]" aria-hidden /></span>
                    <span className="flex-1 text-sm text-ink">{a.label}</span>
                    <span className="min-w-7 h-7 px-2 rounded-full bg-ink text-white text-xs font-bold grid place-items-center tabular-nums">{a.n}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

interface ClientDash { openTasks: number; reuploadDocs: number; recentlyCompleted: { id: string; title: string; approved_at: string; client_note: string | null }[] }

function ClientHome() {
  const u = useUser();
  const nav = useNavigate();
  const [d] = useLoad(() => api<ClientDash>('/dashboard'));
  const [companies, err] = useLoad(() => api<{ id: string; legal_name: string; gstin: string | null; group_name: string }[]>('/companies'));
  const [asking, setAsking] = useState(false);
  const first = companies?.[0];
  return (
    <>
      <section className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-ink via-ink to-ink-900 text-white p-6 sm:p-10 mb-6 shadow-pop ring-1 ring-inset ring-white/10">
        <svg viewBox="0 0 364 416" className="absolute -right-10 -top-10 w-64 opacity-10" aria-hidden>
          <polygon points="0,110 212,0 212,210 0,318" fill="#e8a020" /><polygon points="77,157 289,48 289,258 77,366" fill="#eb8a23" /><polygon points="151,208 363,99 363,307 151,416" fill="#fff" />
        </svg>
        <div className="relative">
          <p className="eyebrow bg-white/10! text-brand-200! ring-white/15!">{today()}</p>
          <h1 className="text-[28px] sm:text-[36px] font-bold text-white mt-4 leading-tight">Welcome, {u.name.split(' ')[0]}</h1>
          <p className="text-slate-300 mt-2 max-w-xl text-sm sm:text-base">Share documents with your CA team, follow the work in progress, and see what has been completed for you.</p>
          <div className="flex flex-wrap gap-2 mt-5">
            <Button icon={Upload} trailing={ArrowUpRight} disabled={!first} onClick={() => first && nav(`/company/${first.id}?tab=docs`)}>Upload documents</Button>
            <Button variant="secondary" icon={Send} onClick={() => setAsking(true)} className="bg-white/10! text-white! border-white/20! hover:bg-white/20!">Raise a request</Button>
          </div>
        </div>
      </section>
      <ErrorText error={err} />

      {!!d?.reuploadDocs && (
        <Link to={first ? `/company/${first.id}` : '/'} className="flex items-center gap-3 rounded-2xl ring-1 ring-red-200 bg-red-50 px-4 py-3 mb-6 text-sm text-red-800 hover:bg-red-100 transition-colors">
          <RotateCcw className="size-5 shrink-0" aria-hidden />
          <span className="flex-1"><b>{d.reuploadDocs} file{d.reuploadDocs > 1 ? 's need' : ' needs'} re-uploading.</b> Open your documents to see why.</span>
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            {d ? <Stat icon={ListChecks} label="Work in progress" value={d.openTasks} onClick={() => nav('/requests')} /> : <Skeleton className="h-[84px] rounded-xl" />}
            {d ? <Stat icon={CircleCheck} label="Completed recently" value={d.recentlyCompleted.length} tone="green" onClick={() => nav('/requests')} /> : <Skeleton className="h-[84px] rounded-xl" />}
          </div>
          <Card title="Your companies" description="Open a company to upload documents and see its work">
            {!companies ? <LoadingRows rows={2} /> : !companies.length ? (
              <EmptyState icon={Building2} title="No company linked yet">Your CA team will link your companies to this login.</EmptyState>
            ) : (
              <ul className="grid sm:grid-cols-2 gap-3">
                {companies.map((c) => (
                  <li key={c.id}>
                    <Link to={`/company/${c.id}`} className="group flex items-center gap-3 rounded-2xl ring-1 ring-ink/[0.07] bg-white p-4 hover:ring-brand-300 hover:-translate-y-0.5 hover:shadow-lift transition-all duration-300 ease-(--ease-fluid)">
                      <span className="grid place-items-center size-11 rounded-xl bg-brand-50 text-brand-700 shrink-0"><Building2 className="size-5" aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-ink truncate">{c.legal_name}</span>
                        <span className="block text-xs text-slate-500 font-mono mt-0.5">{c.gstin ?? c.group_name}</span>
                      </span>
                      <ChevronRight className="size-5 text-slate-300 group-hover:text-brand-700 transition-colors" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card title="Recently completed">
          {!d ? <LoadingRows rows={3} /> : !d.recentlyCompleted.length ? (
            <EmptyState icon={FileText} title="Nothing completed yet">Completed filings and reports will appear here.</EmptyState>
          ) : (
            <ol className="relative border-l border-line ml-2 space-y-5">
              {d.recentlyCompleted.map((t) => (
                <li key={t.id} className="ml-5">
                  <span className="absolute -left-[9px] grid place-items-center size-[18px] rounded-full bg-emerald-100 ring-4 ring-white"><CircleCheck className="size-3 text-emerald-700" aria-hidden /></span>
                  <div className="text-sm font-semibold text-ink">{t.title}</div>
                  {t.client_note && <p className="text-sm text-slate-600 mt-0.5">{t.client_note}</p>}
                  <div className="text-xs text-slate-400 mt-1">{fmtDate(t.approved_at)}</div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      {asking && <RaiseRequest onClose={() => setAsking(false)} onDone={() => setAsking(false)} />}
    </>
  );
}
