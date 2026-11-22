// Classifier (S-73): the fixed category list, the code table, and the one rule for category and
// merchant. Pure. Called only by the ingest step when it first stores a transaction; every answer
// reads the stored result and never calls it.

import type { TranslatedTransaction } from './translated';

export const CATEGORIES = [
  'Groceries & Supermarkets', 'Restaurants & Cafes', 'Fast Food', 'Public Transport', 'Taxi & Rideshare',
  'Fuel & Gas', 'Transport', 'Pharmacy', 'Medical & Dental', 'Clothing & Apparel', 'Electronics & Tech',
  'Software & Subscriptions', 'Entertainment', 'Fitness & Sport', 'Hotels & Accommodation', 'Flights & Airlines',
  'Travel', 'Utilities & Bills', 'Telecom & Internet', 'Education', 'ATM & Cash', 'Financial Services',
  'Home & Furniture', 'Shopping', 'Uncategorized',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const UNCATEGORIZED: Category = 'Uncategorized';

// Individual codes only, no ranges; a code not listed is unknown. No code appears twice.
export const CATEGORY_CODES: Readonly<Record<Exclude<Category, 'Uncategorized'>, readonly number[]>> = {
  'Groceries & Supermarkets': [5400, 5411, 5412, 5422, 5441, 5451, 5461, 5462, 5499],
  'Restaurants & Cafes': [5812, 5813],
  'Fast Food': [5814],
  'Public Transport': [4111, 4112, 4131, 4210],
  'Taxi & Rideshare': [4121],
  'Fuel & Gas': [5171, 5172, 5541, 5542],
  Transport: [4011, 4215, 4784, 7511, 7512, 7513, 7519, 7521, 7523, 7531, 7534, 7535, 7538, 7542, 7549],
  Pharmacy: [5122, 5912],
  'Medical & Dental': [8011, 8021, 8031, 8041, 8042, 8049, 8050, 8062, 8071, 8099],
  'Clothing & Apparel': [5600, 5611, 5621, 5631, 5641, 5651, 5661, 5681, 5691, 5699],
  'Electronics & Tech': [5045, 5065, 5731, 5732, 5734],
  'Software & Subscriptions': [7372, 7374, 7375, 7379],
  Entertainment: [5815, 5816, 5817, 5818, 7832, 7911, 7922, 7929, 7941, 7991, 7993, 7994, 7996, 7999],
  'Fitness & Sport': [5940, 5941, 7997],
  'Hotels & Accommodation': [7011, 7012, 7013],
  'Flights & Airlines': [4511, 3000, 3001, 3002, 3005, 3006, 3020, 3066, 3099, 3174, 3175],
  Travel: [4411, 4722, 5962],
  'Utilities & Bills': [4900],
  'Telecom & Internet': [4813, 4814, 4816, 4899],
  Education: [8211, 8220, 8241, 8244, 8249, 8299],
  'ATM & Cash': [6010, 6011, 6012],
  'Financial Services': [6051, 6211, 6300, 6381, 6399, 6513, 6540],
  'Home & Furniture': [5200, 5211, 5231, 5251, 5261, 5700, 5712, 5713, 5714, 5718, 5719, 5720, 5722],
  Shopping: [5300, 5310, 5311, 5331, 5399, 5900, 5945, 5947, 5977, 5992, 5995, 5999],
};

const CATEGORY_OF_CODE: ReadonlyMap<number, Category> = new Map(
  (Object.entries(CATEGORY_CODES) as [Category, readonly number[]][]).flatMap(([category, codes]) =>
    codes.map((code) => [code, category] as const),
  ),
);

// The table's category, null when code is null or not listed.
export function categoryOfCode(code: number | null): Category | null {
  return code === null ? null : (CATEGORY_OF_CODE.get(code) ?? null);
}

// Original code if known, else code if known, else Uncategorized. Text never takes part.
export function classifyCategory(originalMcc: number | null, mcc: number | null): Category {
  return categoryOfCode(originalMcc) ?? categoryOfCode(mcc) ?? UNCATEGORIZED;
}

export interface KnownMerchant {
  readonly prefix: string; // upper case
  readonly display: string;
}

function known(display: string, ...prefixes: string[]): KnownMerchant[] {
  return prefixes.map((prefix) => ({ prefix, display }));
}

export const KNOWN_MERCHANTS: readonly KnownMerchant[] = [
  ...known('Nova Poshta', 'NOVA POSHTA', 'NOVA POST', 'НОВА ПОШТА'),
  ...known('Ukrposhta', 'UKRPOSHTA'),
  ...known('Meest Express', 'MEEST'),
  ...known('Justin', 'JUSTIN'),
  ...known('Silpo', 'SILPO', 'СІЛЬПО'),
  ...known('ATB Market', 'ATB', 'АТБ'),
  ...known('Novus', 'NOVUS'),
  ...known('Billa', 'BILLA'),
  ...known('Metro', 'METRO'),
  ...known('Auchan', 'AUCHAN'),
  ...known('Fozzy', 'FOZZY'),
  ...known('Varus', 'VARUS'),
  ...known('Ekona', 'EKONA'),
  ...known('Glovo', 'GLOVO'),
  ...known('Uber Eats', 'UBER EATS'),
  ...known('Bolt Food', 'BOLT FOOD'),
  ...known('Raketa', 'RAKETA'),
  ...known('Uber', 'UBER'),
  ...known('Bolt', 'BOLT'),
  ...known('Uklon', 'UKLON'),
  ...known('Rozetka', 'ROZETKA'),
  ...known('Prom.ua', 'PROM.UA'),
  ...known('OLX', 'OLX'),
  ...known('Hotline', 'HOTLINE'),
  ...known('Makeup.ua', 'MAKEUP'),
  ...known('Netflix', 'NETFLIX'),
  ...known('Spotify', 'SPOTIFY'),
  ...known('Apple', 'APPLE'),
  ...known('Google', 'GOOGLE'),
  ...known('Steam', 'STEAM'),
  ...known('PlayStation', 'PLAYSTATION'),
  ...known('Microsoft', 'MICROSOFT'),
  ...known('Adobe', 'ADOBE'),
  ...known('OpenAI', 'OPENAI'),
  ...known('Anthropic', 'ANTHROPIC'),
  ...known('Anthropic / Claude', 'CLAUDE'),
  ...known('GitHub', 'GITHUB'),
  ...known('DigitalOcean', 'DIGITALOCEAN'),
  ...known('Hetzner', 'HETZNER'),
  ...known('Cloudflare', 'CLOUDFLARE'),
  ...known('Monobank', 'MONOBANK'),
  ...known('Privatbank', 'PRIVATBANK', 'PRIVAT24'),
  ...known('Oschadbank', 'ОЩАДБАНК', 'OSCHADBANK'),
  ...known('Farmacia', 'FARMACIA'),
  ...known('Podorozhnyk', 'ПОДОРОЖНИК'),
  ...known('Pharmacy', 'АПТЕКА'),
  ...known('Starbucks', 'STARBUCKS'),
  ...known('Coffee Shop', 'COFFEESHOP'),
  ...known("McDonald's", 'MCDONALDS', 'MC DONALDS'),
  ...known('KFC', 'KFC'),
  ...known('Burger King', 'BURGER KING'),
  ...known('Pizza Hut', 'PIZZA HUT'),
  ...known("Domino's", 'DOMINOS'),
  ...known('WOG', 'WOG'),
  ...known('OKKO', 'OKKO'),
  ...known('SOCAR', 'SOCAR'),
  ...known('UPG', 'UPG'),
  ...known('ANTP', 'ANTP'),
];

// Tail rules, tried in order; each needs whitespace before the tail.
const TAILS: readonly RegExp[] = [
  /\s+[#№/]\d+$/u, // branch number: ' #123', ' №456', ' /789'
  /\s+(UA|UKR|UKRAINE)$/iu,
  /\s+\*[A-Za-z0-9]+$/u, // Uber-style ' *TRIP'
  /\s+\d{4,}$/u,
];

export function cleanDescription(text: string): string {
  let s = text.trim();
  for (;;) {
    const rule = TAILS.find((r) => r.test(s));
    if (rule === undefined) return s;
    s = s.replace(rule, '').trim();
  }
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function deriveMerchant(merchantText: string | null, description: string): string {
  const base = merchantText !== null && merchantText.trim() !== '' ? merchantText : description;
  const c = cleanDescription(base);
  if (c === '') return base.trim();
  const upper = c.toUpperCase();
  let best: KnownMerchant | null = null;
  for (const m of KNOWN_MERCHANTS) {
    if (upper.startsWith(m.prefix) && (best === null || m.prefix.length > best.prefix.length)) best = m;
  }
  return best !== null ? best.display : titleCase(c);
}

export interface Classification {
  readonly category: Category;
  readonly merchant: string;
}

export function classify(
  t: Pick<TranslatedTransaction, 'originalMcc' | 'mcc' | 'merchantText' | 'description'>,
): Classification {
  return { category: classifyCategory(t.originalMcc, t.mcc), merchant: deriveMerchant(t.merchantText, t.description) };
}
