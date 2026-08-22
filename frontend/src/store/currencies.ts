import { create } from 'zustand';
import api from '@/lib/api';
import type { SecondaryCurrency } from '@/lib/countries';

/**
 * Shared tenant currency configuration (base + accepted secondary tenders),
 * loaded once from /settings/currencies and reused by the cart summary,
 * customer display, payment modal, and the POS rate chip. Kept in a store so
 * these surfaces show one consistent set of currencies and a single rate.
 */
interface CurrenciesState {
  baseCurrency: string;
  secondaryCurrencies: SecondaryCurrency[];
  loaded: boolean;
  loading: boolean;
  /** Load once; concurrent/repeat calls are deduped. Pass force to refetch. */
  load: (force?: boolean) => Promise<void>;
  setFromResponse: (data: unknown) => void;
}

function parse(data: unknown): { base: string; list: SecondaryCurrency[] } {
  const d = (data ?? {}) as { base_currency?: unknown; secondary_currencies?: unknown };
  const list = Array.isArray(d.secondary_currencies) ? (d.secondary_currencies as SecondaryCurrency[]) : [];
  return {
    base: typeof d.base_currency === 'string' ? d.base_currency : '',
    list: list.filter((c) => c && typeof c.code === 'string' && Number(c.rate) > 0),
  };
}

export const useCurrenciesStore = create<CurrenciesState>((set, get) => ({
  baseCurrency: '',
  secondaryCurrencies: [],
  loaded: false,
  loading: false,
  load: async (force = false) => {
    const { loaded, loading } = get();
    if (loading || (loaded && !force)) return;
    set({ loading: true });
    try {
      const { data } = await api.get('/settings/currencies');
      const { base, list } = parse(data);
      set({ baseCurrency: base, secondaryCurrencies: list, loaded: true, loading: false });
    } catch {
      set({ loaded: true, loading: false });
    }
  },
  setFromResponse: (data) => {
    const { base, list } = parse(data);
    set({ baseCurrency: base, secondaryCurrencies: list, loaded: true });
  },
}));
