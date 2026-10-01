/**
 * src/lib/money.ts — peso helpers and the ONLY computeSplit() in the system (§6.6.1).
 *
 * Rules:
 *  - Exactly two inputs from the outside world: total and deliveryFee.
 *  - commission = Math.round(foodValue × rate / 100) — rounded ONCE, server-side.
 *  - riderPayout = foodValue − commission — the two always sum back exactly.
 *  - All amounts are integer pesos (§6.6.5). No centavos anywhere.
 */

export interface Split {
  total: number;
  deliveryFee: number;
  foodValue: number;
  commission: number;
  riderPayout: number;
  rate: number;
}

/** Strip ₱, commas, spaces; parse the first number in a string → integer pesos. */
export function parsePeso(raw: string): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[₱,\s]/g, '');
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** THE money function. Pure. Never duplicated anywhere else. */
export function computeSplit(total: number, deliveryFee: number, ratePct: number): Split {
  const t = Math.round(Number(total));
  const df = Math.round(Number(deliveryFee));
  const rate = Number(ratePct) || 0;
  const foodValue = t - df;
  const commission = Math.round((foodValue * rate) / 100);
  const riderPayout = foodValue - commission;
  return { total: t, deliveryFee: df, foodValue, commission, riderPayout, rate };
}

/** Validation shared by parse-preview and create (§6.5.4). Returns error or null. */
export function validateMoney(total: number | null, deliveryFee: number | null): string | null {
  if (total == null || !Number.isFinite(total) || total <= 0) {
    return 'A booking total is required for commission';
  }
  const df = deliveryFee ?? 0;
  if (!Number.isFinite(df) || df < 0) return 'Df cannot be negative';
  if (df > total) return 'Df cannot exceed the booking total';
  if (total - df <= 0) return 'Total and Df leave no food value';
  return null;
}
