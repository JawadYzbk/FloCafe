/**
 * Foreign-exchange rate service. Refreshes the exchange rate for each secondary
 * currency whose `rate_source` is `frankfurter` from the Frankfurter v2 API
 * (https://frankfurter.dev — ECB + IMF + ~40 central banks, so it covers LBP,
 * IQD, SYP and most world currencies), caching the last-known rate in settings.
 *
 * Offline-first (invariant #1): a failed fetch is non-fatal — the previously
 * cached rate stays in effect, and payment settlement never depends on the
 * network. Manual rates (`rate_source: 'manual'`) are owner-controlled and are
 * never overwritten here — the path for currencies Frankfurter can't quote.
 */

import log from 'electron-log';
import {
  getBaseCurrency,
  getSecondaryCurrencies,
  saveSecondaryCurrencies,
  isFrankfurterSupported,
  getFxRefreshMinutes,
  recordExchangeRate,
} from '../currency-config';
import { now } from '../db';
import type { SecondaryCurrency } from '../countries';

export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v2';

const REQUEST_TIMEOUT_MS = 8_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

/** One row of the v2 `/rates` response: rates are returned as a flat array. */
interface FrankfurterV2Rate {
  date: string;
  base: string;
  quote: string;
  rate: number;
}

/**
 * Fetch live rates for `symbols` expressed in `base` from Frankfurter v2.
 * Returns a code→rate map, or `null` on any failure (offline, HTTP error,
 * malformed body). Callers keep their cached rates when this returns null.
 *
 * v2 `/rates?base=X` returns every quote for the base as an array (there is no
 * `symbols` filter — it 422s), so we fetch once and pick out the wanted codes.
 */
export async function fetchFrankfurterRates(
  base: string,
  symbols: string[],
): Promise<Record<string, number> | null> {
  const wanted = symbols.filter(isFrankfurterSupported);
  if (!isFrankfurterSupported(base) || wanted.length === 0) return null;
  const wantedSet = new Set(wanted.map((code) => code.toUpperCase()));
  const url = `${FRANKFURTER_BASE_URL}/rates?base=${encodeURIComponent(base)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      log.debug(`[FX] Frankfurter responded HTTP ${response.status}`);
      return null;
    }
    const body = (await response.json()) as FrankfurterV2Rate[];
    if (!Array.isArray(body)) return null;
    const out: Record<string, number> = {};
    for (const row of body) {
      const code = String(row?.quote || '').toUpperCase();
      const rate = Number(row?.rate);
      if (wantedSet.has(code) && Number.isFinite(rate) && rate > 0) out[code] = rate;
    }
    return out;
  } catch (e) {
    // Non-fatal: offline or transient. Cached rates remain authoritative.
    log.debug('[FX] Frankfurter fetch failed (non-fatal):', e);
    return null;
  }
}

/**
 * Refresh all `frankfurter`-sourced secondary currencies once. Manual rates are
 * left untouched. Returns the number of rates updated (0 when offline or when
 * nothing is Frankfurter-eligible). Never throws.
 */
export async function refreshRates(): Promise<number> {
  if (refreshing) return 0;
  refreshing = true;
  try {
    const base = getBaseCurrency();
    const currencies = getSecondaryCurrencies();
    const auto = currencies.filter((c) => c.rate_source === 'frankfurter' && isFrankfurterSupported(c.code));
    if (auto.length === 0) return 0;

    const rates = await fetchFrankfurterRates(base, auto.map((c) => c.code));
    if (!rates) return 0;

    let updated = 0;
    const timestamp = now();
    const next: SecondaryCurrency[] = currencies.map((currency) => {
      if (currency.rate_source !== 'frankfurter') return currency;
      const fresh = rates[currency.code];
      if (!Number.isFinite(fresh) || fresh <= 0) return currency;
      updated += 1;
      recordExchangeRate(base, currency.code, fresh, 'frankfurter');
      return { ...currency, rate: fresh, rate_updated_at: timestamp };
    });

    if (updated > 0) saveSecondaryCurrencies(next);
    return updated;
  } catch (e) {
    log.debug('[FX] refreshRates failed (non-fatal):', e);
    return 0;
  } finally {
    refreshing = false;
  }
}

export const fxRateService = {
  start(): void {
    void refreshRates();
    this.schedule();
  },
  /**
   * (Re)arm the background poll from the configured cadence. Call after the
   * owner changes the interval so it takes effect without an app restart.
   * A cadence of 0 leaves polling off (manual refresh only).
   */
  schedule(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    const minutes = getFxRefreshMinutes();
    if (minutes > 0) {
      refreshTimer = setInterval(() => void refreshRates(), minutes * 60_000);
    }
  },
  stop(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  },
};
