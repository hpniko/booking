/**
 * pg Pool for the booking app — parameterized queries only.
 * Capped at 5 (§5.2): two services share one Supabase pooler.
 * This is the ONLY database writer in the app: status + money transitions
 * require single transactions, which the Supabase query builder cannot do.
 */
import { Pool, types } from 'pg';

// int8 (count/sum) → JS number (all our sums fit in 2^53)
types.setTypeParser(20, (v) => parseInt(v, 10));
// numeric → string by default; parse to float for commission_rate reads
types.setTypeParser(1700, (v) => parseFloat(v));

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString: url, max: 5, statement_timeout: 15000 });
    pool.on('error', (err) => console.error('[pg] pool error:', err.message));
  }
  return pool;
}

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

export async function q1<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run fn inside a transaction. Any throw rolls everything back (§6.4). */
export async function tx<T>(fn: (client: { query: (t: string, p?: any[]) => Promise<any> }) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}
