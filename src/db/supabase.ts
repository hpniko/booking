/**
 * Supabase query-builder client (service key).
 *
 * Used for READ-ONLY convenience queries where no transaction is needed.
 * All writes go through src/db/pg.ts — see the note there.
 * This module never touches a table that does not start with `bk_` (§0.4).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function supa(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}
