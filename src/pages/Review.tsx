import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { api } from '../api';
import { Card, EmptyState, ErrorText, LoadingRows, PageHeader, Tabs, useLoad } from '../components/ui';
import { TaskTable, type TaskRow } from './Tasks';


export function Review() {
  const [toReview, e1, , l1] = useLoad(() => api<TaskRow[]>('/tasks?view=review'));
  const [requests, e2, reloadRequests, l2] = useLoad(() => api<TaskRow[]>('/tasks?view=requests'));
  const [tab, setTab] = useState<'review' | 'requests'>('review');
  return (
    <>
      <PageHeader title="Review" subtitle="Everything waiting on your decision." />
      <ErrorText error={e1 || e2} />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'review', label: 'Submitted work', count: toReview?.length },
        { value: 'requests', label: 'Client requests', count: requests?.length },
      ]} />

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
