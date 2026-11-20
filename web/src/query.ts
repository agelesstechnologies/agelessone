import { QueryClient } from '@tanstack/react-query';
import { ApiFailure } from './api';

/**
 * The shared cache of API answers (read with useApi in hooks.ts). An answer counts as fresh for 30 seconds, is kept
 * 5 minutes after the last screen that used it closes, and is read again when the browser tab gets focus or the
 * connection comes back.
 * A failed read is tried again (at most twice) only when the server could not be reached or had an error (5xx):
 * a 4xx answer (not allowed, not found, conflict, too many tries) will not change by asking again.
 * A request is sent even when the browser thinks it is offline, so the person sees "Cannot reach the server"
 * instead of a spinner that never ends. Changes (POST, PUT, PATCH, DELETE) are never repeated by the cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      networkMode: 'always',
      // networkMode 'always' turns this off by default; field staff on a weak connection need the screen refreshed
      // as soon as the connection is back
      refetchOnReconnect: true,
      retry: (count, err) => !(err instanceof ApiFailure && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: 0 },
  },
});

/**
 * The cache key of an API path: 'api', the path's parts, then its query values (left out when there are none).
 * '/hrms/leave/requests?status=submitted' -> ['api', 'hrms', 'leave', 'requests', { status: 'submitted' }],
 * so invalidate('/hrms/leave') reaches every leave answer.
 */
export function apiKey(path: string): unknown[] {
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const key: unknown[] = ['api', ...pathname.split('/').filter(Boolean)];
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(q < 0 ? '' : path.slice(q + 1))) {
    const had = query[k];
    query[k] = had === undefined ? v : [...(Array.isArray(had) ? had : [had]), v];   // ?a=1&a=2 keeps both
  }
  if (Object.keys(query).length) key.push(query);
  return key;
}

/**
 * After a change: every cached answer under these paths is read again (now, if a screen shows it; else when one does).
 * invalidate('/hrms/leave') refreshes all leave answers; a query string in a path is ignored.
 * Await it to wait until the screens shown have their new answers (a failed read does not throw here).
 */
export async function invalidate(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => queryClient.invalidateQueries({ queryKey: apiKey(path.split('?')[0]!) })));
}
