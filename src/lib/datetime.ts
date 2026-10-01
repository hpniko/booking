/**
 * src/lib/datetime.ts — the ONE place day/month boundaries are computed (§6.10.7, R16).
 *
 * Never `new Date().toISOString().slice(0, 10)` (that is UTC — the Messenger-bot
 * bug we deliberately do not inherit). Every boundary goes through the store's
 * timezone (default Asia/Manila), so an 11:30 PM booking lands in the right day.
 * Timestamps we WRITE are always UTC ISO-8601 with Z so they sort lexicographically.
 */

const TZ_CACHE = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = TZ_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    TZ_CACHE.set(tz, f);
  }
  return f;
}

interface Zoned { y: number; mo: number; d: number; h: number; mi: number; s: number }

function zoned(date: Date, tz: string): Zoned {
  const parts = fmt(tz).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Intl can render hour '24' at midnight in some environments
  const h = get('hour') % 24;
  return { y: get('year'), mo: get('month'), d: get('day'), h, mi: get('minute'), s: get('second') };
}

/** The ONLY way we write a timestamp: UTC ISO-8601 with Z. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 'YYYY-MM-DD' in the STORE's day, never UTC's. */
export function todayInTz(tz = 'Asia/Manila', at: Date = new Date()): string {
  const z = zoned(at, tz);
  return `${z.y}-${String(z.mo).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
}

/** 'YYYY-MM' in the store's day — the commission ledger's `period`. */
export function monthInTz(tz = 'Asia/Manila', at: Date = new Date()): string {
  return todayInTz(tz, at).slice(0, 7);
}

/**
 * The dispatch date a moment belongs to (§6.1.1): before `cutoffHour` (store
 * local) the moment still belongs to YESTERDAY's dispatch day.
 */
export function dispatchDateInTz(cutoffHour: number, tz = 'Asia/Manila', at: Date = new Date()): string {
  const z = zoned(at, tz);
  const today = new Date(Date.UTC(z.y, z.mo - 1, z.d));
  if (z.h < cutoffHour) today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

/** UTC instant of store-local midnight for `date` → exclusive end is next local midnight. */
export function dayBounds(date: string, tz = 'Asia/Manila'): { fromIso: string; toIso: string } {
  const from = localMidnight(date, tz);
  const nextDate = new Date(`${date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const to = localMidnight(nextDate.toISOString().slice(0, 10), tz);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function localMidnight(date: string, tz: string): Date {
  // guess: treat the date as UTC midnight, measure the offset the store sees, adjust
  const guess = new Date(`${date}T00:00:00Z`);
  const z = zoned(guess, tz);
  const shown = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s);
  const offset = shown - guess.getTime(); // ms ahead of UTC
  return new Date(guess.getTime() - offset);
}

/** Store-local display 'YYYY-MM-DD HH:MM'. */
export function toStoreLocal(iso: string | Date | null | undefined, tz = 'Asia/Manila'): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  const z = zoned(d, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${z.y}-${p(z.mo)}-${p(z.d)} ${p(z.h)}:${p(z.mi)}`;
}

/** Store-local 'HH:MM' for timeline rows. */
export function timeInTz(iso: string | Date | null | undefined, tz = 'Asia/Manila'): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  const z = zoned(d, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(z.h)}:${p(z.mi)}`;
}

/** Store-local calendar date of a timestamp (for grouping history by day). */
export function dateInTz(iso: string | Date, tz = 'Asia/Manila'): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return todayInTz(tz, d);
}

/** Calendar arithmetic on a 'YYYY-MM-DD' string — never through a Date instant. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Store-local month bounds for a 'YYYY-MM' period — inclusive start, exclusive
 * end. Built from local midnights so a month always starts at 00:00 in the
 * STORE's timezone, whatever the server's own offset is.
 */
export function monthBounds(month: string, tz = 'Asia/Manila'): { fromIso: string; toIso: string } {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const nextFirst = m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { fromIso: localMidnight(first, tz).toISOString(), toIso: localMidnight(nextFirst, tz).toISOString() };
}
