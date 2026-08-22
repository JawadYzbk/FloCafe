'use client';

import { useEffect, useState } from 'react';
import { Coins, Plus, RefreshCw, Trash2, Save } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/hooks/useI18n';
import { convertBaseToTender, type SecondaryCurrency, type RoundingMode } from '@/lib/countries';

// Full ISO 4217 currency list for the base-currency picker, from the platform
// when available (falls back to a common set for older runtimes).
const CURRENCY_CODES: string[] = (() => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.('currency');
    if (list && list.length) return list;
  } catch { /* fall through */ }
  return ['USD', 'EUR', 'GBP', 'LBP', 'AED', 'SAR', 'EGP', 'JOD', 'TRY', 'INR', 'JPY'];
})();

// Editable row model — mirrors SecondaryCurrency but keeps rate as a string so
// the input can be cleared while typing.
interface Row {
  code: string;
  symbol: string;
  rate: string;
  rate_source: 'frankfurter' | 'manual';
  rate_updated_at?: string;
  increment: string;
  mode: RoundingMode;
}

const INCREMENT_PRESETS = ['1', '10', '100', '1000', '5000'];

function toRow(c: SecondaryCurrency): Row {
  return {
    code: c.code,
    symbol: c.symbol ?? '',
    rate: String(c.rate),
    rate_source: c.rate_source,
    rate_updated_at: c.rate_updated_at,
    increment: String(c.rounding?.increment ?? 1),
    mode: c.rounding?.mode ?? 'half_up',
  };
}

function toPayload(r: Row): SecondaryCurrency {
  return {
    code: r.code.toUpperCase(),
    symbol: r.symbol.trim() || undefined,
    rate: Number(r.rate),
    rate_source: r.rate_source,
    rate_updated_at: r.rate_updated_at,
    rounding: { increment: Number(r.increment) || 1, mode: r.mode },
  };
}

export function CurrenciesPanel({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const [baseCurrency, setBaseCurrency] = useState('');
  const [supported, setSupported] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [newCode, setNewCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const { data } = await api.get('/settings/currencies');
    setBaseCurrency(String(data.base_currency || ''));
    setSupported(Array.isArray(data.frankfurter_currencies) ? data.frankfurter_currencies : []);
    setRows((Array.isArray(data.secondary_currencies) ? data.secondary_currencies : []).map(toRow));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => toast.error(t('settings.loadFailed')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setRow = (idx: number, changes: Partial<Row>) =>
    setRows((old) => old.map((r, i) => (i === idx ? { ...r, ...changes } : r)));

  const addCurrency = () => {
    const code = newCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      toast.error(t('settings.currencyCodeInvalid', { defaultValue: 'Enter a valid 3-letter currency code' }));
      return;
    }
    if (code === baseCurrency.toUpperCase() || rows.some((r) => r.code.toUpperCase() === code)) {
      toast.error(t('settings.currencyDuplicate', { defaultValue: 'That currency is already in the list' }));
      return;
    }
    const canAuto = supported.includes(code) && supported.includes(baseCurrency.toUpperCase());
    setRows((old) => [...old, {
      code, symbol: '', rate: '', rate_source: canAuto ? 'frankfurter' : 'manual', increment: '1', mode: 'half_up',
    }]);
    setNewCode('');
  };

  const removeRow = (idx: number) => setRows((old) => old.filter((_, i) => i !== idx));

  const baseSupportsLive = supported.includes(baseCurrency.toUpperCase());

  const save = async () => {
    for (const r of rows) {
      if (!(Number(r.rate) > 0)) {
        toast.error(t('settings.currencyRateInvalid', { defaultValue: `Enter a positive rate for ${r.code}` }));
        return;
      }
      if (r.rate_source === 'frankfurter' && (!supported.includes(r.code.toUpperCase()) || !baseSupportsLive)) {
        toast.error(t('settings.currencyNotAuto', { defaultValue: `${r.code} has no live rate — set it manually` }));
        return;
      }
    }
    setSaving(true);
    try {
      await api.put('/settings/currencies', { base_currency: baseCurrency, secondary_currencies: rows.map(toPayload) });
      await load();
      toast.success(t('settings.saved', { defaultValue: 'Saved' }));
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { data } = await api.post('/settings/currencies/refresh');
      setRows((Array.isArray(data.secondary_currencies) ? data.secondary_currencies : []).map(toRow));
      const updated = Number(data.updated) || 0;
      if (updated > 0) {
        toast.success(t('settings.ratesRefreshed', { defaultValue: `Updated ${updated} rate(s)` }));
      } else {
        // No live rates changed — usually offline, or the pair isn't quotable.
        toast(t('settings.ratesUnchanged', { defaultValue: 'No live rates updated — check your connection, or the currency has no live rate' }));
      }
    } catch {
      toast.error(t('settings.saveFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const hasAuto = rows.some((r) => r.rate_source === 'frankfurter');

  return (
    <div className="pb-6 max-w-3xl space-y-6">
      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-2">
          <Coins size={20} className="text-gray-500" />
          <h2 className="font-semibold text-gray-900">{t('settings.currencies', { defaultValue: 'Currencies' })}</h2>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          {t('settings.currenciesHint', {
            defaultValue: 'Your prices and reports stay in the base currency. Add other currencies you accept as payment; the exchange rate is applied at checkout.',
          })}
        </p>

        <div className="rounded-lg border border-gray-100 px-3 py-2 flex items-center justify-between gap-3 text-sm mb-1.5">
          <span className="text-gray-600">{t('settings.baseCurrency', { defaultValue: 'Base currency' })}</span>
          <Select value={baseCurrency} onValueChange={(v) => setBaseCurrency(v.toUpperCase())} disabled={!isAdmin}>
            <SelectTrigger id="base-currency" size="sm" className="w-32 font-semibold"><SelectValue /></SelectTrigger>
            <SelectContent>
              {baseCurrency && !CURRENCY_CODES.includes(baseCurrency) && <SelectItem value={baseCurrency}>{baseCurrency}</SelectItem>}
              {CURRENCY_CODES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          {t('settings.baseCurrencyHint', { defaultValue: 'Prices, taxes, and reports are kept in this currency. Changing it does not reconvert existing amounts.' })}
        </p>
        {baseCurrency && !supported.includes(baseCurrency) && (
          <p className="text-xs text-amber-600 mb-4">
            {t('settings.baseNoLiveRates', { defaultValue: `Live rates aren't available for a ${baseCurrency} base — secondary rates must be set manually.` })}
          </p>
        )}

        <div className="space-y-4">
          {rows.map((row, idx) => {
            const canAuto = supported.includes(row.code.toUpperCase());
            const preview = Number(row.rate) > 0
              ? convertBaseToTender(1, { rate: Number(row.rate), rounding: { increment: Number(row.increment) || 1, mode: row.mode } })
              : null;
            return (
              <div key={row.code} className="rounded-lg border border-gray-200 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-900">{row.code}</span>
                  <Button variant="outline" size="sm" disabled={!isAdmin} onClick={() => removeRow(idx)}><Trash2 size={14} /></Button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="text-xs text-gray-500 space-y-1">
                    <span>{t('settings.rateSource', { defaultValue: 'Rate source' })}</span>
                    <Select value={row.rate_source} onValueChange={(v) => setRow(idx, { rate_source: v as 'frankfurter' | 'manual' })} disabled={!isAdmin}>
                      <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">{t('settings.rateManual', { defaultValue: 'Manual' })}</SelectItem>
                        <SelectItem value="frankfurter" disabled={!canAuto || !baseSupportsLive}>{t('settings.rateAuto', { defaultValue: 'Live (Frankfurter)' })}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="text-xs text-gray-500 space-y-1">
                    <span>{t('settings.rate', { defaultValue: 'Rate (per 1 base)' })}</span>
                    <input
                      type="number" min="0" step="any"
                      disabled={!isAdmin || row.rate_source === 'frankfurter'}
                      value={row.rate}
                      onChange={(e) => setRow(idx, { rate: e.target.value })}
                      placeholder="0"
                      className="w-full px-2 py-2 text-sm border rounded-lg disabled:bg-gray-50"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-gray-500 space-y-1">
                    <span>{t('settings.roundTo', { defaultValue: 'Round tender to nearest' })}</span>
                    <input
                      type="number" min="1" step="1" list={`inc-${row.code}`}
                      disabled={!isAdmin}
                      value={row.increment}
                      onChange={(e) => setRow(idx, { increment: e.target.value })}
                      className="w-full px-2 py-2 text-sm border rounded-lg"
                    />
                    <datalist id={`inc-${row.code}`}>{INCREMENT_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
                  </label>
                  <div className="text-xs text-gray-500 space-y-1">
                    <span>{t('settings.roundingMode', { defaultValue: 'Rounding' })}</span>
                    <Select value={row.mode} onValueChange={(v) => setRow(idx, { mode: v as RoundingMode })} disabled={!isAdmin}>
                      <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="half_up">{t('settings.roundingModeHalfUp', { defaultValue: 'Nearest (half up)' })}</SelectItem>
                        <SelectItem value="floor">{t('settings.roundingModeFloor', { defaultValue: 'Down' })}</SelectItem>
                        <SelectItem value="ceil">{t('settings.roundingModeCeil', { defaultValue: 'Up' })}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {preview && (
                  <p className="text-[11px] text-gray-400">
                    {t('settings.roundingPreview', {
                      defaultValue: `1 ${baseCurrency} ≈ ${row.rate} ${row.code} → charged ${preview.rounded} ${row.code}`,
                    })}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {isAdmin && (
          <div className="flex gap-2 mt-5">
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') addCurrency(); }}
              maxLength={3}
              placeholder={t('settings.currencyCodePlaceholder', { defaultValue: 'e.g. LBP' })}
              className="w-40 px-3 py-2 text-sm border rounded-lg uppercase"
            />
            <Button variant="outline" onClick={addCurrency} disabled={!newCode.trim()}><Plus size={14} className="me-1" />{t('common.add')}</Button>
          </div>
        )}

        <div className="flex items-center gap-2 mt-6 pt-5 border-t border-gray-100">
          <Button onClick={save} disabled={!isAdmin || saving}><Save size={14} className="me-1" />{saving ? t('common.saving', { defaultValue: 'Saving…' }) : t('common.save')}</Button>
          {hasAuto && (
            <Button variant="outline" onClick={refresh} disabled={refreshing}>
              <RefreshCw size={14} className={`me-1 ${refreshing ? 'animate-spin' : ''}`} />{t('settings.refreshRates', { defaultValue: 'Refresh live rates' })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
