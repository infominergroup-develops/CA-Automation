import type { Role } from './types.ts';

/** What a person may do with files. The director sets these per person in Masters; otherwise the role decides. */
export const RIGHTS = ['view', 'edit', 'move', 'download', 'downloadFolder', 'delete', 'deleteFolder'] as const;
export type Right = (typeof RIGHTS)[number];
export type Rights = Record<Right, boolean>;

/**
 * Today's behaviour, so nothing changes until a director changes it. Client "delete" = their own uploads within 24 hours.
 * "edit" = accept a file or ask for a re-upload; "move" = move files to another year, folder or month.
 * "deleteFolder" removes a whole folder (year, type, month or a made folder) with every file in it, so it is separate.
 * "downloadFolder" saves a whole folder as one .zip.
 */
export const ROLE_RIGHTS: Record<Role, Rights> = {
  director: { view: true, edit: true, move: true, download: true, downloadFolder: true, delete: true, deleteFolder: true },
  manager: { view: true, edit: true, move: true, download: true, downloadFolder: true, delete: false, deleteFolder: false },
  employee: { view: true, edit: false, move: false, download: true, downloadFolder: false, delete: false, deleteFolder: false },
  client: { view: true, edit: false, move: false, download: true, downloadFolder: false, delete: true, deleteFolder: false },
};

/** Directors always have every right (so the firm can never lock itself out); clients never edit, move or delete folders. */
export function rightsOf(u: { role: Role; rights?: Partial<Rights> | null }): Rights {
  if (u.role === 'director') return ROLE_RIGHTS.director;
  const set = u.rights ?? {};
  // Rights set before "move" was its own right: moving came with edit.
  const r = { ...ROLE_RIGHTS[u.role], ...(set.edit !== undefined && set.move === undefined && { move: set.edit }), ...set };
  return u.role === 'client' ? { ...r, edit: false, move: false, deleteFolder: false } : r;
}
