/**
 * src/lib/nav.ts — URL builders, ported (not imported) from Messenger-bot's
 * services/branches.ts (§2.2). Pure, dependency-free.
 *
 * The booking stores ONLY coordinates. Both nav links are re-derived from
 * delivery_lat/lng on every read — a frozen URL goes stale (R20, the v13 bug).
 */

export function buildWazeAppUrl(lat: number, lng: number): string {
  return `waze://?ll=${lat},${lng}&navigate=yes`;
}

export function buildWazeUrl(lat: number, lng: number): string {
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

export function buildGoogleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** Nav object for API reads — always derived, never stored (§10.6.7). */
export function buildNav(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null; // "unset" — open water (§6.5.3)
  return {
    waze_app: buildWazeAppUrl(lat, lng),
    waze_https: buildWazeUrl(lat, lng),
    google: buildGoogleMapsUrl(lat, lng),
  };
}

/** Legacy Waze-line stripping regexes, ported from services/orders.ts (§2.2). */
export function stripNavLines(text: string): string {
  return String(text || '')
    .replace(/📍\s*Navigate[^\n]*/gi, '')
    .replace(/https?:\/\/[^\s]*waze\.com[^\s]*/gi, '')
    .replace(/waze:\/\/[^\s]*/gi, '')
    .replace(/;;;WAZE=.*/s, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
