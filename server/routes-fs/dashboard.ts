import { Router } from 'express';
import { companyMap, companyScope } from '../firestore/authz.ts';
import type { DocumentDoc } from '../firestore/documents.ts';
import { h } from '../firestore/http.ts';
import { query } from '../firestore/store.ts';
import { OPEN_STATUSES } from '../firestore/tasks.ts';
import { C, type AccessGrantDoc, type DpdpRequestDoc, type TaskDoc } from '../firestore/types.ts';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', h(async (req, res) => {
  const u = req.user!;
  const scope = await companyScope(u);
  const inScope = (companyId: string) => !scope || scope.includes(companyId);
  const today = new Date().toISOString().slice(0, 10);

  if (u.role === 'client') {
    const [tasks, docs] = await Promise.all([
      // shortcut: Firestore 'in' takes at most 30 values, so a client group past 30 companies counts only the first 30.
      scope?.length ? query<TaskDoc>(C.tasks, { where: [['company_id', 'in', scope.slice(0, 30)]] }) : [],
      query<DocumentDoc>(C.documents, { where: [['review_status', '==', 'reupload'], ['deleted_at', '==', null]] }),
    ]);
    const mine = tasks.filter((t) => inScope(t.company_id));
    return res.json({
      openTasks: mine.filter((t) => !['approved', 'cancelled'].includes(t.status)).length,
      reuploadDocs: docs.filter((d) => inScope(d.company_id)).length,
      recentlyCompleted: mine.filter((t) => t.status === 'approved')
        .sort((a, b) => (b.approved_at ?? '').localeCompare(a.approved_at ?? '')).slice(0, 5)
        .map(({ id, title, approved_at, client_note }) => ({ id, title, approved_at, client_note })),
    });
  }

  const staff = u.role !== 'employee';
  const [open, assigned, grants, pendingDocs, privacy, companies] = await Promise.all([
    query<TaskDoc>(C.tasks, { where: [['status', 'in', OPEN_STATUSES]] }),
    query<TaskDoc>(C.tasks, { where: [['assignee_id', '==', u.id]] }),
    staff ? query<AccessGrantDoc>(C.accessGrants, { where: [['status', '==', 'requested']] }) : [],
    staff ? query<DocumentDoc>(C.documents, { where: [['review_status', '==', 'pending'], ['deleted_at', '==', null]] }) : [],
    u.role === 'director' ? query<DpdpRequestDoc>(C.dpdpRequests, { where: [['status', 'in', ['open', 'in_progress']]] }) : [],
    companyMap(),
  ]);
  const byId = new Map(open.map((t) => [t.id, t]));
  // Overdue and upcoming: an employee sees their own tasks, others the companies in their scope.
  const working = open.filter((t) => t.status !== 'requested' && (u.role === 'employee' ? t.assignee_id === u.id : inScope(t.company_id)));
  res.json({
    myOpenTasks: assigned.filter((t) => ['assigned', 'in_progress', 'rework'].includes(t.status)).length,
    myRework: assigned.filter((t) => t.status === 'rework').length,
    toReview: staff ? open.filter((t) => t.status === 'submitted' && (t.reviewer_id === u.id || u.role === 'director')).length : 0,
    accessRequests: staff ? grants.filter((g) => {
      const t = byId.get(g.task_id);
      return u.role === 'director' || (t && (t.reviewer_id === u.id || t.created_by === u.id));
    }).length : 0,
    clientRequests: staff ? open.filter((t) => t.status === 'requested' && inScope(t.company_id)).length : 0,
    pendingDocs: pendingDocs.filter((d) => inScope(d.company_id)).length,
    overdue: working.filter((t) => t.due_date && t.due_date < today).length,
    privacyOpen: privacy.length,
    upcoming: working.filter((t) => t.due_date).sort((a, b) => a.due_date!.localeCompare(b.due_date!)).slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, company: companies.get(t.company_id)?.legal_name })),
  });
}));
