import { useState } from 'react';
import { Check, Clock, Play, Plus, Timer as TimerIcon, X } from 'lucide-react';
import { api, fmtDate, fmtDateTime, fmtHours } from '../api';
import { useUser } from '../auth';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, Stat, StatusBadge, Table, Td, Textarea,
  useLoad, useToast,
} from '../components/ui';
import type { TaskRow } from './Tasks';

interface Entry { id: string; task: string | null; company: string | null; category: string | null; started_at: string; ended_at: string | null; source: string; note: string | null; status: string; seconds: number }
interface Report {
  byUser: { user_id: string; name: string; task: number; nonTask: number; pending: number }[];
  byCompany: { company_id: string; company: string; seconds: number }[];
  pending: { id: string; name: string; started_at: string; note: string; seconds: number; task: string | null; category: string | null }[];
  overEstimate: { id: string; title: string; company: string; estimate_hours: number; actual_hours: number }[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const weekStart = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d); };

export function Time() {
  const u = useUser();
  const toast = useToast();
  const [range, setRange] = useState<'week' | 'month' | 'custom'>('week');
  const [from, setFrom] = useState(weekStart());
  const [to, setTo] = useState(iso(new Date()));
  const [entries, err, reload, loading] = useLoad(() => api<Entry[]>(`/time/entries?from=${from}&to=${to}`), [from, to]);
  const [current] = useLoad(() => api<{ categories: string[] }>('/time/current'));
  const [myTasks] = useLoad(() => api<TaskRow[]>('/tasks?view=mine&status=in_progress'));
  const [manual, setManual] = useState(false);

  const ok = entries?.filter((e) => e.status === 'ok') ?? [];
  const total = ok.reduce((s, e) => s + e.seconds, 0);
  const onTasks = ok.filter((e) => e.task).reduce((s, e) => s + e.seconds, 0);

  const pick = (r: typeof range) => {
    setRange(r);
    if (r === 'week') { setFrom(weekStart()); setTo(iso(new Date())); }
    if (r === 'month') { setFrom(monthStart()); setTo(iso(new Date())); }
  };
  const start = async (body: Record<string, string>, label: string) => {
    try { await api('/time/start', { body }); window.dispatchEvent(new Event('timer-changed')); toast(`Timer started: ${label}`); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <PageHeader title="Time" subtitle="Start a timer on the task you are working on. It stops counting if you are away for 15 minutes."
        actions={<Button variant="secondary" icon={Plus} onClick={() => setManual(true)}>Add time manually</Button>} />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <Stat icon={Clock} label={`Logged · ${range === 'week' ? 'this week' : range === 'month' ? 'this month' : 'selected range'}`} value={fmtHours(total)} />
        <Stat icon={TimerIcon} label="On client tasks" value={fmtHours(onTasks)} tone="brand" hint={total ? `${Math.round((onTasks / total) * 100)}% of logged time` : undefined} />
        <div className="col-span-2 lg:col-span-1 bezel-core shadow-card p-4">
          <div className="text-[13px] font-medium text-slate-600 mb-2">Period</div>
          <div className="flex flex-wrap gap-2">
            {(['week', 'month', 'custom'] as const).map((r) => (
              <button key={r} onClick={() => pick(r)} aria-pressed={range === r}
                className={`h-8 px-3 rounded-full text-[13px] font-medium border transition-colors ${range === r ? 'bg-ink text-white border-ink' : 'border-line hover:border-slate-400'}`}>
                {r === 'week' ? 'This week' : r === 'month' ? 'This month' : 'Custom'}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="flex gap-2 mt-3">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="h-9!" />
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className="h-9!" />
            </div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <Card title="Start a timer" description="Tasks you have in progress">
          {!myTasks ? <LoadingRows rows={2} /> : !myTasks.length ? (
            <EmptyState icon={Play} title="No tasks in progress">Open a task and press Start work first.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {myTasks.map((t) => (
                <li key={t.id}>
                  <button onClick={() => start({ task_id: t.id }, t.title)} className="group w-full text-left flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 hover:border-brand-300 hover:bg-brand-50/40 transition-colors">
                    <span className="grid place-items-center size-9 rounded-full bg-brand-500 text-ink-900 shrink-0"><Play className="size-4 fill-current" aria-hidden /></span>
                    <span className="min-w-0"><span className="block text-sm font-semibold text-ink truncate">{t.title}</span><span className="block text-xs text-slate-500 truncate">{t.company}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 pt-4 border-t border-line">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Other work</div>
            <div className="flex flex-wrap gap-2">
              {current?.categories.map((c) => <Button key={c} size="sm" variant="secondary" onClick={() => start({ category: c }, c)}>{c}</Button>)}
            </div>
          </div>
        </Card>

        <Card title="My time entries" className="lg:col-span-2" padded={false}>
          {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !entries ? <div className="p-5"><LoadingRows /></div> : !entries?.length ? (
            <EmptyState icon={Clock} title="No time logged in this period" />
          ) : (
            <ul className="divide-y divide-line">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center gap-4 px-5 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink truncate">{e.task ?? e.category}</span>
                    <span className="block text-xs text-slate-500 truncate">
                      {fmtDateTime(e.started_at)}{e.company && ` · ${e.company}`}{e.source === 'manual' && ` · manual: ${e.note}`}
                    </span>
                  </span>
                  {!e.ended_at ? <Badge tone="brand" dot>Running</Badge> : <StatusBadge status={e.status} />}
                  <span className="w-16 text-right text-sm font-semibold tabular-nums text-ink">{fmtHours(e.seconds)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {u.role !== 'employee' && <TeamReport from={from} to={to} />}
      {manual && <ManualEntry tasks={myTasks ?? []} categories={current?.categories ?? []} onClose={() => setManual(false)} onDone={() => { setManual(false); reload(); }} />}
    </>
  );
}

function TeamReport({ from, to }: { from: string; to: string }) {
  const toast = useToast();
  const [r, err, reload] = useLoad(() => api<Report>(`/time/report?from=${from}&to=${to}`), [from, to]);
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    try { await api(`/time/${id}/decide`, { body: { decision } }); toast(decision === 'approve' ? 'Time approved' : 'Time rejected'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const max = Math.max(1, ...(r?.byCompany.map((c) => c.seconds) ?? []));
  return (
    <>
      <h2 className="text-lg font-semibold mt-10 mb-4">Team</h2>
      <ErrorText error={err} />
      {!!r?.pending.length && (
        <Card title="Manual entries awaiting approval" className="mb-6" padded={false}>
          <ul className="divide-y divide-line">
            {r.pending.map((p) => (
              <li key={p.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-3">
                <Avatar name={p.name} size="sm" />
                <div className="flex-1 text-sm"><b className="text-ink">{p.name}</b> · {fmtHours(p.seconds)} on {fmtDate(p.started_at)} · {p.task ?? p.category}<div className="text-xs text-slate-500">{p.note}</div></div>
                <div className="flex gap-2"><Button size="sm" variant="danger" icon={X} onClick={() => decide(p.id, 'reject')}>Reject</Button><Button size="sm" icon={Check} onClick={() => decide(p.id, 'approve')}>Approve</Button></div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card title="Hours by person" padded={false}>
          {!r ? <div className="p-5"><LoadingRows /></div> : !r.byUser.length ? <EmptyState icon={Clock} title="No time logged" /> : (
            <Table head={['Person', 'Client tasks', 'Other', 'Pending']}>
              {r.byUser.map((p) => (
                <tr key={p.user_id}>
                  <Td><span className="flex items-center gap-2 font-medium text-ink"><Avatar name={p.name} size="sm" />{p.name}</span></Td>
                  <Td className="tabular-nums font-semibold text-ink">{fmtHours(p.task)}</Td>
                  <Td className="tabular-nums text-slate-600">{fmtHours(p.nonTask)}</Td>
                  <Td className="tabular-nums text-slate-600">{p.pending ? fmtHours(p.pending) : '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Hours by client">
          {!r ? <LoadingRows /> : !r.byCompany.length ? <EmptyState icon={Clock} title="No client time logged" /> : (
            <ul className="space-y-4">
              {r.byCompany.map((c) => (
                <li key={c.company_id}>
                  <div className="flex justify-between text-sm mb-1.5"><span className="font-medium text-ink truncate pr-3">{c.company}</span><span className="tabular-nums font-semibold text-ink">{fmtHours(c.seconds)}</span></div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-brand-500 rounded-full" style={{ width: `${(c.seconds / max) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {!!r?.overEstimate.length && (
          <Card title="Tasks 25% or more over estimate" className="lg:col-span-2" padded={false}>
            <Table head={['Task', 'Client', 'Estimate', 'Actual']}>
              {r.overEstimate.map((t) => <tr key={t.id}><Td className="font-medium text-ink">{t.title}</Td><Td>{t.company}</Td><Td className="tabular-nums">{t.estimate_hours}h</Td><Td className="tabular-nums text-red-600 font-semibold">{t.actual_hours.toFixed(1)}h</Td></tr>)}
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}

function ManualEntry({ tasks, categories, onClose, onDone }: { tasks: TaskRow[]; categories: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [what, setWhat] = useState('');
  const [date, setDate] = useState(iso(new Date()));
  const [hours, setHours] = useState('1');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(undefined);
    const [kind, value] = what.split(':');
    try {
      const r = await api<{ needsApproval: boolean }>('/time/manual', {
        body: { [kind === 'task' ? 'task_id' : 'category']: value, date, minutes: Math.round(Number(hours) * 60), note },
      });
      toast(r.needsApproval ? 'Saved. Entries over 2 hours go to your manager for approval.' : 'Time added', r.needsApproval ? 'info' : 'success');
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add time manually" description="For work done away from the portal, such as a client visit." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!what || note.trim().length < 3} onClick={save}>Save entry</Button></>}>
      <div className="space-y-4">
        <Field label="Work">
          <Select value={what} onChange={(e) => setWhat(e.target.value)}>
            <option value="">Choose…</option>
            {!!tasks.length && <optgroup label="Tasks">{tasks.map((t) => <option key={t.id} value={`task:${t.id}`}>{t.title} · {t.company}</option>)}</optgroup>}
            <optgroup label="Other work">{categories.map((c) => <option key={c} value={`cat:${c}`}>{c}</option>)}</optgroup>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Date" hint="Within the last 14 days"><Input type="date" value={date} max={iso(new Date())} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Hours" hint="Over 2h needs approval"><Input type="number" min="0.25" max="12" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
        </div>
        <Field label="What did you do?"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
