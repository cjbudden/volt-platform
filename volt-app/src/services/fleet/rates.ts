// ============================================================================
//  WHAT AN HOUR COSTS.
//
//  Rates used to be three numbers inside services/billing.ts, labelled
//  indicative in a comment and unchangeable without a deploy. They are now
//  rows, effective-dated, and this module is the only thing that reads them.
//
//  THE RULE THAT MATTERS: SECONDS ARE A FACT, COST IS AN ESTIMATE, AND THE
//  FACT IS NEVER LOST TO THE ESTIMATE. If no rate can be found for an instance
//  type, the meter still records the seconds and records a null rate. It does
//  NOT skip the accrual and it does NOT substitute a plausible number. An
//  operator can price un-priced time later; they cannot recover time that was
//  never written down because we did not know what to charge for it.
//
//  Effective dating exists so that correcting a rate today does not silently
//  rewrite what was accrued last month. An accrual freezes the rate it used
//  onto its own row, so this lookup is only ever consulted for the window
//  being accrued now.
// ============================================================================
import { query } from '../../db';

export interface Rate {
  usdPerHour: number | null;
  indicative: boolean;
}

/** Nothing known. Explicit rather than a zero, which would read as "free". */
export const UNPRICED: Rate = { usdPerHour: null, indicative: true };

/**
 * The most specific rate in force at `at`.
 *
 * Region is matched loosely on purpose: a row with a NULL region is a global
 * default, and a region-specific row beats it. Ordering by `region IS NULL`
 * puts the specific row first without needing two queries.
 */
export async function rateFor(
  instanceType: string | null | undefined,
  lifecycle: 'spot' | 'on_demand' | null | undefined,
  region: string | null | undefined,
  at: Date = new Date(),
): Promise<Rate> {
  if (!instanceType) return UNPRICED;
  const rows = await query<{ usd_per_hour: string; indicative: boolean }>(
    `SELECT usd_per_hour, indicative
       FROM compute_rates
      WHERE instance_type = $1
        AND lifecycle = COALESCE($2, 'on_demand')
        AND (region IS NULL OR region = $3)
        AND effective_from <= $4
      ORDER BY (region IS NULL), effective_from DESC
      LIMIT 1`,
    [instanceType, lifecycle ?? null, region ?? null, at]
  );
  const r = rows[0];
  if (!r) return UNPRICED;
  return { usdPerHour: Number(r.usd_per_hour), indicative: r.indicative };
}

/**
 * Cost of a window, or null when the window cannot be priced.
 *
 * Rounded to six decimal places because a 30-second window on a cheap box is
 * worth well under a cent, and rounding those to the penny at accrual time
 * would round a month of them to zero. Presentation rounds; the ledger does
 * not.
 */
export function costOf(seconds: number, usdPerHour: number | null): number {
  if (usdPerHour == null) return 0;
  return Math.round((seconds / 3600) * usdPerHour * 1e6) / 1e6;
}
