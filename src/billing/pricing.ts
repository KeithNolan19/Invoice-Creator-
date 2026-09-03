/** Subscription pricing. Plans carry a monthly price; a yearly subscription is
 *  12 months minus the platform's yearly discount. */

export type BillingInterval = "month" | "year";

/**
 * Resolve the amount charged per billing period.
 *   month -> the plan's monthly price
 *   year  -> monthly * 12 * (1 - discountPct/100), rounded to the nearest cent
 */
export function resolveAmountCents(
  monthlyCents: number,
  interval: BillingInterval,
  yearlyDiscountPct: number,
): number {
  if (interval === "month") return Math.round(monthlyCents);
  const gross = monthlyCents * 12;
  const net = gross * (1 - yearlyDiscountPct / 100);
  return Math.round(net);
}

/** The end of the current period, given its start and the interval. */
export function periodEnd(start: Date, interval: BillingInterval): Date {
  const end = new Date(start);
  if (interval === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1); // inclusive period end
  return end;
}

/** First day of the next period (= renewal date). */
export function nextPeriodStart(start: Date, interval: BillingInterval): Date {
  const next = new Date(start);
  if (interval === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}
