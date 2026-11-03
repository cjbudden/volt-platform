// ============================================================================
//  ESTIMATED AGAINST ACTUAL: the platform's cost comparison (system admin only,
//  /api/platform/costs/comparison). Moved here from fleet/relays.ts when the
//  relay tier was removed (build queue 2.1c-2): only compute is estimated now.
// ============================================================================
import { query } from '../../db';

export interface CostComparison {
  periodMonth: string;
  category: string;
  estimatedUsd: number;
  actualUsd: number | null;
  varianceUsd: number | null;
  variancePct: number | null;
  /** True when any rate feeding the estimate was still indicative. */
  indicative: boolean;
}

/**
 * ESTIMATED AGAINST ACTUAL, which is the entire reason for accruing anything.
 *
 * Every figure the fleet produces is an estimate: observed seconds multiplied by
 * a rate somebody typed in. The invoice at the end of the month is the other
 * side, and without both in one place the estimate can never be checked and
 * therefore never improves. A platform that has been quietly 40% under for six
 * months should be able to discover that in one screen.
 *
 * `actualUsd` is null when nobody has entered the bill yet. That is honestly
 * different from a variance of zero, and the two must never render the same.
 */
export async function costComparison(months = 6): Promise<CostComparison[]> {
  const est = await query<any>(
    `SELECT date_trunc('month', from_at)::date AS period_month, 'compute' AS category,
            COALESCE(sum(est_usd), 0) AS est, bool_or(indicative) AS indicative
       FROM usage_accruals
      WHERE from_at >= date_trunc('month', now()) - make_interval(months => $1)
      GROUP BY 1`,
    [months]
  );
  const actuals = await query<any>(
    `SELECT period_month, category, usd FROM cost_actuals
      WHERE period_month >= date_trunc('month', now())::date - make_interval(months => $1)`,
    [months]
  );
  const key = (p: any, c: string) => `${new Date(p).toISOString().slice(0, 10)}|${c}`;
  const actualBy = new Map(actuals.map((a) => [key(a.period_month, a.category), Number(a.usd)]));

  return est.map((e) => {
    const estimated = Number(e.est);
    const actual = actualBy.get(key(e.period_month, e.category)) ?? null;
    return {
      periodMonth: new Date(e.period_month).toISOString().slice(0, 10),
      category: e.category,
      estimatedUsd: estimated,
      actualUsd: actual,
      varianceUsd: actual == null ? null : Number((actual - estimated).toFixed(2)),
      // Guarded: an estimate of zero with a real bill against it is an infinite
      // percentage, which is true and useless. Null says "no meaningful ratio".
      variancePct: actual == null || estimated === 0
        ? null
        : Number((((actual - estimated) / estimated) * 100).toFixed(1)),
      indicative: !!e.indicative,
    };
  }).sort((a, b) => (a.periodMonth === b.periodMonth
    ? a.category.localeCompare(b.category)
    : b.periodMonth.localeCompare(a.periodMonth)));
}
