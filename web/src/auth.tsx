import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LoginResponse, Me, RoleScope } from '@ageless/shared';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { queryClient } from './query';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;
  /** Reload who is signed in. */
  refresh: () => Promise<void>;
  /** Use a new token (after setting or resetting a password) and reload who is signed in. */
  adopt: (token: string) => Promise<void>;
  /** Does the signed-in person hold this permission (any scope)? The backend still checks every request. */
  can: (permission: string) => boolean;
  scopeOf: (permission: string) => RoleScope | null;
  /** More than their own records: employees (own scope only) do not see People or Roles & access. */
  seesOthers: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);
  const person = useRef<string | null>(null);

  // Forget the last page (sign-out and sign-in), so the address bar and the next session start clean.
  const resetPage = () => { try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ } };
  // Signing out (also after a 401), or a different person signing in, empties the cache of API answers,
  // so nothing loaded for the last person is ever shown to the next.
  const signedIn = useCallback((next: Me | null) => {
    const id = next?.person.publicId ?? null;
    if (id !== person.current) queryClient.clear();
    person.current = id;
    setMe(next);
  }, []);
  const logout = useCallback(() => { setToken(null); signedIn(null); resetPage(); }, [signedIn]);
  const refresh = useCallback(async () => { signedIn(await api<Me>('/auth/me')); }, [signedIn]);

  useEffect(() => { setUnauthorizedHandler(logout); }, [logout]);
  useEffect(() => {
    if (!getToken()) return;
    refresh().catch(() => setToken(null)).finally(() => setLoading(false));
  }, [refresh]);

  const adopt = useCallback(async (token: string) => { setToken(token); await refresh(); }, [refresh]);

  const login = useCallback(async (loginName: string, password: string) => {
    const r = await api<LoginResponse>('/auth/login', { method: 'POST', json: { login: loginName, password } });
    setToken(r.token);
    resetPage();
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(() => ({
    me, loading, login, logout, refresh, adopt,
    can: (p) => !!me?.permissions[p],
    scopeOf: (p) => me?.permissions[p] ?? null,
    seesOthers: me?.permissions['hrms.people.view'] === 'team' || me?.permissions['hrms.people.view'] === 'all' || !!me?.permissions['core.users.manage'],
  }), [me, loading, login, logout, refresh, adopt]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
