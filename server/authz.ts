import { all, one, now } from './db.ts';
import { HttpError, type SessionUser } from './security/session.ts';

/**
 * Every data route goes through these checks. The UI hides what a user cannot do,
 * but the server is the only place access is decided.
 */

const OPEN_TASK = `status NOT IN ('approved','cancelled')`;

/** Company ids the user may see at all. `null` means every company (Director). */
export function companyScope(u: SessionUser): string[] | null {
  switch (u.role) {
    case 'director':
      return null;
    case 'manager':
      return all<{ id: string }>(
        `SELECT id FROM companies WHERE manager_id = ?
         UNION SELECT company_id FROM tasks WHERE reviewer_id = ? OR created_by = ?`,
        [u.id, u.id, u.id]).map((r) => r.id);
    case 'employee':
      return all<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM tasks WHERE assignee_id = ? AND ${OPEN_TASK}`, [u.id]).map((r) => r.company_id);
    case 'client':
      return all<{ id: string }>('SELECT id FROM companies WHERE group_id = ?', [u.client_group_id ?? '']).map((r) => r.id);
  }
}

export function inScope(u: SessionUser, companyId: string): boolean {
  const scope = companyScope(u);
  return scope === null || scope.includes(companyId);
}

export function assertCompany(u: SessionUser, companyId: string) {
  // 404 rather than 403, so users cannot probe which company ids exist.
  if (!inScope(u, companyId) || !one('SELECT 1 FROM companies WHERE id = ?', [companyId])) {
    throw new HttpError(404, 'Not found.');
  }
}

/** Category ids an employee may currently open for a company, via granted, unexpired requests on open tasks. */
export function employeeCategories(employeeId: string, companyId: string): Set<number> {
  const rows = all<{ category_ids: string }>(
    `SELECT g.category_ids FROM access_grants g JOIN tasks t ON t.id = g.task_id
     WHERE g.employee_id = ? AND g.company_id = ? AND g.status = 'granted' AND g.expires_at > ?
       AND t.assignee_id = ? AND t.${OPEN_TASK}`,
    [employeeId, companyId, now(), employeeId]);
  return new Set(rows.flatMap((r) => JSON.parse(r.category_ids) as number[]));
}

export function canViewDocument(u: SessionUser, doc: { company_id: string; category_id: number }): boolean {
  if (u.role === 'employee') return employeeCategories(u.id, doc.company_id).has(doc.category_id);
  return inScope(u, doc.company_id);
}

export interface TaskRow {
  id: string;
  company_id: string;
  assignee_id: string | null;
  reviewer_id: string | null;
  created_by: string;
  status: string;
}

export function loadTask(u: SessionUser, taskId: string): TaskRow & Record<string, unknown> {
  const t = one<TaskRow & Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!t) throw new HttpError(404, 'Not found.');
  const visible =
    u.role === 'director' ||
    (u.role === 'manager' && inScope(u, t.company_id)) ||
    (u.role === 'employee' && t.assignee_id === u.id) ||
    (u.role === 'client' && inScope(u, t.company_id));
  if (!visible) throw new HttpError(404, 'Not found.');
  return t;
}

/** Who may assign, grant access, and approve: a Director, or the manager who reviews or created the task. */
export function isTaskOwner(u: SessionUser, t: TaskRow): boolean {
  return u.role === 'director' || (u.role === 'manager' && (t.reviewer_id === u.id || t.created_by === u.id));
}
