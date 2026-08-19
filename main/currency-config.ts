/**
 * Multi-currency configuration: the tenant's base accounting currency plus any
 * secondary currencies accepted as tender. Stored in the `settings` table as:
 *
 *   base_currency        → 3-letter code; defaults to the country currency.
 *   secondary_currencies → JSON array of SecondaryCurrency (see countries.ts).
 *
 * These helpers are the single parse/validate/serialize point shared by the
 * settings route, the FX rate service, and the payment settlement path so a
 * malformed row can never reach the authoritative money math.
 */

import { getSettingValue, upsertSettings } from './db';
import {
  normalizeRoundingRule,
  type SecondaryCurrency,
  type RoundingRule,
} from './countries';

/**
 * Currencies for which Frankfurter (ECB reference rates) can supply a live
 * rate. Anything outside this set — notably LBP — must use a manual rate.
 * Source of truth is https://api.frankfurter.dev/v1/currencies; this mirror is
 * a cheap pre-check that avoids futile network calls for unsupported pairs.
 */
export const FRANKFURTER_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK',
  'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);

export const isFrankfurterSupported = (code: string): boolean =>
  FRANKFURTER_CURRENCIES.has(String(code || '').toUpperCase());

const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

export const isValidCurrencyCode = (code: unknown): code is string =>
  typeof code === 'string' && CURRENCY_CODE_RE.test(code);

/**
 * Parse one untrusted secondary-currency entry into a well-formed
 * SecondaryCurrency, or `null` if it is unusable (bad code / non-positive
 * rate). Never throws — callers filter out nulls.
 */
export function parseSecondaryCurrency(raw: unknown): SecondaryCurrency | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const code = String(entry.code || '').toUpperCase();
  if (!isValidCurrencyCode(code)) return null;
  const rate = Number(entry.rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const source = entry.rate_source === 'frankfurter' ? 'frankfurter' : 'manual';
  const rounding: RoundingRule = normalizeRoundingRule(entry.rounding as Partial<RoundingRule> | undefined);
  return {
    code,
    symbol: typeof entry.symbol === 'string' && entry.symbol.trim() ? entry.symbol.trim() : undefined,
    rate,
    rate_source: source,
    rate_updated_at: typeof entry.rate_updated_at === 'string' ? entry.rate_updated_at : undefined,
    rounding,
  };
}

/** Parse the raw `secondary_currencies` JSON string, de-duplicating by code. */
export function parseSecondaryCurrenciesJson(json: string | null | undefined): SecondaryCurrency[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byCode = new Map<string, SecondaryCurrency>();
  for (const item of parsed) {
    const currency = parseSecondaryCurrency(item);
    if (currency) byCode.set(currency.code, currency); // last write wins
  }
  return [...byCode.values()];
}

export const serializeSecondaryCurrencies = (currencies: SecondaryCurrency[]): string =>
  JSON.stringify(currencies);

/** The tenant's base accounting currency (falls back to the country currency, then INR). */
export function getBaseCurrency(): string {
  const base = getSettingValue('base_currency');
  if (isValidCurrencyCode(base ?? '')) return (base as string).toUpperCase();
  const legacy = getSettingValue('currency');
  return isValidCurrencyCode(legacy ?? '') ? (legacy as string).toUpperCase() : 'INR';
}

export function getSecondaryCurrencies(): SecondaryCurrency[] {
  return parseSecondaryCurrenciesJson(getSettingValue('secondary_currencies'));
}

/** Look up a single accepted secondary currency by code (case-insensitive). */
export function getSecondaryCurrency(code: string): SecondaryCurrency | undefined {
  const target = String(code || '').toUpperCase();
  return getSecondaryCurrencies().find((c) => c.code === target);
}

export function saveSecondaryCurrencies(currencies: SecondaryCurrency[]): void {
  upsertSettings({ secondary_currencies: serializeSecondaryCurrencies(currencies) });
}
