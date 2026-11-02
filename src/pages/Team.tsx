import { useState } from 'react';
import { KeyRound, Plus, Users } from 'lucide-react';
import { api, fmtDate } from '../api';
import { useUser } from '../auth';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Table, Td,
  useConfirm, useLoad, useToast,
} from '../components/ui';
import type { StaffUser } from './Clients';

const ROLE_TONE = { director: 'ink', manager: 'brand', employee: 'slate' } as const;

export function Team() {
  const u = useUser();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, err, reload, loading] = useLoad(() => api<(StaffUser & { created_at: string })[]>('/users'));
  const [adding, setAdding] = useState(false);
  const [pw, setPw] = useState(false);
  const toggle = async (s: StaffUser) => {
    const disabling = s.status === 'active';
    const ok = await confirm({
      title: `${disabling ? 'Disable' : 'Enable'} ${s.name}?`,
      body: disabling ? 'They are signed out everywhere immediately and lose all document access. Their history stays in the audit trail.' : 'They will be able to sign in again.',
      confirmLabel: disabling ? 'Disable account' : 'Enable account', danger: disabling,
    });
    if (!ok) return;
    try { await api(`/users/${s.id}/status`, { method: 'PATCH', body: { status: disabling ? 'disabled' : 'active' } }); toast(`${s.name} ${disabling ? 'disabled' : 'enabled'}`); reload(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <>
      <PageHeader title="Team" subtitle="People at the firm who use the portal."
        actions={
          <>
            <Button variant="secondary" icon={KeyRound} onClick={() => setPw(true)}>Change my password</Button>
            <Button icon={Plus} onClick={() => setAdding(true)}>Add {u.role === 'manager' ? 'employee' : 'staff'}</Button>
          </>
        } />
      <Card padded={false} title={`${rows?.length ?? '–'} people`}>
        {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !rows ? <div className="p-5"><LoadingRows /></div> : !rows?.length ? <EmptyState icon={Users} title="No staff yet" /> : (
          <Table head={['Name', 'Role', 'Contact', 'Since', 'Status', '']}>
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50/70">
                <Td><span className="flex items-center gap-3"><Avatar name={s.name} /><span className="font-semibold text-ink">{s.name}{s.id === u.id && <span className="text-xs font-normal text-slate-400"> (you)</span>}</span></span></Td>
                <Td><Badge tone={ROLE_TONE[s.role as keyof typeof ROLE_TONE] ?? 'slate'}>{s.role[0].toUpperCase() + s.role.slice(1)}</Badge></Td>
                <Td><div className="text-ink">{s.email}</div><div className="text-xs text-slate-500 tabular-nums">{s.mobile}</div></Td>
                <Td className="text-slate-600 whitespace-nowrap">{fmtDate(s.created_at)}</Td>
                <Td><StatusBadge status={s.status} /></Td>
                <Td className="text-right">{u.role === 'director' && s.id !== u.id && <Button size="sm" variant={s.status === 'active' ? 'danger' : 'secondary'} onClick={() => toggle(s)}>{s.status === 'active' ? 'Disable' : 'Enable'}</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {adding && <AddStaff onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {pw && <ChangePassword onClose={() => setPw(false)} />}
    </>
  );
}

function AddStaff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const u = useUser();
  const toast = useToast();
  const [f, setF] = useState({ name: '', role: 'employee', email: '', mobile: '', password: '' });
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const weak = f.password && (f.password.length < 12 || !/[A-Za-z]/.test(f.password) || !/\d/.test(f.password));
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api('/users', { body: f }); toast(`${f.name} added. Share the temporary password privately.`); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add staff member" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save} disabled={!f.name || !f.email || !f.mobile || !f.password || !!weak}>Add</Button></>}>
      <div className="space-y-4">
        <Field label="Full name"><Input value={f.name} onChange={set('name')} /></Field>
        {u.role === 'director' && (
          <Field label="Role"><Select value={f.role} onChange={set('role')}><option value="employee">Employee</option><option value="manager">Manager</option><option value="director">Director</option></Select></Field>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Work email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Mobile" hint="Receives the sign-in code"><Input value={f.mobile} onChange={set('mobile')} inputMode="tel" /></Field>
        </div>
        <Field label="Temporary password" error={weak ? 'Use 12+ characters with letters and numbers.' : undefined}
          hint="12+ characters with letters and numbers. They should change it after first sign-in.">
          <Input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />
        </Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && again !== next;
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { await api('/me/password', { body: { current, next } }); toast('Password changed. Other devices were signed out.'); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Change my password" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save} disabled={!current || !next || next !== again}>Change password</Button></>}>
      <div className="space-y-4">
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="12+ characters with letters and numbers"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match.' : undefined}><Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
