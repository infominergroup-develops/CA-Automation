import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, CalendarClock, CalendarPlus, CircleCheck, Hand, Trash2 } from 'lucide-react';
import { api, fmtDate } from '../api';
import { useUser } from '../auth';
import {
  Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, PageHeader, Select, Table, Td, useAction, useConfirm, useLoad,
} from '../components/ui';

export interface Schedule {
  id: string; company_id: string; company: string; task: string; repeat: 'monthly' | 'yearly';
  /** The run on now, or the next one. */
  run: { start: string; end: string };
  live: boolean; created_by_name: string;
  taken: { by: string; name: string; at: string } | null;
}

const runText = (s: Schedule) => `${fmtDate(s.run.start)} – ${fmtDate(s.run.end)}`;
/** Tells the sidebar badge to count again. */
const changed = () => window.dispatchEvent(new Event('schedules-changed'));

/** Who has a run, or a button to take it. Shared by this page and the dashboard. */
function TakeButton({ s, onDone }: { s: Schedule; onDone: () => void }) {
  const me = useUser();
  const { busy, run } = useAction();
  if (s.taken) {
    return <Badge tone={s.taken.by === me.id ? 'green' : 'slate'} dot>{s.taken.by === me.id ? 'Taken by you' : `Taken by ${s.taken.name}`}</Badge>;
  }
  const take = () => run(() => api(`/schedules/${s.id}/take`, { body: {} }), `You have taken ${s.task || s.company}`).then(() => { changed(); onDone(); });
  return <Button size="sm" icon={Hand} busy={busy} onClick={take}>Take it</Button>;
}

export function Schedules() {
  const me = useUser();
  const planner = me.role === 'director' || me.role === 'manager';
  const [rows, err, reload, loading] = useLoad(() => api<Schedule[]>('/schedules'));
  const confirm = useConfirm();
  const { run } = useAction();
  const stop = async (s: Schedule) => {
    if (await confirm({ title: `Stop the schedule for ${s.company}?`, body: 'It will not come back again. Runs already taken stay on record.', confirmLabel: 'Stop it', danger: true })) {
      if (await run(() => api(`/schedules/${s.id}`, { method: 'DELETE' }), 'Schedule stopped')) { changed(); reload(); }
    }
  };
  const live = rows?.filter((s) => s.live) ?? [];
  const later = rows?.filter((s) => !s.live) ?? [];

  const table = (list: Schedule[]) => (
    <Table head={['Task', 'Client', 'Dates', 'Repeats', 'Who has it', ...(planner ? [''] : [])]} label="Scheduled tasks">
      {list.map((s) => (
        <tr key={s.id}>
          <Td className="font-semibold text-ink">{s.task || '—'}</Td>
          <Td>{s.company}</Td>
          <Td className="whitespace-nowrap tabular-nums">{runText(s)}</Td>
          <Td>{s.repeat === 'monthly' ? 'Every month' : 'Every year'}</Td>
          <Td><TakeButton s={s} onDone={reload} /></Td>
          {planner && (
            <Td className="text-right">
              <button type="button" aria-label={`Stop the schedule for ${s.company}`} onClick={() => stop(s)}
                className="grid place-items-center size-8 rounded-full text-slate-400 hover:bg-slate-100 hover:text-red-600"><Trash2 className="size-4" aria-hidden /></button>
            </Td>
          )}
        </tr>
      ))}
    </Table>
  );

  return (
    <>
      <PageHeader title="Scheduled tasks" subtitle="Work that comes back every month or year. While its dates are on, the whole team is told. Whoever takes it can open that client's files until the run ends." />
      <div className={`grid gap-6 items-start ${planner ? 'xl:grid-cols-[22rem_1fr]' : ''}`}>
        {planner && <NewSchedule onDone={() => { changed(); reload(); }} />}
        <div className="space-y-6 min-w-0">
          <ErrorText error={err} />
          {loading && !rows ? <Card><LoadingRows /></Card> : !rows?.length ? (
            <Card><EmptyState icon={CalendarClock} title="Nothing scheduled yet">{planner ? 'Schedule the first one on the left.' : 'A director or manager schedules these.'}</EmptyState></Card>
          ) : (
            <>
              <Card title="On now" description="Their dates have started. Take one to make it yours." padded={false}>
                {live.length ? table(live) : <p className="px-5 py-4 text-sm text-slate-500">Nothing is on right now.</p>}
              </Card>
              {!!later.length && <Card title="Coming up" description="You can take these early." padded={false}>{table(later)}</Card>}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function NewSchedule({ onDone }: { onDone: () => void }) {
  const [companies, err] = useLoad(() => api<{ id: string; legal_name: string; approval?: string | null }[]>('/companies'));
  const [tasks, err2] = useLoad(() => api<{ id: string; name: string }[]>('/task-names'));
  const [f, setF] = useState({ task_name_id: '', company_id: '', start: '', end: '', repeat: 'monthly' });
  const { busy, run } = useAction();
  const ready = f.task_name_id && f.company_id && f.start && f.end && f.end >= f.start;
  const save = async () => {
    if (await run(() => api('/schedules', { body: f }), 'Task scheduled')) { setF({ ...f, task_name_id: '', company_id: '', start: '', end: '' }); onDone(); }
  };
  return (
    <Card title="Schedule a task" description="The team is told on these dates, every month or every year.">
      <div className="space-y-4">
        <ErrorText error={err || err2} />
        <Field label="Task" hint={<>Missing one? Add it in <Link to="/master?tab=tasks" className="underline">Masters</Link>.</>}>
          <Select value={f.task_name_id} onChange={(e) => setF({ ...f, task_name_id: e.target.value })}>
            <option value="">Choose a task</option>
            {tasks?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Client">
          <Select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>
            <option value="">Choose a client</option>
            {companies?.filter((c) => c.approval !== 'pending').map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From"><Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={f.end} min={f.start || undefined} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
        </div>
        <Field label="Repeats">
          <Select value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })}>
            <option value="monthly">Every month, on the same dates</option>
            <option value="yearly">Every year, on the same dates</option>
          </Select>
        </Field>
        <Button icon={CalendarPlus} busy={busy} disabled={!ready} onClick={save} className="w-full">Schedule it</Button>
      </div>
    </Card>
  );
}

/** On the dashboard: runs that are on now, so the whole team sees them. Hidden when there are none. */
export function SchedulesOnNow() {
  const [rows, , reload] = useLoad(() => api<Schedule[]>('/schedules'));
  const live = rows?.filter((s) => s.live) ?? [];
  if (!live.length) return null;
  const open = live.filter((s) => !s.taken).length;
  return (
    <Card title={<span className="flex items-center gap-2"><BellRing className="size-4 text-brand-700" aria-hidden />Scheduled tasks on now</span>}
      description={open ? `${open} waiting for someone to take ${open === 1 ? 'it' : 'them'}.` : 'All taken.'} padded={false}>
      <ul className="divide-y divide-line">
        {live.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            {s.taken ? <CircleCheck className="size-4 text-emerald-600 shrink-0" aria-hidden /> : <CalendarClock className="size-4 text-amber-600 shrink-0" aria-hidden />}
            <span className="flex-1 min-w-40">
              <span className="block text-sm font-semibold text-ink">{s.task ? `${s.task} · ` : ''}{s.company}</span>
              <span className="block text-xs text-slate-500 tabular-nums">{runText(s)} · {s.repeat === 'monthly' ? 'every month' : 'every year'}</span>
            </span>
            <TakeButton s={s} onDone={reload} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
