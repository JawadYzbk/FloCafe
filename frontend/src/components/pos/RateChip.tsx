'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'use-intl';
import { TrendingUp, AlertTriangle } from 'lucide-react';
import { useCurrenciesStore } from '@/store/currencies';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { parseDbTimestamp } from '@/lib/utils';

// A manual "fresh dollar" rate drifts daily; flag it once it's older than this
// so LBP totals aren't quietly wrong.
const STALE_MS = 18 * 60 * 60 * 1000;

function relativeTime(iso: string, locale: string, now: number): string {
  const diffMs = now - parseDbTimestamp(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' });
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return rtf.format(-Math.max(1, mins), 'minute');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return rtf.format(-hrs, 'hour');
  return rtf.format(-Math.round(hrs / 24), 'day');
}

/**
 * Compact exchange-rate indicator for the POS topbar: shows "1 USD = 89,000 LBP"
 * with when it was last set, and turns amber when the rate is stale. Tapping it
 * jumps to the Currencies settings to update it. Renders nothing when no
 * secondary currency is configured.
 */
export default function RateChip() {
  const router = useRouter();
  const locale = useLocale();
  const fmtNum = useFormatNumber();
  const base = useCurrenciesStore((s) => s.baseCurrency);
  const secondaryCurrencies = useCurrenciesStore((s) => s.secondaryCurrencies);
  const load = useCurrenciesStore((s) => s.load);
  // Time-of-render lives in state (refreshed each minute) so the render stays
  // pure — the staleness check and "x hours ago" both read from it.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const c = secondaryCurrencies[0];
  if (!c || !base) return null;

  const updatedAt = c.rate_updated_at;
  const stale = !updatedAt || now - parseDbTimestamp(updatedAt).getTime() > STALE_MS;
  const rateText = `1 ${base} = ${fmtNum(c.rate)} ${c.symbol || c.code}`;
  const when = updatedAt ? relativeTime(updatedAt, locale, now) : '';

  return (
    <button
      type="button"
      onClick={() => router.push('/settings?tab=currencies')}
      aria-label={`${rateText}${when ? ` — ${when}` : ''}`}
      title={when ? `${rateText} · ${when}` : rateText}
      className={`h-10 shrink-0 flex items-center gap-1.5 px-3 rounded-lg border text-sm font-medium whitespace-nowrap transition-colors ${
        stale
          ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
          : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
      }`}
    >
      {stale ? <AlertTriangle size={14} className="shrink-0" /> : <TrendingUp size={14} className="shrink-0 text-gray-400" />}
      <span className="ltr-island font-semibold" dir="ltr">{rateText}</span>
      {when && <span className="hidden md:inline text-[11px] opacity-70">· {when}</span>}
    </button>
  );
}
