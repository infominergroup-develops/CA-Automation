import { HttpError, type SessionUser } from './http.ts';
import { getById, query } from './store.ts';
import { OPEN_STATUSES, employeeCategories, getTask } from './tasks.ts';
import { C, type CompanyDoc, type TaskDoc, type UserDoc } from './types.ts';

/**
 * Every data route goes through these checks (same rules as server/authz.ts). The UI hides what a user
 * cannot do, but the server is the only place access is decided.
 */

// req.user is a fresh object per request, so this caches the scope for exactly one request.
const scopes = new WeakMap<SessionUser, Promise<string[] | null>>();

/** Company ids the user may see at all. `null` means every company (Director). */
export function companyScope(u: SessionUser): Promise<string[] | null> {
  let p = scopes.get(u);
  if (!p) { p = computeScope(u); scopes.set(u, p); }
  return p;
}

async function computeScope(u: SessionUser): Promise<string[] | null> {
  switch (u.role) {
    case 'director':
      return null;
    case 'manager': {
      const [own, reviewing, created] = await Promise.all([
        query<CompanyDoc>(C.companies, { where: [['manager_id', '==', u.id]] }),
        query<TaskDoc>(C.tasks, { where: [['reviewer_id', '==', u.id]] }),
        query<TaskDoc>(C.tasks, { where: [['created_by', '==', u.id]] }),
      ]);
      return [...new Set([...own.map((c) => c.id), ...reviewing.map((t) => t.company_id), ...created.map((t) => t.company_id)])];
    }
    case 'employee': {
      const tasks = await query<TaskDoc>(C.tasks, { where: [['assignee_id', '==', u.id]] });
      return [...new Set(tasks.filter((t) => OPEN_STATUSES.includes(t.status)).map((t) => t.company_id))];
    }
    case 'client':
      return (await query<CompanyDoc>(C.companies, { where: [['group_id', '==', u.client_group_id ?? '']] })).map((c) => c.id);
  }
}

export async function inScope(u: SessionUser, companyId: string): Promise<boolean> {
  const scope = await companyScope(u);
  return scope === null || scope.includes(companyId);
}

/** The company, if the user may see it. 404 rather than 403, so users cannot probe which company ids exist. */
export async function assertCompany(u: SessionUser, companyId: string): Promise<CompanyDoc> {
  const c = (await inScope(u, companyId)) ? await getById<CompanyDoc>(C.companies, companyId) : undefined;
  if (!c) throw new HttpError(404, 'Not found.');
  return c;
}

export async function canViewDocument(u: SessionUser, doc: { company_id: string; category_id: string }): Promise<boolean> {
  if (u.role === 'employee') return (await employeeCategories(u.id, doc.company_id)).has(doc.category_id);
  return inScope(u, doc.company_id);
}

export async function loadTask(u: SessionUser, taskId: string): Promise<TaskDoc> {
  const t = await getTask(taskId);
  if (!t) throw new HttpError(404, 'Not found.');
  const visible =
    u.role === 'director' ||
    (u.role === 'manager' && (await inScope(u, t.company_id))) ||
    (u.role === 'employee' && t.assignee_id === u.id) ||
    (u.role === 'client' && (await inScope(u, t.company_id)));
  if (!visible) throw new HttpError(404, 'Not found.');
  return t;
}

/** Who may assign, grant access, and approve: a Director, or the manager who reviews or created the task. */
export function isTaskOwner(u: SessionUser, t: TaskDoc): boolean {
  return u.role === 'director' || (u.role === 'manager' && (t.reviewer_id === u.id || t.created_by === u.id));
}

// shortcut: loads every user/company to resolve names (no joins in Firestore); fine for one firm, page or cache past a few thousand.
export async function userNames(): Promise<Map<string, UserDoc>> {
  return new Map((await query<UserDoc>(C.users)).map((u) => [u.id, u]));
}
export async function companyMap(): Promise<Map<string, CompanyDoc>> {
  return new Map((await query<CompanyDoc>(C.companies)).map((c) => [c.id, c]));
}
