import { useEffect } from 'react';
import { useCurrenciesStore } from '@/store/currencies';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { convertBaseToTender, type SecondaryCurrency } from '@/lib/countries';

/**
 * Formats a base-currency amount into the accepted secondary tenders (e.g. LBP)
 * for a persistent dual-currency display. Loads the shared currency config on
 * first use. Returns an empty `secondaryLine` when no secondary currency is
 * configured, so callers can render it unconditionally.
 */
export function useDualCurrency() {
  const secondaryCurrencies = useCurrenciesStore((s) => s.secondaryCurrencies);
  const load = useCurrenciesStore((s) => s.load);
  const fmtNum = useFormatNumber();

  useEffect(() => {
    void load();
  }, [load]);

  const tenderAmount = (baseAmount: number, c: SecondaryCurrency) =>
    `${fmtNum(convertBaseToTender(baseAmount, c).rounded)} ${c.symbol || c.code}`;

  return {
    secondaryCurrencies,
    hasSecondary: secondaryCurrencies.length > 0,
    /** e.g. "1,200,000 L.L" (all secondary tenders, dot-separated). */
    secondaryLine: (baseAmount: number) =>
      secondaryCurrencies.map((c) => tenderAmount(baseAmount, c)).join('  ·  '),
  };
}
