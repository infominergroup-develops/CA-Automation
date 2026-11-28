import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { api } from '../api';
import { Link } from 'react-router-dom';
import { useUser } from '../auth';
import { Card, EmptyState, ErrorText, LoadingRows, PageHeader, Table, Tabs, Td, useLoad } from '../components/ui';
import { TaskTable, type TaskRow } from './Tasks';


export function Review() {
  const [toReview, e1, , l1] = useLoad(() => api<TaskRow[]>('/tasks?view=review'));
  const [requests, e2, reloadRequests, l2] = useLoad(() => api<TaskRow[]>('/tasks?view=requests'));
  const me = useUser();
  const [companies, e3] = useLoad(() => api<{ id: string; legal_name: string; manager_id: string | null; manager_name: string | null; added_by: string | null; approval: string | null }[]>('/companies'));
  // New clients employees added, waiting on me: my own clients as a manager, all of them as a director.
  const newClients = companies?.filter((c) => c.approval === 'pending' && (me.role === 'director' || c.manager_id === me.id));
  const [tab, setTab] = useState<'review' | 'requests' | 'clients'>('review');
  return (
    <>
      <PageHeader title="Review" subtitle="Everything waiting on your decision." />
      <ErrorText error={e1 || e2 || e3} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'review', label: 'Submitted work', count: toReview?.length },
        { value: 'requests', label: 'Client requests', count: requests?.length },
        { value: 'clients', label: 'New clients', count: newClients?.length },
      ]} />

      {tab === 'clients' && (
        <Card padded={false}>
          {!newClients ? <div className="p-5"><LoadingRows /></div> : newClients.length ? (
            <Table head={['Client', 'Added by', 'Manager', '']} label="New clients to approve">
              {newClients.map((c) => (
                <tr key={c.id}>
                  <Td className="font-semibold text-ink">{c.legal_name}</Td>
                  <Td>{c.added_by ?? '—'}</Td>
                  <Td>{c.manager_name ?? '—'}</Td>
                  <Td className="text-right"><Link to={`/company/${c.id}`} className="text-sm font-semibold text-brand-700 hover:underline">Open to approve</Link></Td>
                </tr>
              ))}
            </Table>
          ) : <EmptyState icon={CircleCheck} title="No new clients to approve">Clients an employee adds wait here for their manager or a director.</EmptyState>}
        </Card>
      )}

      {tab === 'review' && (
        <Card padded={false}>
          {l1 && !toReview ? <div className="p-5"><LoadingRows /></div> : toReview?.length ? <TaskTable rows={toReview} /> : (
            <EmptyState icon={CircleCheck} title="No work waiting for review">Tasks your team submits to you will appear here.</EmptyState>
          )}
        </Card>
      )}

      {tab === 'requests' && (
        <Card padded={false}>
          {l2 && !requests ? <div className="p-5"><LoadingRows /></div> : requests?.length ? <TaskTable rows={requests} onChanged={reloadRequests} /> : (
            <EmptyState icon={CircleCheck} title="No new client requests">Requests clients raise from their portal land here to be assigned.</EmptyState>
          )}
        </Card>
      )}
    </>
  );
}
