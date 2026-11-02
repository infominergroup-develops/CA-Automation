import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Ban, Check, ChevronRight, CircleCheck, Clock, FolderOpen, KeyRound, ListChecks, Play, Plus, Send, Timer, Undo2,
} from 'lucide-react';
import { api, fmtDate, fmtDateTime, fmtHours } from '../api';
import { useUser } from '../auth';
import {
  Avatar, Badge, Button, Card, Chip, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Td,
  Textarea, useConfirm, useLoad, useToast,
} from '../components/ui';
import type { Category } from '../components/DocumentsPanel';
import type { StaffUser } from './Clients';

export interface TaskRow {
  id: string; company_id: string; company: string; type: string; title: string; period: string | null; status: string;
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

export function TaskTable({ rows }: { rows: TaskRow[] }) {
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
                  <span>{t.type}{t.period ? ` · ${t.period}` : ''}</span>
                  {PRIORITY[t.priority] && <Badge tone={PRIORITY[t.priority]![0]}>{PRIORITY[t.priority]![1]}</Badge>}
                  {t.rework_count > 0 && <Badge tone="red">Rework ×{t.rework_count}</Badge>}
                </div>
              </Td>
              <Td className="text-slate-700">{t.company}</Td>
              <Td>{t.assignee ? <span className="flex items-center gap-2"><Avatar name={t.assignee} size="sm" /><span className="text-slate-700">{t.assignee}</span></span> : <span className="text-slate-400">Unassigned</span>}</Td>
              <Td className={`whitespace-nowrap tabular-nums ${isLate(t) ? 'text-red-600 font-semibold' : 'text-slate-700'}`}>{fmtDate(t.due_date)}{isLate(t) && <span className="sr-only"> (overdue)</span>}</Td>
              <Td><Logged t={t} /></Td>
              <Td><StatusBadge status={t.status} /></Td>
            </tr>
          ))}
        </Table>
      </div>
      <ul className="md:hidden divide-y divide-line">
        {rows.map((t) => (
          <li key={t.id}>
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
            {u.role !== 'employee' && <Button icon={Plus} onClick={() => set('new', '1')}>New task</Button>}
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
        {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !rows ? <div className="p-5"><LoadingRows /></div> : rows && <TaskTable rows={rows.filter(FILTERS[filter])} />}
      </Card>
      {creating && <TaskForm onClose={() => set('new', null)} onDone={() => { set('new', null); reload(); }} />}
    </>
  );
}

/** Create a task, or (with `assignTaskId`) assign a client request. */
export function TaskForm({ companyId, assignTaskId, initial, onClose, onDone }:
  { companyId?: string; assignTaskId?: string; initial?: Partial<Record<string, string>>; onClose: () => void; onDone: () => void }) {
  const u = useUser();
  const toast = useToast();
  const [companies] = useLoad(() => api<{ id: string; legal_name: string }[]>('/companies'));
  const [staff] = useLoad(() => api<StaffUser[]>('/users'));
  const [meta] = useLoad(() => api<{ types: string[] }>('/tasks/meta'));
  const [cats] = useLoad(() => api<Category[]>('/categories'));
  const [f, setF] = useState({
    company_id: companyId ?? '', type: initial?.type ?? 'GST return', title: initial?.title ?? '', period: '', instructions: initial?.instructions ?? '',
    assignee_id: '', reviewer_id: u.id, due_date: '', statutory_due: '', priority: 'normal', estimate_hours: '',
  });
  const [grant, setGrant] = useState<number[]>([]);
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
        await api('/tasks', { body: { ...body, grant_category_ids: grant.length ? grant : undefined } });
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
        {!assignTaskId && (
          <fieldset>
            <legend className="text-[13px] font-medium text-ink mb-1">Grant document access now <span className="font-normal text-slate-400">· optional</span></legend>
            <p className="text-xs text-slate-500 mb-2">Otherwise the assignee requests access when they start. Access ends when you approve the task.</p>
            <div className="flex flex-wrap gap-2">
              {cats?.map((c) => <Chip key={c.id} selected={grant.includes(c.id)} onToggle={() => setGrant((g) => (g.includes(c.id) ? g.filter((x) => x !== c.id) : [...g, c.id]))}>{c.name}</Chip>)}
            </div>
          </fieldset>
        )}
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
  const u = useUser();
  const toast = useToast();
  const confirm = useConfirm();
  const [t, err, reload] = useLoad(() => api<TaskDetailData>(`/tasks/${id}`), [id]);
  const [cats] = useLoad(() => api<Category[]>('/categories'));
  const [modal, setModal] = useState<null | 'approve' | 'access' | 'assign'>(null);
  const catName = (cid: number) => cats?.find((c) => c.id === cid)?.name ?? `#${cid}`;

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
  const decide = async (gid: string, decision: 'grant' | 'reject') => {
    try { await api(`/access-requests/${gid}/decide`, { body: { decision } }); toast(decision === 'grant' ? 'Access granted' : 'Request rejected'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const revoke = async (gid: string) => {
    if (!(await confirm({ title: 'Revoke document access now?', body: 'The assignee will immediately lose access to these documents.', confirmLabel: 'Revoke', danger: true }))) return;
    try { await api(`/access-grants/${gid}/revoke`, { body: {} }); toast('Access revoked'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (err) return <ErrorText error={err} />;
  if (!t) return <LoadingRows rows={6} />;
  const working = t.can.requestAccess;
  const hasGrant = t.grants.some((g) => g.status === 'granted');
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

          <Card title="Document access" description="Employees see a client's documents only for the categories granted on this task."
            actions={working && <Button size="sm" variant="secondary" icon={KeyRound} onClick={() => setModal('access')}>Request access</Button>}>
            {!t.grants.length ? (
              <EmptyState icon={KeyRound} title="No access requested">{working ? 'Request only the categories this task needs.' : 'Nothing has been requested on this task.'}</EmptyState>
            ) : (
              <ul className="space-y-3">
                {t.grants.map((g) => (
                  <li key={g.id} className="rounded-2xl ring-1 ring-ink/[0.07] bg-white p-4">
                    <div className="flex justify-between gap-3 flex-wrap">
                      <div className="flex flex-wrap gap-1.5">{g.category_ids.map((c) => <Badge key={c} tone="ink">{catName(c)}</Badge>)}</div>
                      {g.status === 'requested' ? <Badge tone="amber" dot>Awaiting decision</Badge> : <StatusBadge status={g.status} />}
                    </div>
                    <p className="text-sm text-slate-700 mt-2">{g.reason}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Requested {fmtDateTime(g.created_at)}{g.decided_by_name && ` · decided by ${g.decided_by_name}`}
                      {g.status === 'granted' && g.expires_at && ` · ends ${fmtDate(g.expires_at)} or on approval`}
                    </p>
                    {g.status === 'requested' && t.can.decideAccess && (
                      <div className="flex gap-2 mt-3">
                        <Button size="sm" icon={Check} onClick={() => decide(g.id, 'grant')}>Grant</Button>
                        <Button size="sm" variant="danger" onClick={() => decide(g.id, 'reject')}>Reject</Button>
                      </div>
                    )}
                    {g.status === 'granted' && t.can.decideAccess && <Button size="sm" variant="ghost" className="mt-2 -ml-3" onClick={() => revoke(g.id)}>Revoke now</Button>}
                  </li>
                ))}
              </ul>
            )}
            {u.role === 'employee' && hasGrant && (
              <Link to={`/company/${t.company_id}`} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:underline">
                <FolderOpen className="size-4" aria-hidden />Open granted documents<ChevronRight className="size-4" aria-hidden />
              </Link>
            )}
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
      {modal === 'access' && <AccessModal cats={cats ?? []} onClose={() => setModal(null)}
        onSave={(b) => api(`/tasks/${id}/access-requests`, { body: b }).then(() => { toast('Access requested. Your manager has been notified.'); setModal(null); reload(); })} />}
      {modal === 'assign' && <TaskForm assignTaskId={t.id} initial={{ title: t.title, instructions: t.instructions ?? '' }} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
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

function AccessModal({ cats, onClose, onSave }: { cats: Category[]; onClose: () => void; onSave: (b: { category_ids: number[]; reason: string }) => Promise<unknown> }) {
  const [sel, setSel] = useState<number[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const save = () => { setBusy(true); onSave({ category_ids: sel, reason: reason.trim() }).catch(setErr).finally(() => setBusy(false)); };
  return (
    <Modal title="Request document access" description="Ask only for what this task needs. Access ends automatically when the task is approved." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} icon={Send} disabled={!sel.length || reason.trim().length < 5} onClick={save}>Send request</Button></>}>
      <div className="space-y-4">
        <fieldset>
          <legend className="text-[13px] font-medium text-ink mb-2">Categories</legend>
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => <Chip key={c.id} selected={sel.includes(c.id)} onToggle={() => setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))}>{c.name}</Chip>)}
          </div>
        </fieldset>
        <Field label="Why do you need these?"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bank statements Apr–Sep to reconcile ITC" /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
