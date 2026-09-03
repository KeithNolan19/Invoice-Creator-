/** Subscription pricing + period math.
 *
 *  A plan has a `base_interval` (day | month) and a `base_amount_cents`.
 *  A subscription picks a `billing_interval`:
 *    - a `day` plan  -> only `day`
 *    - a `month` plan -> `month` (base price) or `year` (12 months − discount)
 */

export type PlanInterval = "day" | "month";
export type BillingInterval = "day" | "month" | "year";

export function intervalAllowedForPlan(planBase: PlanInterval, billing: BillingInterval): boolean {
  return planBase === "day" ? billing === "day" : billing === "month" || billing === "year";
}

/** Amount charged per billing period. */
export function resolveAmountCents(
  baseAmountCents: number,
  planBase: PlanInterval,
  billing: BillingInterval,
  yearlyDiscountPct: number,
): number {
  if (!intervalAllowedForPlan(planBase, billing)) {
    throw new Error(`billing interval "${billing}" is not valid for a "${planBase}" plan`);
  }
  if (billing === "year") {
    return Math.round(baseAmountCents * 12 * (1 - yearlyDiscountPct / 100));
  }
  return Math.round(baseAmountCents); // day/day or month/month
}

/** Inclusive end date of the current period, given its start and cadence. */
export function periodEnd(start: Date, billing: BillingInterval): Date {
  const end = new Date(start);
  if (billing === "day") return toDateOnly(end); // a one-day period
  if (billing === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return toDateOnly(end);
}

/** First day of the next period (= the renewal date). */
export function nextPeriodStart(start: Date, billing: BillingInterval): Date {
  const next = new Date(start);
  if (billing === "day") next.setUTCDate(next.getUTCDate() + 1);
  else if (billing === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return toDateOnly(next);
}

function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
