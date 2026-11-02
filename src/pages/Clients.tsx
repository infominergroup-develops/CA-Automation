import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight, ClipboardList, Plus, Search, Send, UserPlus, Users } from 'lucide-react';
import { api, fmtDate } from '../api';
import { useHasTally, useUser } from '../auth';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { ReportsPanel } from './Reports';
import {
  Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Td, Textarea,
  useLoad, useToast,
} from '../components/ui';
import { TaskForm, TaskTable, type TaskRow } from './Tasks';

interface Company {
  id: string; legal_name: string; pan: string | null; gstin: string | null; tally_name: string | null; group_id: string;
  group_name: string; manager_name: string | null; pending_docs: number; open_tasks: number;
}
export interface StaffUser { id: string; role: string; name: string; email: string; mobile: string; status: string }

export function Clients() {
  const u = useUser();
  const [params, setParams] = useSearchParams();
  const [rows, err, reload, loading] = useLoad(() => api<Company[]>('/companies'));
  const adding = params.get('new') === '1';
  const setAdding = (v: boolean) => setParams(v ? { new: '1' } : {});
  const [q, setQ] = useState('');
  const shown = rows?.filter((c) => `${c.legal_name} ${c.group_name} ${c.gstin ?? ''} ${c.pan ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title="Clients" subtitle={u.role === 'manager' ? 'Clients you manage or have tasks for.' : 'Every client company of the firm.'}
        actions={<Button icon={Plus} onClick={() => setAdding(true)}>New client</Button>} />
      <Card padded={false} title={`${rows?.length ?? '–'} companies`} actions={
        <div className="relative">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input placeholder="Search name, GSTIN or PAN" aria-label="Search clients" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9 w-64! h-9!" />
        </div>
      }>
        {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !rows ? <div className="p-5"><LoadingRows /></div> : !shown?.length ? (
          <EmptyState icon={Building2} title={q ? 'No clients match' : 'No clients yet'} action={!q && <Button icon={Plus} onClick={() => setAdding(true)}>Add your first client</Button>}>
            {q ? 'Try a different name, GSTIN or PAN.' : 'Add a client to start collecting documents and assigning work.'}
          </EmptyState>
        ) : (
          <>
            <div className="hidden md:block">
              <Table head={['Company', 'GSTIN', 'Manager', 'Open tasks', 'Docs to check', '']}>
                {shown.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 transition-colors">
                    <Td>
                      <Link to={`/company/${c.id}`} className="font-semibold text-ink hover:text-brand-700">{c.legal_name}</Link>
                      <div className="text-xs text-slate-500">{c.group_name}</div>
                    </Td>
                    <Td className="font-mono text-xs text-slate-600">{c.gstin ?? '—'}</Td>
                    <Td>{c.manager_name ?? <span className="text-slate-400">Unassigned</span>}</Td>
                    <Td className="tabular-nums">{c.open_tasks}</Td>
                    <Td>{c.pending_docs ? <Badge tone="amber" dot>{c.pending_docs} pending</Badge> : <span className="text-slate-400">—</span>}</Td>
                    <Td className="text-right"><Link to={`/company/${c.id}`} aria-label={`Open ${c.legal_name}`} className="inline-grid place-items-center size-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-ink"><ChevronRight className="size-4" /></Link></Td>
                  </tr>
                ))}
              </Table>
            </div>
            <ul className="md:hidden divide-y divide-line">
              {shown.map((c) => (
                <li key={c.id}>
                  <Link to={`/company/${c.id}`} className="flex items-center gap-3 px-5 py-3.5">
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink truncate">{c.legal_name}</span>
                      <span className="block text-xs text-slate-500">{c.open_tasks} open tasks · {c.manager_name ?? 'Unassigned'}</span>
                    </span>
                    {!!c.pending_docs && <Badge tone="amber" dot>{c.pending_docs}</Badge>}
                    <ChevronRight className="size-4 text-slate-300" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      {adding && <NewClient onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function NewClient({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const u = useUser();
  const toast = useToast();
  const [staff] = useLoad(() => api<StaffUser[]>('/users'));
  const [f, setF] = useState({ group_name: '', legal_name: '', pan: '', gstin: '', tally_name: '', manager_id: '', name: '', mobile: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api('/clients', {
        body: {
          group_name: f.group_name || f.legal_name,
          company: { legal_name: f.legal_name, pan: f.pan, gstin: f.gstin, tally_name: f.tally_name || undefined, manager_id: f.manager_id || undefined },
          contact: { name: f.name, mobile: f.mobile, email: f.email },
        },
      });
      toast(`${f.legal_name} added. ${f.name} can now sign in with their mobile.`);
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="New client" description="Creates the company and a login for the client contact." onClose={onClose} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save} disabled={!f.legal_name || !f.name || !f.mobile}>Create client</Button></>}>
      <div className="space-y-6">
        <fieldset>
          <legend className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 mb-3">Company</legend>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Legal name"><Input value={f.legal_name} onChange={set('legal_name')} placeholder="e.g. Sharma Traders Pvt Ltd" /></Field>
            <Field label="Client group" optional hint="Owner or family group. Defaults to the company name."><Input value={f.group_name} onChange={set('group_name')} /></Field>
            <Field label="PAN" optional><Input value={f.pan} onChange={set('pan')} maxLength={10} className="uppercase font-mono" placeholder="AAAAA9999A" /></Field>
            <Field label="GSTIN" optional><Input value={f.gstin} onChange={set('gstin')} maxLength={15} className="uppercase font-mono" placeholder="09AAAAA9999A1Z5" /></Field>
            <Field label="Name in Tally" optional hint="Used to match the Tally sync later"><Input value={f.tally_name} onChange={set('tally_name')} /></Field>
            {u.role === 'director' && (
              <Field label="Relationship manager">
                <Select value={f.manager_id} onChange={set('manager_id')}>
                  <option value="">Choose…</option>
                  {staff?.filter((s) => s.role !== 'employee' && s.status === 'active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 mb-3">Client login</legend>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Contact name"><Input value={f.name} onChange={set('name')} /></Field>
            <Field label="Mobile" hint="Signs in with a one-time code"><Input value={f.mobile} onChange={set('mobile')} inputMode="tel" placeholder="98765 43210" /></Field>
            <Field label="Email" optional><Input value={f.email} onChange={set('email')} type="email" /></Field>
          </div>
        </fieldset>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

/* ---------- Company page (staff and client) ---------- */

export function CompanyPage() {
  return useUser().role === 'client' ? <ClientCompany /> : <StaffCompany />;
}

function StaffCompany() {
  const { id } = useParams();
  const u = useUser();
  const managerial = u.role === 'director' || u.role === 'manager';
  const [data, err, reload] = useLoad(() => managerial
    ? api<{ company: Company; contacts: { id: string; name: string; mobile: string; email: string | null; status: string }[] }>(`/companies/${id}`)
    : api<Company[]>('/companies').then((cs) => ({ company: cs.find((c) => c.id === id)!, contacts: [] })), [id]);
  const [tasks, , reloadTasks] = useLoad(() => api<TaskRow[]>(`/tasks?company_id=${id}`), [id]);
  const [params, setParams] = useSearchParams();
  const hasTally = useHasTally();
  const tab = (params.get('tab') ?? 'docs') as 'docs' | 'reports' | 'tasks' | 'contacts';
  const setTab = (t: typeof tab) => setParams(t === 'docs' ? {} : { tab: t }, { replace: true });
  const [newTask, setNewTask] = useState(false);
  const [addContact, setAddContact] = useState(false);
  const c = data?.company;
  if (err) return <ErrorText error={err} />;
  if (!c) return <LoadingRows rows={6} />;
  return (
    <>
      <PageHeader back={managerial ? { to: '/clients', label: 'Clients' } : { to: '/tasks', label: 'My tasks' }}
        title={<span className="flex items-center gap-3"><span className="grid place-items-center size-11 rounded-xl bg-brand-50 text-brand-700 shrink-0"><Building2 className="size-5" aria-hidden /></span>{c.legal_name}</span>}
        subtitle={
          <span className="flex flex-wrap gap-2 mt-1">
            {c.group_name && <Badge>Group · {c.group_name}</Badge>}
            {c.gstin && <Badge><span className="font-mono">GSTIN {c.gstin}</span></Badge>}
            {c.pan && <Badge><span className="font-mono">PAN {c.pan}</span></Badge>}
            {c.manager_name && <Badge tone="brand">Manager · {c.manager_name}</Badge>}
          </span>
        }
        actions={managerial && <Button icon={Plus} onClick={() => setNewTask(true)}>New task</Button>} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'docs', label: 'Documents' },
        ...(hasTally ? [{ value: 'reports' as const, label: 'Reports' }] : []),
        { value: 'tasks', label: 'Tasks', count: tasks?.length },
        ...(managerial ? [{ value: 'contacts' as const, label: 'Client logins', count: data.contacts.length }] : []),
      ]} />
      {tab === 'docs' && <DocumentsPanel companyId={c.id} />}
      {hasTally && tab === 'reports' && <ReportsPanel companyId={c.id} />}
      {tab === 'tasks' && <Card padded={false}>{tasks && <TaskTable rows={tasks} />}</Card>}
      {tab === 'contacts' && (
        <Card title="People who can sign in for this client" padded={false} actions={<Button variant="secondary" icon={UserPlus} onClick={() => setAddContact(true)}>Add login</Button>}>
          {!data.contacts.length ? <EmptyState icon={Users} title="No logins yet" /> : (
            <Table head={['Name', 'Mobile', 'Email', 'Status']}>
              {data.contacts.map((p) => <tr key={p.id}><Td className="font-medium text-ink">{p.name}</Td><Td className="tabular-nums">{p.mobile}</Td><Td>{p.email ?? '—'}</Td><Td><StatusBadge status={p.status} /></Td></tr>)}
            </Table>
          )}
        </Card>
      )}
      {newTask && <TaskForm companyId={c.id} onClose={() => setNewTask(false)} onDone={() => { setNewTask(false); reloadTasks(); setTab('tasks'); }} />}
      {addContact && <AddContact groupId={c.group_id} onClose={() => setAddContact(false)} onDone={() => { setAddContact(false); reload(); }} />}
    </>
  );
}

function AddContact({ groupId, onClose, onDone }: { groupId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', mobile: '', email: '' });
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api(`/clients/${groupId}/users`, { body: f }); toast(`${f.name} can now sign in.`); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add client login" description="This person will see every company in the client group." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save} disabled={!f.name || !f.mobile}>Add login</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Mobile" hint="Receives the one-time sign-in code"><Input value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} inputMode="tel" /></Field>
        <Field label="Email" optional><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} type="email" /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

interface ClientTask { id: string; title: string; type: string; period: string | null; status: string; updated_at: string; client_note: string | null; company: string }

function ClientCompany() {
  const { id } = useParams();
  const [companies] = useLoad(() => api<{ id: string; legal_name: string; gstin: string | null }[]>('/companies'));
  const [tasks, , reload] = useLoad(() => api<ClientTask[]>('/tasks'), [id]);
  const [asking, setAsking] = useState(false);
  const [params, setParams] = useSearchParams();
  const hasTally = useHasTally();
  const tab = (params.get('tab') ?? (hasTally ? 'reports' : 'docs')) as 'reports' | 'docs' | 'work';
  const setTab = (t: typeof tab) => setParams({ tab: t }, { replace: true });
  const c = companies?.find((x) => x.id === id);
  return (
    <>
      <PageHeader back={{ to: '/', label: 'Home' }} title={c?.legal_name ?? 'Company'} subtitle={c?.gstin && <span className="font-mono">GSTIN {c.gstin}</span>}
        actions={<Button variant="dark" icon={Send} onClick={() => setAsking(true)}>Raise a request</Button>} />
      <Tabs value={tab} onChange={setTab} items={[...(hasTally ? [{ value: 'reports' as const, label: 'Reports' }] : []), { value: 'docs', label: 'Documents' }, { value: 'work', label: 'Work status' }]} />
      {id && hasTally && tab === 'reports' && <ReportsPanel companyId={id} />}
      {id && tab === 'docs' && <DocumentsPanel companyId={id} />}
      {tab === 'work' && <div className="max-w-2xl"><ClientTasks tasks={tasks?.filter((t) => t.company === c?.legal_name)} /></div>}
      {asking && id && <RaiseRequest companyId={id} onClose={() => setAsking(false)} onDone={() => { setAsking(false); reload(); }} />}
    </>
  );
}

export function ClientTasks({ tasks }: { tasks?: ClientTask[] }) {
  return (
    <Card title="Work status" description="What we are doing for you">
      {!tasks ? <LoadingRows rows={3} /> : !tasks.length ? <EmptyState icon={ClipboardList} title="No work items yet">Raise a request and it will appear here.</EmptyState> : (
        <ul className="space-y-3">
          {tasks.map((t) => (
            <li key={t.id} className="rounded-2xl ring-1 ring-ink/[0.07] bg-white p-4">
              <div className="flex justify-between gap-3 items-start">
                <div className="text-sm font-semibold text-ink">{t.title}</div>
                <StatusBadge status={t.status} />
              </div>
              <div className="text-xs text-slate-500 mt-1">{t.type}{t.period ? ` · ${t.period}` : ''} · updated {fmtDate(t.updated_at)}</div>
              {t.client_note && <p className="text-sm text-emerald-900 mt-3 bg-emerald-50 rounded-lg px-3 py-2">{t.client_note}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RaiseRequest({ companyId, onClose, onDone }: { companyId?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [companies] = useLoad(() => api<{ id: string; legal_name: string }[]>('/companies'));
  const [f, setF] = useState({ company_id: companyId ?? '', title: '', details: '' });
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api('/tasks/request', { body: { ...f, company_id: f.company_id || (companies?.length === 1 ? companies[0].id : '') } }); toast('Request sent. Your CA team will pick it up shortly.'); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Raise a request" description="Tell us what you need. You can track it under Requests & status." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} icon={Send} onClick={save} disabled={!(f.company_id || companies?.length === 1) || f.title.trim().length < 3}>Send request</Button></>}>
      <div className="space-y-4">
        {!companyId && (companies?.length ?? 0) > 1 && (
          <Field label="Company">
            <Select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>
              <option value="">Choose…</option>{companies?.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="What do you need?"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. CA certificate for bank loan" /></Field>
        <Field label="Details" optional><Textarea value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} placeholder="Deadline, bank name, anything that helps" /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

export function ClientRequests() {
  const [tasks, , reload] = useLoad(() => api<ClientTask[]>('/tasks'));
  const [asking, setAsking] = useState(false);
  const open = tasks?.filter((t) => t.status !== 'Completed' && t.status !== 'Cancelled');
  const done = tasks?.filter((t) => t.status === 'Completed');
  return (
    <>
      <PageHeader title="Requests & status" subtitle="Everything we are working on for you, and what is complete."
        actions={<Button variant="dark" icon={Send} onClick={() => setAsking(true)}>Raise a request</Button>} />
      <div className="grid lg:grid-cols-2 gap-6">
        <ClientTasks tasks={open} />
        <Card title="Completed">
          {!done ? <LoadingRows rows={2} /> : !done.length ? <EmptyState icon={ClipboardList} title="Nothing completed yet" /> : (
            <ul className="space-y-3">{done.map((t) => (
              <li key={t.id} className="rounded-2xl ring-1 ring-ink/[0.07] bg-white p-4">
                <div className="flex justify-between gap-3"><span className="text-sm font-semibold text-ink">{t.title}</span><StatusBadge status={t.status} /></div>
                {t.client_note && <p className="text-sm text-slate-600 mt-2">{t.client_note}</p>}
                <div className="text-xs text-slate-400 mt-1">{fmtDate(t.updated_at)}</div>
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
      {asking && <RaiseRequest onClose={() => setAsking(false)} onDone={() => { setAsking(false); reload(); }} />}
    </>
  );
}
