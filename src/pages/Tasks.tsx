import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Ban, Check, ChevronRight, CircleCheck, Clock, FolderOpen, ListChecks, Play, Plus, Send, Timer, Undo2,
} from 'lucide-react';
import { api, fmtDate, fmtDateTime, fmtHours } from '../api';
import { useUser } from '../auth';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Td,
  Textarea, useConfirm, useLoad, useToast,
} from '../components/ui';
import type { StaffUser } from './Clients';
import { GstStateField } from '../components/GstStateField';
import { stateOf } from '../gst';

export interface TaskRow {
  id: string; company_id: string; company: string; type: string; title: string; period: string | null; status: string; gstin?: string | null;
  priority: string; due_date: string | null; assignee: string | null; reviewer: string | null; rework_count: number;
  estimate_hours: number | null; seconds_logged: number; updated_at: string;
}

const PRIORITY: Record<string, ['slate' | 'amber' | 'red', string] | undefined> = { high: ['amber', 'High'], urgent: ['red', 'Urgent'] };
const todayIso = () => new Date().toISOString().slice(0, 10);
const isLate = (t: { due_date: string | null; status: string }) => !!t.due_date && t.due_date < todayIso() && !['approved', 'cancelled'].includes(t.status);

function Logged({ t }: { t: TaskRow }) {
  const over = !!t.estimate_hours && t.seconds_logged / 3600 > t.estimate_hours * 1.25;
  return (
    <span className="tabular-nums whitespace-nowrap">
      {fmtHours(t.seconds_logged)}
      {t.estimate_hours ? <span className={`text-xs ${over ? 'text-red-600 font-semibold' : 'text-slate-400'}`}> / {t.estimate_hours}h</span> : null}
    </span>
  );
}

/** Directors and managers assign a client request straight from any task list. */
function AssignButton({ t, onDone }: { t: TaskRow; onDone?: () => void }) {
  const [form, setForm] = useState<{ type: string; title: string; instructions: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // The client's own description is loaded first, so assigning keeps it.
  const open = () => { setBusy(true); api<{ type: string; title: string; instructions: string | null }>(`/tasks/${t.id}`)
    .then((d) => setForm({ type: d.type, title: d.title, instructions: d.instructions ?? '' }), (e) => toast((e as Error).message, 'error')).finally(() => setBusy(false)); };
  return (
    <>
      <Button size="sm" icon={Plus} busy={busy} onClick={open}>Assign</Button>
      {form && <TaskForm assignTaskId={t.id} initial={form} onClose={() => setForm(null)} onDone={() => { setForm(null); onDone?.(); }} />}
    </>
  );
}

export function TaskTable({ rows, onChanged }: { rows: TaskRow[]; onChanged?: () => void }) {
  const u = useUser();
  const canAssign = (t: TaskRow) => t.status === 'requested' && (u.role === 'director' || u.role === 'manager');
  if (!rows.length) return <EmptyState icon={ListChecks} title="No tasks here">Tasks matching this view will appear here.</EmptyState>;
  return (
    <>
      <div className="hidden md:block">
        <Table head={['Task', 'Client', 'Assignee', 'Due', 'Logged', 'Status']}>
          {rows.map((t) => (
            <tr key={t.id} className="hover:bg-slate-50/70 transition-colors">
              <Td>
                <Link to={`/tasks/${t.id}`} className="font-semibold text-ink hover:text-brand-700">{t.title}</Link>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                  <span>{t.type}{t.period ? ` · ${t.period}` : ''}{t.gstin ? ` · ${stateOf(t.gstin)}` : ''}</span>
                  {PRIORITY[t.priority] && <Badge tone={PRIORITY[t.priority]![0]}>{PRIORITY[t.priority]![1]}</Badge>}
                  {t.rework_count > 0 && <Badge tone="red">Rework ×{t.rework_count}</Badge>}
                </div>
              </Td>
              <Td className="text-slate-700">{t.company}</Td>
              <Td>{t.assignee ? <span className="flex items-center gap-2"><Avatar name={t.assignee} size="sm" /><span className="text-slate-700">{t.assignee}</span></span> : canAssign(t) ? <AssignButton t={t} onDone={onChanged} /> : <span className="text-slate-400">Unassigned</span>}</Td>
              <Td className={`whitespace-nowrap tabular-nums ${isLate(t) ? 'text-red-600 font-semibold' : 'text-slate-700'}`}>{fmtDate(t.due_date)}{isLate(t) && <span className="sr-only"> (overdue)</span>}</Td>
              <Td><Logged t={t} /></Td>
              <Td><StatusBadge status={t.status} /></Td>
            </tr>
          ))}
        </Table>
      </div>
      <ul className="md:hidden divide-y divide-line">
        {rows.map((t) => (
          <li key={t.id} className="relative">
            {canAssign(t) && <span className="absolute right-5 bottom-3"><AssignButton t={t} onDone={onChanged} /></span>}
            <Link to={`/tasks/${t.id}`} className="block px-5 py-3.5">
              <div className="flex justify-between gap-3 items-start">
                <span className="font-semibold text-ink">{t.title}</span>
                <StatusBadge status={t.status} />
              </div>
              <div className="text-xs text-slate-500 mt-1">{t.company} · {t.assignee ?? 'Unassigned'}</div>
              <div className={`text-xs mt-1 ${isLate(t) ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>Due {fmtDate(t.due_date)} · <Logged t={t} /></div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

type Filter = 'active' | 'submitted' | 'rework' | 'approved' | 'all';
const FILTERS: Record<Filter, (t: TaskRow) => boolean> = {
  active: (t) => ['requested', 'assigned', 'in_progress', 'rework', 'submitted'].includes(t.status),
  submitted: (t) => t.status === 'submitted',
  rework: (t) => t.status === 'rework',
  approved: (t) => t.status === 'approved',
  all: () => true,
};

export function Tasks() {
  const u = useUser();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? (u.role === 'employee' ? 'mine' : 'all');
  const filter = (params.get('status') === 'rework' ? 'rework' : params.get('filter') ?? 'active') as Filter;
  const [rows, err, reload, loading] = useLoad(() => api<TaskRow[]>(`/tasks?view=${view}`), [view]);
  const creating = params.get('new') === '1';
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); p.delete('status'); v ? p.set(k, v) : p.delete(k); setParams(p); };
  const count = (f: Filter) => rows?.filter(FILTERS[f]).length;
  return (
    <>
      <PageHeader title={u.role === 'employee' ? 'My tasks' : 'Tasks'} subtitle="Assigned work across your clients, from assignment to approval."
        actions={
          <>
            {u.role !== 'employee' && (
              <Select value={view} onChange={(e) => set('view', e.target.value)} className="w-auto!" aria-label="Whose tasks">
                <option value="all">All my clients</option><option value="mine">Assigned to me</option>
              </Select>
            )}
            <Button icon={Plus} onClick={() => set('new', '1')}>{u.role === 'employee' ? 'Add my task' : 'New task'}</Button>
          </>
        } />
      <Tabs value={filter} onChange={(v) => set('filter', v)} items={[
        { value: 'active', label: 'Active', count: count('active') },
        { value: 'submitted', label: 'Awaiting review', count: count('submitted') },
        { value: 'rework', label: 'Rework', count: count('rework') },
        { value: 'approved', label: 'Approved', count: count('approved') },
        { value: 'all', label: 'All' },
      ]} />
      <Card padded={false}>
        {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !rows ? <div className="p-5"><LoadingRows /></div> : rows && <TaskTable rows={rows.filter(FILTERS[filter])} onChanged={reload} />}
      </Card>
      {creating && (u.role === 'employee'
        ? <OwnTaskForm onClose={() => set('new', null)} onDone={() => { set('new', null); reload(); }} />
        : <TaskForm onClose={() => set('new', null)} onDone={() => { set('new', null); reload(); }} />)}
    </>
  );
}

/** An employee adds work they were given; whoever gave it approves it once it is submitted. */
function OwnTaskForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [companies] = useLoad(() => api<{ id: string; legal_name: string; approval?: string | null; gstins?: string[] }[]>('/companies'));
  const [names] = useLoad(() => api<{ id: string; name: string }[]>('/task-names'));
  const [staff] = useLoad(() => api<StaffUser[]>('/users'));
  const [f, setF] = useState({ company_id: '', task_name_id: '', reviewer_id: '', due_date: '', gstin: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const bosses = staff?.filter((s) => s.status === 'active' && (s.role === 'manager' || s.role === 'director'));
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api('/tasks/own', { body: { ...f, due_date: f.due_date || undefined, gstin: f.gstin || undefined } });
      toast('Task added. Once you submit it, the person who gave it to you approves it.');
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add my task" description="Work someone gave you. When you finish and submit it, they approve it." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!f.company_id || !f.task_name_id || !f.reviewer_id} onClick={save}>Add task</Button></>}>
      <div className="space-y-4">
        <ErrorText error={err} />
        <Field label="Client" hint="Clients you work on.">
          <Select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value, gstin: '' })}>
            <option value="">Choose a client</option>
            {companies?.filter((c) => c.approval !== 'pending').map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
          </Select>
        </Field>
        <GstStateField gstins={companies?.find((c) => c.id === f.company_id)?.gstins} value={f.gstin} onChange={(gstin) => setF({ ...f, gstin })} />
        <Field label="Task">
          <Select value={f.task_name_id} onChange={(e) => setF({ ...f, task_name_id: e.target.value })}>
            <option value="">Choose a task</option>
            {names?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Assigned by" hint="They approve it when you are done.">
          <Select value={f.reviewer_id} onChange={(e) => setF({ ...f, reviewer_id: e.target.value })}>
            <option value="">Choose who gave it to you</option>
            {bosses?.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role === 'director' ? 'Director' : 'Manager'}</option>)}
          </Select>
        </Field>
        <Field label="Due date" optional><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** Create a task, or (with `assignTaskId`) assign a client request. */
export function TaskForm({ companyId, assignTaskId, initial, onClose, onDone }:
  { companyId?: string; assignTaskId?: string; initial?: Partial<Record<string, string>>; onClose: () => void; onDone: () => void }) {
  const u = useUser();
  const toast = useToast();
  const [companies] = useLoad(() => api<{ id: string; legal_name: string; gstins?: string[] }[]>('/companies'));
  const [staff] = useLoad(() => api<StaffUser[]>('/users'));
  const [meta] = useLoad(() => api<{ types: string[] }>('/tasks/meta'));
  const [f, setF] = useState({
    company_id: companyId ?? '', type: initial?.type ?? 'GST return', title: initial?.title ?? '', period: '', instructions: initial?.instructions ?? '',
    assignee_id: '', reviewer_id: u.id, due_date: '', statutory_due: '', priority: 'normal', estimate_hours: '', gstin: '',
  });
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const active = staff?.filter((s) => s.status === 'active') ?? [];
  const sameReviewer = f.assignee_id && f.assignee_id === f.reviewer_id;

  const save = async () => {
    setBusy(true); setErr(undefined);
    const body: Record<string, unknown> = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
    if (f.estimate_hours) body.estimate_hours = Number(f.estimate_hours);
    try {
      if (assignTaskId) {
        delete body.company_id;
        await api(`/tasks/${assignTaskId}/assign`, { body });
        toast('Request assigned');
      } else {
        await api('/tasks', { body });
        toast('Task created and assigned');
      }
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={assignTaskId ? 'Assign client request' : 'New task'} onClose={onClose} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save} disabled={!f.title || !f.assignee_id || (!assignTaskId && !f.company_id) || !!sameReviewer}>{assignTaskId ? 'Assign' : 'Create task'}</Button></>}>
      <div className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          {!companyId && !assignTaskId && (
            <Field label="Client">
              <Select value={f.company_id} onChange={set('company_id')}>
                <option value="">Choose a client</option>{companies?.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Type"><Select value={f.type} onChange={set('type')}>{meta?.types.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Title"><Input value={f.title} onChange={set('title')} placeholder="e.g. GSTR-3B Sep 2026" /></Field>
          <Field label="Period" optional><Input value={f.period} onChange={set('period')} placeholder="e.g. Sep 2026 or FY 2025-26" /></Field>
          {!assignTaskId && <GstStateField gstins={companies?.find((c) => c.id === f.company_id)?.gstins} value={f.gstin} onChange={(gstin) => setF({ ...f, gstin })} />}
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Assign to">
            <Select value={f.assignee_id} onChange={set('assignee_id')}>
              <option value="">Choose a person</option>
              {active.filter((s) => s.role === 'employee' || s.role === 'manager').map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}
            </Select>
          </Field>
          <Field label="Reviewer" hint="Approves the work" error={sameReviewer ? 'The reviewer must be a different person from the assignee.' : undefined}>
            <Select value={f.reviewer_id} onChange={set('reviewer_id')}>
              {active.filter((s) => s.role !== 'employee').map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === u.id ? ' (me)' : ''}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Due date" optional><Input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
          <Field label="Statutory deadline" optional><Input type="date" value={f.statutory_due} onChange={set('statutory_due')} /></Field>
          <Field label="Priority"><Select value={f.priority} onChange={set('priority')}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select></Field>
          <Field label="Estimate (h)" optional><Input type="number" min="0" step="0.5" value={f.estimate_hours} onChange={set('estimate_hours')} /></Field>
        </div>
        <Field label="Instructions" optional><Textarea value={f.instructions} onChange={set('instructions')} placeholder="What should be done, and anything to watch for" /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

interface TaskDetailData extends TaskRow {
  instructions: string | null; submission_note: string | null; client_note: string | null; statutory_due: string | null;
  creator: string; created_at: string; created_by: string;
  events: { from_status: string | null; to_status: string; comment: string | null; created_at: string; actor: string }[];
  grants: { id: string; category_ids: number[]; reason: string; status: string; expires_at: string | null; decision_note: string | null; created_at: string; decided_by_name: string | null }[];
  can: Record<'start' | 'submit' | 'requestAccess' | 'review' | 'decideAccess' | 'assign' | 'cancel', boolean>;
}

const STEPS = [
  { key: 'assigned', label: 'Assigned' }, { key: 'in_progress', label: 'In progress' },
  { key: 'submitted', label: 'Review' }, { key: 'approved', label: 'Approved' },
];
function Stepper({ status }: { status: string }) {
  const idx = status === 'rework' ? 1 : status === 'requested' ? -1 : STEPS.findIndex((s) => s.key === status);
  if (status === 'cancelled') return null;
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i < idx || status === 'approved';
        const current = i === idx && status !== 'approved';
        return (
          <li key={s.key} className="flex items-center gap-2 shrink-0">
            <span className={`flex items-center gap-2 h-8 pl-1 pr-3 rounded-full text-[13px] font-medium ${
              done ? 'bg-emerald-50 text-emerald-800' : current ? (status === 'rework' ? 'bg-red-50 text-red-700' : 'bg-brand-50 text-brand-800') : 'bg-slate-100 text-slate-500'}`}
              aria-current={current ? 'step' : undefined}>
              <span className={`grid place-items-center size-6 rounded-full text-xs font-bold ${done ? 'bg-emerald-600 text-white' : current ? 'bg-white ring-2 ring-current' : 'bg-white text-slate-400'}`}>
                {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
              </span>
              {current && status === 'rework' ? 'Rework' : s.label}
            </span>
            {i < STEPS.length - 1 && <span className={`h-px w-6 ${i < idx ? 'bg-emerald-300' : 'bg-line'}`} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export function TaskDetail() {
  const { id } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const [t, err, reload] = useLoad(() => api<TaskDetailData>(`/tasks/${id}`), [id]);
  const [modal, setModal] = useState<null | 'approve' | 'assign'>(null);

  const act = async (path: string, body: Record<string, unknown>, ok: string) => {
    try { await api(`/tasks/${id}/${path}`, { body }); toast(ok); setModal(null); reload(); return true; } catch (e) { toast((e as Error).message, 'error'); return false; }
  };
  const withNote = async (path: string, title: string, label: string, ok: string, field: 'note' | 'comment', danger = false) => {
    const r = await confirm({ title, confirmLabel: title, danger, input: { label, required: true } });
    if (r) await act(path, { [field]: r.value }, ok);
  };
  const startTimer = async () => {
    try { await api('/time/start', { body: { task_id: id } }); window.dispatchEvent(new Event('timer-changed')); toast('Timer started'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  if (err) return <ErrorText error={err} />;
  if (!t) return <LoadingRows rows={6} />;
  const working = t.can.requestAccess; // the assignee, while the task is open
  const actions = [
    t.can.start && <Button key="start" icon={Play} onClick={() => act('start', {}, 'Task started')}>{t.status === 'rework' ? 'Resume work' : 'Start work'}</Button>,
    working && t.status === 'in_progress' && <Button key="timer" variant="secondary" icon={Timer} onClick={startTimer}>Start timer</Button>,
    t.can.submit && <Button key="submit" icon={Send} onClick={() => withNote('submit', 'Submit for review', 'What did you do? Note anything the reviewer should check.', 'Submitted for review', 'note')}>Submit for review</Button>,
    t.can.review && <Button key="reject" variant="danger" icon={Undo2} onClick={() => withNote('reject', 'Send back for rework', 'What needs fixing?', 'Sent back to the assignee', 'comment', true)}>Send back</Button>,
    t.can.review && <Button key="approve" icon={Check} onClick={() => setModal('approve')}>Approve</Button>,
    t.can.assign && <Button key="assign" icon={Plus} onClick={() => setModal('assign')}>Assign</Button>,
    t.can.cancel && <Button key="cancel" variant="ghost" icon={Ban} onClick={() => withNote('cancel', 'Cancel task', 'Reason for cancelling', 'Task cancelled', 'comment', true)}>Cancel task</Button>,
  ].filter(Boolean);

  return (
    <>
      <PageHeader back={{ to: '/tasks', label: 'Tasks' }} eyebrow={`${t.type}${t.period ? ` · ${t.period}` : ''}`} title={t.title}
        subtitle={<Link to={`/company/${t.company_id}`} className="font-medium text-brand-700 hover:underline">{t.company}</Link>} />
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <Stepper status={t.status} />
        {t.status === 'cancelled' && <StatusBadge status="cancelled" />}
      </div>
      {actions.length > 0 && (
        <div className="sticky top-[5.25rem] z-10 mb-6 flex flex-wrap items-center gap-2 rounded-2xl bg-white/80 backdrop-blur-xl ring-1 ring-ink/[0.06] px-4 py-3 shadow-card">
          <span className="mr-auto self-center text-sm text-slate-600">
            {t.can.review ? 'Submitted and waiting for your decision.' : t.can.submit ? 'In progress. Submit when done.' : t.can.start ? 'Ready to start.' : t.can.assign ? 'Client request waiting to be assigned.' : ['assigned', 'in_progress', 'rework'].includes(t.status) ? `Currently with ${t.assignee ?? 'nobody'}.` : t.status === 'submitted' ? `Waiting for ${t.reviewer ?? 'the reviewer'} to review.` : 'Actions'}
          </span>
          {actions}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          <Card title="Details">
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5 text-sm">
              <Info label="Assigned to" value={t.assignee} person /><Info label="Reviewer" value={t.reviewer} person /><Info label="Created by" value={t.creator} person />
              <Info label="Due" value={fmtDate(t.due_date)} late={isLate(t)} /><Info label="Statutory deadline" value={fmtDate(t.statutory_due)} />
              <Info label="Time logged" value={`${fmtHours(t.seconds_logged ?? 0)}${t.estimate_hours ? ` of ${t.estimate_hours}h` : ''}`} />
            </dl>
            {[['Instructions', t.instructions], ['Submission note', t.submission_note], ['Message to client', t.client_note]].map(([label, v]) => v && (
              <div key={label} className="mt-5 pt-5 border-t border-line">
                <h3 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{label}</h3>
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{v}</p>
              </div>
            ))}
          </Card>

          <Card title="Documents" description="Everyone working on this task can open all of this client’s documents while it is open. Only a director can delete them.">
            <Link to={`/company/${t.company_id}`} className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:underline">
              <FolderOpen className="size-4" aria-hidden />Open {t.company}’s documents<ChevronRight className="size-4" aria-hidden />
            </Link>
          </Card>
        </div>

        <Card title="Activity">
          <ol className="relative border-l border-line ml-3 space-y-5">
            {t.events.map((e, i) => (
              <li key={i} className="ml-6">
                <span className="absolute -left-[13px] grid place-items-center size-[26px] rounded-full bg-white ring-1 ring-line">
                  {e.to_status === 'approved' ? <CircleCheck className="size-4 text-emerald-600" aria-hidden /> : e.to_status === 'rework' ? <Undo2 className="size-4 text-red-600" aria-hidden /> : <Clock className="size-3.5 text-slate-400" aria-hidden />}
                </span>
                <div className="flex flex-wrap items-center gap-2 text-sm"><b className="text-ink font-semibold">{e.actor}</b><StatusBadge status={e.to_status} /></div>
                {e.comment && <p className="text-sm text-slate-600 mt-1.5 bg-slate-50 rounded-lg px-3 py-2 whitespace-pre-wrap">{e.comment}</p>}
                <time className="block text-xs text-slate-400 mt-1">{fmtDateTime(e.created_at)}</time>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {modal === 'approve' && <ApproveModal onClose={() => setModal(null)} onSave={(b) => act('approve', b, 'Approved. The client has been updated.')} />}
      {modal === 'assign' && <TaskForm assignTaskId={t.id} initial={{ type: t.type, title: t.title, instructions: t.instructions ?? '' }} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </>
  );
}

const Info = ({ label, value, person, late }: { label: string; value: string | null; person?: boolean; late?: boolean }) => (
  <div>
    <dt className="text-xs font-medium text-slate-500">{label}</dt>
    <dd className={`mt-1 font-medium flex items-center gap-2 ${late ? 'text-red-600' : 'text-ink'}`}>
      {person && value && <Avatar name={value} size="sm" />}{value ?? '—'}{late && <Badge tone="red">Overdue</Badge>}
    </dd>
  </div>
);

function ApproveModal({ onClose, onSave }: { onClose: () => void; onSave: (b: Record<string, string>) => Promise<boolean> }) {
  const [comment, setComment] = useState('');
  const [clientNote, setClientNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); await onSave({ ...(comment && { comment }), ...(clientNote && { client_note: clientNote }) }); setBusy(false); };
  return (
    <Modal title="Approve task" description="Closes the task, ends the employee's document access, and marks it Completed for the client." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button busy={busy} icon={Check} onClick={save}>Approve</Button></>}>
      <div className="space-y-4">
        <Field label="Message the client will see" optional hint="e.g. GSTR-3B for September filed on 18 Oct. The acknowledgement is in your documents.">
          <Textarea value={clientNote} onChange={(e) => setClientNote(e.target.value)} />
        </Field>
        <Field label="Internal comment" optional><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

