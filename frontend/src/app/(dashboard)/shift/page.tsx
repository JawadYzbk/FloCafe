'use client';

import { useEffect, useMemo, useState } from 'react';
import { Banknote, Plus, Minus, ArrowLeftRight, Lock, Printer } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/hooks/useI18n';
import { useCurrenciesStore } from '@/store/currencies';
import { usePrinterStore } from '@/hooks/usePrinter';
import { useAuthStore } from '@/store/auth';

type Amounts = Record<string, number>;

interface Movement {
  id: number; type: 'pay_in' | 'pay_out' | 'exchange';
  currency: string | null; amount: number | null;
  from_currency: string | null; from_amount: number | null; to_currency: string | null; to_amount: number | null;
  reason: string | null; created_at: string;
}

interface Shift {
  id: number; status: 'open' | 'closed';
  opened_at: string; closed_at: string | null; base_currency: string;
  currencies: string[];
  opening_floats: Amounts; cash_sales: Amounts; expected: Amounts;
  counted_close: Amounts | null; variance: Amounts | null;
  movements: Movement[];
}

const fmtNum = (n: number) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function ShiftPage() {
  const { t } = useI18n();
  const baseCurrency = useCurrenciesStore((s) => s.baseCurrency);
  const secondary = useCurrenciesStore((s) => s.secondaryCurrencies);
  const loadCurrencies = useCurrenciesStore((s) => s.load);

  const [shift, setShift] = useState<Shift | null>(null);
  const [closedReport, setClosedReport] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const currencies = useMemo(() => {
    if (shift) return shift.currencies;
    const list = [baseCurrency, ...secondary.map((c) => c.code)].filter(Boolean);
    return list.filter((c, i) => c && list.indexOf(c) === i);
  }, [shift, baseCurrency, secondary]);

  const load = async () => {
    try {
      const { data } = await api.get('/shifts/current');
      setShift(data.shift);
    } catch {
      toast.error(t('shift.loadFailed', { defaultValue: 'Failed to load shift' }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCurrencies();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="p-8 text-sm text-gray-400">{t('common.loading', { defaultValue: 'Loading…' })}</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-2">
        <Banknote className="text-brand" size={22} />
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t('shift.title', { defaultValue: 'Cash Shift' })}</h1>
          <p className="text-sm text-gray-500">{t('shift.subtitle', { defaultValue: 'Open the drawer, record cash movements, and reconcile each currency at close.' })}</p>
        </div>
      </div>

      {closedReport
        ? <ClosedReportView shift={closedReport} currencies={closedReport.currencies} onDone={() => setClosedReport(null)} t={t} />
        : shift
          ? <OpenShiftView shift={shift} currencies={currencies} busy={busy} setBusy={setBusy} onChanged={setShift} onClosed={(report) => { setShift(null); setClosedReport(report); }} t={t} />
          : <OpenShiftForm currencies={currencies} busy={busy} setBusy={setBusy} onOpened={setShift} t={t} />}
    </div>
  );
}

// ── Closed shift → Z-report + print ───────────────────────────────────────────
function ClosedReportView({ shift, currencies, onDone, t }: {
  shift: Shift; currencies: string[]; onDone: () => void; t: ReturnType<typeof useI18n>['t'];
}) {
  const printZReport = usePrinterStore((s) => s.printZReport);
  const businessName = useAuthStore((s) => s.currentTenant?.business_name) || '';
  const [printing, setPrinting] = useState(false);
  const print = async () => {
    setPrinting(true);
    try {
      await printZReport(shift, businessName);
    } catch (e: unknown) {
      toast.error((e as Error)?.message || t('shift.printFailed', { defaultValue: 'Failed to print Z-report' }));
    } finally { setPrinting(false); }
  };
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600">{t('shift.closed', { defaultValue: 'Shift closed' })}</span>
        <span className="text-sm font-semibold text-gray-900">{t('shift.title', { defaultValue: 'Cash Shift' })} #{shift.id}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-gray-400">
              <th className="py-1 text-start">{t('shift.currency', { defaultValue: 'Currency' })}</th>
              <th className="py-1 text-end">{t('shift.expected', { defaultValue: 'Expected' })}</th>
              <th className="py-1 text-end">{t('shift.counted', { defaultValue: 'Counted' })}</th>
              <th className="py-1 text-end">{t('shift.variance', { defaultValue: 'Variance' })}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {currencies.map((c) => {
              const v = shift.variance ? (shift.variance[c] || 0) : 0;
              return (
                <tr key={c} className="border-t border-gray-50">
                  <td className="py-2 font-semibold text-gray-900">{c}</td>
                  <td className="py-2 text-end text-gray-500" dir="ltr">{fmtNum(shift.expected[c] || 0)}</td>
                  <td className="py-2 text-end text-gray-500" dir="ltr">{fmtNum(shift.counted_close?.[c] || 0)}</td>
                  <td className={`py-2 text-end font-semibold ${v === 0 ? 'text-emerald-600' : 'text-red-600'}`} dir="ltr">{v > 0 ? '+' : ''}{fmtNum(v)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button onClick={print} disabled={printing} className="min-h-11"><Printer size={15} className="me-1" />{printing ? t('shift.printing', { defaultValue: 'Printing…' }) : t('shift.printZReport', { defaultValue: 'Print Z-report' })}</Button>
        <Button variant="outline" onClick={onDone} className="min-h-11">{t('common.done', { defaultValue: 'Done' })}</Button>
      </div>
    </div>
  );
}

// ── No open shift → opening form ──────────────────────────────────────────────
function OpenShiftForm({ currencies, busy, setBusy, onOpened, t }: {
  currencies: string[]; busy: boolean; setBusy: (b: boolean) => void; onOpened: (s: Shift) => void; t: ReturnType<typeof useI18n>['t'];
}) {
  const [floats, setFloats] = useState<Record<string, string>>({});
  const open = async () => {
    setBusy(true);
    try {
      const opening_floats: Amounts = {};
      for (const c of currencies) { const v = Number(floats[c]); if (v > 0) opening_floats[c] = v; }
      const { data } = await api.post('/shifts/open', { opening_floats });
      onOpened(data.shift);
      toast.success(t('shift.opened', { defaultValue: 'Shift opened' }));
    } catch (e: unknown) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || t('shift.openFailed', { defaultValue: 'Failed to open shift' }));
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
      <p className="mb-1 font-semibold text-gray-900">{t('shift.noneOpen', { defaultValue: 'No shift is open' })}</p>
      <p className="mb-5 text-sm text-gray-500">{t('shift.openingFloatHint', { defaultValue: 'Enter the cash already in the drawer for each currency, then open the shift.' })}</p>
      <div className="space-y-3">
        {currencies.map((c) => (
          <label key={c} className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-gray-700">{t('shift.openingFloat', { defaultValue: 'Opening float' })} · {c}</span>
            <input type="number" min="0" step="any" inputMode="decimal" value={floats[c] ?? ''}
              onChange={(e) => setFloats((f) => ({ ...f, [c]: e.target.value }))}
              placeholder="0" dir="ltr"
              className="w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
          </label>
        ))}
      </div>
      <Button onClick={open} disabled={busy} className="mt-6 min-h-11"><Lock size={15} className="me-1" />{t('shift.open', { defaultValue: 'Open shift' })}</Button>
    </div>
  );
}

// ── Open shift → drawer, movements, close ─────────────────────────────────────
function OpenShiftView({ shift, currencies, busy, setBusy, onChanged, onClosed, t }: {
  shift: Shift; currencies: string[]; busy: boolean; setBusy: (b: boolean) => void; onChanged: (s: Shift | null) => void; onClosed: (report: Shift) => void; t: ReturnType<typeof useI18n>['t'];
}) {
  const [form, setForm] = useState<'pay_in' | 'pay_out' | 'exchange' | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});

  const record = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const { data } = await api.post('/shifts/movements', body);
      onChanged(data.shift);
      setForm(null);
      toast.success(t('shift.recorded', { defaultValue: 'Recorded' }));
    } catch (e: unknown) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || t('common.saveFailed', { defaultValue: 'Could not save' }));
    } finally { setBusy(false); }
  };

  const close = async () => {
    setBusy(true);
    try {
      const countedAmounts: Amounts = {};
      for (const c of currencies) { const v = Number(counted[c]); if (v >= 0 && counted[c] !== undefined && counted[c] !== '') countedAmounts[c] = v; }
      const { data } = await api.post('/shifts/close', { counted: countedAmounts });
      toast.success(t('shift.closed', { defaultValue: 'Shift closed' }));
      onClosed(data.shift as Shift);
    } catch (e: unknown) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || t('shift.closeFailed', { defaultValue: 'Failed to close shift' }));
    } finally { setBusy(false); }
  };

  const openedAt = new Date(shift.opened_at.replace(' ', 'T') + 'Z').toLocaleString();

  return (
    <div className="space-y-5">
      {/* Drawer summary */}
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">● {t('shift.open', { defaultValue: 'Open' })}</span>
          <span className="text-xs text-gray-400">{t('shift.openedAt', { defaultValue: 'Opened' })} {openedAt}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-gray-400">
                <th className="py-1 text-start">{t('shift.currency', { defaultValue: 'Currency' })}</th>
                <th className="py-1 text-end">{t('shift.opening', { defaultValue: 'Opening' })}</th>
                <th className="py-1 text-end">{t('shift.cashSales', { defaultValue: 'Cash sales' })}</th>
                <th className="py-1 text-end">{t('shift.expected', { defaultValue: 'Expected' })}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {currencies.map((c) => (
                <tr key={c} className="border-t border-gray-50">
                  <td className="py-2 font-semibold text-gray-900">{c}</td>
                  <td className="py-2 text-end text-gray-500" dir="ltr">{fmtNum(shift.opening_floats[c] || 0)}</td>
                  <td className="py-2 text-end text-gray-500" dir="ltr">{fmtNum(shift.cash_sales[c] || 0)}</td>
                  <td className="py-2 text-end font-bold text-gray-900" dir="ltr">{fmtNum(shift.expected[c] || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Movements */}
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-gray-900">{t('shift.movements', { defaultValue: 'Movements' })}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setForm(form === 'pay_in' ? null : 'pay_in')}><Plus size={14} className="me-1" />{t('shift.payIn', { defaultValue: 'Pay in' })}</Button>
            <Button size="sm" variant="outline" onClick={() => setForm(form === 'pay_out' ? null : 'pay_out')}><Minus size={14} className="me-1" />{t('shift.payOut', { defaultValue: 'Pay out' })}</Button>
            {currencies.length > 1 && <Button size="sm" variant="outline" onClick={() => setForm(form === 'exchange' ? null : 'exchange')}><ArrowLeftRight size={14} className="me-1" />{t('shift.exchange', { defaultValue: 'Exchange' })}</Button>}
          </div>
        </div>

        {form && form !== 'exchange' && (
          <PayForm type={form} currencies={currencies} busy={busy} onSubmit={record} t={t} />
        )}
        {form === 'exchange' && (
          <ExchangeForm currencies={currencies} busy={busy} onSubmit={record} t={t} />
        )}

        {shift.movements.length === 0 ? (
          <p className="py-2 text-sm text-gray-400">{t('shift.noMovements', { defaultValue: 'No movements yet.' })}</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-50 text-sm">
            {shift.movements.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-gray-600">
                  {m.type === 'exchange'
                    ? <>{t('shift.exchange', { defaultValue: 'Exchange' })} · <span dir="ltr">{fmtNum(m.from_amount || 0)} {m.from_currency} → {fmtNum(m.to_amount || 0)} {m.to_currency}</span></>
                    : <>{m.type === 'pay_in' ? t('shift.payIn', { defaultValue: 'Pay in' }) : t('shift.payOut', { defaultValue: 'Pay out' })} · <span dir="ltr">{fmtNum(m.amount || 0)} {m.currency}</span></>}
                  {m.reason && <span className="text-gray-400"> — {m.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Close & reconcile */}
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <p className="mb-1 font-semibold text-gray-900">{t('shift.closeTitle', { defaultValue: 'Count & close' })}</p>
        <p className="mb-4 text-sm text-gray-500">{t('shift.closeHint', { defaultValue: 'Count the physical cash in each currency. The variance is the difference from the expected balance.' })}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-gray-400">
                <th className="py-1 text-start">{t('shift.currency', { defaultValue: 'Currency' })}</th>
                <th className="py-1 text-end">{t('shift.expected', { defaultValue: 'Expected' })}</th>
                <th className="py-1 text-end">{t('shift.counted', { defaultValue: 'Counted' })}</th>
                <th className="py-1 text-end">{t('shift.variance', { defaultValue: 'Variance' })}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {currencies.map((c) => {
                const exp = shift.expected[c] || 0;
                const cnt = counted[c] === '' || counted[c] === undefined ? null : Number(counted[c]);
                const variance = cnt === null ? null : Math.round((cnt - exp) * 100) / 100;
                return (
                  <tr key={c} className="border-t border-gray-50">
                    <td className="py-2 font-semibold text-gray-900">{c}</td>
                    <td className="py-2 text-end text-gray-500" dir="ltr">{fmtNum(exp)}</td>
                    <td className="py-2 text-end">
                      <input type="number" min="0" step="any" inputMode="decimal" value={counted[c] ?? ''}
                        onChange={(e) => setCounted((v) => ({ ...v, [c]: e.target.value }))}
                        placeholder="0" dir="ltr"
                        className="w-32 rounded-lg border border-gray-200 px-2 py-1.5 text-end text-sm outline-none focus:ring-2 focus:ring-brand" />
                    </td>
                    <td className={`py-2 text-end font-semibold ${variance === null ? 'text-gray-300' : variance === 0 ? 'text-emerald-600' : 'text-red-600'}`} dir="ltr">
                      {variance === null ? '—' : `${variance > 0 ? '+' : ''}${fmtNum(variance)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button onClick={close} disabled={busy} className="mt-5 min-h-11" variant="destructive"><Lock size={15} className="me-1" />{t('shift.closeShift', { defaultValue: 'Close shift' })}</Button>
      </div>
    </div>
  );
}

function PayForm({ type, currencies, busy, onSubmit, t }: {
  type: 'pay_in' | 'pay_out'; currencies: string[]; busy: boolean; onSubmit: (b: Record<string, unknown>) => void; t: ReturnType<typeof useI18n>['t'];
}) {
  const [currency, setCurrency] = useState(currencies[0] || '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="mb-3 grid gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3 sm:grid-cols-4">
      <Select value={currency} onValueChange={setCurrency}>
        <SelectTrigger className="w-full bg-white"><SelectValue /></SelectTrigger>
        <SelectContent>{currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
      </Select>
      <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('shift.amount', { defaultValue: 'Amount' })} dir="ltr" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
      <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('shift.reason', { defaultValue: 'Reason (optional)' })} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
      <Button disabled={busy || !(Number(amount) > 0)} onClick={() => onSubmit({ type, currency, amount: Number(amount), reason })}>{t('shift.record', { defaultValue: 'Record' })}</Button>
    </div>
  );
}

function ExchangeForm({ currencies, busy, onSubmit, t }: {
  currencies: string[]; busy: boolean; onSubmit: (b: Record<string, unknown>) => void; t: ReturnType<typeof useI18n>['t'];
}) {
  const [fromCur, setFromCur] = useState(currencies[0] || '');
  const [toCur, setToCur] = useState(currencies[1] || currencies[0] || '');
  const [fromAmt, setFromAmt] = useState('');
  const [toAmt, setToAmt] = useState('');
  return (
    <div className="mb-3 grid gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3 sm:grid-cols-5">
      <div className="flex gap-1">
        <Select value={fromCur} onValueChange={setFromCur}><SelectTrigger className="w-full bg-white"><SelectValue /></SelectTrigger><SelectContent>{currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
      </div>
      <input type="number" min="0" step="any" value={fromAmt} onChange={(e) => setFromAmt(e.target.value)} placeholder={t('shift.from', { defaultValue: 'From' })} dir="ltr" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
      <Select value={toCur} onValueChange={setToCur}><SelectTrigger className="w-full bg-white"><SelectValue /></SelectTrigger><SelectContent>{currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
      <input type="number" min="0" step="any" value={toAmt} onChange={(e) => setToAmt(e.target.value)} placeholder={t('shift.to', { defaultValue: 'To' })} dir="ltr" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
      <Button disabled={busy || fromCur === toCur || !(Number(fromAmt) > 0) || !(Number(toAmt) > 0)} onClick={() => onSubmit({ type: 'exchange', from_currency: fromCur, from_amount: Number(fromAmt), to_currency: toCur, to_amount: Number(toAmt) })}>{t('shift.record', { defaultValue: 'Record' })}</Button>
    </div>
  );
}
