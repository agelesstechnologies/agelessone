import { issuesText } from '@ageless/shared';

/** Talks to the backend under /api. Sends the sign-in token; a 401 signs the person out. */
export const API = (import.meta.env.VITE_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');

const TOKEN_KEY = 'ageless.token';
export type ApiError = { code?: string; message?: string; details?: unknown };

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

/** Plain answers when the server sends no message of its own (a proxy page, a crash before the API answered). */
const BY_STATUS: Record<number, string> = {
  400: 'The request was not accepted. Check the form and try again.',
  401: 'Your session has ended. Please sign in again.',
  403: 'You do not have permission to do this.',
  404: 'Not found: it may have been removed, or you cannot see it.',
  409: 'This was changed by someone else, or already exists. Reload and try again.',
  413: 'The upload is too large. Choose a smaller file.',
  429: 'Too many tries. Wait a little and try again.',
  500: 'Something went wrong on the server. Try again; if it keeps happening, tell support.',
  502: 'The server is not answering right now. Try again in a minute.',
  503: 'The server is busy or being updated. Try again in a minute.',
  504: 'The server took too long to answer. Try again.',
};
const OFFLINE = 'Cannot reach the server. Check your internet connection and try again.';

/** An error from the API, with its code (e.g. LEAVE_INSUFFICIENT_BALANCE), HTTP status and details. */
export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly api: ApiError) { super(message); }
}

/** The error a failed response becomes: the API's own message, else a plain one for its status. */
async function failure(response: Response): Promise<ApiFailure> {
  let e: ApiError = {};
  try { e = await response.json() as ApiError; } catch { /* not JSON: a proxy or server error page */ }
  let message = e.message || BY_STATUS[response.status] || (response.status >= 500 ? BY_STATUS[500]! : `The request failed (error ${response.status}).`);
  const retry = Number(response.headers.get('Retry-After'));
  if (response.status === 429 && retry > 0) message += ` (try again in ${retry < 90 ? `${retry} seconds` : `${Math.ceil(retry / 60)} minutes`})`;
  return new ApiFailure(message, response.status, e);
}

/** fetch, but a network failure (offline, server stopped, blocked) becomes a clear message instead of "Failed to fetch". */
async function send(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiFailure(OFFLINE, 0, { code: 'OFFLINE' });
  }
}

/** Text for any caught error, ready to show in a Notice. */
export const errText = (e: unknown): string => {
  if (e instanceof ApiFailure) return e.message;
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return OFFLINE;
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.';
};

/** A form's own check failed: which fields and what is wrong ("Title must have at least 3 characters"). */
export const formError = (error: { issues: { path: (string | number)[]; message: string }[] }, fallback = 'Check the form'): string =>
  error.issues.length ? issuesText(error.issues) : fallback;

type Options = Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit | null };

/** JSON in and out. Pass `json` for a JSON body, or `body: FormData` for a file upload. */
export async function api<T>(path: string, { json, headers, ...options }: Options = {}): Promise<T> {
  const token = getToken();
  const response = await send(`${API}${path}`, {
    ...options,
    body: json !== undefined ? JSON.stringify(json) : options.body,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401 && token && path !== '/auth/login') onUnauthorized();
    throw await failure(response);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Download a file the API sends (CSV, PDF) with the sign-in token, then save it in the browser. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  const response = await send(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw await failure(response);
  const match = /filename="?([^";]+)"?/.exec(response.headers.get('Content-Disposition') ?? '');
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url; a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
