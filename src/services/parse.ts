/**
 * src/services/parse.ts — the paste parser (§6.5). Pure: no DB, no I/O.
 *
 * THREE things come out of the paste, and nothing else:
 *   1. Total:  (required — the manager types it if absent; never guessed)
 *   2. Df:     (0 when absent)
 *   3. Waze/Maps coordinates → the drop-off pin
 * Everything else stays in details_text verbatim. No name, phone, address,
 * date, time or item line is ever parsed.
 */
import { parsePeso } from '../lib/money';

export interface ParseResult {
  total: number | null;
  delivery_fee: number;
  has_df_line: boolean;
  lat: number | null;
  lng: number | null;
  has_pin: boolean;
  /** A Waze link was present but gave no usable coordinates → blocks Create (§6.5.4). */
  link_error: boolean;
  details_text: string;
}

const TOTAL_RE = /^\s*(💰\s*)?(grand\s+)?total\s*:?\s*/i;
const DF_RE = /^\s*(d\.?f\.?|delivery\s*(fee|charge))\s*:?\s*/i;

/** Last matching line wins (§6.5.2). */
export function extractTotal(raw: string): number | null {
  let found: number | null = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (TOTAL_RE.test(line)) {
      const rest = line.replace(TOTAL_RE, '');
      const n = parsePeso(rest);
      if (n != null) found = n;
    }
  }
  return found;
}

/** 0 when no Df line; a Df line with no readable number is ignored, not NaN. */
export function extractDf(raw: string): { value: number; found: boolean } {
  let value = 0;
  let found = false;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (DF_RE.test(line)) {
      const rest = line.replace(DF_RE, '');
      const n = parsePeso(rest);
      if (n != null) { value = n; found = true; }
    }
  }
  return { value, found };
}

function validPin(lat: unknown, lng: unknown): boolean {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return false;
  if (la === 0 && ln === 0) return false; // "unset" → open water (§6.5.3)
  return true;
}

function parseLL(s: string): { lat: number; lng: number } | null {
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return validPin(lat, lng) ? { lat, lng } : null;
}

/**
 * Pin extraction, in order of reliability (§6.5.3):
 *  1. ;;;WAZE={…} trailer (decoded JSON: .app / .https)
 *  2. any Waze URL (waze:// or https://waze.com)
 *  3. Google Maps URL (@lat,lng)
 *  4. geo: URI, or a bare lat, lng pair
 */
export function extractPin(raw: string): { lat: number | null; lng: number | null; link_error: boolean } {
  const text = String(raw ?? '');
  let sawLink = false;

  // 1. ;;;WAZE trailer
  const trailer = text.match(/;;;WAZE=([^\s]+)/);
  if (trailer) {
    sawLink = true;
    try {
      const decoded = decodeURIComponent(trailer[1]);
      const obj = JSON.parse(decoded);
      for (const candidate of [obj?.https, obj?.app]) {
        if (typeof candidate === 'string' && candidate) {
          const llParam = (candidate.match(/ll=([^&\s]+)/) || [])[1];
          const ll = llParam
            ? parseLL(decodeURIComponent(llParam).replace(/%2C/gi, ','))
            : parseLL(candidate);
          if (ll) return { lat: ll.lat, lng: ll.lng, link_error: false };
        }
      }
    } catch { /* fall through to URL scanning */ }
  }

  // 2. Waze URLs
  const wazeUrls = text.match(/(?:waze:\/\/[^\s]*|https?:\/\/[^\s]*waze\.com[^\s]*)/gi) || [];
  for (const u of wazeUrls) {
    sawLink = true;
    const decoded = (() => { try { return decodeURIComponent(u); } catch { return u; } })();
    const ll = parseLL((decoded.match(/ll=([^&\s]+)/) || [])[1] || decoded);
    if (ll) return { lat: ll.lat, lng: ll.lng, link_error: false };
  }

  // 3. Google Maps @lat,lng
  const gmaps = text.match(/https?:\/\/[^\s]*google\.[^\s]*maps[^\s]*/gi) || [];
  for (const u of gmaps) {
    sawLink = true;
    const decoded = (() => { try { return decodeURIComponent(u); } catch { return u; } })();
    const at = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (at && validPin(at[1], at[2])) return { lat: Number(at[1]), lng: Number(at[2]), link_error: false };
    const q = decoded.match(/[?&](?:q|center)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (q && validPin(q[1], q[2])) return { lat: Number(q[1]), lng: Number(q[2]), link_error: false };
  }

  // 4a. geo: URI
  const geo = text.match(/geo:([-\d.]+),([-\d.]+)/);
  if (geo && validPin(geo[1], geo[2])) return { lat: Number(geo[1]), lng: Number(geo[2]), link_error: false };

  // 4b. bare lat, lng pair (only when clearly a coordinate pair)
  const bare = text.match(/(?:^|[^\w.])(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/m);
  if (bare && validPin(bare[1], bare[2])) return { lat: Number(bare[1]), lng: Number(bare[2]), link_error: false };

  // a nav-looking link we could not read → blocks Create (§6.5.4)
  if (sawLink) return { lat: null, lng: null, link_error: true };
  return { lat: null, lng: null, link_error: false };
}

/** The whole pipeline (§6.5.1). details_text is the raw paste, byte-for-byte. */
export function parsePaste(raw: string): ParseResult {
  const text = String(raw ?? '');
  const total = extractTotal(text);
  const df = extractDf(text);
  const pin = extractPin(text);
  return {
    total,
    delivery_fee: df.value,
    has_df_line: df.found,
    lat: pin.lat,
    lng: pin.lng,
    has_pin: pin.lat != null && pin.lng != null,
    link_error: pin.link_error,
    details_text: text,
  };
}
