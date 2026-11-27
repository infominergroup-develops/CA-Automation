import { useEffect, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check, ChevronLeft, ChevronRight, Download, Eye, FileImage, FileSpreadsheet, FileText, FileArchive, Fingerprint, Folder, FolderInput, FolderOpen, FolderPlus, FolderUp, RotateCcw, Search, Trash2, UploadCloud, X,
} from 'lucide-react';
import { api, currentFy, download, fetchBlob, fmtDateTime, fmtSize, fyOptions } from '../api';
import { parseCsv } from '../csv';
import { useRights, useUser } from '../auth';
import { placeFile, type Place } from '../placeFile';
import { Button, Card, EmptyState, ErrorText, Field, IconButton, Input, LoadingRows, Modal, Select, StatusBadge, useConfirm, useLoad, useToast } from './ui';

interface Doc {
  id: string; category_id: number; category: string; fy: string; month: number | null; original_name: string; mime: string;
  size: number; sha256: string; review_status: string; review_note: string | null; created_at: string; subfolder?: string | null;
  uploaded_by_name: string; mine?: boolean;
}
export interface Category { id: number; name: string }
/** A place in the file manager, as kept in the address. */
type Place2 = { fy?: string; folder?: string; month?: string; sub?: string };

const MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
const MONTH_NUM = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const monthName = (m: number) => MONTHS[MONTH_NUM.indexOf(m)];
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

/**
 * Documents as folders: financial year, document type, month, then any folders people made. Only folders that hold files
 * are shown. The open folder is kept in the address, so Back works.
 */
export function DocumentsPanel({ companyId, canUpload = true }: { companyId: string; canUpload?: boolean }) {
  const u = useUser();
  const can = useRights(); // what the director lets this person do with files
  const toast = useToast();
  const confirm = useConfirm();
  const [cats, , reloadCats] = useLoad(() => api<Category[]>('/categories'));
  const [params, setParams] = useSearchParams();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const fy = params.get('fy') ?? '', folder = params.get('folder') ?? '', month = params.get('month') ?? '', sub = params.get('sub') ?? '';
  const [makingSub, setMakingSub] = useState(false);
  const [q, setQ] = useState('');
  const [docs, loadErr, reload, loading] = useLoad(() => (can.view ? api<Doc[]>(`/companies/${companyId}/documents`) : Promise.resolve([])), [companyId, can.view]);
  // Move, accept, ask for re-upload: the edit right (directors and managers unless changed).
  const managerial = can.edit && u.role !== 'client';
  // Document-type folders are shared by every client, so only staff add them; anyone who uploads makes folders inside them.
  const staff = u.role !== 'client';

  const open = (to: Place2) => {
    const next = new URLSearchParams(params);
    for (const k of ['fy', 'folder', 'month', 'sub'] as const) { next.delete(k); if (to[k]) next.set(k, to[k]); }
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
  // Deleting a folder deletes every file in it, at any depth (the "delete folders" right in Masters).
  const removeFolder = async (t: { name: string; count: number; to: Place2 }) => {
    const r = await confirm({ title: `Delete the folder “${t.name}”?`, danger: true, confirmLabel: `Delete ${t.count} file${t.count > 1 ? 's' : ''}`,
      body: <>All <b>{t.count} file{t.count > 1 ? 's' : ''}</b> in it, including its inner folders, will be removed from the portal. The deletion is recorded in the audit trail.</> });
    if (r) attempt(() => api(`/companies/${companyId}/folders/delete`, { body: { fy: t.to.fy, category_id: t.to.folder || undefined, month: t.to.month ? Number(t.to.month) : undefined, sub: t.to.sub || undefined } }), `Folder ${t.name} deleted`);
  };
  const removePicked = async () => {
    const list = (docs ?? []).filter((d) => picked.has(d.id));
    const r = await confirm({ title: `Delete ${list.length} file${list.length > 1 ? 's' : ''}?`, danger: true, confirmLabel: 'Delete',
      body: 'They will be removed from the portal. The deletion is recorded in the audit trail.' });
    if (!r) return;
    let failed = 0;
    for (const d of list) await api(`/documents/${d.id}`, { method: 'DELETE' }).catch(() => failed++);
    setPicked(new Set());
    if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} could not be deleted.`, 'error'); else toast(`${list.length} file${list.length > 1 ? 's' : ''} deleted`);
    reload();
  };
  const canPick = managerial || (staff && can.delete); // ticking files to move or delete them together
  const canDelete = (d: Doc) => can.delete && (u.role !== 'client' || (!!d.mine && Date.parse(d.created_at) > Date.now() - 86400e3));

  // Every file inside the open folder, at any depth. Folders people made inside a document type hold files of no month.
  const here = (docs ?? []).filter((d) => (!fy || d.fy === fy) && (!folder || String(d.category_id) === folder)
    && (month ? String(d.month ?? '') === month : !sub || !d.month)
    && (!sub || (d.subfolder ?? '') === sub || (d.subfolder ?? '').startsWith(`${sub}/`)));
  const rel = (d: Doc) => (sub ? (d.subfolder ?? '').slice(sub.length + 1) : d.subfolder ?? ''); // its folders below this one
  const catName = cats?.find((c) => String(c.id) === folder)?.name ?? folder;
  const count = (list: Doc[]) => list.length;
  const madeFolders = (list: Doc[]) => [...new Set(list.map(rel).filter(Boolean).map((r) => r.split('/')[0]))].sort((a, b) => a.localeCompare(b))
    .map((name) => ({ key: `sub:${name}`, name, count: count(list.filter((d) => rel(d).split('/')[0] === name)), to: { fy, folder, month, sub: sub ? `${sub}/${name}` : name } }));
  const atTypeRoot = !!folder && !month && !sub;
  // Only folders that hold files: years, document types and months appear once something is uploaded into them.
  const tiles = !docs || q ? []
    : !fy ? [...new Set(here.map((d) => d.fy))].sort().reverse().map((y) => ({ key: y, name: `FY ${y}`, count: count(here.filter((d) => d.fy === y)), to: { fy: y } as Place2 }))
      : !folder ? (cats ?? []).map((c) => ({ key: String(c.id), name: c.name, count: count(here.filter((d) => d.category_id === c.id)), to: { fy, folder: String(c.id) } as Place2 })).filter((t) => t.count)
        : atTypeRoot ? [
          ...MONTHS.map((m, i) => ({ key: m, name: m, count: count(here.filter((d) => d.month === MONTH_NUM[i])), to: { fy, folder, month: String(MONTH_NUM[i]) } as Place2 })).filter((t) => t.count),
          ...madeFolders(here.filter((d) => !d.month)),
        ]
          : madeFolders(here);
  // Files sitting directly in the open folder; inside a document type, files of no month sit beside the month folders.
  const files = q ? here.filter((d) => `${d.original_name} ${d.subfolder ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    : atTypeRoot ? here.filter((d) => !d.month && !rel(d)) : folder ? here.filter((d) => !rel(d)) : [];
  const subParts = sub ? sub.split('/') : [];
  const crumbs = [
    { name: 'All years', go: () => open({}) },
    ...(fy ? [{ name: `FY ${fy}`, go: () => open({ fy }) }] : []),
    ...(folder ? [{ name: catName, go: () => open({ fy, folder }) }] : []),
    ...(month ? [{ name: monthName(Number(month)), go: () => open({ fy, folder, month }) }] : []),
    ...subParts.map((p, i) => ({ name: p, go: () => open({ fy, folder, month, sub: subParts.slice(0, i + 1).join('/') }) })),
  ];

  return (
    <div className="space-y-6">
      {canUpload && <UploadZone key={`${fy}|${folder}|${month}|${sub}`} companyId={companyId} cats={cats ?? []} at={{ fy, folder, month, sub }} onDone={reload} onNewFolder={staff ? reloadCats : undefined} />}

      {!can.view ? (
        <Card title="Documents">
          <EmptyState icon={FolderOpen} title="Viewing files is turned off for you">{canUpload ? 'You can still upload files above. ' : ''}Ask a director if you need to see them.</EmptyState>
        </Card>
      ) : (
      <Card title="Documents" description={u.role === 'employee' ? `All files of clients you work on. You can ${sayList(['upload', 'view', can.download && 'download', can.edit && 'move', can.delete && 'delete'])} them.` : `${docs?.length ?? '–'} files`} padded={false}
        actions={
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={fy ? 'Search this folder' : 'Search all files'} aria-label="Search files" className="pl-9 w-52! h-9!" />
          </div>
        }>
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 px-5 py-3 border-b border-line text-sm">
          {crumbs.map((c, i) => (
            <span key={`${i}:${c.name}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-4 text-slate-300" aria-hidden />}
              {i < crumbs.length - 1
                ? <button type="button" onClick={c.go} className="font-medium text-brand-700 hover:underline">{c.name}</button>
                : <span className="font-semibold text-ink" aria-current="page">{c.name}</span>}
            </span>
          ))}
        </nav>
        {loadErr ? <div className="p-5"><ErrorText error={loadErr} /></div> : loading && !docs ? <div className="p-5"><LoadingRows /></div> : (
          <>
            {(!!tiles.length || (!q && ((staff && fy && !folder) || (canUpload && folder)))) && (
              <ul className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
                {tiles.map((t) => (
                  <li key={t.key} className="relative">
                    <button type="button" onClick={() => open(t.to)} className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-ink/10 hover:ring-brand-500 hover:bg-brand-50/40 transition-colors ${staff && can.deleteFolder ? 'pr-12' : ''}`}>
                      {t.count ? <FolderOpen className="size-5 shrink-0 text-brand-700" aria-hidden /> : <Folder className="size-5 shrink-0 text-slate-300" aria-hidden />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{t.name}</span>
                        <span className="block text-xs text-slate-500">{t.count ? `${t.count} file${t.count > 1 ? 's' : ''}` : 'Empty'}</span>
                      </span>
                    </button>
                    {staff && can.deleteFolder && (
                      <IconButton label={`Delete folder ${t.name}`} icon={Trash2} onClick={() => removeFolder(t)} className="absolute right-2 top-1/2 -translate-y-1/2" />
                    )}
                  </li>
                ))}
                {!q && ((staff && fy && !folder) || (canUpload && folder && subParts.length < 5)) && (
                  <li>
                    <button type="button" onClick={() => (folder ? setMakingSub(true) : setNaming(true))} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left border-2 border-dashed border-line text-brand-700 hover:border-brand-500 hover:bg-brand-50/40 transition-colors">
                      <FolderPlus className="size-5 shrink-0" aria-hidden /><span className="text-sm font-semibold">New folder</span>
                    </button>
                  </li>
                )}
              </ul>
            )}
            {canPick && !!files.length && (
              <div className="flex flex-wrap items-center gap-3 px-5 py-2 border-b border-line text-sm">
                <label className="flex items-center gap-2 text-slate-600">
                  <input type="checkbox" className="size-4 accent-brand-500" checked={files.every((d) => picked.has(d.id))}
                    onChange={(e) => setPicked(new Set(e.target.checked ? files.map((d) => d.id) : []))} />
                  Select all
                </label>
                {!!picked.size && managerial && <Button size="sm" variant="secondary" icon={FolderInput} onClick={() => setMoving(true)}>Move {picked.size} file{picked.size > 1 ? 's' : ''}</Button>}
                {!!picked.size && can.delete && <Button size="sm" variant="danger" icon={Trash2} onClick={removePicked}>Delete {picked.size} file{picked.size > 1 ? 's' : ''}</Button>}
              </div>
            )}
            {!!files.length && !!tiles.length && <p className="px-5 pb-2 text-[13px] font-semibold text-slate-500">Not for a particular month</p>}
            {!files.length && !tiles.length && (
              <EmptyState icon={FolderOpen} title={q ? 'No matching documents' : !fy ? 'No files yet' : 'This folder is empty'}>
                {q ? 'Try a different search.' : canUpload ? `Upload files or a whole folder above. They are encrypted as soon as they arrive.${fy ? ' An empty folder is not kept: it stays once a file is in it.' : ''}` : ''}
              </EmptyState>
            )}
            {!!files.length && (
              <ul className="divide-y divide-line">
                {files.map((d) => (
                  <li key={d.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-3.5 hover:bg-slate-50/70 transition-colors">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {canPick && (
                        <input type="checkbox" aria-label={`Select ${d.original_name}`} className="mt-3 size-4 shrink-0 accent-brand-500" checked={picked.has(d.id)}
                          onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })} />
                      )}
                      <FileIcon mime={d.mime} name={d.original_name} />
                      <div className="min-w-0">
                        <button type="button" onClick={() => setViewing(files.indexOf(d))} className="text-left text-sm font-semibold text-ink break-all hover:text-brand-700 hover:underline">{d.original_name}</button>
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
                        <IconButton label={`View ${d.original_name}`} icon={Eye} onClick={() => setViewing(files.indexOf(d))} />
                        {can.download && <IconButton label={`Download ${d.original_name}`} icon={Download} onClick={() => get(d)} />}
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
      )}
      {viewing !== null && files[viewing] && (
        <FileViewer docs={files} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} onDownload={can.download ? get : undefined} />
      )}
      {naming && <NewFolder onClose={() => setNaming(false)} onDone={(c) => { setNaming(false); reloadCats(); open({ fy, folder: String(c.id) }); }} />}
      {makingSub && <NewSubfolder taken={tiles.map((t) => t.name)} onClose={() => setMakingSub(false)}
        onDone={(name) => { setMakingSub(false); open({ fy, folder, month, sub: sub ? `${sub}/${name}` : name }); }} />}
      {moving && cats && (
        <MoveFiles docs={(docs ?? []).filter((d) => picked.has(d.id))} cats={cats} at={{ fy, folder, month }}
          onClose={() => setMoving(false)} onDone={() => { setMoving(false); setPicked(new Set()); reload(); }} />
      )}
    </div>
  );
}

/** A folder inside the open one, made by whoever is uploading. It exists once a file is uploaded into it. */
function NewSubfolder({ taken, onClose, onDone }: { taken: string[]; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  // Same rules as the server's folder names: no slashes or control characters, no leading dots.
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/^\.+/, '').trim();
  const clash = taken.some((t) => t.toLowerCase() === clean.toLowerCase());
  return (
    <Modal title="New folder" description="Made inside the folder you have open. Upload files into it; an empty folder is not kept." onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={FolderPlus} onClick={() => onDone(clean)} disabled={!clean}>{clash ? 'Open folder' : 'Make folder'}</Button></>}>
      <Field label="Folder name" hint={clash ? 'A folder with this name is already here; it will open.' : undefined}>
        <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. HDFC current account"
          onKeyDown={(e) => { if (e.key === 'Enter' && clean) onDone(clean); }} />
      </Field>
    </Modal>
  );
}

/** A document-type folder for every client, such as Bookkeeping. Any staff member; it shows for a client once it holds their files. */
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
    <Modal title="New folder" description="A document type for every client and year, like Bank statements. It shows for a client once it holds their files." onClose={onClose}
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

/**
 * Never holds a file back for its folder: with no folder chosen it goes to Others, keeping its own folder names. Staff
 * uploading a folder of their own layout (year / type / month) get its unknown document types added as new folders.
 */
function UploadZone({ companyId, cats, at, onDone, onNewFolder }: { companyId: string; cats: Category[]; at: { fy: string; folder: string; month: string; sub: string }; onDone: () => void; onNewFolder?: () => void }) {
  const toast = useToast();
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

  // The open folder is fixed (inside a made folder, so is "no month"); the rest comes from the uploaded folder's names, else the boxes above.
  const fixed: Partial<Place> = { ...(at.fy && { fy: at.fy }), ...(at.folder && { category: at.folder }), ...((at.month || at.sub) && { month: at.month }) };
  const others = String(cats.find((c) => c.name === 'Others')?.id ?? '');
  const plan = (list: Category[]) => files.map((f) => {
    const p = placeFile(f.path, fixed, { category: category || String(list.find((c) => c.name === 'Others')?.id ?? ''), fy, month }, list);
    return { ...f, place: { ...p, sub: [at.sub, p.sub].filter(Boolean).join('/') } };
  });
  const planned = plan(cats);
  const ready = planned.filter((f) => f.place.category && f.file.size <= MAX);
  // Folder names in the upload that look like document types the portal does not have yet; staff get them added.
  const unknown = !category && !at.folder && onNewFolder ? [...new Set(planned.filter((f) => f.place.newFolder).map((f) => f.place.newFolder!))] : [];

  const submit = async () => {
    setErr(undefined);
    let done = 0, dups = 0;
    const failed = new Map<File, string>();
    let ready = planned.filter((f) => f.place.category && f.file.size <= MAX);
    if (unknown.length) {
      // Added first (one that exists already is fine), then every file is placed again with them.
      for (const name of unknown) await api('/categories', { body: { name } }).catch(() => {});
      const fresh = await api<Category[]>('/categories').catch(() => cats);
      ready = plan(fresh).filter((f) => f.place.category && f.file.size <= MAX);
      onNewFolder?.();
    }
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
  const label = (p: Place) => {
    const fresh = unknown.includes(p.newFolder ?? '') ? p.newFolder : undefined; // a document type about to be added
    const sub = fresh && p.sub.startsWith(fresh) ? p.sub.slice(fresh.length + 1) : p.sub;
    return [`FY ${p.fy}`, fresh ? `${fresh} (new folder)` : cats.find((c) => String(c.id) === p.category)?.name ?? 'Others', p.month && monthName(Number(p.month)), sub].filter(Boolean).join(' / ');
  };
  const pickerClass = 'font-semibold text-brand-700 cursor-pointer hover:underline focus-within:ring-2 focus-within:ring-brand-500 rounded';

  return (
    <Card title="Upload documents" description={`Files are encrypted the moment they reach us. Any file up to 25 MB, except programs and scripts.${at.sub ? ` Going into ${at.sub}.` : ''}`}>
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Financial year">
          <Select value={fy} disabled={!!at.fy || busy} onChange={(e) => setFy(e.target.value)}>{[...new Set([...fyOptions(), fy])].map((f) => <option key={f} value={f}>FY {f}</option>)}</Select>
        </Field>
        <Field label="Folder">
          <Select value={category} disabled={!!at.folder || busy} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{others ? 'Others, or by the uploaded folder’s names' : 'By the uploaded folder’s names'}</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Month" optional>
          <Select value={month} disabled={!!at.month || !!at.sub || busy} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Not for a particular month</option>
            {MONTHS.map((m, i) => <option key={m} value={MONTH_NUM[i]}>{m}</option>)}
          </Select>
        </Field>
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={`mt-4 flex flex-col items-center justify-center text-center gap-2 px-4 py-8 rounded-2xl border-2 border-dashed transition-colors duration-150 ${drag ? 'border-brand-500 bg-brand-50' : 'border-line bg-slate-50/50 hover:border-slate-300'}`}>
        <span className="grid place-items-center size-12 rounded-full bg-white shadow-card text-brand-700"><UploadCloud className="size-6" aria-hidden /></span>
        <span className="text-sm text-ink">
          <label className={pickerClass}>Choose files<input type="file" multiple disabled={busy} className="sr-only" onChange={(e) => fromInput(e.target)} /></label>
          {', '}
          <label className={pickerClass}><FolderUp className="inline size-4 mr-1 -mt-0.5" aria-hidden />choose a folder<input type="file" multiple disabled={busy} className="sr-only" {...{ webkitdirectory: '' }} onChange={(e) => fromInput(e.target)} /></label>
          {' or drag them here'}
        </span>
        <span className="text-xs text-slate-500">A folder’s files are filed by its year, document and month names. On a phone you can take a photo of a bill.</span>
      </div>

      {!!planned.length && (
        <ul className="mt-4 space-y-2 max-h-96 overflow-y-auto">
          {planned.map((f) => {
            const problem = f.error ?? (f.file.size > MAX ? 'Larger than 25 MB' : '');
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
        <p className="mt-4 rounded-xl bg-brand-50 ring-1 ring-brand-200 px-4 py-3 text-sm text-ink">
          New folders will be added as you upload: {unknown.map((n) => <b key={n} className="font-semibold">{n} </b>)}
        </p>
      )}
      {err ? <div className="mt-4"><ErrorText error={err} /></div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
        <span className="text-xs text-slate-500" aria-live="polite">
          {progress ? `Uploading ${progress.done} of ${progress.total}. Keep this page open.` : ready.length ? `${ready.length} file${ready.length > 1 ? 's' : ''} ready` : ''}
        </span>
        <Button icon={UploadCloud} onClick={submit} busy={busy} disabled={!ready.length}>
          Upload{ready.length ? ` ${ready.length} file${ready.length > 1 ? 's' : ''}` : ''}
        </Button>
      </div>
    </Card>
  );
}

/** "upload, view and delete" from a list with gaps. */
const sayList = (items: (string | false)[]) => { const w = items.filter(Boolean) as string[]; return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w.at(-1)}` : w[0] ?? ''; };

/** What the viewer can show inside the portal; other files are offered as a download. */
// Phones whose browser has no built-in PDF viewer (Chrome on Android) would show an empty box, so they get the download.
const viewKind = (mime: string) =>
  mime === 'application/pdf' ? (navigator.pdfViewerEnabled === false ? null : 'pdf') : ['image/jpeg', 'image/png', 'image/webp'].includes(mime) ? 'image'
    : mime === 'text/csv' ? 'csv' : mime === 'text/plain' ? 'text'
      : mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel' ? 'sheet'
        : mime.includes('wordprocessingml') ? 'word' : null;

const MAX_ROWS = 1000, MAX_COLS = 60;

/** Sheets as rows of displayed text (as Excel shows them), at most MAX_ROWS each. Loaded only when needed. */
async function readSheets(b: Blob) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await b.arrayBuffer(), { type: 'array', sheetRows: MAX_ROWS + 1, cellFormula: false, cellHTML: false });
  return wb.SheetNames.map((name) => ({
    name, rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false }),
  }));
}

/** A Word file as a page of HTML. It is shown in a sandboxed frame, so nothing in it can run. */
async function readWord(b: Blob) {
  const { convertToHtml } = await import('mammoth');
  const { value: raw } = await convertToHtml({ arrayBuffer: await b.arrayBuffer() });
  // Belt and braces: links that are not web, mail or in-page are dropped (the sandbox already stops scripts).
  const value = raw.replace(/\shref="(?!https?:|mailto:|#)[^"]*"/gi, '');
  return `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 system-ui,sans-serif;color:#0f172a;max-width:800px;margin:24px auto;padding:0 24px}
table{border-collapse:collapse}td,th{border:1px solid #cbd5e1;padding:4px 8px}img{max-width:100%}</style>${value}`;
}

/** Shows a file inside the portal, with previous/next through the files listed. Each opening is recorded as a view. */
function FileViewer({ docs, index, onIndex, onClose, onDownload }: { docs: Doc[]; index: number; onIndex: (i: number) => void; onClose: () => void; onDownload?: (d: Doc) => void }) {
  const d = docs[index];
  const kind = viewKind(d.mime);
  const [shown, setShown] = useState<{ id: string; url?: string; text?: string; html?: string; sheets?: { name: string; rows: string[][] }[]; error?: string }>();
  const [sheet, setSheet] = useState(0);
  useEffect(() => {
    if (!kind) return;
    let live = true, url = '';
    fetchBlob(`/documents/${d.id}/download?view=1`).then(async (b) => {
      if (!live) return;
      if (kind === 'csv' || kind === 'text') setShown({ id: d.id, text: await b.text() });
      else if (kind === 'sheet') { const sheets = await readSheets(b); if (live) { setSheet(0); setShown({ id: d.id, sheets }); } }
      else if (kind === 'word') { const html = await readWord(b); if (live) setShown({ id: d.id, html }); }
      else { url = URL.createObjectURL(new Blob([b], { type: d.mime })); setShown({ id: d.id, url }); }
    }).catch((e: Error) => live && setShown({ id: d.id, error: kind === 'sheet' || kind === 'word' ? 'This file could not be read. Download it to open it in Excel or Word.' : e.message }));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [d.id, d.mime, kind]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      if (e.key === 'ArrowRight' && index < docs.length - 1) onIndex(index + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, docs.length, onIndex]);
  const ready = shown?.id === d.id ? shown : undefined;
  const box = 'h-[70dvh] rounded-xl ring-1 ring-ink/10 bg-slate-50';
  const rows = kind === 'csv' && ready?.text !== undefined ? parseCsv(ready.text) : ready?.sheets?.[sheet]?.rows ?? [];
  return (
    <Modal wide="full" title={d.original_name} onClose={onClose}
      description={<>FY {d.fy} / {d.category}{d.month ? ` / ${monthName(d.month)}` : ''} · {fmtSize(d.size)}</>}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-slate-500">{index + 1} of {docs.length} · use the arrow keys</span>
          <Button variant="secondary" icon={ChevronLeft} disabled={index === 0} onClick={() => onIndex(index - 1)}>Previous</Button>
          <Button variant="secondary" disabled={index === docs.length - 1} onClick={() => onIndex(index + 1)}>Next<ChevronRight className="size-4" aria-hidden /></Button>
          {onDownload && <Button icon={Download} onClick={() => onDownload(d)}>Download</Button>}
        </>
      }>
      {!kind ? (
        <div className={`${box} grid place-items-center`}>
          <EmptyState icon={FileText} title="This file cannot be shown here">
            {d.mime === 'application/pdf' ? 'This browser cannot show PDFs inside a page. Download it to open it.'
              : 'PDFs, photos, Excel, Word (.docx), CSV and text files open in the portal. Download this one to open it in its own program.'}
          </EmptyState>
        </div>
      ) : ready?.error ? <ErrorText error={new Error(ready.error)} />
        : !ready ? <div className={`${box} grid place-items-center text-sm text-slate-500`}>Opening…</div>
          : kind === 'pdf' ? <iframe src={ready.url} title={d.original_name} className={`${box} w-full bg-white`} />
            : kind === 'image' ? (
              <div className={`${box} grid place-items-center overflow-auto`}><img src={ready.url} alt={d.original_name} className="max-w-full max-h-full object-contain" /></div>
            ) : kind === 'word' ? <iframe sandbox="" srcDoc={ready.html} title={d.original_name} className={`${box} w-full bg-white`} />
            : kind === 'csv' || kind === 'sheet' ? (
              <div className={`${box} overflow-auto bg-white`}>
                {ready.sheets && ready.sheets.length > 1 && (
                  <div role="tablist" aria-label="Sheets" className="sticky left-0 top-0 z-10 flex gap-1 overflow-x-auto bg-white border-b border-line p-2">
                    {ready.sheets.map((sh, i) => (
                      <button key={sh.name} type="button" role="tab" aria-selected={i === sheet} onClick={() => setSheet(i)}
                        className={`shrink-0 rounded-full px-3 h-7 text-xs font-medium ${i === sheet ? 'bg-ink text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{sh.name}</button>
                    ))}
                  </div>
                )}
                {!rows.length && <p className="p-4 text-sm text-slate-500">This sheet is empty.</p>}
                <table className="text-xs tabular-nums border-collapse">
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={i === 0 ? 'bg-slate-100 font-semibold sticky top-0' : 'odd:bg-slate-50/60'}>
                        {r.slice(0, MAX_COLS).map((c, j) => <td key={j} className="border border-line px-2 py-1 whitespace-nowrap">{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(rows.length >= MAX_ROWS || rows.some((r) => r.length > MAX_COLS)) && <p className="p-3 text-xs text-slate-500">Showing the first 1,000 rows and 60 columns. Download the file for the rest.</p>}
              </div>
            ) : <pre className={`${box} overflow-auto p-4 text-xs whitespace-pre-wrap break-words bg-white`}>{ready.text}</pre>}
    </Modal>
  );
}
