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

import { getSettingValue, upsertSettings, getDatabase, now } from './db';
import {
  normalizeRoundingRule,
  type SecondaryCurrency,
  type RoundingRule,
} from './countries';

/**
 * Currencies for which Frankfurter can supply a live rate. The Frankfurter v2
 * API aggregates the ECB plus the IMF and ~40 national central banks, so its
 * coverage is far wider than the old ECB-only v1 (30 currencies) — it includes
 * LBP (Banque du Liban), IQD, SYP, and most world currencies.
 * Source of truth is https://api.frankfurter.dev/v2/currencies; this mirror is
 * a cheap pre-check that avoids futile network calls for unsupported pairs.
 */
export const FRANKFURTER_CURRENCIES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD',
  'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNH', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GGP', 'GHS', 'GIP',
  'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS',
  'IMP', 'INR', 'IQD', 'IRR', 'ISK', 'JEP', 'JMD', 'JOD', 'JPY', 'KES',
  'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP',
  'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT',
  'MOP', 'MRO', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD',
  'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP',
  'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD',
  'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN',
  'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD',
  'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV',
  'WST', 'XAF', 'XAG', 'XAU', 'XCD', 'XCG', 'XDR', 'XOF', 'XPD', 'XPF',
  'XPT', 'YER', 'ZAR', 'ZMW', 'ZWG',
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

/**
 * Append a rate to the exchange_rate_history log, but only when it differs from
 * the currency's most recent entry — so a poll that returns an unchanged rate
 * doesn't spam the log. Best-effort: never throws (history must not block a
 * refresh or a settings save).
 */
export function recordExchangeRate(
  baseCurrency: string,
  currency: string,
  rate: number,
  source: 'manual' | 'frankfurter',
): void {
  try {
    if (!(Number.isFinite(rate) && rate > 0)) return;
    const db = getDatabase();
    const base = String(baseCurrency || '').toUpperCase();
    const code = String(currency || '').toUpperCase();
    if (!base || !code) return;
    const last = db
      .prepare('SELECT rate, base_currency FROM exchange_rate_history WHERE currency = ? ORDER BY id DESC LIMIT 1')
      .get(code) as { rate: number; base_currency: string } | undefined;
    if (last && Number(last.rate) === rate && String(last.base_currency).toUpperCase() === base) return;
    db.prepare(
      'INSERT INTO exchange_rate_history (base_currency, currency, rate, source, recorded_at) VALUES (?, ?, ?, ?, ?)',
    ).run(base, code, rate, source, now());
  } catch { /* non-fatal: rate history is best-effort */ }
}

/** Recent exchange-rate history for a currency (newest first). */
export function getExchangeRateHistory(currency: string, limit = 50): Array<{ base_currency: string; currency: string; rate: number; source: string; recorded_at: string }> {
  try {
    const db = getDatabase();
    const code = String(currency || '').toUpperCase();
    const capped = Math.min(Math.max(1, Math.floor(limit) || 50), 500);
    return db
      .prepare('SELECT base_currency, currency, rate, source, recorded_at FROM exchange_rate_history WHERE currency = ? ORDER BY id DESC LIMIT ?')
      .all(code, capped) as Array<{ base_currency: string; currency: string; rate: number; source: string; recorded_at: string }>;
  } catch {
    return [];
  }
}

/** Default auto-refresh cadence for live rates (minutes). ECB publishes ~daily,
 *  so 6h is ample, but the owner can poll more/less often or disable it. */
export const DEFAULT_FX_REFRESH_MINUTES = 360;

/**
 * How often (in minutes) to auto-poll Frankfurter for fresh rates. `0` disables
 * background polling entirely (manual "Refresh live rates" only). A configured
 * value is clamped to at least 1 minute.
 */
export function getFxRefreshMinutes(): number {
  const raw = Number(getSettingValue('fx_refresh_minutes'));
  if (!Number.isFinite(raw)) return DEFAULT_FX_REFRESH_MINUTES;
  if (raw <= 0) return 0;
  return Math.max(1, Math.floor(raw));
}
