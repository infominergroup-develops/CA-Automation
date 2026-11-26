import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderPlus, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { api } from '../api';
import {
  Badge, Button, Card, Chip, EmptyState, ErrorText, Field, Input, LoadingRows, PageHeader, Select, Table, Tabs, Td, useConfirm, useLoad, useToast,
} from '../components/ui';

interface Client { id: string; legal_name: string; group_name: string; work_types: string[] }
interface WorkType { id: string; name: string }
interface ClientSet { id: string; name: string; company_ids: string[]; member_ids: string[] }
interface Staff { id: string; name: string; role: string; status: string; client_ids?: string[] }

/** Director's client master: what work we do for each client, and which staff see which clients. */
export function ClientMaster() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'work') as 'work' | 'groups' | 'staff';
  const [clients, e1, reloadClients] = useLoad(() => api<Client[]>('/companies'));
  const [types, e2, reloadTypes] = useLoad(() => api<WorkType[]>('/work-types'));
  const [sets, e3, reloadSets] = useLoad(() => api<ClientSet[]>('/client-sets'));
  const [staff, e4, reloadStaff] = useLoad(() => api<Staff[]>('/users'));
  const team = (staff ?? []).filter((s) => s.status === 'active' && (s.role === 'employee' || s.role === 'manager'));
  const ready = clients && types && sets && staff;
  return (
    <>
      <PageHeader title="Client master" subtitle="What we do for each client, and which staff see which clients. Managers see every client; employees see these plus their own tasks and clients they added." />
      <ErrorText error={e1 || e2 || e3 || e4} />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} items={[
        { value: 'work', label: 'Work types' },
        { value: 'groups', label: 'Client groups', count: sets?.length },
        { value: 'staff', label: 'Employee access' },
      ]} />
      {!ready ? <LoadingRows rows={6} />
        : tab === 'work' ? <WorkTypes clients={clients} types={types} onChange={() => { reloadClients(); reloadTypes(); }} />
          : tab === 'groups' ? <Groups clients={clients} sets={sets} team={team} onChange={reloadSets} />
            : <EmployeeAccess clients={clients} sets={sets} staff={staff.filter((s) => s.role === 'employee' && s.status === 'active')} onChange={reloadStaff} />}
    </>
  );
}

/** A searchable list of ticks, for clients or staff. */
function PickList({ items, picked, onChange, label }: { items: { id: string; name: string; hint?: string }[]; picked: Set<string>; onChange: (p: Set<string>) => void; label: string }) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => `${i.name} ${i.hint ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string, on: boolean) => { const n = new Set(picked); if (on) n.add(id); else n.delete(id); onChange(n); };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <div className="relative flex-1 min-w-48">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label}`} aria-label={`Search ${label}`} className="pl-9 h-9!" />
        </div>
        <span className="text-xs text-slate-500">{picked.size} chosen</span>
        <Button size="sm" variant="ghost" onClick={() => onChange(new Set([...picked, ...shown.map((i) => i.id)]))}>Tick all shown</Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(new Set([...picked].filter((id) => !shown.some((i) => i.id === id))))}>Clear shown</Button>
      </div>
      <ul className="max-h-80 overflow-y-auto rounded-xl ring-1 ring-ink/10 divide-y divide-line">
        {shown.map((i) => (
          <li key={i.id}>
            <label className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
              <input type="checkbox" className="size-4 accent-brand-500" checked={picked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
              <span className="text-sm text-ink">{i.name}</span>
              {i.hint && <span className="text-xs text-slate-500">{i.hint}</span>}
            </label>
          </li>
        ))}
        {!shown.length && <li className="px-4 py-3 text-sm text-slate-500">Nothing matches.</li>}
      </ul>
    </div>
  );
}

function WorkTypes({ clients, types, onChange }: { clients: Client[]; types: WorkType[]; onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<unknown>();
  // Ticks show at once and build on each other, and saves go one after another, so quick clicks never undo one another.
  const [ticked, setTicked] = useState<Record<string, string[]>>({});
  const latest = useRef<Record<string, string[]>>({});
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr(undefined);
    try { await fn(); if (ok) toast(ok); onChange(); } catch (e) { setErr(e); latest.current = {}; setTicked({}); onChange(); }
  };
  const add = () => run(() => api('/work-types', { body: { name: name.trim() } }).then(() => setName('')), `${name.trim()} added`);
  const remove = async (t: WorkType) => {
    if (await confirm({ title: `Remove ${t.name}?`, body: 'It is taken off every client that has it. Clients and their documents are not affected.', confirmLabel: 'Remove', danger: true })) {
      run(() => api(`/work-types/${t.id}`, { method: 'DELETE' }), `${t.name} removed`);
    }
  };
  const current = (c: Client) => ticked[c.id] ?? c.work_types;
  const toggle = (c: Client, id: string) => {
    const now = latest.current[c.id] ?? c.work_types;
    const next = now.includes(id) ? now.filter((w) => w !== id) : [...now, id];
    latest.current = { ...latest.current, [c.id]: next };
    setTicked(latest.current);
    saving.current = saving.current.then(() => run(() => api(`/companies/${c.id}/work-types`, { method: 'PUT', body: { work_types: next } })));
  };
  const shown = clients.filter((c) => `${c.legal_name} ${c.group_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-6">
      <Card title="Kinds of work" description="Tick these for each client below. The Clients page can then be filtered by them.">
        <div className="flex flex-wrap gap-2">
          {types.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-ink/[0.05] pl-3.5 pr-1 h-8 text-[13px] font-medium text-ink">
              {t.name}
              <button type="button" aria-label={`Remove ${t.name}`} onClick={() => remove(t)} className="grid place-items-center size-6 rounded-full text-slate-400 hover:bg-white hover:text-red-600"><X className="size-3.5" aria-hidden /></button>
            </span>
          ))}
        </div>
        <div className="flex gap-2 mt-4 max-w-md">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Valuation" aria-label="New kind of work" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim().length >= 2) add(); }} />
          <Button icon={Plus} disabled={name.trim().length < 2} onClick={add}>Add</Button>
        </div>
        <ErrorText error={err} />
      </Card>
      <Card title="Clients" padded={false} actions={
        <div className="relative">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" aria-label="Search clients" className="pl-9 w-56! h-9!" />
        </div>
      }>
        {!shown.length ? <EmptyState icon={Users} title="No clients" /> : (
          <Table head={['Client', 'Work we do for them']}>
            {shown.map((c) => (
              <tr key={c.id}>
                <Td><div className="font-semibold text-ink">{c.legal_name}</div><div className="text-xs text-slate-500">{c.group_name}</div></Td>
                <Td><div className="flex flex-wrap gap-1.5">{types.map((t) => <Chip key={t.id} selected={current(c).includes(t.id)} onToggle={() => toggle(c, t.id)}>{t.name}</Chip>)}</div></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Groups({ clients, sets, team, onChange }: { clients: Client[]; sets: ClientSet[]; team: Staff[]; onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [openId, setOpenId] = useState<string | null>(sets[0]?.id ?? null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<unknown>();
  const create = async () => {
    setErr(undefined);
    try { const s = await api<ClientSet>('/client-sets', { body: { name: name.trim() } }); setName(''); toast(`Group ${s.name} created`); setOpenId(s.id); onChange(); } catch (e) { setErr(e); }
  };
  const open = sets.find((s) => s.id === openId);
  return (
    <div className="grid lg:grid-cols-[18rem_1fr] gap-6 items-start">
      <Card title="Groups" padded={false}>
        <ul className="divide-y divide-line">
          {sets.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setOpenId(s.id)} className={`w-full text-left px-5 py-3 hover:bg-slate-50 ${s.id === openId ? 'bg-brand-50/60' : ''}`}>
                <div className="text-sm font-semibold text-ink">{s.name}</div>
                <div className="text-xs text-slate-500">{s.company_ids.length} client{s.company_ids.length === 1 ? '' : 's'} · {s.member_ids.length} staff</div>
              </button>
            </li>
          ))}
        </ul>
        <div className="p-4 border-t border-line space-y-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Audit clients – North" aria-label="New group name" />
          <Button icon={FolderPlus} className="w-full" disabled={name.trim().length < 2} onClick={create}>New group</Button>
          <ErrorText error={err} />
        </div>
      </Card>
      {open ? <GroupEditor key={open.id} set={open} clients={clients} team={team} onSaved={onChange}
        onDelete={async () => {
          if (await confirm({ title: `Delete ${open.name}?`, body: 'Its staff lose the access this group gave them. Clients and documents are not affected.', confirmLabel: 'Delete group', danger: true })) {
            await api(`/client-sets/${open.id}`, { method: 'DELETE' }).then(() => { toast('Group deleted'); setOpenId(null); onChange(); }, (e) => toast((e as Error).message, 'error'));
          }
        }} />
        : <Card><EmptyState icon={Users} title="No group chosen">Create a group, tick its clients, then tick the staff who should see them.</EmptyState></Card>}
    </div>
  );
}

function GroupEditor({ set, clients, team, onSaved, onDelete }: { set: ClientSet; clients: Client[]; team: Staff[]; onSaved: () => void; onDelete: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(set.name);
  const [picked, setPicked] = useState(new Set(set.company_ids));
  const [members, setMembers] = useState(new Set(set.member_ids));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api(`/client-sets/${set.id}`, { method: 'PUT', body: { name: name.trim(), company_ids: [...picked], member_ids: [...members] } });
      toast(`${name.trim()} saved`); onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title={set.name} description="Ticked staff see every ticked client, with their usual rights. Employees still cannot delete, move or change files."
      actions={<Button variant="ghost" icon={Trash2} onClick={onDelete}>Delete group</Button>}>
      <div className="space-y-6">
        <Field label="Group name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <div><h3 className="text-sm font-semibold text-ink mb-2">Clients in this group</h3>
          <PickList label="clients" items={clients.map((c) => ({ id: c.id, name: c.legal_name, hint: c.group_name }))} picked={picked} onChange={setPicked} /></div>
        <div><h3 className="text-sm font-semibold text-ink mb-2">Staff who get these clients</h3>
          <PickList label="staff" items={team.map((s) => ({ id: s.id, name: s.name, hint: s.role === 'manager' ? 'manager (already sees every client)' : 'employee' }))} picked={members} onChange={setMembers} /></div>
        <ErrorText error={err} />
        <div className="flex justify-end"><Button busy={busy} onClick={save} disabled={name.trim().length < 2}>Save group</Button></div>
      </div>
    </Card>
  );
}

function EmployeeAccess({ clients, sets, staff, onChange }: { clients: Client[]; sets: ClientSet[]; staff: Staff[]; onChange: () => void }) {
  const [who, setWho] = useState(staff[0]?.id ?? '');
  const person = staff.find((s) => s.id === who);
  return (
    <Card title="Clients each employee can see" description="Tick clients for one employee. They also see clients from their groups, clients they added, and clients they have an open task for.">
      {!staff.length ? <EmptyState icon={Users} title="No employees yet" /> : (
        <div className="space-y-4">
          <Field label="Employee">
            <Select value={who} onChange={(e) => setWho(e.target.value)}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
          {person && <EmployeeTicks key={person.id} person={person} clients={clients} sets={sets} onSaved={onChange} />}
        </div>
      )}
    </Card>
  );
}

function EmployeeTicks({ person, clients, sets, onSaved }: { person: Staff; clients: Client[]; sets: ClientSet[]; onSaved: () => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState(new Set(person.client_ids ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const viaGroups = sets.filter((s) => s.member_ids.includes(person.id));
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api(`/users/${person.id}/clients`, { method: 'PUT', body: { company_ids: [...picked] } }); toast(`${person.name}'s clients saved`); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <>
      {!!viaGroups.length && (
        <p className="text-sm text-slate-600">Also through groups: {viaGroups.map((s) => <Badge key={s.id} tone="brand">{s.name}</Badge>)}</p>
      )}
      <PickList label="clients" items={clients.map((c) => ({ id: c.id, name: c.legal_name, hint: c.group_name }))} picked={picked} onChange={setPicked} />
      <ErrorText error={err} />
      <div className="flex justify-end"><Button busy={busy} onClick={save}>Save for {person.name}</Button></div>
    </>
  );
}
