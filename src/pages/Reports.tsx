import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  AlertTriangle, BookOpen, Building2, CheckCircle2, ChevronRight, Download, FileSpreadsheet, FileText, Landmark, PlugZap, RefreshCw, Scale,
  ShieldCheck, TrendingUp, Users, type LucideIcon,
} from 'lucide-react';
import { api, download, fmtDateTime } from '../api';
import { useUser } from '../auth';
import { Alert, Badge, Button, Card, CountUp, EmptyState, ErrorText, Field, Input, LoadingRows, PageHeader, Select, Skeleton, useLoad, useToast } from '../components/ui';

type ReportType = 'balance-sheet' | 'profit-loss' | 'trial-balance' | 'ledger' | 'debtors' | 'creditors';
interface Row { cells: (string | number | null)[]; style?: 'heading' | 'subtotal' | 'total' | 'muted'; indent?: number }
interface ReportDoc {
  type: ReportType; title: string; company: string; period: string;
  columns: { label: string; align: 'left' | 'right'; width: number }[];
  rows: Row[]; summary?: { label: string; value: number; tone?: 'good' | 'bad' }[]; notes?: string[]; dataAsOf: string; provisional: boolean;
}
interface FyMeta {
  fy: string; monthEnds: string[]; syncedAt: string; periodTo: string; clientVisible: boolean; final: boolean;
  status?: 'ok' | 'warning'; checks?: { code: string; ok: boolean; message: string }[]; stats?: { vouchers: number; ledgers: number };
}
interface Meta { fys: FyMeta[]; source: { online: boolean; last_seen?: string; pc_name?: string; tally_name?: string } | null; pending: { status: string; created_at: string } | null }

const REPORTS: { type: ReportType; label: string; icon: LucideIcon; period: 'asOn' | 'range' }[] = [
  { type: 'balance-sheet', label: 'Balance Sheet', icon: Scale, period: 'asOn' },
  { type: 'profit-loss', label: 'Profit & Loss', icon: TrendingUp, period: 'range' },
  { type: 'trial-balance', label: 'Trial Balance', icon: Landmark, period: 'asOn' },
  { type: 'ledger', label: 'Ledger', icon: BookOpen, period: 'range' },
  { type: 'debtors', label: 'Debtors', icon: Users, period: 'asOn' },
  { type: 'creditors', label: 'Creditors', icon: Building2, period: 'asOn' },
];

export const inr = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
};
const dLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Client navigation entry: straight to the company if there is only one. */
export function ClientReports() {
  const [companies] = useLoad(() => api<{ id: string; legal_name: string }[]>('/companies'));
  if (!companies) return <LoadingRows />;
  if (companies.length === 1) return <Navigate to={`/company/${companies[0].id}?tab=reports`} replace />;
  return (
    <>
      <PageHeader title="Reports" subtitle="Choose a company." />
      <Card padded={false}>
        <ul className="divide-y divide-line">
          {companies.map((c) => (
            <li key={c.id}><Link to={`/company/${c.id}?tab=reports`} className="flex items-center gap-3 px-5 py-4 hover:bg-slate-50">
              <Building2 className="size-5 text-brand-700" aria-hidden /><span className="flex-1 font-semibold text-ink">{c.legal_name}</span><ChevronRight className="size-4 text-slate-300" aria-hidden />
            </Link></li>
          ))}
        </ul>
      </Card>
    </>
  );
}

export function ReportsPanel({ companyId }: { companyId: string }) {
  const u = useUser();
  const toast = useToast();
  const staff = u.role !== 'client';
  const managerial = u.role === 'director' || u.role === 'manager';
  const [meta, metaErr, reloadMeta, metaLoading] = useLoad(() => api<Meta>(`/companies/${companyId}/reports/meta`), [companyId]);
  const [fy, setFy] = useState('');
  const [type, setType] = useState<ReportType>('balance-sheet');
  const [asOn, setAsOn] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ledger, setLedger] = useState('');
  const [busyFmt, setBusyFmt] = useState<string>();

  const fyMeta = meta?.fys.find((f) => f.fy === fy) ?? meta?.fys[0];
  useEffect(() => {
    if (!fyMeta) return;
    if (fy !== fyMeta.fy) setFy(fyMeta.fy);
    const last = fyMeta.monthEnds.at(-1)!;
    setAsOn(last); setTo(last); setFrom(`${fyMeta.monthEnds[0].slice(0, 8)}01`);
  }, [fyMeta?.fy, fyMeta?.syncedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const [ledgers] = useLoad(() => (fyMeta ? api<{ name: string; group: string }[]>(`/companies/${companyId}/reports/ledgers?fy=${fyMeta.fy}`) : Promise.resolve([])), [companyId, fyMeta?.fy, fyMeta?.syncedAt]);
  const def = REPORTS.find((r) => r.type === type)!;
  const params = useMemo(() => {
    if (!fyMeta || !to || !asOn) return null;
    const p = new URLSearchParams({ fy: fyMeta.fy, to: def.period === 'asOn' ? asOn : to });
    if (def.period === 'range') p.set('from', from);
    if (type === 'ledger') { if (!ledger) return null; p.set('ledger', ledger); }
    return p.toString();
  }, [fyMeta, type, asOn, from, to, ledger, def.period]);
  const [doc, docErr, , docLoading] = useLoad(() => (params ? api<ReportDoc>(`/companies/${companyId}/reports/${type}?${params}`) : Promise.resolve(undefined)), [companyId, type, params]);

  const requestSync = async () => {
    try {
      const r = await api<{ alreadyQueued?: boolean }>(`/companies/${companyId}/sync-request`, { body: {} });
      toast(r.alreadyQueued ? 'Already requested. Fresh figures will appear shortly.' : 'Requested. Fresh figures usually arrive within a few minutes while the office PC is on.', 'info');
      reloadMeta();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const get = async (format: 'pdf' | 'xlsx') => {
    if (!params) return;
    setBusyFmt(format);
    try { await download(`/companies/${companyId}/reports/${type}?${params}&format=${format}`, `${def.label}.${format}`); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusyFmt(undefined); }
  };
  const setFlag = async (body: { client_visible?: boolean; final?: boolean }) => {
    try { await api(`/companies/${companyId}/report-settings`, { method: 'PATCH', body: { fy: fyMeta!.fy, ...body } }); toast('Saved'); reloadMeta(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  if (metaErr) return <ErrorText error={metaErr} />;
  if (metaLoading && !meta) return <LoadingRows rows={6} />;
  if (!meta || !meta.fys.length || !fyMeta) {
    return (
      <Card>
        <EmptyState icon={PlugZap} title={meta?.source ? 'Waiting for the first sync' : 'Not connected to Tally yet'}
          action={u.role === 'director' && !meta?.source && <Link to="/tally"><Button variant="secondary">Set up Tally sync</Button></Link>}>
          {meta?.source ? 'Figures appear here after the office PC sends this company’s books. This usually takes a few minutes.'
            : staff ? 'Connect this company’s Tally data from Tally sync to enable one-click reports.'
              : 'Your CA team is setting up your reports. They will appear here soon.'}
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* Freshness bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-white/80 ring-1 ring-ink/[0.06] px-4 py-3 shadow-card">
        <span className="flex items-center gap-2 text-sm text-slate-600">
          <span className={`size-2 rounded-full ${meta.source?.online ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-hidden />
          Figures from Tally as of <b className="text-ink">{fmtDateTime(fyMeta.syncedAt)}</b>
        </span>
        {staff && meta.source && <span className="text-xs text-slate-500">{meta.source.online ? 'Office PC online' : 'Office PC offline'}{meta.source.pc_name ? ` · ${meta.source.pc_name}` : ''}</span>}
        {fyMeta.final ? <Badge tone="green" dot>Final</Badge> : <Badge tone="amber" dot>Provisional</Badge>}
        <span className="flex-1" />
        {meta.pending
          ? <span className="inline-flex items-center gap-2 text-sm text-brand-700"><RefreshCw className="size-4 animate-spin" aria-hidden />Fresh data requested{meta.source && !meta.source.online && ' (waiting for the office PC)'}</span>
          : <Button size="sm" variant="secondary" icon={RefreshCw} onClick={requestSync}>Request fresh data</Button>}
      </div>

      {staff && fyMeta.status === 'warning' && (
        <Alert tone="warning" title="Sync completed with warnings">
          <ul className="list-disc pl-5 mt-1">{fyMeta.checks?.filter((c) => !c.ok).map((c) => <li key={c.code}>{c.message}</li>)}</ul>
        </Alert>
      )}

      {/* Report picker */}
      <div role="tablist" aria-label="Report" className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {REPORTS.map((r) => (
          <button key={r.type} role="tab" aria-selected={type === r.type} onClick={() => setType(r.type)}
            className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[13px] font-medium transition-all duration-150 ${
              type === r.type ? 'border-brand-500 bg-brand-50 text-ink ring-4 ring-brand-500/10' : 'border-line bg-white text-slate-600 hover:border-slate-300 hover:text-ink'}`}>
            <r.icon className={`size-5 ${type === r.type ? 'text-brand-700' : 'text-slate-400'}`} aria-hidden />{r.label}
          </button>
        ))}
      </div>

      {/* Period controls */}
      <Card padded>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Financial year">
            <Select value={fyMeta.fy} onChange={(e) => setFy(e.target.value)} className="w-36!">{meta.fys.map((f) => <option key={f.fy} value={f.fy}>FY {f.fy}</option>)}</Select>
          </Field>
          {def.period === 'asOn' ? (
            <Field label="As on">
              <Select value={asOn} onChange={(e) => setAsOn(e.target.value)} className="w-48!">
                {[...fyMeta.monthEnds].reverse().map((m) => <option key={m} value={m}>{dLabel(m)}{m === fyMeta.monthEnds.at(-1) ? ' (latest)' : ''}</option>)}
              </Select>
            </Field>
          ) : (
            <>
              {type === 'ledger' && (
                <Field label="Ledger">
                  <Input list="ledger-list" value={ledger} onChange={(e) => setLedger(e.target.value)} placeholder="Start typing a ledger name" className="w-64!" />
                  <datalist id="ledger-list">{ledgers?.map((l) => <option key={l.name} value={l.name}>{l.group}</option>)}</datalist>
                </Field>
              )}
              <Field label="From">
                <Select value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(fyMeta.monthEnds.find((m) => m >= e.target.value)!); }} className="w-36!">
                  {fyMeta.monthEnds.map((m) => `${m.slice(0, 8)}01`).map((s) => <option key={s} value={s}>{monthLabel(s)}</option>)}
                </Select>
              </Field>
              <Field label="To">
                <Select value={to} onChange={(e) => setTo(e.target.value)} className="w-40!">
                  {fyMeta.monthEnds.filter((m) => m >= from).map((m) => <option key={m} value={m}>{dLabel(m)}</option>)}
                </Select>
              </Field>
            </>
          )}
          <span className="flex-1" />
          <div className="flex gap-2">
            <Button variant="secondary" icon={FileText} busy={busyFmt === 'pdf'} disabled={!doc} onClick={() => get('pdf')}>PDF</Button>
            <Button variant="secondary" icon={FileSpreadsheet} busy={busyFmt === 'xlsx'} disabled={!doc} onClick={() => get('xlsx')}>Excel</Button>
          </div>
        </div>
      </Card>

      {type === 'ledger' && !ledger ? (
        <Card><EmptyState icon={BookOpen} title="Choose a ledger">Type a ledger name above to see its statement.</EmptyState></Card>
      ) : docErr ? <ErrorText error={docErr} /> : (
        <ReportView doc={doc} loading={docLoading} />
      )}

      {managerial && (
        <Card title="Sharing with the client" description={`FY ${fyMeta.fy}`}>
          <div className="grid sm:grid-cols-2 gap-4">
            <Toggle label="Visible to the client" hint="Turn off to hold back figures while you review them." checked={fyMeta.clientVisible} onChange={(v) => setFlag({ client_visible: v })} />
            <Toggle label="Figures are final" hint="Removes the “Provisional, unaudited” label from reports and PDFs." checked={fyMeta.final} onChange={(v) => setFlag({ final: v })} />
          </div>
          {fyMeta.checks && (
            <ul className="mt-5 pt-4 border-t border-line space-y-1.5">
              {fyMeta.checks.map((c) => (
                <li key={c.code} className="flex gap-2 text-sm">
                  {c.ok ? <CheckCircle2 className="size-4 mt-0.5 text-emerald-600 shrink-0" aria-hidden /> : <AlertTriangle className="size-4 mt-0.5 text-amber-600 shrink-0" aria-hidden />}
                  <span className="text-slate-700">{c.message}</span>
                </li>
              ))}
              {fyMeta.stats && <li className="text-xs text-slate-500 pl-6">{fyMeta.stats.vouchers.toLocaleString('en-IN')} vouchers · {fyMeta.stats.ledgers.toLocaleString('en-IN')} ledgers synced</li>}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 rounded-2xl ring-1 ring-ink/[0.07] bg-white p-4 cursor-pointer hover:border-slate-300">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ${checked ? 'bg-brand-500' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-150 ${checked ? 'translate-x-5' : ''}`} />
      </button>
      <span><span className="block text-sm font-semibold text-ink">{label}</span><span className="block text-xs text-slate-500 mt-0.5">{hint}</span></span>
    </label>
  );
}

/** On phones, statements with one label and two amount columns read better as a two-column list. */
function CompactRows({ doc }: { doc: ReportDoc }) {
  const tb = doc.type === 'trial-balance';
  return (
    <ul className="sm:hidden divide-y divide-line/70">
      {doc.rows.map((r, i) => {
        const [label, a, b] = r.cells as [string, number | null, number | null];
        const v = tb ? (a ?? (b !== null ? -b : null)) : (b ?? a);
        return (
          <li key={i} className={`flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm ${
            r.style === 'total' ? 'bg-slate-50 font-bold text-ink' : r.style === 'subtotal' ? 'bg-brand-50 font-semibold text-ink'
              : r.style === 'heading' ? 'font-semibold text-ink' : r.style === 'muted' ? 'text-slate-500' : 'text-ink-900'}`}
            style={{ paddingLeft: `${16 + (r.indent ?? 0) * 14}px` }}>
            <span className="min-w-0">{label}</span>
            {tb && r.style === 'total' ? (
              <span className="tabular-nums whitespace-nowrap text-right">{inr(a ?? 0)} Dr<br />{inr(b ?? 0)} Cr</span>
            ) : v !== null && (
              <span className={`tabular-nums whitespace-nowrap ${v < 0 && !tb ? 'text-red-600' : ''}`}>{tb ? `${inr(Math.abs(v))} ${v >= 0 ? 'Dr' : 'Cr'}` : inr(v)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ReportView({ doc, loading }: { doc?: ReportDoc; loading: boolean }) {
  if (!doc) return loading ? <Skeleton className="h-96 rounded-[22px]" /> : null;
  const compact = doc.columns.length === 3;
  return (
    <div className={`space-y-5 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      {!!doc.summary?.length && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {doc.summary.map((s) => (
            <div key={s.label} className="bezel">
              <div className="bezel-core px-4 py-4">
                <div className="text-[13px] font-medium text-slate-500">{s.label}</div>
                <div className={`text-lg sm:text-[22px] font-bold tabular-nums tracking-tight mt-1.5 whitespace-nowrap ${s.tone === 'bad' || s.value < 0 ? 'text-red-600' : s.tone === 'good' ? 'text-emerald-700' : 'text-ink'}`}>
                  ₹ <CountUp value={s.value} format={inr} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <section className="bezel">
        <div className="bezel-core overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-line/80">
          <div>
            <h2 className="text-lg font-bold">{doc.title}</h2>
            <p className="text-sm text-slate-500">{doc.company} · {doc.period}</p>
          </div>
          {doc.provisional ? <Badge tone="amber">Provisional · unaudited</Badge> : <Badge tone="green"><ShieldCheck className="size-3.5" aria-hidden />Final</Badge>}
        </header>
        {compact && <CompactRows doc={doc} />}
        <div className={`overflow-x-auto ${compact ? 'hidden sm:block' : ''}`} tabIndex={0} role="region" aria-label={doc.title}>
          <table className="min-w-[640px] w-full text-sm">
            <thead>
              <tr className="bg-ink-900 text-white">
                {doc.columns.map((c, i) => <th key={i} scope="col" style={{ width: `${c.width * 100}%` }} className={`px-5 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {doc.rows.map((r, i) => (
                <tr key={i} className={
                  r.style === 'total' ? 'bg-slate-50 border-t-2 border-ink font-bold text-ink'
                    : r.style === 'subtotal' ? 'bg-brand-50 font-semibold text-ink border-t border-line'
                      : r.style === 'heading' ? 'font-semibold text-ink border-t border-line'
                        : r.style === 'muted' ? 'text-slate-500' : 'text-ink-900 border-t border-line/60'}>
                  {r.cells.map((v, j) => (
                    <td key={j} className={`px-5 py-2 ${doc.columns[j].align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : ['Date', 'Voucher', 'GSTIN', 'Last transaction'].includes(doc.columns[j].label) ? 'whitespace-nowrap' : ''} ${typeof v === 'number' && v < 0 ? 'text-red-600' : ''}`}
                      style={j === 0 && r.indent ? { paddingLeft: `${20 + r.indent * 16}px` } : undefined}>
                      {v === null ? '' : typeof v === 'number' ? inr(v) : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!!doc.notes?.length && (
          <footer className="px-5 py-3 border-t border-line bg-slate-50/60 text-xs text-slate-600 space-y-1">
            {doc.notes.map((n) => <p key={n}>{n}</p>)}
          </footer>
        )}
        </div>
      </section>
      <p className="text-xs text-slate-400 flex items-center gap-1.5"><Download className="size-3.5" aria-hidden />PDFs carry your name and the time of download. Every view and download is recorded.</p>
    </div>
  );
}
