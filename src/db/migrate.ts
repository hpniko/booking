/**
 * Boot-time migration — additive, idempotent, NON-FATAL (§5.4).
 *
 * Runs migrations/001_bk_init.sql (the same file pasted into the Supabase SQL
 * Editor). Every statement is IF NOT EXISTS, so running it any number of times,
 * before or after the SQL-Editor paste, is safe.
 *
 * Boundary guard (§0.4, §5.2): before executing, every CREATE/ALTER/INDEX in
 * the file must reference `bk_` objects only. A statement touching a non-bk_
 * table aborts the migration with a loud error — it never runs.
 *
 * Also seeds: default bk_settings, the first MANAGER (from env, once), and
 * ensures exactly one OPEN dispatch day exists.
 */
import * as fs from 'fs';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import { getPool, q, q1 } from './pg';

const TABLE_RE = /\b(?:CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)?\s+\S+\s+ON|CREATE TABLE IF NOT EXISTS|ALTER TABLE(?: IF EXISTS)?)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Assert every object the migration writes to starts with bk_ (§0.4 rule 1/3).
 * Returns a list of violations — empty means the file is safe to run.
 */
export function boundaryViolations(sql: string): string[] {
  const bad: string[] = [];
  // strip comments so prose mentioning `admins` etc. is not flagged
  const code = sql.replace(/--[^\n]*/g, '');
  let m: RegExpExecArray | null;
  TABLE_RE.lastIndex = 0;
  while ((m = TABLE_RE.exec(code)) !== null) {
    const name = m[1];
    if (!name.startsWith('bk_')) bad.push(name);
  }
  const destructive = code.match(/\bDROP TABLE\b|\bTRUNCATE\b|\bRENAME TO\b/gi);
  if (destructive) bad.push(...destructive.map((k) => `forbidden keyword: ${k}`));
  return [...new Set(bad)];
}


/** Default bk_settings — only inserted when the key does not exist yet. */
const DEFAULT_SETTINGS: Record<string, string> = {
  commission_rate: '15',
  booking_commission_enabled: '1',
  booking_currency_symbol: '₱',
  booking_show_rider_earnings: '1',
  store_label: 'Postre',
  day_cutoff_hour: '4',
  auto_rollover: '1',
  store_timezone: 'Asia/Manila',
  booking_max_concurrent: '1',
  booking_auto_reject_others_on_approve: '1',
  booking_heartbeat_ms: '20000',
  booking_presence_ttl_s: '60',
  booking_sweep_ms: '30000',
  booking_history_page_size: '25',
  booking_open_jobs_show_address: '0',
  notify_new_job: '1',
  notify_request_received: '1',
  notify_request_approved: '1',
  notify_assigned: '1',
  notify_job_status: '1',
  notify_payout: '1',
  push_chat_booking_cards: '1',
  push_chat_mentions: '1',
  push_chat_enabled: '1',
};

async function seedSettings(): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q(
      'INSERT INTO bk_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value],
    );
  }
}

/** Bootstrap the first MANAGER from env — the only way in over HTTP is a manager. */
async function bootstrapManager(): Promise<void> {
  const existing = await q1("SELECT id FROM bk_users WHERE role = 'MANAGER' LIMIT 1");
  if (existing) return;
  const username = process.env.BK_ADMIN_USERNAME || 'manager';
  const password = process.env.BK_ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      '[migrate] ⚠ No MANAGER exists and BK_ADMIN_PASSWORD is missing/too short (<8 chars). ' +
      'Set it and restart to create the initial manager.',
    );
    return;
  }
  await q(
    `INSERT INTO bk_users (username, password_hash, role, full_name, is_active, password_reset_required)
     VALUES ($1, $2, 'MANAGER', $3, 1, 1)`,
    [username, bcrypt.hashSync(password, 10), 'Manager'],
  );
  console.warn(
    '[migrate] ═══════════════════════════════════════════════════════════\n' +
    `[migrate]  INITIAL MANAGER CREATED: ${username}\n` +
    '[migrate]  Change this password now (login → Profile → Change password).\n' +
    '[migrate] ═══════════════════════════════════════════════════════════',
  );
}

function migrationPath(): string {
  // works from src/ (tsx) and dist/ (compiled): both are one level under repo root
  const candidates = [
    path.join(__dirname, '..', '..', 'migrations', '001_bk_init.sql'),
    path.join(process.cwd(), 'migrations', '001_bk_init.sql'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('migrations/001_bk_init.sql not found');
}

/** Verify the bk_* tables we expect to own exist; warn loudly about missing ones (§5.2). */
async function boundaryGuard(): Promise<void> {
  const expected = [
    'bk_users', 'bk_settings', 'bk_riders', 'bk_dispatch_days', 'bk_bookings',
    'bk_booking_requests', 'bk_booking_events', 'bk_rider_presence',
    'bk_booking_devices', 'bk_booking_sessions', 'bk_app_releases',
    'bk_rider_payouts', 'bk_commission_ledger', 'bk_chat_messages',
  ];
  const rows = await q<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'bk\\_%'",
  );
  const have = new Set(rows.map((r) => r.table_name));
  const missing = expected.filter((t) => !have.has(t));
  if (missing.length) console.error(`[migrate] ⚠ MISSING bk_* tables: ${missing.join(', ')}`);
}

/** Run the DDL. Never throws — a failure is logged, the app still boots (§5.4). */
export async function migrate(): Promise<boolean> {
  try {
    const file = migrationPath();
    const sql = fs.readFileSync(file, 'utf8');

    const violations = boundaryViolations(sql);
    if (violations.length) {
      console.error(
        `[migrate] 🚫 BOUNDARY VIOLATION in ${file} — non-bk_ objects: ${violations.join(', ')}. ` +
        'Migration ABORTED (§0.4).',
      );
      return false;
    }

    const client = await getPool().connect();
    try {
      // whole file in one simple query: the server parses dollar-quoted blocks
      // correctly, and an implicit transaction keeps it all-or-nothing
      await client.query(sql);
    } finally {
      client.release();
    }

    await seedSettings();
    await bootstrapManager();
    await boundaryGuard();
    console.log('[migrate] bk_* schema up to date');
    return true;
  } catch (err: any) {
    console.error(`[migrate] ⚠ migration failed (non-fatal, app still boots): ${err.message}`);
    return false;
  }
}


