/**
 * Reverse geocoding (coordinates → a readable address), behind one small adapter. Which provider, its address and its
 * key come from settings (backend/.env), never from code:
 *   GEOCODING_PROVIDER = none (default) | nominatim | google
 *   GEOCODING_URL      = the provider's base URL (optional; e.g. your own Nominatim server)
 *   GEOCODING_API_KEY  = the key (google needs one)
 *   GEOCODING_TIMEOUT_MS = how long to wait (default 3000)
 * Never log coordinates or addresses (CLAUDE.md rule 7): errors say what failed, not where.
 */
export type GeocodingProvider = 'none' | 'nominatim' | 'google';

export interface GeocodingSettings { provider: GeocodingProvider; url?: string; apiKey?: string; timeoutMs: number }

export type GeocodeResult =
  | { status: 'found'; address: string; provider: GeocodingProvider }
  | { status: 'not_configured' }
  | { status: 'failed'; reason: string };

/** The settings as they are now (read on every call, so a change of backend/.env applies after a restart, and tests can set them). */
export function geocodingSettings(env: NodeJS.ProcessEnv = process.env): GeocodingSettings {
  const p = (env.GEOCODING_PROVIDER ?? 'none').trim().toLowerCase();
  const provider: GeocodingProvider = p === 'nominatim' || p === 'google' ? p : 'none';
  return { provider, url: env.GEOCODING_URL?.trim() || undefined, apiKey: env.GEOCODING_API_KEY?.trim() || undefined,
    timeoutMs: Number(env.GEOCODING_TIMEOUT_MS) > 0 ? Number(env.GEOCODING_TIMEOUT_MS) : 3000 };
}

/** One lookup. Never throws: a timeout, an HTTP error or an empty answer is { status: 'failed' }. */
export async function reverseGeocode(latitude: number, longitude: number, s: GeocodingSettings = geocodingSettings()): Promise<GeocodeResult> {
  if (s.provider === 'none' || (s.provider === 'google' && !s.apiKey)) return { status: 'not_configured' };
  const url = s.provider === 'nominatim'
    ? `${s.url ?? 'https://nominatim.openstreetmap.org'}/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`
    : `${s.url ?? 'https://maps.googleapis.com'}/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${encodeURIComponent(s.apiKey!)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ageless-platform', Accept: 'application/json' }, signal: AbortSignal.timeout(s.timeoutMs) });
    if (!res.ok) return { status: 'failed', reason: `HTTP ${res.status}` };
    const body = await res.json() as { display_name?: string; status?: string; results?: { formatted_address?: string }[] };
    const address = s.provider === 'nominatim' ? body.display_name : body.status === 'OK' ? body.results?.[0]?.formatted_address : undefined;
    if (!address?.trim()) return { status: 'failed', reason: 'no address in the answer' };
    return { status: 'found', address: address.trim().slice(0, 500), provider: s.provider };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error' };
  }
}
