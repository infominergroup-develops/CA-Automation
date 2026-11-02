import { useState } from 'react';
import { AlertTriangle, Download, FileQuestion, Inbox, Plus, Save, ShieldCheck } from 'lucide-react';
import { api, download, fmtDate, fmtDateTime } from '../api';
import { useAuth, useUser } from '../auth';
import {
  Alert, Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Table, Tabs, Td, Textarea,
  useConfirm, useLoad, useToast,
} from '../components/ui';
import { NoticeBody, type Notice } from './Gates';

interface Mine {
  consents: { notice_version: string; purposes: string; given_at: string; withdrawn_at: string | null }[];
  requests: { id: string; type: string; details: string; status: string; response: string | null; due_at: string; created_at: string }[];
}

const REQUEST_TYPES = [
  ['access', 'Get a summary of my data'], ['correction', 'Correct or complete my data'], ['erasure', 'Erase my data'],
  ['nomination', 'Nominate someone to act for me'], ['grievance', 'Raise a grievance'],
] as const;
const typeLabel = (t: string) => t.replace('_', ' ').replace(/^./, (c) => c.toUpperCase());

export function Privacy() {
  const u = useUser();
  const [tab, setTab] = useState<'mine' | 'requests' | 'breaches' | 'settings'>('mine');
  return (
    <>
      <PageHeader title="Privacy & data" subtitle="Your rights under the Digital Personal Data Protection Act, 2023." />
      {u.role === 'director' && (
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'mine', label: 'My privacy' }, { value: 'requests', label: 'Data-principal requests' },
          { value: 'breaches', label: 'Breach register' }, { value: 'settings', label: 'Settings' },
        ]} />
      )}
      {tab === 'mine' && <MyPrivacy />}
      {tab === 'requests' && <RequestQueue />}
      {tab === 'breaches' && <Breaches />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

function MyPrivacy() {
  const u = useUser();
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useAuth();
  const [notice] = useLoad(() => api<Notice>('/privacy/notice'));
  const [mine, err, reload] = useLoad(() => api<Mine>('/privacy/mine'));
  const [asking, setAsking] = useState(false);
  const active = mine?.consents.find((c) => !c.withdrawn_at);
  const activePurposes = active ? (JSON.parse(active.purposes) as string[]) : [];

  const withdraw = async (code: string) => {
    const service = code === 'service';
    const ok = await confirm({
      title: service ? 'Withdraw consent for service delivery?' : 'Stop WhatsApp and SMS updates?',
      body: service ? 'You will be signed out and lose portal access. Records the firm must keep by law are retained. Your CA team will contact you.' : 'You will stop receiving updates on WhatsApp and SMS. You can still use the portal.',
      confirmLabel: 'Withdraw consent', danger: service,
    });
    if (!ok) return;
    try {
      const r = await api<{ signedOut: boolean }>('/privacy/consent/withdraw', { body: { purposes: [code] } });
      if (r.signedOut) await refresh(); else { toast('Consent withdrawn'); reload(); }
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-6">
        <Button variant="secondary" icon={Download} onClick={() => download('/privacy/my-data', 'my-data.json').then(() => toast('Your data was downloaded')).catch((e) => toast(e.message, 'error'))}>Download my data</Button>
        <Button icon={Plus} onClick={() => setAsking(true)}>Make a request</Button>
      </div>
      <ErrorText error={err} />
      <div className="grid lg:grid-cols-5 gap-6">
        <Card title="Privacy notice" className="lg:col-span-3">{notice ? <NoticeBody n={notice} /> : <LoadingRows />}</Card>
        <div className="lg:col-span-2 space-y-6">
          {u.role === 'client' && notice && (
            <Card title="Your consent">
              {!active ? <EmptyState icon={ShieldCheck} title="No active consent" /> : (
                <ul className="space-y-4">
                  {notice.purposes.map((p) => {
                    const on = activePurposes.includes(p.code);
                    return (
                      <li key={p.code} className="flex justify-between gap-4 items-start">
                        <span className="text-sm text-slate-700">{p.label}</span>
                        {on ? <Button size="sm" variant="secondary" className="shrink-0" onClick={() => withdraw(p.code)}>Withdraw</Button> : <Badge>Not given</Badge>}
                      </li>
                    );
                  })}
                  <li className="text-xs text-slate-500 pt-3 border-t border-line">Given {fmtDateTime(active.given_at)} · notice version {active.notice_version}</li>
                </ul>
              )}
            </Card>
          )}
          <Card title="My requests">
            {!mine ? <LoadingRows rows={2} /> : !mine.requests.length ? <EmptyState icon={FileQuestion} title="No requests yet">Ask for a copy, correction or erasure of your data.</EmptyState> : (
              <ul className="space-y-3">
                {mine.requests.map((r) => (
                  <li key={r.id} className="rounded-2xl ring-1 ring-ink/[0.07] bg-white p-4 text-sm">
                    <div className="flex justify-between gap-3"><b className="text-ink">{typeLabel(r.type)}</b><StatusBadge status={r.status} /></div>
                    <p className="text-slate-600 mt-1">{r.details}</p>
                    {r.response && <p className="mt-2 bg-slate-50 rounded-lg px-3 py-2 text-slate-700"><b>Response:</b> {r.response}</p>}
                    <p className="text-xs text-slate-400 mt-2">Raised {fmtDate(r.created_at)} · reply due by {fmtDate(r.due_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {asking && <NewRequest onClose={() => setAsking(false)} onDone={() => { setAsking(false); reload(); }} />}
    </>
  );
}

function NewRequest({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState('access');
  const [details, setDetails] = useState('');
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api('/privacy/requests', { body: { type, details } }); toast('Request sent to the Grievance Officer'); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Make a privacy request" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={details.trim().length < 5} onClick={save}>Send request</Button></>}>
      <div className="space-y-4">
        <Field label="Request"><Select value={type} onChange={(e) => setType(e.target.value)}>{REQUEST_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Details"><Textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Tell us what you need" /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

/* ---------- Director tabs ---------- */

interface DpdpReq { id: string; type: string; details: string; status: string; response: string | null; due_at: string; created_at: string; user_name: string; user_role: string }
interface Breach { id: string; detected_at: string; description: string; data_affected: string; principals_affected: number | null; board_intimated_at: string | null; principals_notified_at: string | null; status: string }

function RequestQueue() {
  const [reqs, err, reload, loading] = useLoad(() => api<DpdpReq[]>('/privacy/requests'));
  const [responding, setResponding] = useState<DpdpReq | null>(null);
  const now = Date.now();
  return (
    <Card padded={false} title="Requests from clients and staff" description="Answer within the response period set in Settings.">
      {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !reqs ? <div className="p-5"><LoadingRows /></div> : !reqs?.length ? <EmptyState icon={Inbox} title="No requests" /> : (
        <Table head={['From', 'Type', 'Details', 'Due', 'Status', '']}>
          {reqs.map((r) => {
            const openish = ['open', 'in_progress'].includes(r.status);
            const overdue = openish && Date.parse(r.due_at) < now;
            return (
              <tr key={r.id}>
                <Td><div className="font-medium text-ink">{r.user_name}</div><div className="text-xs text-slate-500 capitalize">{r.user_role}</div></Td>
                <Td className="whitespace-nowrap">{typeLabel(r.type)}</Td>
                <Td className="max-w-80 text-slate-700">{r.details}{r.response && <div className="text-xs text-slate-500 mt-1">↳ {r.response}</div>}</Td>
                <Td className={`whitespace-nowrap tabular-nums ${overdue ? 'text-red-600 font-semibold' : ''}`}>{fmtDate(r.due_at)}{overdue && <Badge tone="red">Overdue</Badge>}</Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td className="text-right">{openish && <Button size="sm" variant="secondary" onClick={() => setResponding(r)}>Respond</Button>}</Td>
              </tr>
            );
          })}
        </Table>
      )}
      {responding && <Respond r={responding} onClose={() => setResponding(null)} onDone={() => { setResponding(null); reload(); }} />}
    </Card>
  );
}

function Respond({ r, onClose, onDone }: { r: DpdpReq; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [response, setResponse] = useState('');
  const [err, setErr] = useState<unknown>();
  const send = async (status: string) => {
    try { await api(`/privacy/requests/${r.id}`, { method: 'PATCH', body: { status, ...(response && { response }) } }); toast('Request updated'); onDone(); } catch (e) { setErr(e); }
  };
  return (
    <Modal title={`${typeLabel(r.type)} request from ${r.user_name}`} onClose={onClose}
      footer={<>
        <Button variant="secondary" onClick={() => send('in_progress')}>Mark in progress</Button>
        <Button variant="danger" onClick={() => send('rejected')} disabled={!response}>Reject with reason</Button>
        <Button onClick={() => send('closed')} disabled={!response}>Close as done</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm bg-slate-50 rounded-lg px-3 py-2 text-slate-700">{r.details}</p>
        {r.type === 'erasure' && <Alert tone="warning">Erase only what the law does not require you to keep (tax, audit and ICAI records). Explain what is retained and why.</Alert>}
        <Field label="Response sent to the person"><Textarea rows={4} value={response} onChange={(e) => setResponse(e.target.value)} /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function Breaches() {
  const toast = useToast();
  const [rows, err, reload, loading] = useLoad(() => api<Breach[]>('/privacy/breaches'));
  const [adding, setAdding] = useState(false);
  const patch = async (id: string, body: Record<string, unknown>) => {
    try { await api(`/privacy/breaches/${id}`, { method: 'PATCH', body }); toast('Breach record updated'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <>
      <div className="mb-6"><Alert tone="info">A personal data breach must be reported to the Data Protection Board and to affected people without delay. Check the timelines in the DPDP Rules in force and record each step here.</Alert></div>
      <Card padded={false} title="Breach register" actions={<Button variant="danger" icon={AlertTriangle} onClick={() => setAdding(true)}>Record a breach</Button>}>
        {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !rows ? <div className="p-5"><LoadingRows /></div> : !rows?.length ? <EmptyState icon={ShieldCheck} title="No breaches recorded" /> : (
          <Table head={['Detected', 'What happened', 'Board informed', 'People notified', 'Status']}>
            {rows.map((b) => (
              <tr key={b.id}>
                <Td className="whitespace-nowrap tabular-nums">{fmtDateTime(b.detected_at)}</Td>
                <Td className="max-w-96"><div className="text-ink">{b.description}</div><div className="text-xs text-slate-500 mt-0.5">Data: {b.data_affected}{b.principals_affected != null && ` · ${b.principals_affected} people`}</div></Td>
                <Td>{b.board_intimated_at ? <span className="tabular-nums">{fmtDateTime(b.board_intimated_at)}</span> : <Button size="sm" variant="secondary" onClick={() => patch(b.id, { board_intimated: true })}>Mark done</Button>}</Td>
                <Td>{b.principals_notified_at ? <span className="tabular-nums">{fmtDateTime(b.principals_notified_at)}</span> : <Button size="sm" variant="secondary" onClick={() => patch(b.id, { principals_notified: true })}>Mark done</Button>}</Td>
                <Td>
                  <Select value={b.status} onChange={(e) => patch(b.id, { status: e.target.value })} className="w-auto! h-9!" aria-label="Breach status">
                    <option value="open">Open</option><option value="contained">Contained</option><option value="closed">Closed</option>
                  </Select>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {adding && <NewBreach onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function NewBreach({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ detected_at: new Date().toISOString().slice(0, 16), description: '', data_affected: '', principals_affected: '' });
  const [err, setErr] = useState<unknown>();
  const save = async () => {
    try {
      await api('/privacy/breaches', { body: { ...f, principals_affected: f.principals_affected ? Number(f.principals_affected) : undefined } });
      toast('Breach recorded'); onDone();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title="Record a personal data breach" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="dark" className="bg-red-600! hover:bg-red-700!" onClick={save} disabled={f.description.length < 10 || !f.data_affected}>Record breach</Button></>}>
      <div className="space-y-4">
        <Field label="Detected at"><Input type="datetime-local" value={f.detected_at} onChange={(e) => setF({ ...f, detected_at: e.target.value })} /></Field>
        <Field label="What happened"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Data affected"><Input value={f.data_affected} onChange={(e) => setF({ ...f, data_affected: e.target.value })} placeholder="e.g. bank statements of 3 clients" /></Field>
        <Field label="Number of people affected" optional><Input type="number" min="0" value={f.principals_affected} onChange={(e) => setF({ ...f, principals_affected: e.target.value })} /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function Settings() {
  const [initial, err, reload] = useLoad(() => api<Record<string, string>>('/settings'));
  return err ? <ErrorText error={err} /> : !initial ? <LoadingRows /> : <SettingsForm initial={initial} onSaved={reload} />;
}

function SettingsForm({ initial, onSaved }: { initial: Record<string, string>; onSaved: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setF] = useState(initial);
  const [err, setErr] = useState<unknown>();
  const save = async () => {
    setErr(undefined);
    if (f.privacy_notice_version !== initial.privacy_notice_version && !(await confirm({
      title: 'Publish a new notice version?', body: 'Every client will be asked to read and accept the privacy notice again on their next sign-in.', confirmLabel: 'Publish',
    }))) return;
    try { await api('/settings', { method: 'PATCH', body: f }); toast('Settings saved'); onSaved(); } catch (e) { setErr(e); }
  };
  const field = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}><Input value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
  );
  return (
    <Card title="Firm and Grievance Officer" description="Shown to every client in the privacy notice."
      actions={<Button icon={Save} onClick={save}>Save settings</Button>}>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {field('firm_name', 'Firm name')}
        {field('grievance_officer_name', 'Grievance Officer name')}
        {field('grievance_officer_email', 'Grievance Officer email')}
        {field('grievance_officer_phone', 'Grievance Officer phone')}
        {field('dpdp_response_days', 'Days to respond to requests', 'Check against the DPDP Rules in force')}
        {field('privacy_notice_version', 'Privacy notice version', 'Change this when the notice text changes')}
      </div>
      <div className="mt-4"><ErrorText error={err} /></div>
    </Card>
  );
}
