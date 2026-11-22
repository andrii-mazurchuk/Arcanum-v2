// Exact money arithmetic (S-16): ExactDecimal parsed from text as written, Fraction over bigint,
// and roundHalfAwayFromZero, the only rounding of money in the product. No binary
// floating-point number ever holds a rate or an amount.

export interface ExactDecimal {
  readonly digits: bigint;
  readonly scale: number; // value = digits / 10^scale, scale >= 0 integer
}

const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

// Keeps the scale as written: "41.10" -> {4110n, 2}. Anything outside the grammar
// (exponent, '+', spaces, ',', bare '.') -> null.
export function parseExactDecimal(text: string): ExactDecimal | null {
  if (!DECIMAL.test(text)) return null;
  const dot = text.indexOf('.');
  const scale = dot < 0 ? 0 : text.length - dot - 1;
  const digits = BigInt(dot < 0 ? text : text.slice(0, dot) + text.slice(dot + 1));
  return { digits, scale };
}

export function decimalToString(d: ExactDecimal): string {
  const neg = d.digits < 0n;
  const abs = (neg ? -d.digits : d.digits).toString();
  let body: string;
  if (d.scale === 0) {
    body = abs;
  } else {
    const padded = abs.padStart(d.scale + 1, '0');
    const cut = padded.length - d.scale;
    body = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
  }
  return neg ? `-${body}` : body;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

// Exact (a+b)/2: align both to s = max(scales), digits = (a'+b') * 5, scale = s + 1.
export function midpoint(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const s = Math.max(a.scale, b.scale);
  const sum = a.digits * pow10(s - a.scale) + b.digits * pow10(s - b.scale);
  return { digits: sum * 5n, scale: s + 1 };
}

export interface Fraction {
  readonly num: bigint;
  readonly den: bigint; // den > 0, gcd(|num|, den) = 1, zero is 0/1
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

// Normalises the sign onto num and reduces.
export function fraction(num: bigint, den: bigint): Fraction {
  if (den === 0n) throw new RangeError('fraction: zero denominator');
  if (num === 0n) return { num: 0n, den: 1n };
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export function decimalToFraction(d: ExactDecimal): Fraction {
  return fraction(d.digits, pow10(d.scale));
}

export function mulF(a: Fraction, b: Fraction): Fraction {
  return fraction(a.num * b.num, a.den * b.den);
}

export function divF(a: Fraction, b: Fraction): Fraction {
  if (b.num === 0n) throw new RangeError('divF: division by zero');
  return fraction(a.num * b.den, a.den * b.num);
}

export function reciprocal(a: Fraction): Fraction {
  if (a.num === 0n) throw new RangeError('reciprocal: zero has no reciprocal');
  return fraction(a.den, a.num);
}

export function fractionsEqual(a: Fraction, b: Fraction): boolean {
  return a.num === b.num && a.den === b.den;
}

// q = floor(|num| / den), r = |num| mod den; magnitude q + 1 when 2r >= den, else q; sign of num.
export function roundHalfAwayFromZero(f: Fraction): bigint {
  const n = abs(f.num);
  const q = n / f.den;
  const r = n % f.den;
  const mag = 2n * r >= f.den ? q + 1n : q;
  return f.num < 0n ? -mag : mag;
}
