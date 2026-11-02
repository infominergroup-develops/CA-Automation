import { useState } from 'react';
import { AlertTriangle, Check, Copy, Download, Monitor, Plus, ShieldOff, Star } from 'lucide-react';
import { api, download, fmtDateTime } from '../api';
import { useUser } from '../auth';
import {
  Alert, Badge, Button, Card, EmptyState, ErrorText, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Table, Td,
  useConfirm, useLoad, useToast,
} from '../components/ui';

interface Agent { id: string; name: string; status: string; pc_name: string | null; agent_version: string | null; tally_reachable: number | null; last_seen: string | null; online: boolean; companies: number }
interface Source {
  id: string; tally_name: string; tally_guid: string; company_id: string | null; company: string | null; is_primary: number; last_synced: string | null;
  agent: string; pc_name: string | null; online: boolean; copies: number; snapshot_status: string | null;
}

export function TallySync() {
  const u = useUser();
  const toast = useToast();
  const confirm = useConfirm();
  const director = u.role === 'director';
  const [agents, aErr, reloadAgents] = useLoad(() => (director ? api<Agent[]>('/tally/agents') : Promise.resolve([] as Agent[])));
  const [sources, sErr, reloadSources, sLoading] = useLoad(() => api<Source[]>('/tally/sources'));
  const [companies] = useLoad(() => api<{ id: string; legal_name: string }[]>('/companies'));
  const [adding, setAdding] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); reloadSources(); reloadAgents(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const revoke = async (a: Agent) => {
    if (!(await confirm({ title: `Disconnect ${a.name}?`, body: 'Its key stops working immediately. Companies it was the primary source for will stop syncing until another PC is made primary.', confirmLabel: 'Disconnect PC', danger: true }))) return;
    act(() => api(`/tally/agents/${a.id}/revoke`, { body: {} }), `${a.name} disconnected`);
  };
  const unmapped = sources?.filter((s) => !s.company_id) ?? [];

  return (
    <>
      <PageHeader title="Tally sync" subtitle="Office PCs running Tally send each client's books here, so reports are one click away."
        actions={director && <Button icon={Plus} onClick={() => setAdding(true)}>Add a Tally PC</Button>} />

      {director && (
        <Card title="Tally PCs" padded={false} className="mb-6">
          {aErr ? <div className="p-5"><ErrorText error={aErr} /></div> : !agents ? <div className="p-5"><LoadingRows rows={2} /></div> : !agents.length ? (
            <EmptyState icon={Monitor} title="No PCs connected" action={<Button icon={Plus} onClick={() => setAdding(true)}>Add a Tally PC</Button>}>
              Install the sync agent on each PC where Tally runs. It only reads from Tally and never changes your books.
            </EmptyState>
          ) : (
            <Table head={['PC', 'Status', 'Tally', 'Companies', 'Last seen', '']}>
              {agents.map((a) => (
                <tr key={a.id} className={a.status === 'revoked' ? 'opacity-50' : ''}>
                  <Td><div className="font-semibold text-ink">{a.name}</div><div className="text-xs text-slate-500">{a.pc_name ?? 'Not connected yet'}{a.agent_version && ` · agent ${a.agent_version}`}</div></Td>
                  <Td>{a.status === 'revoked' ? <Badge tone="red">Disconnected</Badge> : a.online ? <Badge tone="green" dot>Online</Badge> : <Badge dot>Offline</Badge>}</Td>
                  <Td>{a.tally_reachable === null ? '—' : a.tally_reachable ? <span className="text-emerald-700 text-sm">Tally open</span> : <span className="text-amber-700 text-sm">Tally not reachable</span>}</Td>
                  <Td className="tabular-nums">{a.companies}</Td>
                  <Td className="text-slate-600 whitespace-nowrap">{a.last_seen ? fmtDateTime(a.last_seen) : 'Never'}</Td>
                  <Td className="text-right">{a.status === 'active' && <Button size="sm" variant="danger" icon={ShieldOff} onClick={() => revoke(a)}>Disconnect</Button>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {!!unmapped.length && (
        <div className="mb-6"><Alert tone="info" title={`${unmapped.length} Tally compan${unmapped.length > 1 ? 'ies are' : 'y is'} not linked to a client yet`}>Choose the matching client below. Nothing syncs until a Tally company is linked.</Alert></div>
      )}

      <Card title="Tally companies" description="Each Tally company is linked to one client. If the same company exists on two PCs, pick which one is the primary source." padded={false}>
        {sErr ? <div className="p-5"><ErrorText error={sErr} /></div> : sLoading && !sources ? <div className="p-5"><LoadingRows /></div> : !sources?.length ? (
          <EmptyState icon={Monitor} title="No Tally companies reported yet">Companies appear here once a PC with the agent has them open in Tally.</EmptyState>
        ) : (
          <Table head={['Tally company', 'PC', 'Linked client', 'Source', 'Last synced', '']}>
            {sources.map((s) => (
              <tr key={s.id}>
                <Td>
                  <div className="font-semibold text-ink">{s.tally_name}</div>
                  {s.copies > 1 && <div className="flex items-center gap-1 text-xs text-amber-700 mt-0.5"><AlertTriangle className="size-3.5" aria-hidden />Also on {s.copies - 1} other PC{s.copies > 2 ? 's' : ''}</div>}
                </Td>
                <Td><span className="flex items-center gap-2"><span className={`size-2 rounded-full ${s.online ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-hidden /><span className="sr-only">{s.online ? 'Online:' : 'Offline:'}</span>{s.agent}</span></Td>
                <Td>
                  <Select value={s.company_id ?? ''} aria-label={`Client for ${s.tally_name}`} className="w-56! h-9!"
                    onChange={(e) => act(() => api(`/tally/sources/${s.id}/map`, { body: { company_id: e.target.value || null } }), e.target.value ? 'Linked. The first sync starts within a minute.' : 'Unlinked')}>
                    <option value="">Not linked</option>
                    {companies?.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
                  </Select>
                </Td>
                <Td>{!s.company_id ? '—' : s.is_primary ? <Badge tone="brand"><Star className="size-3 fill-current" aria-hidden />Primary</Badge>
                  : <Button size="sm" variant="ghost" onClick={() => act(() => api(`/tally/sources/${s.id}/primary`, { body: {} }), 'Primary source changed')}>Make primary</Button>}</Td>
                <Td className="whitespace-nowrap text-slate-600">{s.last_synced ? fmtDateTime(s.last_synced) : 'Not yet'}</Td>
                <Td>{s.snapshot_status && s.is_primary ? <StatusBadge status={s.snapshot_status === 'ok' ? 'ok' : 'pending'} /> : null}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {adding && <AddAgent onClose={() => setAdding(false)} onDone={() => { reloadAgents(); }} />}
    </>
  );
}

function AddAgent({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [key, setKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const serverUrl = window.location.origin;

  const create = async () => {
    setBusy(true); setErr(undefined);
    try { const r = await api<{ key: string }>('/tally/agents', { body: { name } }); setKey(r.key); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const config = key ? JSON.stringify({ serverUrl, agentKey: key, tallyUrl: 'http://localhost:9000' }, null, 2) : '';
  const saveConfig = () => {
    const url = URL.createObjectURL(new Blob([config], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'agent.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <Modal title={key ? `Set up ${name}` : 'Add a Tally PC'} onClose={onClose} wide
      footer={key ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={name.trim().length < 2} onClick={create}>Create key</Button></>}>
      {!key ? (
        <div className="space-y-4">
          <Field label="Name for this PC" hint="Something your team recognises, e.g. Accounts desk 2"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <ErrorText error={err} />
        </div>
      ) : (
        <div className="space-y-5">
          <Alert tone="warning" title="This key is shown only once">Save the config file now. Anyone with this key can send books to the portal as this PC; if it leaks, disconnect the PC and create a new one.</Alert>
          <div className="flex flex-wrap gap-2">
            <Button icon={Download} onClick={saveConfig}>Download agent.json</Button>
            <Button variant="secondary" icon={Download} onClick={() => download('/tally/agent/download', 'infominer-agent.mjs').catch((e) => toast(e.message, 'error'))}>Download agent program</Button>
            <Button variant="secondary" icon={Download} onClick={() => download('/tally/agent/download?file=installer', 'install-agent.ps1').catch((e) => toast(e.message, 'error'))}>Download installer</Button>
            <Button variant="ghost" icon={copied ? Check : Copy} onClick={() => navigator.clipboard.writeText(key).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy key'}</Button>
          </div>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700">
            <li>In TallyPrime, open <b>F1 Help › Settings › Connectivity</b> and set <b>TallyPrime acts as</b> to <b>Server</b> on port <b>9000</b>.</li>
            <li>Install <b>Node.js LTS</b> on the PC (nodejs.org).</li>
            <li>Create the folder <code className="font-mono text-xs bg-slate-100 px-1 rounded">C:\Infominer</code> and put the three downloaded files in it.</li>
            <li>In PowerShell run <code className="font-mono text-xs bg-slate-100 px-1 rounded break-all">powershell -ExecutionPolicy Bypass -File C:\Infominer\install-agent.ps1</code>. It tests the connection and starts the agent with Windows.</li>
            <li>Come back here: the PC shows as <b>Online</b> within a minute and its Tally companies appear below for linking.</li>
          </ol>
        </div>
      )}
    </Modal>
  );
}
