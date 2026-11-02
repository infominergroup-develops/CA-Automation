import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type Role = 'director' | 'manager' | 'employee' | 'client';

export interface Me {
  user: { id: string; role: Role; name: string; email: string | null; mobile: string | null } | null;
  needsConsent?: boolean;
  needsMonitoringAck?: boolean;
  noticeVersion?: string;
  firmName?: string;
  /** Absent on servers that have every feature. */
  features?: { tally?: boolean };
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
  const logout = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    setMe({ user: null });
  }, []);

  useEffect(() => {
    refresh();
    const expired = () => setMe({ user: null });
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
/** Tally sync and reports, unless the server says they are not available. */
export const useHasTally = () => useContext(Ctx).me?.features?.tally !== false;
export const isStaff = (r: Role) => r !== 'client';
export const isManagerial = (r: Role) => r === 'director' || r === 'manager';
