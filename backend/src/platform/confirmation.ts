import { PunchConfirmation } from '@ageless/shared';

const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

/**
 * The confirmation a person sees after a punch: "Punched in at 09:02 IST on 05 Oct 2026, MG Road, Panaji". Without an
 * address yet it shows the coordinates; without a location it says so. Shown only to the person (never logged).
 */
export function punchConfirmation(what: string, at: Date, where: { address: string | null; latitude: number | null; longitude: number | null }): PunchConfirmation {
  const when = `${what} at ${TIME.format(at)} IST on ${DATE.format(at)}`;
  const place = where.address
    ?? (where.latitude !== null && where.longitude !== null ? `location ${where.latitude.toFixed(6)}, ${where.longitude.toFixed(6)} (address to follow)` : 'no location sent');
  return { message: `${when}, ${place}`, at: at.toISOString(), address: where.address, latitude: where.latitude, longitude: where.longitude };
}
