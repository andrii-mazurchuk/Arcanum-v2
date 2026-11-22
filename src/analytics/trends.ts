// Tier rule (S-153): the one shared judgement of elevated, high and spike. A period's minor-unit
// total x is compared against the sum S of n baseline periods by cross-multiplication, so no
// division and no rounding ever take place. Trends, the health signal and both reports call
// tierOf; none restates a threshold.

export const TIERS = ['elevated', 'high', 'spike'] as const;
export type Tier = (typeof TIERS)[number];

// x and baselineSum are minor units of the display currency; a baseline period without spending
// contributes 0 to baselineSum and still counts in n.
export function tierOf(x: bigint, baselineSum: bigint, n: number): Tier | null {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`tierOf: n must be a whole number >= 1, got ${n}`);
  if (x < 0n) throw new RangeError(`tierOf: x must not be negative, got ${x}`);
  if (baselineSum < 0n) throw new RangeError(`tierOf: baselineSum must not be negative, got ${baselineSum}`);
  if (baselineSum === 0n) return null;
  const N = BigInt(n);
  if (x * N >= 3n * baselineSum) return 'spike';
  if (x * N >= 2n * baselineSum) return 'high';
  if (2n * x * N >= 3n * baselineSum) return 'elevated';
  return null;
}
