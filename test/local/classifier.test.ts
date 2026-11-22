// Classifier (S-73): the fixed category list and the code table, the one category rule
// (original code, then code, then Uncategorized), and the merchant derived from the merchant text or
// description by tail cleanup, longest known-name prefix, else title case, from src/local/classifier.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const classifier = () => import('../../src/local/classifier');

describe('local/classifier', () => {
  test('category list and code table', async () => {
    const { CATEGORIES, UNCATEGORIZED, CATEGORY_CODES, categoryOfCode } = await classifier();

    expect(CATEGORIES.length).toBe(25);
    expect(CATEGORIES[24]).toBe('Uncategorized');
    expect(UNCATEGORIZED).toBe('Uncategorized');
    expect(new Set(CATEGORIES).size).toBe(25);

    const listed = new Set<string>(Object.keys(CATEGORY_CODES));
    const real = new Set<string>(CATEGORIES.filter((c) => c !== 'Uncategorized'));
    expect([...listed].sort()).toEqual([...real].sort());

    // Every code is listed once, under one real category: a repeat names the code and both categories.
    const seen = new Map<number, string>();
    for (const [category, codes] of Object.entries(CATEGORY_CODES) as [string, readonly number[]][]) {
      for (const code of codes) {
        if (!(Number.isInteger(code) && code >= 0 && code <= 9999)) {
          throw new Error(`code ${code} under ${category} is not a whole number from 0 to 9999`);
        }
        const earlier = seen.get(code);
        if (earlier !== undefined) {
          throw new Error(`code ${code} is listed under both ${earlier} and ${category}`);
        }
        seen.set(code, category);
      }
    }

    expect(categoryOfCode(5940)).toBe('Fitness & Sport');
    expect(categoryOfCode(5411)).toBe('Groceries & Supermarkets');
    expect(categoryOfCode(6011)).toBe('ATM & Cash');
    expect(categoryOfCode(3000)).toBe('Flights & Airlines');
    expect(categoryOfCode(3175)).toBe('Flights & Airlines');
    expect(categoryOfCode(4900)).toBe('Utilities & Bills');

    // Individual codes only: 3003 and 3500 sit inside 3000..3999 but are not listed.
    expect(categoryOfCode(3003)).toBeNull();
    expect(categoryOfCode(3500)).toBeNull();
    expect(categoryOfCode(1234)).toBeNull();
    expect(categoryOfCode(null)).toBeNull();
  });

  test('classifyCategory order', async () => {
    const { classifyCategory, classify } = await classifier();

    expect(classifyCategory(null, 6011)).toBe('ATM & Cash');
    // The original code decides before the code.
    expect(classifyCategory(5940, 5999)).toBe('Fitness & Sport');
    // An unknown original code is skipped, not final.
    expect(classifyCategory(1234, 5411)).toBe('Groceries & Supermarkets');
    expect(classifyCategory(3500, null)).toBe('Uncategorized');
    expect(classifyCategory(3003, 3001)).toBe('Flights & Airlines');
    expect(classifyCategory(null, null)).toBe('Uncategorized');

    // Text never decides the category.
    expect(
      classify({ originalMcc: null, mcc: null, merchantText: 'NETFLIX', description: 'SILPO supermarket' }).category,
    ).toBe('Uncategorized');
  });

  test('cleanDescription and deriveMerchant', async () => {
    const { cleanDescription, deriveMerchant, KNOWN_MERCHANTS } = await classifier();

    expect(cleanDescription('SILPO #12 UA')).toBe('SILPO'); // rule 2 then rule 1
    expect(cleanDescription('ATB 1234 UKRAINE')).toBe('ATB'); // rule 2 then rule 4
    expect(cleanDescription('UBER *TRIP')).toBe('UBER');
    expect(cleanDescription('  Coffee /77  ')).toBe('Coffee');
    expect(cleanDescription('Kavarnia Lviv 004512')).toBe('Kavarnia Lviv');
    expect(cleanDescription('shop ua')).toBe('shop'); // rule 2 ignores case
    // Every rule needs whitespace before the tail, and rule 4 needs four digits.
    expect(cleanDescription('PROM.UA')).toBe('PROM.UA');
    expect(cleanDescription('12345')).toBe('12345');
    expect(cleanDescription('Shop 123')).toBe('Shop 123');

    expect(deriveMerchant(null, 'SILPO #12 UA')).toBe('Silpo');
    // A blank merchant text falls back to the description.
    expect(deriveMerchant('   ', 'SILPO #12 UA')).toBe('Silpo');
    expect(deriveMerchant('Netflix.com', 'card payment 0001')).toBe('Netflix');
    // The longest matching prefix wins: 'UBER EATS' over 'UBER'.
    expect(deriveMerchant(null, 'UBER EATS KYIV')).toBe('Uber Eats');
    expect(deriveMerchant(null, 'UBER *TRIP')).toBe('Uber');
    // Matching is on the start only.
    expect(deriveMerchant(null, 'APPLEBEES KYIV')).toBe('Apple');
    expect(deriveMerchant(null, 'сільпо 23')).toBe('Silpo');
    expect(deriveMerchant(null, 'mcdonalds kyiv')).toBe("McDonald's");
    // Title case of the cleaned text, words joined with one space.
    expect(deriveMerchant(null, 'kavarnia  LVIV')).toBe('Kavarnia Lviv');
    expect(deriveMerchant(null, 'Kavarnia Lviv 004512')).toBe('Kavarnia Lviv');
    // No fixed fallback text.
    expect(deriveMerchant(null, '')).toBe('');
    expect(deriveMerchant(null, '   ')).toBe('');

    const prefixes = new Set<string>();
    for (const { prefix } of KNOWN_MERCHANTS) {
      if (prefixes.has(prefix)) throw new Error(`prefix ${prefix} is listed twice in KNOWN_MERCHANTS`);
      prefixes.add(prefix);
      expect(prefix).toBe(prefix.toUpperCase());
    }
  });
});
