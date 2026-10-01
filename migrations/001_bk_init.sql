-- ═══════════════════════════════════════════════════════════════════════════════
-- 001_bk_init.sql — Postre Live Booking App (STANDALONE, §0)
--
-- Paste this file into the Supabase SQL Editor ONCE before first deploy.
-- The same statements run at boot from src/db/migrate.ts (idempotent).
--
-- HARD RULES (§0.4):
--   1. Every object created here starts with `bk_`. Never touch a non-bk_ table.
--   2. Strictly additive: IF NOT EXISTS only. No DROP / TRUNCATE / RENAME.
--   3. RLS is enabled only on NEW bk_* tables.
--   4. Messenger-bot's 28 tables are never read, never written, never altered.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── bk_001: our own identity + settings (NOT `admins`, NOT `app_settings`) ─────

CREATE TABLE IF NOT EXISTS bk_users (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'RIDER',
  full_name      TEXT NOT NULL,
  phone          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  password_reset_required INTEGER NOT NULL DEFAULT 0,
  last_login_at  TIMESTAMPTZ,
  created_by     INTEGER REFERENCES bk_users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bk_users_role ON bk_users(role, is_active);

CREATE TABLE IF NOT EXISTS bk_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── bk_002: riders (dispatch profile; credentials live in bk_users) ────────────

CREATE TABLE IF NOT EXISTS bk_riders (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES bk_users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  phone      TEXT,
  vehicle    TEXT,
  plate      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  notes      TEXT,
  created_by INTEGER REFERENCES bk_users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_bk_riders_active ON bk_riders(is_active);

-- ── bk_003: ONE branch, ONE dispatch day at a time (§6.1.1) ────────────────────

CREATE TABLE IF NOT EXISTS bk_dispatch_days (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date_ref        TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN',
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  closed_by       INTEGER REFERENCES bk_users(id),
  totals_snapshot TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_bk_days_status ON bk_dispatch_days(status, date_ref DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_days_one_open
  ON bk_dispatch_days ((status)) WHERE status = 'OPEN';
-- ── bookings ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bk_bookings (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref               TEXT UNIQUE NOT NULL,
  day_id            INTEGER NOT NULL REFERENCES bk_dispatch_days(id),
  status            TEXT NOT NULL DEFAULT 'PENDING',
  priority          TEXT NOT NULL DEFAULT 'NORMAL',
  source            TEXT NOT NULL DEFAULT 'PASTE',

  -- THE ONLY TWO NUMBERS WE PARSE (§6.5)
  total             INTEGER NOT NULL DEFAULT 0,
  delivery_fee      INTEGER NOT NULL DEFAULT 0,

  -- Drop-off pin from the paste. The URL is NEVER stored — only the numbers.
  delivery_lat      DOUBLE PRECISION,
  delivery_lng      DOUBLE PRECISION,
  pin_source        TEXT,

  customer_name     TEXT,
  customer_phone    TEXT,
  notes             TEXT,
  details_text      TEXT,

  payment_status    TEXT NOT NULL DEFAULT 'UNPAID',
  assigned_rider_id INTEGER REFERENCES bk_riders(id) ON DELETE SET NULL,
  assigned_at       TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ,
  picked_up_at      TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_by        INTEGER REFERENCES bk_users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- money snapshot (§6.6.1): rate frozen at creation, never recomputed later
  commission_rate   NUMERIC(5,2),
  food_value        INTEGER NOT NULL DEFAULT 0,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  rider_payout      INTEGER NOT NULL DEFAULT 0,
  commission_paid_at TIMESTAMPTZ,
  commission_paid_by INTEGER REFERENCES bk_users(id),

  -- archive, never hard-delete (§6.10.1)
  archived_at       TIMESTAMPTZ,
  archived_by       INTEGER REFERENCES bk_users(id),
  archive_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_status   ON bk_bookings(status);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_day      ON bk_bookings(day_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_dayref   ON bk_bookings(day_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_rider    ON bk_bookings(assigned_rider_id);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_created  ON bk_bookings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bk_bookings_pin      ON bk_bookings(delivery_lat, delivery_lng)
  WHERE delivery_lat IS NOT NULL;

-- Rider claim on an unassigned booking. MANY riders may request the SAME booking.
CREATE TABLE IF NOT EXISTS bk_booking_requests (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bk_bookings(id) ON DELETE CASCADE,
  rider_id    INTEGER NOT NULL REFERENCES bk_riders(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'PENDING',
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES bk_users(id),
  UNIQUE(booking_id, rider_id)
);
CREATE INDEX IF NOT EXISTS idx_bk_breq_booking_status ON bk_booking_requests(booking_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_breq_rider         ON bk_booking_requests(rider_id, status);

-- Immutable audit timeline — the full cross-entity ledger (§6.10.2).
CREATE TABLE IF NOT EXISTS bk_booking_events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id INTEGER REFERENCES bk_bookings(id) ON DELETE CASCADE,
  entity     TEXT,
  type       TEXT NOT NULL,
  message    TEXT,
  actor_type TEXT,
  actor_id   INTEGER,
  actor_name TEXT,
  from_status TEXT,
  to_status  TEXT,
  amount_delta INTEGER,
  visible_to_rider INTEGER NOT NULL DEFAULT 1,
  meta       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bk_bevents_booking ON bk_booking_events(booking_id, id);
CREATE INDEX IF NOT EXISTS idx_bk_bevents_type    ON bk_booking_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_bk_bevents_actor   ON bk_booking_events(actor_type, actor_id, created_at);
-- ── live presence: one row per rider PER DEVICE INSTALL (§4.5) ─────────────────

CREATE TABLE IF NOT EXISTS bk_rider_presence (
  rider_id     INTEGER NOT NULL REFERENCES bk_riders(id) ON DELETE CASCADE,
  instance_id  TEXT NOT NULL,
  platform     TEXT,
  app_version  TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_id, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_bk_presence_seen ON bk_rider_presence(last_seen_at);

-- Push subscriptions, scoped by audience.
CREATE TABLE IF NOT EXISTS bk_booking_devices (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id     INTEGER REFERENCES bk_riders(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES bk_users(id) ON DELETE CASCADE,
  audience     TEXT NOT NULL DEFAULT 'MANAGER',
  endpoint     TEXT UNIQUE NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bk_bdev_audience ON bk_booking_devices(audience);

-- Refresh tokens: opaque, single-use (rotated on every use).
CREATE TABLE IF NOT EXISTS bk_booking_sessions (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id      INTEGER REFERENCES bk_riders(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES bk_users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bk_sessions_user ON bk_booking_sessions(user_id);

-- APK version published to the in-app "Download update" button.
CREATE TABLE IF NOT EXISTS bk_app_releases (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version    TEXT NOT NULL,
  build_no   INTEGER NOT NULL DEFAULT 1,
  apk_url    TEXT NOT NULL,
  notes      TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── money: payout + commission ledgers (§6.6) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS bk_rider_payouts (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id      INTEGER NOT NULL REFERENCES bk_riders(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,
  method        TEXT NOT NULL DEFAULT 'CASH',
  reference     TEXT,
  period_from   TEXT,
  period_to     TEXT,
  note          TEXT,
  booking_ids   TEXT,
  is_void       INTEGER NOT NULL DEFAULT 0,
  void_reason   TEXT,
  voided_at     TIMESTAMPTZ,
  created_by    INTEGER REFERENCES bk_users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bk_payouts_rider ON bk_rider_payouts(rider_id, created_at);

CREATE TABLE IF NOT EXISTS bk_commission_ledger (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bk_bookings(id) ON DELETE CASCADE,
  rider_id    INTEGER REFERENCES bk_riders(id) ON DELETE SET NULL,
  amount      INTEGER NOT NULL,
  basis_food  INTEGER NOT NULL,
  rate        NUMERIC(5,2) NOT NULL,
  day_id      INTEGER REFERENCES bk_dispatch_days(id),
  period      TEXT,
  status      TEXT NOT NULL DEFAULT 'ACCRUED',
  paid_at     TIMESTAMPTZ,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_comm_ledger_booking ON bk_commission_ledger(booking_id);
CREATE INDEX IF NOT EXISTS idx_bk_comm_ledger_rider   ON bk_commission_ledger(rider_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_comm_ledger_period  ON bk_commission_ledger(period, status);
CREATE INDEX IF NOT EXISTS idx_bk_comm_ledger_day     ON bk_commission_ledger(day_id);

-- ── team chat (§6.11) — single fixed room ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS bk_chat_messages (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id     INTEGER NOT NULL REFERENCES bk_users(id) ON DELETE CASCADE,
  sender_role   TEXT NOT NULL,
  sender_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'TEXT',
  booking_id    INTEGER REFERENCES bk_bookings(id) ON DELETE SET NULL,
  mentioned_ids TEXT,
  client_msg_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at     TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  deleted_by    INTEGER REFERENCES bk_users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_chat_client_msg
  ON bk_chat_messages(sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bk_chat_created ON bk_chat_messages(id DESC);

-- ── RLS defence-in-depth on our NEW tables only (service role bypasses it) ─────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bk_users','bk_settings','bk_riders','bk_dispatch_days','bk_bookings',
    'bk_booking_requests','bk_booking_events','bk_rider_presence',
    'bk_booking_devices','bk_booking_sessions','bk_app_releases',
    'bk_rider_payouts','bk_commission_ledger','bk_chat_messages'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;


