import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleCheck, KeyRound, X } from 'lucide-react';
import { api, fmtDateTime } from '../api';
import { Avatar, Badge, Button, Card, EmptyState, ErrorText, LoadingRows, PageHeader, Tabs, useLoad, useToast } from '../components/ui';
import type { Category } from '../components/DocumentsPanel';
import { TaskTable, type TaskRow } from './Tasks';

interface AccessReq { id: string; task_id: string; category_ids: number[]; reason: string; created_at: string; task_title: string; company: string; employee: string }

export function Review() {
  const toast = useToast();
  const [toReview, e1, , l1] = useLoad(() => api<TaskRow[]>('/tasks?view=review'));
  const [requests, e2, , l2] = useLoad(() => api<TaskRow[]>('/tasks?view=requests'));
  const [access, e3, reloadAccess, l3] = useLoad(() => api<AccessReq[]>('/access-requests'));
  const [cats] = useLoad(() => api<Category[]>('/categories'));
  const [tab, setTab] = useState<'review' | 'access' | 'requests'>('review');
  const name = (id: number) => cats?.find((c) => c.id === id)?.name ?? `#${id}`;
  const decide = async (a: AccessReq, decision: 'grant' | 'reject') => {
    try {
      await api(`/access-requests/${a.id}/decide`, { body: { decision } });
      toast(decision === 'grant' ? `${a.employee} can now open those documents` : 'Request rejected');
      reloadAccess();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <>
      <PageHeader title="Review" subtitle="Everything waiting on your decision." />
      <ErrorText error={e1 || e2 || e3} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'review', label: 'Submitted work', count: toReview?.length },
        { value: 'access', label: 'Document access', count: access?.length },
        { value: 'requests', label: 'Client requests', count: requests?.length },
      ]} />

      {tab === 'review' && (
        <Card padded={false}>
          {l1 && !toReview ? <div className="p-5"><LoadingRows /></div> : toReview?.length ? <TaskTable rows={toReview} /> : (
            <EmptyState icon={CircleCheck} title="No work waiting for review">Tasks your team submits to you will appear here.</EmptyState>
          )}
        </Card>
      )}

      {tab === 'access' && (
        <Card padded={false}>
          {l3 && !access ? <div className="p-5"><LoadingRows /></div> : !access?.length ? (
            <EmptyState icon={KeyRound} title="No pending access requests">When an employee asks to see a client's documents for a task, you decide here.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {access.map((a) => (
                <li key={a.id} className="flex flex-col sm:flex-row gap-4 sm:items-center px-5 py-4">
                  <Avatar name={a.employee} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm"><b className="text-ink">{a.employee}</b> <span className="text-slate-500">for</span> <Link className="font-semibold text-brand-700 hover:underline" to={`/tasks/${a.task_id}`}>{a.task_title}</Link> <span className="text-slate-500">· {a.company}</span></div>
                    <div className="flex flex-wrap gap-1.5 mt-2">{a.category_ids.map((c) => <Badge key={c} tone="ink">{name(c)}</Badge>)}</div>
                    <p className="text-sm text-slate-600 mt-2">“{a.reason}”</p>
                    <time className="text-xs text-slate-400">{fmtDateTime(a.created_at)}</time>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="danger" icon={X} onClick={() => decide(a, 'reject')}>Reject</Button>
                    <Button icon={Check} onClick={() => decide(a, 'grant')}>Grant</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'requests' && (
        <Card padded={false}>
          {l2 && !requests ? <div className="p-5"><LoadingRows /></div> : requests?.length ? <TaskTable rows={requests} /> : (
            <EmptyState icon={CircleCheck} title="No new client requests">Requests clients raise from their portal land here to be assigned.</EmptyState>
          )}
        </Card>
      )}
    </>
  );
}
