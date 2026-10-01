/**
 * src/services/settings.ts — bk_settings key/value with a 60s cache (§6.6.4).
 * Deliberately NOT Messenger-bot's `app_settings` (§0.4 rule 2).
 */
import { q, q1 } from '../db/pg';

export const BOOKING_SETTING_KEYS = [
  'commission_rate', 'booking_commission_enabled', 'booking_currency_symbol',
  'booking_show_rider_earnings', 'store_label', 'day_cutoff_hour', 'auto_rollover',
  'store_timezone', 'booking_max_concurrent', 'booking_auto_reject_others_on_approve',
  'booking_heartbeat_ms', 'booking_presence_ttl_s', 'booking_sweep_ms',
  'booking_history_page_size', 'booking_open_jobs_show_address',
  'notify_new_job', 'notify_request_received', 'notify_request_approved',
  'notify_assigned', 'notify_job_status', 'notify_payout',
  'push_chat_booking_cards', 'push_chat_mentions', 'push_chat_enabled',
] as const;

export type BookingSettingKey = (typeof BOOKING_SETTING_KEYS)[number];

/**
 * Per-key validation. The Settings screen commits on blur, so a half-typed value
 * ("1" while the manager meant "15") would otherwise be persisted silently — on
 * commission_rate that is a money bug, not a cosmetic one. Returns an error
 * message, or null when the value is acceptable.
 */
const NUMERIC_RANGES: Record<string, [number, number]> = {
  commission_rate: [0, 100],
  booking_max_concurrent: [1, 50],
  booking_heartbeat_ms: [5000, 300000],
  booking_presence_ttl_s: [10, 3600],
  booking_sweep_ms: [5000, 600000],
  booking_history_page_size: [5, 200],
  day_cutoff_hour: [0, 23],
};

const MAX_TEXT_LEN = 64;

export function validateSetting(key: string, value: string): string | null {
  const range = NUMERIC_RANGES[key];
  if (range) {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n)) return 'Enter a number';
    if (n < range[0] || n > range[1]) return `Must be between ${range[0]} and ${range[1]}`;
    return null;
  }
  if (key === 'store_timezone') {
    const v = value.trim();
    if (!v) return 'Enter a timezone, e.g. Asia/Manila';
    try { new Intl.DateTimeFormat('en-CA', { timeZone: v }); }
    catch { return `"${v}" is not a valid IANA timezone`; }
    return null;
  }
  if (key === 'booking_currency_symbol') {
    if (!value.trim()) return 'Enter a currency symbol';
    if (value.length > 4) return 'Keep the symbol short (4 characters max)';
    return null;
  }
  if (value.length > MAX_TEXT_LEN) return `Keep it under ${MAX_TEXT_LEN} characters`;
  return null;
}

const CACHE_TTL = 60_000;
let cache: { at: number; map: Record<string, string> } | null = null;

export function invalidateSettingsCache(): void { cache = null; }

export async function allSettings(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.map;
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM bk_settings');
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  cache = { at: Date.now(), map };
  return map;
}

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const map = await allSettings();
  return map[key] ?? fallback;
}

export async function getNumber(key: string, fallback: number): Promise<number> {
  const v = await getSetting(key, String(fallback));
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function getBool(key: string, fallback = true): Promise<boolean> {
  const v = await getSetting(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}

/** Whitelisted write (§9.5). Unknown keys are rejected, never silently stored. */
export async function setSetting(key: string, value: string): Promise<void> {
  if (!(BOOKING_SETTING_KEYS as readonly string[]).includes(key)) {
    throw Object.assign(new Error(`Unknown setting: ${key}`), { status: 400 });
  }
  const bad = validateSetting(key, value);
  if (bad) throw Object.assign(new Error(`${key}: ${bad}`), { status: 400 });
  await q(
    `INSERT INTO bk_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
  invalidateSettingsCache();
}

export async function currentRate(): Promise<number> {
  const enabled = await getBool('booking_commission_enabled', true);
  if (!enabled) return 0;
  const rate = await getNumber('commission_rate', 15);
  return rate >= 0 && rate <= 100 ? rate : 15;
}

/** Write a SETTING_CHANGED audit row (§6.10.3, visible_to_rider = 0). */
export async function logSettingChange(
  key: string, oldValue: string, newValue: string,
  actor: { id: number; name: string },
): Promise<void> {
  await q(
    `INSERT INTO bk_booking_events (entity, type, message, actor_type, actor_id, actor_name, meta, visible_to_rider)
     VALUES ('SETTING', 'SETTING_CHANGED', $1, 'MANAGER', $2, $3, $4, 0)`,
    [`${key}: ${oldValue} → ${newValue}`, actor.id, actor.name, JSON.stringify({ key, from: oldValue, to: newValue })],
  );
}
