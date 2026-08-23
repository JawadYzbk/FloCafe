'use client';

import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Printer, ReceiptText, Download, TrendingUp, TrendingDown } from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useAuthStore } from '@/store/auth';

type ExpenseKey = keyof AppConfig['Messages']['expenses'];
const EXPENSE_CATEGORY_KEYS: Record<string, ExpenseKey> = {
  salary: 'catSalary', rent: 'catRent', utilities: 'catUtilities', supplies: 'catSupplies',
  inventory: 'catInventory', maintenance: 'catMaintenance', marketing: 'catMarketing',
  fees: 'catFees', tax: 'catTax', other: 'catOther',
};

interface Summary { gross: number; discounts: number; tax: number; net: number; collected: number; orders: number; itemsSold: number; avgOrder: number; }
interface Overview {
  meta: { range: { startDate: string; endDate: string; days: number }; comparison?: { startDate: string; endDate: string } };
  summary: Summary;
  comparison?: { summary: Summary; deltaPct: Partial<Record<keyof Summary, number | null>> };
  profit: { netSales: number; cogs: number; grossProfit: number; grossMargin: number; operatingExpenses: number; netOperatingProfit: number };
  payments: Array<{ method: string; amount: number; count: number }>;
  expenses: { total: number; byCategory: Array<{ category: string; total: number }> };
  topProducts: Array<{ product_name: string; quantity: number; revenue: number; profit: number; margin: number }>;
  categories: Array<{ category: string; quantity: number; revenue: number; profit: number }>;
  modifiers: Array<{ addon_name: string; quantity: number; revenue: number; attachmentRate: number }>;
  staff: Array<{ staff_name: string | null; orders: number; net: number; itemsSold: number }>;
  orderTypes: Array<{ type: string; orders: number; net: number; avgOrder: number }>;
  discounts: { total: number; discountedOrders: number; byReason: Array<{ reason: string; count: number; total: number }> };
  voids: { voidedItems: number; voidValue: number; byProduct: Array<{ product_name: string; count: number; value: number }> };
}

const isoToday = () => new Date().toISOString().slice(0, 10);
function isoDaysAgo(days: number) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); }

type Preset = 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'this_month' | 'custom';

export default function ReportsPage() {
  const t = useTranslations('reports');
  const tExpenses = useTranslations('expenses');
  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const businessName = useAuthStore((s) => s.currentTenant?.business_name) || 'FloCafe';
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const [preset, setPreset] = useState<Preset>('today');
  const [startDate, setStartDate] = useState(isoToday());
  const [endDate, setEndDate] = useState(isoToday());
  const [compare, setCompare] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  const expenseCatLabel = useCallback((c: string) => {
    const key = EXPENSE_CATEGORY_KEYS[c];
    return key ? tExpenses(key) : c;
  }, [tExpenses]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { compare: String(compare) };
      if (preset === 'custom') { params.start_date = startDate; params.end_date = endDate; }
      else params.preset = preset;
      const { data } = await api.get('/reports/overview', { params });
      setData(data);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [preset, startDate, endDate, compare, t]);

  useEffect(() => { void load(); }, [load]);

  const delta = (key: keyof Summary) => data?.comparison?.deltaPct?.[key];

  const exportCsv = () => {
    if (!data) return;
    const lines: string[] = [];
    const push = (title: string, header: string[], rows: (string | number)[][]) => {
      lines.push(title, header.join(','));
      rows.forEach((r) => lines.push(r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')));
      lines.push('');
    };
    push(t('title'), ['metric', 'value'], [
      [t('grossSales'), data.summary.gross], [t('discounts'), data.summary.discounts], [t('tax'), data.summary.tax],
      [t('netSales'), data.summary.net], [t('collected'), data.summary.collected], [t('orders'), data.summary.orders],
      [t('netProfit'), data.profit.netOperatingProfit],
    ]);
    push(t('paymentMethods'), [t('method'), t('amount')], data.payments.map((p) => [p.method, p.amount]));
    push(t('topItems'), [t('item'), t('quantity'), t('revenue'), t('profit')], data.topProducts.map((p) => [p.product_name, p.quantity, p.revenue, p.profit]));
    push(t('staff'), [t('staff'), t('orders'), t('sales')], data.staff.map((s) => [s.staff_name || '-', s.orders, s.net]));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `report-${data.meta.range.startDate}_${data.meta.range.endDate}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const print = (format: 'a4' | 'thermal') => {
    if (!data) return;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast.error(t('printBlocked')); return; }
    win.document.write(buildReportHtml(data, format, {
      title: t('title'), businessName, generatedAt: new Date().toLocaleString(),
      currency: currencyFmt, num: (n: number) => fmtNum(n), expenseCatLabel,
      L: {
        grossSales: t('grossSales'), discounts: t('discounts'), tax: t('tax'), netSales: t('netSales'),
        collected: t('collected'), orders: t('orders'), netProfit: t('netProfit'), grossProfit: t('grossProfit'),
        cogs: t('cogs'), expenses: t('expenses'), paymentMethods: t('paymentMethods'), method: t('method'),
        amount: t('amount'), byCategory: t('byCategory'), category: t('category'), total: t('total'),
        staff: t('staff'), sales: t('sales'), topItems: t('topItems'), item: t('item'), quantity: t('quantity'),
        revenue: t('revenue'), profit: t('profit'),
      },
    }));
    win.document.close(); win.focus();
    setTimeout(() => win.print(), 250);
  };

  // Per-report detailed views — fetch the dedicated endpoint (full, authoritative
  // data with all columns) and show a sortable table. Column getters reuse the
  // tenant formatters so the detail matches the summary exactly.
  type DetailCol = { label: string; get: (row: any) => string | number; sort?: (row: any) => number | string; num?: boolean };
  const detailConfigs: Record<string, { title: string; endpoint: string; extract: (r: any) => any[]; columns: DetailCol[] }> = {
    products: { title: t('topItems'), endpoint: '/reports/products', extract: (r) => r.products || [], columns: [
      { label: t('item'), get: (r) => r.product_name },
      { label: t('quantity'), get: (r) => fmtNum(r.quantity), sort: (r) => r.quantity, num: true },
      { label: t('revenue'), get: (r) => currencyFmt(r.revenue), sort: (r) => r.revenue, num: true },
      { label: t('cogs'), get: (r) => currencyFmt(r.cost), sort: (r) => r.cost, num: true },
      { label: t('profit'), get: (r) => currencyFmt(r.profit), sort: (r) => r.profit, num: true },
      { label: t('margin'), get: (r) => pct(r.margin), sort: (r) => r.margin, num: true },
    ] },
    categories: { title: t('categories'), endpoint: '/reports/categories', extract: (r) => r.categories || [], columns: [
      { label: t('category'), get: (r) => r.category },
      { label: t('quantity'), get: (r) => fmtNum(r.quantity), sort: (r) => r.quantity, num: true },
      { label: t('revenue'), get: (r) => currencyFmt(r.revenue), sort: (r) => r.revenue, num: true },
      { label: t('profit'), get: (r) => currencyFmt(r.profit), sort: (r) => r.profit, num: true },
      { label: t('margin'), get: (r) => pct(r.margin), sort: (r) => r.margin, num: true },
    ] },
    modifiers: { title: t('modifiers'), endpoint: '/reports/modifiers', extract: (r) => r.modifiers || [], columns: [
      { label: t('modifier'), get: (r) => r.addon_name },
      { label: t('quantity'), get: (r) => fmtNum(r.quantity), sort: (r) => r.quantity, num: true },
      { label: t('revenue'), get: (r) => currencyFmt(r.revenue), sort: (r) => r.revenue, num: true },
      { label: t('attachment'), get: (r) => pct(r.attachmentRate), sort: (r) => r.attachmentRate, num: true },
    ] },
    staff: { title: t('staff'), endpoint: '/reports/staff', extract: (r) => r.staff || [], columns: [
      { label: t('staff'), get: (r) => r.staff_name || '—' },
      { label: t('orders'), get: (r) => fmtNum(r.orders), sort: (r) => r.orders, num: true },
      { label: t('quantity'), get: (r) => fmtNum(r.itemsSold), sort: (r) => r.itemsSold, num: true },
      { label: t('discounts'), get: (r) => currencyFmt(r.discounts), sort: (r) => r.discounts, num: true },
      { label: t('sales'), get: (r) => currencyFmt(r.net), sort: (r) => r.net, num: true },
      { label: t('avgTicket'), get: (r) => currencyFmt(r.avgOrder), sort: (r) => r.avgOrder, num: true },
    ] },
    orderTypes: { title: t('orderTypes'), endpoint: '/reports/order-types', extract: (r) => r.orderTypes || [], columns: [
      { label: t('orderType'), get: (r) => r.type },
      { label: t('orders'), get: (r) => fmtNum(r.orders), sort: (r) => r.orders, num: true },
      { label: t('sales'), get: (r) => currencyFmt(r.net), sort: (r) => r.net, num: true },
      { label: t('avgTicket'), get: (r) => currencyFmt(r.avgOrder), sort: (r) => r.avgOrder, num: true },
    ] },
    payments: { title: t('paymentMethods'), endpoint: '/reports/payments', extract: (r) => r.payments || [], columns: [
      { label: t('method'), get: (r) => r.method },
      { label: t('orders'), get: (r) => fmtNum(r.count), sort: (r) => r.count, num: true },
      { label: t('amount'), get: (r) => currencyFmt(r.amount), sort: (r) => r.amount, num: true },
    ] },
    discounts: { title: t('discountsTitle'), endpoint: '/reports/discounts', extract: (r) => r.discounts?.byStaff || [], columns: [
      { label: t('staff'), get: (r) => r.staff_name || '—' },
      { label: t('orders'), get: (r) => fmtNum(r.count), sort: (r) => r.count, num: true },
      { label: t('total'), get: (r) => currencyFmt(r.total), sort: (r) => r.total, num: true },
    ] },
    voids: { title: t('voids'), endpoint: '/reports/voids', extract: (r) => r.voids?.byProduct || [], columns: [
      { label: t('item'), get: (r) => r.product_name },
      { label: t('orders'), get: (r) => fmtNum(r.count), sort: (r) => r.count, num: true },
      { label: t('total'), get: (r) => currencyFmt(r.value), sort: (r) => r.value, num: true },
    ] },
  };

  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<Record<string, unknown>[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>({ col: 1, dir: -1 });

  const openDetail = async (key: string) => {
    setDetailKey(key); setDetailRows([]); setDetailLoading(true); setSort({ col: 1, dir: -1 });
    try {
      const params: Record<string, string> = {};
      if (preset === 'custom') { params.start_date = startDate; params.end_date = endDate; } else params.preset = preset;
      const { data } = await api.get(detailConfigs[key].endpoint, { params });
      setDetailRows(detailConfigs[key].extract(data));
    } catch { toast.error(t('loadFailed')); } finally { setDetailLoading(false); }
  };

  const detailCfg = detailKey ? detailConfigs[detailKey] : null;
  const sortedDetail = detailCfg ? [...detailRows].sort((a, b) => {
    const col = detailCfg.columns[sort.col];
    if (!col?.sort) return 0;
    const va = col.sort(a), vb = col.sort(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  }) : [];

  const kpis = data ? [
    { label: t('netSales'), value: currencyFmt(data.summary.net), d: delta('net') },
    { label: t('collected'), value: currencyFmt(data.summary.collected), d: delta('collected') },
    { label: t('orders'), value: fmtNum(data.summary.orders), d: delta('orders') },
    { label: t('avgTicket'), value: currencyFmt(data.summary.avgOrder), d: delta('avgOrder') },
    { label: t('expenses'), value: currencyFmt(data.profit.operatingExpenses) },
    { label: t('netProfit'), value: currencyFmt(data.profit.netOperatingProfit), accent: data.profit.netOperatingProfit >= 0 },
  ] : [];

  const presets: Preset[] = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month'];
  const presetLabel: Record<Preset, string> = {
    today: t('today'), yesterday: t('yesterday'), last_7_days: t('thisWeek'),
    last_30_days: t('thisMonth'), this_month: t('monthToDate'), custom: t('custom'),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 size={22} className="text-gray-500" />
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={!data}><Download size={15} className="me-1" /> CSV</Button>
          <Button variant="outline" onClick={() => print('a4')} disabled={!data}><Printer size={15} className="me-1" /> {t('printPage')}</Button>
          <Button variant="outline" onClick={() => print('thermal')} disabled={!data}><ReceiptText size={15} className="me-1" /> {t('printReceipt')}</Button>
        </div>
      </div>

      {/* Range + presets + compare */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-100 bg-white p-4">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <Button key={p} variant={preset === p ? 'default' : 'ghost'} size="sm" onClick={() => setPreset(p)}>{presetLabel[p]}</Button>
          ))}
          <Button variant={preset === 'custom' ? 'default' : 'ghost'} size="sm" onClick={() => setPreset('custom')}>{t('custom')}</Button>
        </div>
        {preset === 'custom' && (
          <>
            <label className="text-xs text-gray-500 space-y-1"><span className="block">{t('from')}</span>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" /></label>
            <label className="text-xs text-gray-500 space-y-1"><span className="block">{t('to')}</span>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" /></label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-600 ms-auto">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> {t('compare')}
        </label>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="text-xs text-gray-500">{k.label}</p>
            <p className={`text-xl font-bold mt-1 ${k.accent === false ? 'text-red-600' : k.accent === true ? 'text-emerald-600' : 'text-gray-900'}`}>{k.value}</p>
            {typeof k.d === 'number' && (
              <p className={`text-xs mt-0.5 flex items-center gap-0.5 ${k.d >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {k.d >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />} {pct(Math.abs(k.d))} {t('vsPrevious')}
              </p>
            )}
          </div>
        ))}
      </div>

      {data && !loading && (
        <>
          {/* Profit & Loss */}
          <ReportCard title={t('profitAndLoss')}>
            <SimpleTable head={[t('total'), t('amount')]} align="end" empty={t('noData')} rows={[
              [t('netSales'), currencyFmt(data.profit.netSales)],
              [t('cogs'), '-' + currencyFmt(data.profit.cogs)],
              [`${t('grossProfit')} (${pct(data.profit.grossMargin)})`, currencyFmt(data.profit.grossProfit)],
              [t('expenses'), '-' + currencyFmt(data.profit.operatingExpenses)],
              [t('netProfit'), currencyFmt(data.profit.netOperatingProfit)],
            ]} />
          </ReportCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <ReportCard title={t('paymentMethods')} onDetails={() => openDetail('payments')} detailsLabel={t('details')}>
              <SimpleTable head={[t('method'), t('amount')]} align="end" empty={t('noData')}
                rows={data.payments.map((p) => [p.method, currencyFmt(p.amount)])} />
            </ReportCard>
            <ReportCard title={t('expenses')} subtitle={t('byCategory')}>
              <SimpleTable head={[t('category'), t('total')]} align="end" empty={t('noData')}
                rows={data.expenses.byCategory.map((e) => [expenseCatLabel(e.category), currencyFmt(e.total)])} />
            </ReportCard>
            <ReportCard title={t('orderTypes')} onDetails={() => openDetail('orderTypes')} detailsLabel={t('details')}>
              <SimpleTable head={[t('orderType'), t('orders'), t('sales')]} align="end" empty={t('noData')}
                rows={data.orderTypes.map((o) => [o.type, fmtNum(o.orders), currencyFmt(o.net)])} />
            </ReportCard>
            <ReportCard title={t('staff')} onDetails={() => openDetail('staff')} detailsLabel={t('details')}>
              <SimpleTable head={[t('staff'), t('orders'), t('sales')]} align="end" empty={t('noData')}
                rows={data.staff.map((s) => [s.staff_name || '—', fmtNum(s.orders), currencyFmt(s.net)])} />
            </ReportCard>
            <ReportCard title={t('categories')} onDetails={() => openDetail('categories')} detailsLabel={t('details')}>
              <SimpleTable head={[t('category'), t('quantity'), t('revenue')]} align="end" empty={t('noData')}
                rows={data.categories.map((c) => [c.category, fmtNum(c.quantity), currencyFmt(c.revenue)])} />
            </ReportCard>
            <ReportCard title={t('modifiers')} onDetails={() => openDetail('modifiers')} detailsLabel={t('details')}>
              <SimpleTable head={[t('modifier'), t('quantity'), t('revenue')]} align="end" empty={t('noData')}
                rows={data.modifiers.map((m) => [m.addon_name, fmtNum(m.quantity), currencyFmt(m.revenue)])} />
            </ReportCard>
            <ReportCard title={t('discountsTitle')} onDetails={() => openDetail('discounts')} detailsLabel={t('details')}>
              <SimpleTable head={[t('reason'), t('total')]} align="end" empty={t('noData')}
                rows={data.discounts.byReason.map((d) => [d.reason, currencyFmt(d.total)])} />
            </ReportCard>
            <ReportCard title={t('voids')} onDetails={() => openDetail('voids')} detailsLabel={t('details')}>
              <SimpleTable head={[t('item'), t('total')]} align="end" empty={t('noData')}
                rows={data.voids.byProduct.map((v) => [v.product_name, currencyFmt(v.value)])} />
            </ReportCard>
          </div>

          <ReportCard title={t('topItems')} onDetails={() => openDetail('products')} detailsLabel={t('details')}>
            <SimpleTable head={[t('item'), t('quantity'), t('revenue'), t('profit')]} align="end" empty={t('noData')}
              rows={data.topProducts.slice(0, 25).map((i) => [i.product_name, fmtNum(i.quantity), currencyFmt(i.revenue), currencyFmt(i.profit)])} />
          </ReportCard>
        </>
      )}

      {/* Per-report detail dialog (full data, sortable) */}
      <Dialog open={!!detailKey} onOpenChange={(o) => { if (!o) setDetailKey(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>{detailCfg?.title}</DialogTitle></DialogHeader>
          <div className="max-h-[70vh] overflow-auto">
            {detailLoading ? (
              <p className="text-center text-gray-400 py-10">…</p>
            ) : !detailCfg || sortedDetail.length === 0 ? (
              <p className="text-center text-gray-400 py-10">{t('noData')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {detailCfg.columns.map((c, i) => (
                      <TableHead
                        key={c.label}
                        onClick={() => c.sort && setSort((s) => ({ col: i, dir: s.col === i ? (s.dir * -1 as 1 | -1) : -1 }))}
                        className={`${i > 0 ? 'text-end' : ''} ${c.sort ? 'cursor-pointer select-none hover:text-brand' : ''}`}
                      >
                        {c.label}{sort.col === i ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedDetail.map((row, ri) => (
                    <TableRow key={ri}>
                      {detailCfg.columns.map((c, ci) => (
                        <TableCell key={ci} className={`${ci > 0 ? 'text-end tabular-nums' : 'text-gray-700'}`}>{c.get(row)}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReportCard({ title, subtitle, className, onDetails, detailsLabel, children }: { title: string; subtitle?: string; className?: string; onDetails?: () => void; detailsLabel?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-gray-100 bg-white overflow-hidden ${className ?? ''}`}>
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-gray-900">{title}</h2>
          {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
        </div>
        {onDetails && (
          <button type="button" onClick={onDetails} className="text-xs font-medium text-brand hover:underline shrink-0">{detailsLabel}</button>
        )}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function SimpleTable({ head, rows, align, empty }: { head: string[]; rows: (string | number)[][]; align?: 'start' | 'end'; empty: string }) {
  if (rows.length === 0) return <p className="text-center text-gray-400 text-sm py-8">{empty}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>{head.map((h, i) => <TableHead key={h} className={i > 0 && align === 'end' ? 'text-end' : ''}>{h}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, ri) => (
          <TableRow key={ri}>
            {r.map((cell, ci) => <TableCell key={ci} className={`${ci > 0 && align === 'end' ? 'text-end tabular-nums' : ''} ${ci === 0 ? 'text-gray-700' : 'text-gray-600'}`}>{cell}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Print (generated HTML window, A4 or 80mm thermal) ────────────────────────
function buildReportHtml(
  d: Overview,
  format: 'a4' | 'thermal',
  ctx: { title: string; businessName: string; generatedAt: string; currency: (n: number) => string; num: (n: number) => string; expenseCatLabel: (c: string) => string; L: Record<string, string> },
): string {
  const { currency, num, expenseCatLabel: cat, L } = ctx;
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const thermal = format === 'thermal';
  const rows = (r: string[][]) => r.map((cells) => `<tr>${cells.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  const section = (title: string, head: string[], body: string[][]) => body.length
    ? `<h2>${esc(title)}</h2><table><thead><tr>${head.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows(body)}</tbody></table>` : '';

  const summary: string[][] = [
    [L.grossSales, currency(d.summary.gross)], [L.discounts, '-' + currency(d.summary.discounts)],
    [L.tax, currency(d.summary.tax)], [L.netSales, currency(d.summary.net)], [L.collected, currency(d.summary.collected)],
    [L.orders, num(d.summary.orders)], [L.cogs, '-' + currency(d.profit.cogs)], [L.grossProfit, currency(d.profit.grossProfit)],
    [L.expenses, '-' + currency(d.profit.operatingExpenses)], [L.netProfit, currency(d.profit.netOperatingProfit)],
  ];
  const header = thermal
    ? `<h1>${esc(ctx.businessName)}</h1><p class="sub">${esc(ctx.title)}</p>
       <p class="period">${esc(d.meta.range.startDate)} → ${esc(d.meta.range.endDate)}</p>`
    : `<div class="head">
         <div><div class="biz">${esc(ctx.businessName)}</div><div class="rtitle">${esc(ctx.title)}</div></div>
         <div class="meta"><div>${esc(d.meta.range.startDate)} → ${esc(d.meta.range.endDate)}</div><div class="gen">${esc(ctx.generatedAt)}</div></div>
       </div>`;
  const body = `
    ${header}
    <table class="summary">${rows(summary)}</table>
    ${section(L.paymentMethods, [L.method, L.amount], d.payments.map((p) => [p.method, currency(p.amount)]))}
    ${section(L.expenses + ' — ' + L.byCategory, [L.category, L.total], d.expenses.byCategory.map((e) => [cat(e.category), currency(e.total)]))}
    ${section(L.staff, [L.staff, L.sales], d.staff.map((s) => [s.staff_name || '-', currency(s.net)]))}
    ${section(L.categories, [L.category, L.revenue], d.categories.map((c) => [c.category, currency(c.revenue)]))}
    ${section(L.topItems, [L.item, L.quantity], d.topProducts.slice(0, thermal ? 20 : 60).map((i) => [i.product_name, num(i.quantity)]))}
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ctx.businessName)} — ${esc(ctx.title)}</title><style>
    @page { size: ${thermal ? '80mm auto' : 'A4'}; margin: ${thermal ? '4mm' : '18mm'}; }
    * { box-sizing: border-box; }
    body { font-family: ${thermal ? "'Courier New', monospace" : "'Segoe UI', system-ui, -apple-system, sans-serif"}; color: #1a1a1a; margin: 0; ${thermal ? 'width: 72mm; font-size: 11px;' : 'font-size: 12.5px; line-height: 1.45;'} }
    h1 { font-size: ${thermal ? '14px' : '22px'}; margin: 0 0 2px; text-align: ${thermal ? 'center' : 'start'}; }
    .sub { text-align: center; color: #444; margin: 0 0 4px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
    .biz { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
    .rtitle { font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px; }
    .meta { text-align: end; font-size: 12px; color: #555; }
    .meta .gen { color: #999; font-size: 11px; margin-top: 2px; }
    h2 { font-size: ${thermal ? '12px' : '14px'}; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.05em; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
    .period { color: #666; margin: 0 0 10px; text-align: center; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: ${thermal ? '2px 0' : '5px 8px'}; text-align: start; border-bottom: 1px solid #eee; }
    th { font-weight: 700; ${thermal ? '' : 'background: #f7f7f7;'} font-size: ${thermal ? '11px' : '11px'}; text-transform: uppercase; letter-spacing: 0.03em; color: #666; }
    .num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .summary { margin-bottom: 6px; } .summary td { border-bottom: 1px dashed #ddd; font-weight: 600; padding: ${thermal ? '2px 0' : '6px 8px'}; }
    .summary tr:last-child td { border-top: 2px solid #111; border-bottom: none; font-size: ${thermal ? '12px' : '14px'}; font-weight: 800; }
    tbody tr:nth-child(even) td { ${thermal ? '' : 'background: #fafafa;'} }
  </style></head><body>${body}</body></html>`;
}
