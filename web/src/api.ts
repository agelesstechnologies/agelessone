/** Talks to the backend under /api. Sends the sign-in token; a 401 signs the person out. */
export const API = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');

const TOKEN_KEY = 'ageless.token';
export type ApiError = { code?: string; message?: string; details?: { path: string; message: string }[] };

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

export const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

type Options = Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit | null };

/** JSON in and out. Pass `json` for a JSON body, or `body: FormData` for a file upload. */
export async function api<T>(path: string, { json, headers, ...options }: Options = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API}${path}`, {
    ...options,
    body: json !== undefined ? JSON.stringify(json) : options.body,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    let e: ApiError = {};
    try { e = await response.json() as ApiError; } catch { /* no JSON response */ }
    if (response.status === 401 && token && path !== '/auth/login') onUnauthorized();
    throw Object.assign(new Error(e.message || `Request failed (${response.status})`), { api: e, status: response.status });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
