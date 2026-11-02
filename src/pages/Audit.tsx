import { useState } from 'react';
import { History, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, fmtDateTime } from '../api';
import { Alert, Badge, Button, Card, EmptyState, ErrorText, LoadingRows, PageHeader, Select, Table, Td, useLoad, type Tone } from '../components/ui';

interface Row { seq: number; ts: string; action: string; object_type: string | null; object_id: string | null; ip: string | null; details: string | null; hash: string; actor: string | null; actor_role: string | null; company: string | null }

const GROUPS = [['', 'All activity'], ['auth.', 'Sign-ins'], ['document.', 'Documents'], ['access.', 'Document access'], ['task.', 'Tasks'], ['time.', 'Time'], ['privacy.', 'Privacy'], ['user.', 'Users']];
const tone = (a: string): Tone =>
  /failed|integrity|blocked|breach|disabled|deleted/.test(a) ? 'red'
    : a.startsWith('document.download') || a.startsWith('access.') ? 'brand'
      : /approved|granted|login$|consent_given/.test(a) ? 'green' : 'slate';
const label = (a: string) => a.replace(/^[a-z]+\./, '').replace(/_/g, ' ');

function Details({ json }: { json: string | null }) {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return (
      <span className="flex flex-wrap gap-1">
        {Object.entries(o).filter(([, v]) => v !== undefined && v !== null).slice(0, 4).map(([k, v]) => (
          <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 font-mono max-w-56 truncate" title={`${k}: ${JSON.stringify(v)}`}>
            {k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
          </span>
        ))}
      </span>
    );
  } catch { return <span className="text-xs text-slate-500">{json}</span>; }
}

export function Audit() {
  const [action, setAction] = useState('');
  const [before, setBefore] = useState<number>();
  const [rows, err, , loading] = useLoad(() => api<Row[]>(`/audit?${new URLSearchParams({ ...(action && { action }), ...(before && { before: String(before) }) })}`), [action, before]);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt?: number; headHash: string }>();
  const [busy, setBusy] = useState(false);
  const runVerify = async () => { setBusy(true); try { setVerify(await api('/audit/verify')); } finally { setBusy(false); } };

  return (
    <>
      <PageHeader title="Audit trail" subtitle="Every sign-in, view, download and decision. Entries are hash-chained, so changing any past entry breaks the chain."
        actions={<Button variant="dark" icon={ShieldCheck} busy={busy} onClick={runVerify}>Verify integrity</Button>} />
      {verify && (
        <div className="mb-6">
          {verify.ok ? (
            <Alert tone="success" title={`Intact. All ${verify.checked} entries verified.`}>
              <div className="font-mono text-xs mt-1 break-all opacity-80">Latest hash {verify.headHash}</div>
              <div className="text-xs mt-1">Record this hash outside the system each week (for example, email it to yourself) to prove later that history was not rewritten.</div>
            </Alert>
          ) : (
            <Alert tone="error" title={`Chain broken at entry #${verify.brokenAt}.`}>Records may have been altered. Treat this as a security incident and record it in the breach register.</Alert>
          )}
        </div>
      )}
      <Card padded={false} title="Activity" description={verify?.ok === false ? undefined : 'Newest first'} actions={
        <Select value={action} onChange={(e) => { setAction(e.target.value); setBefore(undefined); }} className="w-auto! h-9!" aria-label="Filter activity">
          {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      }>
        {err ? <div className="p-5"><ErrorText error={err} /></div> : loading && !rows ? <div className="p-5"><LoadingRows rows={8} /></div> : !rows?.length ? <EmptyState icon={History} title="No activity" /> : (
          <Table head={['#', 'When', 'Who', 'Action', 'Client', 'Details', 'IP']}>
            {rows.map((r) => (
              <tr key={r.seq} className={tone(r.action) === 'red' ? 'bg-red-50/40' : ''}>
                <Td className="text-xs text-slate-400 tabular-nums">{r.seq}</Td>
                <Td className="whitespace-nowrap text-slate-700 tabular-nums">{fmtDateTime(r.ts)}</Td>
                <Td>{r.actor ? <><div className="font-medium text-ink whitespace-nowrap">{r.actor}</div><div className="text-xs text-slate-500 capitalize">{r.actor_role}</div></> : <span className="text-slate-400">System</span>}</Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    {tone(r.action) === 'red' && <ShieldAlert className="size-4 text-red-600" aria-hidden />}
                    <Badge tone={tone(r.action)}>{label(r.action)}</Badge>
                  </span>
                  <div className="text-[11px] text-slate-400 mt-0.5 font-mono">{r.action.split('.')[0]}</div>
                </Td>
                <Td className="text-slate-700">{r.company ?? ''}</Td>
                <Td><Details json={r.details} /></Td>
                <Td className="text-xs text-slate-500 font-mono">{r.ip}</Td>
              </tr>
            ))}
          </Table>
        )}
        {rows && rows.length === 200 && (
          <div className="text-center p-4 border-t border-line"><Button variant="secondary" onClick={() => setBefore(rows.at(-1)!.seq)}>Load older entries</Button></div>
        )}
      </Card>
    </>
  );
}
