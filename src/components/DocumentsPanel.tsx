import { useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check, ChevronRight, Download, FileImage, FileSpreadsheet, FileText, FileArchive, Fingerprint, Folder, FolderInput, FolderOpen, FolderPlus, FolderUp, RotateCcw, Search, Trash2, UploadCloud, X,
} from 'lucide-react';
import { api, currentFy, download, fmtDateTime, fmtSize, fyOptions } from '../api';
import { useUser } from '../auth';
import { placeFile, type Place } from '../placeFile';
import { Button, Card, EmptyState, ErrorText, Field, IconButton, Input, LoadingRows, Modal, Select, StatusBadge, useConfirm, useLoad, useToast } from './ui';

interface Doc {
  id: string; category_id: number; category: string; fy: string; month: number | null; original_name: string; mime: string;
  size: number; sha256: string; review_status: string; review_note: string | null; created_at: string; subfolder?: string | null;
  uploaded_by_name: string; mine?: boolean;
}
export interface Category { id: number; name: string }

const MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
const MONTH_NUM = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const monthName = (m: number) => MONTHS[MONTH_NUM.indexOf(m)];
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xls,.docx,.doc,.csv,.zip,image/*';
const MAX = 25e6;
// Files the computer adds by itself, never worth uploading.
const JUNK = /^(\.|~\$|thumbs\.db$|desktop\.ini$)/i;

function FileIcon({ mime, name }: { mime: string; name?: string }) {
  const [Icon, color] =
    mime.startsWith('image/') ? [FileImage, 'bg-violet-50 text-violet-700']
      : mime.includes('sheet') || mime.includes('excel') || mime === 'text/csv' || /\.(xlsx?|csv)$/i.test(name ?? '') ? [FileSpreadsheet, 'bg-emerald-50 text-emerald-700']
        : mime.includes('zip') ? [FileArchive, 'bg-amber-50 text-amber-700']
          : [FileText, 'bg-red-50 text-red-700'];
  return <span className={`grid place-items-center size-10 rounded-lg shrink-0 ${color}`}><Icon className="size-5" aria-hidden /></span>;
}

/** Documents as folders: financial year, then document type, then month. The open folder is kept in the address, so Back works. */
export function DocumentsPanel({ companyId, canUpload = true }: { companyId: string; canUpload?: boolean }) {
  const u = useUser();
  const toast = useToast();
  const confirm = useConfirm();
  const [cats, , reloadCats] = useLoad(() => api<Category[]>('/categories'));
  const [params, setParams] = useSearchParams();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [naming, setNaming] = useState(false);
  const fy = params.get('fy') ?? '', folder = params.get('folder') ?? '', month = params.get('month') ?? '';
  const [q, setQ] = useState('');
  const [docs, loadErr, reload, loading] = useLoad(() => api<Doc[]>(`/companies/${companyId}/documents`), [companyId]);
  const managerial = u.role === 'director' || u.role === 'manager';

  const open = (to: { fy?: string; folder?: string; month?: string }) => {
    const next = new URLSearchParams(params);
    for (const k of ['fy', 'folder', 'month'] as const) { next.delete(k); if (to[k]) next.set(k, to[k]); }
    setParams(next);
    setQ('');
    setPicked(new Set());
  };

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

  const here = (docs ?? []).filter((d) => (!fy || d.fy === fy) && (!folder || String(d.category_id) === folder) && (!month || String(d.month ?? '') === month));
  const catName = cats?.find((c) => String(c.id) === folder)?.name ?? folder;
  const years = [...new Set([...fyOptions(), ...(docs ?? []).map((d) => d.fy)])].sort().reverse();
  const tiles = !docs || q ? []
    : !fy ? years.map((y) => ({ name: `FY ${y}`, count: here.filter((d) => d.fy === y).length, go: () => open({ fy: y }) }))
      : !folder ? (cats ?? []).map((c) => ({ name: c.name, count: here.filter((d) => d.category_id === c.id).length, go: () => open({ fy, folder: String(c.id) }) }))
        : !month ? MONTHS.map((m, i) => ({ name: m, count: here.filter((d) => d.month === MONTH_NUM[i]).length, go: () => open({ fy, folder, month: String(MONTH_NUM[i]) }) }))
          : [];
  // Inside a document type, files that belong to no month are listed under the month folders.
  const files = q ? here.filter((d) => `${d.original_name} ${d.subfolder ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    : month ? here : folder ? here.filter((d) => !d.month) : [];
  const crumbs = [
    { name: 'All years', go: () => open({}) },
    ...(fy ? [{ name: `FY ${fy}`, go: () => open({ fy }) }] : []),
    ...(folder ? [{ name: catName, go: () => open({ fy, folder }) }] : []),
    ...(month ? [{ name: monthName(Number(month)), go: () => open({ fy, folder, month }) }] : []),
  ];

  return (
    <div className="space-y-6">
      {canUpload && <UploadZone key={`${fy}|${folder}|${month}`} companyId={companyId} cats={cats ?? []} at={{ fy, folder, month }} onDone={reload} onNewFolder={managerial ? reloadCats : undefined} />}

      <Card title="Documents" description={u.role === 'employee' ? 'All files of clients you added or have an open task for. You can upload and download, not delete or move.' : `${docs?.length ?? '–'} files`} padded={false}
        actions={
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={fy ? 'Search this folder' : 'Search all files'} aria-label="Search files" className="pl-9 w-52! h-9!" />
          </div>
        }>
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 px-5 py-3 border-b border-line text-sm">
          {crumbs.map((c, i) => (
            <span key={c.name} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-4 text-slate-300" aria-hidden />}
              {i < crumbs.length - 1
                ? <button type="button" onClick={c.go} className="font-medium text-brand-700 hover:underline">{c.name}</button>
                : <span className="font-semibold text-ink" aria-current="page">{c.name}</span>}
            </span>
          ))}
        </nav>
        {loadErr ? <div className="p-5"><ErrorText error={loadErr} /></div> : loading && !docs ? <div className="p-5"><LoadingRows /></div> : (
          <>
            {!!tiles.length && (
              <ul className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
                {tiles.map((t) => (
                  <li key={t.name}>
                    <button type="button" onClick={t.go} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-ink/10 hover:ring-brand-500 hover:bg-brand-50/40 transition-colors">
                      {t.count ? <FolderOpen className="size-5 shrink-0 text-brand-700" aria-hidden /> : <Folder className="size-5 shrink-0 text-slate-300" aria-hidden />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{t.name}</span>
                        <span className="block text-xs text-slate-500">{t.count ? `${t.count} file${t.count > 1 ? 's' : ''}` : 'Empty'}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {managerial && fy && !folder && (
                  <li>
                    <button type="button" onClick={() => setNaming(true)} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left border-2 border-dashed border-line text-brand-700 hover:border-brand-500 hover:bg-brand-50/40 transition-colors">
                      <FolderPlus className="size-5 shrink-0" aria-hidden /><span className="text-sm font-semibold">New folder</span>
                    </button>
                  </li>
                )}
              </ul>
            )}
            {managerial && !!files.length && (
              <div className="flex flex-wrap items-center gap-3 px-5 py-2 border-b border-line text-sm">
                <label className="flex items-center gap-2 text-slate-600">
                  <input type="checkbox" className="size-4 accent-brand-500" checked={files.every((d) => picked.has(d.id))}
                    onChange={(e) => setPicked(new Set(e.target.checked ? files.map((d) => d.id) : []))} />
                  Select all
                </label>
                {!!picked.size && <Button size="sm" variant="secondary" icon={FolderInput} onClick={() => setMoving(true)}>Move {picked.size} file{picked.size > 1 ? 's' : ''}</Button>}
              </div>
            )}
            {!!files.length && !!tiles.length && <p className="px-5 pb-2 text-[13px] font-semibold text-slate-500">Not for a particular month</p>}
            {!files.length && !tiles.length && (
              <EmptyState icon={FolderOpen} title={q ? 'No matching documents' : 'This folder is empty'}>
                {canUpload && !q ? 'Upload files or a whole folder above. They are encrypted as soon as they arrive.' : 'Try a different search.'}
              </EmptyState>
            )}
            {!!files.length && (
              <ul className="divide-y divide-line">
                {files.map((d) => (
                  <li key={d.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-3.5 hover:bg-slate-50/70 transition-colors">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {managerial && (
                        <input type="checkbox" aria-label={`Select ${d.original_name}`} className="mt-3 size-4 shrink-0 accent-brand-500" checked={picked.has(d.id)}
                          onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })} />
                      )}
                      <FileIcon mime={d.mime} name={d.original_name} />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink break-all">{d.original_name}</div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 mt-0.5">
                          {q && <><span>FY {d.fy} / {d.category}{d.month ? ` / ${monthName(d.month)}` : ''}</span><span aria-hidden>·</span></>}
                          {d.subfolder && <><span className="break-all">{d.subfolder}</span><span aria-hidden>·</span></>}
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
          </>
        )}
      </Card>
      {naming && <NewFolder onClose={() => setNaming(false)} onDone={(c) => { setNaming(false); reloadCats(); open({ fy, folder: String(c.id) }); }} />}
      {moving && cats && (
        <MoveFiles docs={(docs ?? []).filter((d) => picked.has(d.id))} cats={cats} at={{ fy, folder, month }}
          onClose={() => setMoving(false)} onDone={() => { setMoving(false); setPicked(new Set()); reload(); }} />
      )}
    </div>
  );
}

/** A folder for every client, such as Bookkeeping. Directors and managers only. */
function NewFolder({ name: initial = '', onClose, onDone }: { name?: string; onClose: () => void; onDone: (c: Category) => void }) {
  const toast = useToast();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const save = async () => {
    setBusy(true); setErr(undefined);
    try { const c = await api<Category>('/categories', { body: { name: name.trim() } }); toast(`Folder ${c.name} added for every client.`); onDone(c); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="New folder" description="Added to every financial year of every client, like Bank statements." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} icon={FolderPlus} onClick={save} disabled={name.trim().length < 2}>Add folder</Button></>}>
      <div className="space-y-4">
        <Field label="Folder name"><Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bookkeeping" /></Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

/** Moves the chosen files to another year, folder or month. Their inner folders go with them. */
function MoveFiles({ docs, cats, at, onClose, onDone }: { docs: Doc[]; cats: Category[]; at: { fy: string; folder: string; month: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [fy, setFy] = useState(at.fy || docs[0]?.fy || currentFy());
  const [folder, setFolder] = useState(at.folder);
  const [month, setMonth] = useState(at.month);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const move = async () => {
    setBusy(true); setErr(undefined);
    let failed = 0;
    for (const d of docs) {
      try { await api(`/documents/${d.id}/move`, { body: { fy, category_id: folder, month: month ? Number(month) : null } }); } catch { failed++; }
    }
    setBusy(false);
    const moved = docs.length - failed;
    if (moved) toast(`${moved} file${moved > 1 ? 's' : ''} moved.`);
    if (failed) setErr(new Error(`${failed} file${failed > 1 ? 's' : ''} could not be moved. Please try again.`)); else onDone();
  };
  return (
    <Modal title={`Move ${docs.length} file${docs.length > 1 ? 's' : ''}`} description="The move is recorded in the audit trail." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} icon={FolderInput} onClick={move} disabled={!folder}>Move</Button></>}>
      <div className="space-y-4">
        <Field label="Financial year"><Select value={fy} onChange={(e) => setFy(e.target.value)}>{[...new Set([...fyOptions(), fy])].sort().reverse().map((f) => <option key={f} value={f}>FY {f}</option>)}</Select></Field>
        <Field label="Folder">
          <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">Choose a folder</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Month" optional>
          <Select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Not for a particular month</option>
            {MONTHS.map((m, i) => <option key={m} value={MONTH_NUM[i]}>{m}</option>)}
          </Select>
        </Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

interface Picked { file: File; path: string; error?: string }

/** Every file in what was dropped, including files inside dropped folders. */
async function readDropped(data: DataTransfer): Promise<Picked[]> {
  // Both lists must be read before the first await: the browser empties them afterwards.
  const entries = [...data.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  const plain = [...data.files].map((file) => ({ file, path: file.name }));
  if (!entries.length) return plain;
  const out: Picked[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push({ file: await new Promise<File>((ok, no) => (e as FileSystemFileEntry).file(ok, no)), path: e.fullPath.slice(1) });
      return;
    }
    const reader = (e as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) return;
      for (const child of batch) await walk(child);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

function UploadZone({ companyId, cats, at, onDone, onNewFolder }: { companyId: string; cats: Category[]; at: { fy: string; folder: string; month: string }; onDone: () => void; onNewFolder?: () => void }) {
  const toast = useToast();
  const [naming, setNaming] = useState<string | null>(null);
  const [category, setCategory] = useState(at.folder);
  const [fy, setFy] = useState(at.fy || currentFy());
  const [month, setMonth] = useState(at.month);
  const [files, setFiles] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<unknown>();

  const add = (list: Picked[]) => setFiles((f) => [...f, ...list.filter((n) => !JUNK.test(n.file.name) && !f.some((x) => x.path === n.path && x.file.size === n.file.size))].slice(0, 1000));
  // Copied at once: the browser empties the list as soon as the box is reset.
  const fromInput = (input: HTMLInputElement) => { add([...(input.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); input.value = ''; };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); setErr(undefined); readDropped(e.dataTransfer).then(add).catch(setErr); };

  // The open folder is fixed; what is not fixed comes from the uploaded folder's own names, else from the boxes above.
  const fixed: Partial<Place> = { ...(at.fy && { fy: at.fy }), ...(at.folder && { category: at.folder }), ...(at.month && { month: at.month }) };
  const planned = files.map((f) => ({ ...f, place: placeFile(f.path, fixed, { category, fy, month }, cats) }));
  const ready = planned.filter((f) => f.place.category && f.file.size <= MAX);
  const unfiled = planned.filter((f) => !f.place.category).length;
  // Folder names in the upload that look like document types the portal does not have yet.
  const unknown = [...new Set(planned.filter((f) => !f.place.category && f.place.newFolder).map((f) => f.place.newFolder!))];

  const submit = async () => {
    setErr(undefined);
    let done = 0, dups = 0;
    const failed = new Map<File, string>();
    const queue = [...ready];
    setProgress({ done, total: queue.length });
    // One file per request, so one bad file cannot sink the rest, and a large folder never sits in the server's memory.
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          const fd = new FormData();
          fd.append('category_id', f.place.category); fd.append('fy', f.place.fy); fd.append('month', f.place.month); fd.append('subfolder', f.place.sub);
          fd.append('files', f.file);
          const [saved] = await api<{ duplicateOf: unknown }[]>(`/companies/${companyId}/documents`, { body: fd });
          if (saved.duplicateOf) dups++;
        } catch (e) { failed.set(f.file, (e as Error).message); }
        setProgress({ done: ++done, total: ready.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setProgress(null);
    const sent = new Set(ready.map((f) => f.file));
    setFiles((all) => all.filter((f) => !sent.has(f.file) || failed.has(f.file)).map((f) => ({ ...f, error: failed.get(f.file) })));
    const ok = ready.length - failed.size;
    if (ok) toast(`${ok} file${ok > 1 ? 's' : ''} uploaded and encrypted${dups ? ` (${dups} already existed and ${dups > 1 ? 'were' : 'was'} flagged as duplicate)` : ''}.`);
    if (failed.size) setErr(new Error(`${failed.size} file${failed.size > 1 ? 's were' : ' was'} not uploaded. The reason is shown next to each; the rest are saved.`));
    onDone();
  };

  const busy = !!progress;
  const label = (p: Place) => [`FY ${p.fy}`, cats.find((c) => String(c.id) === p.category)?.name ?? 'choose a folder', p.month && monthName(Number(p.month)), p.sub].filter(Boolean).join(' / ');
  const pickerClass = 'font-semibold text-brand-700 cursor-pointer hover:underline focus-within:ring-2 focus-within:ring-brand-500 rounded';

  return (
    <Card title="Upload documents" description="Files are encrypted the moment they reach us. PDF, images, Excel, Word, CSV or ZIP, up to 25 MB each.">
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Financial year">
          <Select value={fy} disabled={!!at.fy || busy} onChange={(e) => setFy(e.target.value)}>{[...new Set([...fyOptions(), fy])].map((f) => <option key={f} value={f}>FY {f}</option>)}</Select>
        </Field>
        <Field label="Folder">
          <Select value={category} disabled={!!at.folder || busy} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Choose a folder</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Month" optional>
          <Select value={month} disabled={!!at.month || busy} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Not for a particular month</option>
            {MONTHS.map((m, i) => <option key={m} value={MONTH_NUM[i]}>{m}</option>)}
          </Select>
        </Field>
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={`mt-4 flex flex-col items-center justify-center text-center gap-2 px-4 py-8 rounded-2xl border-2 border-dashed transition-colors duration-150 ${drag ? 'border-brand-500 bg-brand-50' : 'border-line bg-slate-50/50 hover:border-slate-300'}`}>
        <span className="grid place-items-center size-12 rounded-full bg-white shadow-card text-brand-700"><UploadCloud className="size-6" aria-hidden /></span>
        <span className="text-sm text-ink">
          <label className={pickerClass}>Choose files<input type="file" multiple accept={ACCEPT} disabled={busy} className="sr-only" onChange={(e) => fromInput(e.target)} /></label>
          {', '}
          <label className={pickerClass}><FolderUp className="inline size-4 mr-1 -mt-0.5" aria-hidden />choose a folder<input type="file" multiple disabled={busy} className="sr-only" {...{ webkitdirectory: '' }} onChange={(e) => fromInput(e.target)} /></label>
          {' or drag them here'}
        </span>
        <span className="text-xs text-slate-500">A folder’s files are filed by its year, document and month names. On a phone you can take a photo of a bill.</span>
      </div>

      {!!planned.length && (
        <ul className="mt-4 space-y-2 max-h-96 overflow-y-auto">
          {planned.map((f) => {
            const problem = f.error ?? (f.file.size > MAX ? 'Larger than 25 MB' : f.place.category ? '' : 'Choose a folder above');
            return (
              <li key={f.path + f.file.size} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${problem ? 'border-red-200 bg-red-50' : 'border-line'}`}>
                <FileIcon mime={f.file.type} name={f.file.name} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink truncate">{f.file.name}</span>
                  <span className={`block text-xs ${problem ? 'text-red-700' : 'text-slate-500'}`}>{problem ? `${problem} · ` : ''}{label(f.place)} · {fmtSize(f.file.size)}</span>
                </span>
                {!busy && <IconButton label={`Remove ${f.file.name}`} icon={X} onClick={() => setFiles((x) => x.filter((y) => y.file !== f.file))} />}
              </li>
            );
          })}
        </ul>
      )}

      {!busy && !!unknown.length && (
        <div className="mt-4 rounded-xl bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-900">
          <p>{onNewFolder ? 'These folders are not in the portal yet. Add them to file everything in them, or choose a folder above:' : 'These folders are not in the portal yet. Ask a manager to add them, or choose a folder above:'}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {unknown.map((n) => onNewFolder
              ? <Button key={n} size="sm" variant="secondary" icon={FolderPlus} onClick={() => setNaming(n)}>Add folder “{n}”</Button>
              : <span key={n} className="rounded-md bg-white px-2 py-1 ring-1 ring-amber-200">{n}</span>)}
          </div>
        </div>
      )}
      {naming !== null && <NewFolder name={naming} onClose={() => setNaming(null)} onDone={() => { setNaming(null); onNewFolder?.(); }} />}
      {err ? <div className="mt-4"><ErrorText error={err} /></div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
        <span className="text-xs text-slate-500" aria-live="polite">
          {progress ? `Uploading ${progress.done} of ${progress.total}. Keep this page open.` : unfiled ? `Choose a folder for ${unfiled} file${unfiled > 1 ? 's' : ''}.` : ready.length ? `${ready.length} file${ready.length > 1 ? 's' : ''} ready` : ''}
        </span>
        <Button icon={UploadCloud} onClick={submit} busy={busy} disabled={!ready.length}>
          Upload{ready.length ? ` ${ready.length} file${ready.length > 1 ? 's' : ''}` : ''}
        </Button>
      </div>
    </Card>
  );
}
