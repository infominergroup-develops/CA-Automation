import { useRef, useState, type DragEvent } from 'react';
import {
  Check, Download, FileImage, FileSpreadsheet, FileText, FileArchive, Fingerprint, FolderOpen, RotateCcw, Search, Trash2, UploadCloud, X,
} from 'lucide-react';
import { api, currentFy, download, fmtDateTime, fmtSize, fyOptions } from '../api';
import { useUser } from '../auth';
import { Button, Card, EmptyState, ErrorText, Field, IconButton, Input, LoadingRows, Select, StatusBadge, useConfirm, useLoad, useToast } from './ui';

interface Doc {
  id: string; category_id: number; category: string; fy: string; month: number | null; original_name: string; mime: string;
  size: number; sha256: string; review_status: string; review_note: string | null; created_at: string;
  uploaded_by_name: string; mine?: boolean;
}
export interface Category { id: number; name: string }

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const MONTH_NUM = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const monthName = (m: number) => MONTHS[MONTH_NUM.indexOf(m)];
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xls,.docx,.csv,.zip,image/*';
const MAX = 25e6;

function FileIcon({ mime, name }: { mime: string; name?: string }) {
  const [Icon, color] =
    mime.startsWith('image/') ? [FileImage, 'bg-violet-50 text-violet-700']
      : mime.includes('sheet') || mime.includes('excel') || mime === 'text/csv' || /\.(xlsx?|csv)$/i.test(name ?? '') ? [FileSpreadsheet, 'bg-emerald-50 text-emerald-700']
        : mime.includes('zip') ? [FileArchive, 'bg-amber-50 text-amber-700']
          : [FileText, 'bg-red-50 text-red-700'];
  return <span className={`grid place-items-center size-10 rounded-lg shrink-0 ${color}`}><Icon className="size-5" aria-hidden /></span>;
}

export function DocumentsPanel({ companyId, canUpload = true }: { companyId: string; canUpload?: boolean }) {
  const u = useUser();
  const toast = useToast();
  const confirm = useConfirm();
  const [cats] = useLoad(() => api<Category[]>('/categories'));
  const [filterCat, setFilterCat] = useState('');
  const [filterFy, setFilterFy] = useState('');
  const [q, setQ] = useState('');
  const [docs, loadErr, reload, loading] = useLoad(
    () => api<Doc[]>(`/companies/${companyId}/documents?${new URLSearchParams({ ...(filterCat && { category_id: filterCat }), ...(filterFy && { fy: filterFy }) })}`),
    [companyId, filterCat, filterFy]);
  const managerial = u.role === 'director' || u.role === 'manager';
  const shown = docs?.filter((d) => d.original_name.toLowerCase().includes(q.toLowerCase()));

  const attempt = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const accept = (d: Doc) => attempt(() => api(`/documents/${d.id}/review`, { method: 'PATCH', body: { status: 'accepted' } }), `Accepted ${d.original_name}`);
  const askReupload = async (d: Doc) => {
    const r = await confirm({ title: 'Ask the client to re-upload', body: <>The client will see this note next to <b>{d.original_name}</b>.</>,
      confirmLabel: 'Send request', input: { label: 'What is wrong with the file?', required: true, placeholder: 'e.g. Pages 3–4 are missing; statement should cover the full month.' } });
    if (r) attempt(() => api(`/documents/${d.id}/review`, { method: 'PATCH', body: { status: 'reupload', note: r.value } }), 'Re-upload requested');
  };
  const remove = async (d: Doc) => {
    const r = await confirm({ title: 'Delete this document?', body: <><b>{d.original_name}</b> will be removed from the portal. The deletion is recorded in the audit trail.</>, confirmLabel: 'Delete', danger: true });
    if (r) attempt(() => api(`/documents/${d.id}`, { method: 'DELETE' }), 'Document deleted');
  };
  const get = (d: Doc) => attempt(() => download(`/documents/${d.id}/download`, d.original_name));
  const canDelete = (d: Doc) => u.role === 'director' || (!!d.mine && Date.parse(d.created_at) > Date.now() - 86400e3);

  return (
    <div className="space-y-6">
      {canUpload && <UploadZone companyId={companyId} cats={cats ?? []} onDone={reload} />}

      <Card title="Documents" description={u.role === 'employee' ? 'Only categories granted to you for an open task are shown.' : `${docs?.length ?? '–'} files`} padded={false}
        actions={
          <>
            <div className="relative">
              <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" aria-label="Search files" className="pl-9 w-44! h-9!" />
            </div>
            <Select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} className="w-auto! h-9!" aria-label="Filter by category">
              <option value="">All categories</option>
              {cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select value={filterFy} onChange={(e) => setFilterFy(e.target.value)} className="w-auto! h-9!" aria-label="Filter by financial year">
              <option value="">All years</option>
              {fyOptions().map((f) => <option key={f} value={f}>FY {f}</option>)}
            </Select>
          </>
        }>
        {loadErr ? <div className="p-5"><ErrorText error={loadErr} /></div> : loading && !docs ? <div className="p-5"><LoadingRows /></div> : !shown?.length ? (
          <EmptyState icon={FolderOpen} title={q || filterCat || filterFy ? 'No matching documents' : 'No documents yet'}>
            {canUpload && !q ? 'Upload bank statements, bills and other records above. They are encrypted as soon as they arrive.' : 'Try a different filter.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((d) => (
              <li key={d.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-3.5 hover:bg-slate-50/70 transition-colors">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <FileIcon mime={d.mime} name={d.original_name} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink break-all">{d.original_name}</div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 mt-0.5">
                      <span>{d.category}</span><span aria-hidden>·</span>
                      <span>FY {d.fy}{d.month ? ` · ${monthName(d.month)}` : ''}</span><span aria-hidden>·</span>
                      <span>{fmtSize(d.size)}</span><span aria-hidden>·</span>
                      <span>{d.uploaded_by_name}, {fmtDateTime(d.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono mt-1" title={`SHA-256 fingerprint: ${d.sha256}`}>
                      <Fingerprint className="size-3" aria-hidden />{d.sha256.slice(0, 16)}…
                    </div>
                    {d.review_note && d.review_status === 'reupload' && <p className="text-xs text-red-700 bg-red-50 rounded-md px-2 py-1 mt-1.5">{d.review_note}</p>}
                  </div>
                </div>
                <div className="flex items-center justify-between sm:justify-end gap-2 pl-[52px] sm:pl-0">
                  <StatusBadge status={d.review_status} />
                  <div className="flex">
                    <IconButton label={`Download ${d.original_name}`} icon={Download} onClick={() => get(d)} />
                    {managerial && d.review_status !== 'accepted' && <IconButton label="Accept" icon={Check} tone="success" onClick={() => accept(d)} />}
                    {managerial && d.review_status !== 'reupload' && <IconButton label="Ask for re-upload" icon={RotateCcw} tone="danger" onClick={() => askReupload(d)} />}
                    {canDelete(d) && <IconButton label="Delete" icon={Trash2} onClick={() => remove(d)} />}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function UploadZone({ companyId, cats, onDone }: { companyId: string; cats: Category[]; onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [fy, setFy] = useState(currentFy());
  const [month, setMonth] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const input = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => setFiles((f) => [...f, ...[...(list ?? [])].filter((n) => !f.some((x) => x.name === n.name && x.size === n.size))].slice(0, 20));
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); };
  const tooBig = files.filter((f) => f.size > MAX);

  const submit = async () => {
    setBusy(true); setErr(undefined);
    try {
      const fd = new FormData();
      fd.append('category_id', category); fd.append('fy', fy); fd.append('month', month);
      files.forEach((f) => fd.append('files', f));
      const saved = await api<{ name: string; duplicateOf: unknown }[]>(`/companies/${companyId}/documents`, { body: fd });
      const dups = saved.filter((s) => s.duplicateOf).length;
      toast(`${saved.length} file${saved.length > 1 ? 's' : ''} uploaded and encrypted${dups ? ` (${dups} already existed and ${dups > 1 ? 'were' : 'was'} flagged as duplicate)` : ''}.`);
      setFiles([]);
      if (input.current) input.current.value = '';
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Card title="Upload documents" description="Files are encrypted the moment they reach us. PDF, images, Excel, Word, CSV or ZIP, up to 25 MB each.">
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} required>
            <option value="">Choose a category</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Financial year">
          <Select value={fy} onChange={(e) => setFy(e.target.value)}>{fyOptions().map((f) => <option key={f} value={f}>FY {f}</option>)}</Select>
        </Field>
        <Field label="Month" optional>
          <Select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Whole year</option>
            {MONTHS.map((m, i) => <option key={m} value={MONTH_NUM[i]}>{m}</option>)}
          </Select>
        </Field>
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={`mt-4 rounded-2xl border-2 border-dashed transition-colors duration-150 ${drag ? 'border-brand-500 bg-brand-50' : 'border-line bg-slate-50/50 hover:border-slate-300'}`}>
        <label className="flex flex-col items-center justify-center text-center gap-2 px-4 py-8 cursor-pointer">
          <span className="grid place-items-center size-12 rounded-full bg-white shadow-card text-brand-700"><UploadCloud className="size-6" aria-hidden /></span>
          <span className="text-sm text-ink"><b className="text-brand-700">Choose files</b> or drag them here</span>
          <span className="text-xs text-slate-500">On a phone you can take a photo of a bill</span>
          <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      {!!files.length && (
        <ul className="mt-4 space-y-2">
          {files.map((f) => (
            <li key={f.name + f.size} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${f.size > MAX ? 'border-red-200 bg-red-50' : 'border-line'}`}>
              <FileIcon mime={f.type} name={f.name} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink truncate">{f.name}</span>
                <span className={`block text-xs ${f.size > MAX ? 'text-red-700' : 'text-slate-500'}`}>{fmtSize(f.size)}{f.size > MAX && ' · larger than 25 MB'}</span>
              </span>
              <IconButton label={`Remove ${f.name}`} icon={X} onClick={() => setFiles((x) => x.filter((y) => y !== f))} />
            </li>
          ))}
        </ul>
      )}

      {err ? <div className="mt-4"><ErrorText error={err} /></div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
        <span className="text-xs text-slate-500">{!category && files.length ? 'Choose a category to continue.' : files.length ? `${files.length} file${files.length > 1 ? 's' : ''} ready` : ''}</span>
        <Button icon={UploadCloud} onClick={submit} busy={busy} disabled={!category || !files.length || tooBig.length > 0}>
          Upload{files.length ? ` ${files.length} file${files.length > 1 ? 's' : ''}` : ''}
        </Button>
      </div>
    </Card>
  );
}
