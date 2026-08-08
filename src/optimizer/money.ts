const CENTS = 100;

// Bids and budgets are Decimal(12,2) in Postgres; every value we hand to a platform adapter or
// store must already be representable there, otherwise the DB rounds behind our back and the
// guardrail arithmetic we asserted on is no longer the value that was applied.
export function roundMoney(value: number): number {
  return Math.round(value * CENTS) / CENTS;
}

/** Rounds down, so a clamped upper bound can never be exceeded by the rounding itself. */
export function floorMoney(value: number): number {
  return Math.floor(value * CENTS) / CENTS;
}

/** Rounds up, so a clamped lower bound can never be undercut by the rounding itself. */
export function ceilMoney(value: number): number {
  return Math.ceil(value * CENTS) / CENTS;
}

export function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function formatRatio(value: number): string {
  return value.toFixed(2);
}

export function formatPercent(share: number): string {
  return (share * CENTS).toFixed(2);
}
