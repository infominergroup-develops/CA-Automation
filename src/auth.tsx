import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type Role = 'director' | 'manager' | 'employee' | 'client';
export type Rights = { view: boolean; edit: boolean; download: boolean; delete: boolean; deleteFolder: boolean };

/** The role's file rights (same table as server/firestore/rights.ts), for servers that do not send them. */
const ROLE_RIGHTS: Record<Role, Rights> = {
  director: { view: true, edit: true, download: true, delete: true, deleteFolder: true },
  manager: { view: true, edit: true, download: true, delete: false, deleteFolder: false },
  employee: { view: true, edit: false, download: true, delete: false, deleteFolder: false },
  client: { view: true, edit: false, download: true, delete: true, deleteFolder: false },
};

export interface Me {
  user: { id: string; role: Role; name: string; email: string | null; mobile: string | null; rights?: Rights } | null;
  needsConsent?: boolean;
  needsMonitoringAck?: boolean;
  noticeVersion?: string;
  firmName?: string;
  /** Absent on servers that have every feature. */
  features?: { tally?: boolean; clientMaster?: boolean };
  /** Clients sign in with a firm-set password (one-time codes are off). */
  clientPassword?: boolean;
}

interface AuthCtx {
  me: Me | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      setMe({ user: null });
    }
  }, []);
  // Signed out, /auth/me still says how the login page should look (e.g. client password sign-in).
  const logout = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    await refresh();
  }, [refresh]);

  useEffect(() => {
    refresh();
    const expired = () => { refresh(); };
    window.addEventListener('session-expired', expired);
    window.addEventListener('refresh-me', refresh);
    return () => {
      window.removeEventListener('session-expired', expired);
      window.removeEventListener('refresh-me', refresh);
    };
  }, [refresh]);

  return <Ctx.Provider value={{ me, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
export const useUser = () => useContext(Ctx).me!.user!;
/** What the signed-in person may do with files (set by the director in Masters, or their role's default). */
export const useRights = (): Rights => { const u = useUser(); return { ...ROLE_RIGHTS[u.role], ...u.rights }; };
/** Tally sync and reports, unless the server says they are not available. */
export const useHasTally = () => useContext(Ctx).me?.features?.tally !== false;
/** The director's client master (work types, client groups, employee access); on the Firestore server only. */
export const useHasClientMaster = () => useContext(Ctx).me?.features?.clientMaster === true;
export const useClientPassword = () => useContext(Ctx).me?.clientPassword === true;
export const isStaff = (r: Role) => r !== 'client';
export const isManagerial = (r: Role) => r === 'director' || r === 'manager';
