import type { Role } from './types.ts';

/** What a person may do with files. The director sets these per person in Masters; otherwise the role decides. */
export const RIGHTS = ['view', 'edit', 'download', 'delete', 'deleteFolder'] as const;
export type Right = (typeof RIGHTS)[number];
export type Rights = Record<Right, boolean>;

/**
 * Today's behaviour, so nothing changes until a director changes it. Client "delete" = their own uploads within 24 hours.
 * "deleteFolder" removes a whole folder (year, type, month or a made folder) with every file in it, so it is separate.
 */
export const ROLE_RIGHTS: Record<Role, Rights> = {
  director: { view: true, edit: true, download: true, delete: true, deleteFolder: true },
  manager: { view: true, edit: true, download: true, delete: false, deleteFolder: false },
  employee: { view: true, edit: false, download: true, delete: false, deleteFolder: false },
  client: { view: true, edit: false, download: true, delete: true, deleteFolder: false },
};

/** Directors always have every right (so the firm can never lock itself out); clients never edit or delete folders. */
export function rightsOf(u: { role: Role; rights?: Partial<Rights> | null }): Rights {
  if (u.role === 'director') return ROLE_RIGHTS.director;
  const r = { ...ROLE_RIGHTS[u.role], ...(u.rights ?? {}) };
  return u.role === 'client' ? { ...r, edit: false, deleteFolder: false } : r;
}
