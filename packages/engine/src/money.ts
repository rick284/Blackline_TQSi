import Decimal from "decimal.js";

/** Decimal arithmetic for all money and quantities. Never use JS floats. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

export const ZERO = new D(0);

/** Money is rounded half-up to whole cents. */
export function cents(x: Decimal.Value): Dec {
  return new D(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sum(xs: Iterable<Dec>): Dec {
  let t = ZERO;
  for (const x of xs) t = t.plus(x);
  return t;
}

/**
 * Split `total` (in cents) across `weights` in proportion, so the parts add
 * back to the total exactly. Largest-remainder method; ties go to the earlier item.
 */
export function allocate(total: Dec, weights: Dec[]): Dec[] {
  const w = sum(weights);
  if (weights.length === 0) return [];
  if (w.isZero()) return weights.map(() => ZERO);
  const totalCents = total.times(100).toDecimalPlaces(0);
  const raw = weights.map((x) => totalCents.times(x).div(w));
  const floors = raw.map((r) => r.floor());
  let left = totalCents.minus(sum(floors)).toNumber();
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(floors[i]!) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  const out = floors.slice();
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = out[i]!.plus(1);
    left--;
  }
  return out.map((c) => c.div(100));
}
