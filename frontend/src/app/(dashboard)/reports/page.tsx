'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Printer, ReceiptText } from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';

type ExpenseKey = keyof AppConfig['Messages']['expenses'];
const EXPENSE_CATEGORY_KEYS: Record<string, ExpenseKey> = {
  salary: 'catSalary', rent: 'catRent', utilities: 'catUtilities', supplies: 'catSupplies',
  inventory: 'catInventory', maintenance: 'catMaintenance', marketing: 'catMarketing',
  fees: 'catFees', tax: 'catTax', other: 'catOther',
};

interface Financial {
  period: { start_date: string; end_date: string };
  sales: { order_count: number; gross: number; discounts: number; tax: number; net: number; collected: number };
  payments: Array<{ method: string; label?: string; amount: number; count?: number }>;
  expenses: { total: number; by_category: Array<{ category: string; count: number; total: number }> };
  profit: { revenue: number; expenses: number; net: number };
  staff: Array<{ user_id: string | null; staff_name: string | null; order_count: number; sales: number }>;
  items: Array<{ product_name: string; quantity: number; revenue: number }>;
  categories: Array<{ category: string; quantity: number; revenue: number }>;
  shifts: { count: number; open_count: number; closed_count: number };
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
const isoToday = () => new Date().toISOString().slice(0, 10);

export default function ReportsPage() {
  const t = useTranslations('reports');
  const tExpenses = useTranslations('expenses');
  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();

  const [startDate, setStartDate] = useState(isoToday());
  const [endDate, setEndDate] = useState(isoToday());
  const [data, setData] = useState<Financial | null>(null);
  const [loading, setLoading] = useState(true);

  const expenseCatLabel = useCallback((c: string) => {
    const key = EXPENSE_CATEGORY_KEYS[c];
    return key ? tExpenses(key) : c;
  }, [tExpenses]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/reports/financial', { params: { start_date: startDate, end_date: endDate } });
      setData(data);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, t]);

  useEffect(() => { void load(); }, [load]);

  const setPreset = (preset: 'today' | 'week' | 'month') => {
    const today = isoToday();
    if (preset === 'today') { setStartDate(today); setEndDate(today); }
    else if (preset === 'week') { setStartDate(isoDaysAgo(6)); setEndDate(today); }
    else { setStartDate(isoDaysAgo(29)); setEndDate(today); }
  };

  const avgTicket = useMemo(() => {
    if (!data || data.sales.order_count === 0) return 0;
    return data.sales.net / data.sales.order_count;
  }, [data]);

  const print = (format: 'a4' | 'thermal') => {
    if (!data) return;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast.error(t('printBlocked')); return; }
    win.document.write(buildReportHtml(data, format, {
      title: t('title'),
      currency: currencyFmt,
      num: (n: number) => fmtNum(n),
      expenseCatLabel,
      labels: {
        period: t('period'), netSales: t('netSales'), collected: t('collected'), grossSales: t('grossSales'),
        discounts: t('discounts'), tax: t('tax'), orders: t('orders'), avgTicket: t('avgTicket'),
        expenses: t('expenses'), netProfit: t('netProfit'), paymentMethods: t('paymentMethods'),
        method: t('method'), amount: t('amount'), byCategory: t('byCategory'), category: t('category'),
        total: t('total'), staff: t('staff'), sales: t('sales'), topItems: t('topItems'), item: t('item'),
        quantity: t('quantity'), revenue: t('revenue'), categories: t('categories'), shifts: t('shifts'),
      },
    }));
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  const kpis = data ? [
    { label: t('netSales'), value: currencyFmt(data.sales.net) },
    { label: t('collected'), value: currencyFmt(data.sales.collected) },
    { label: t('expenses'), value: currencyFmt(data.expenses.total) },
    { label: t('netProfit'), value: currencyFmt(data.profit.net), accent: data.profit.net >= 0 },
  ] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 size={22} className="text-gray-500" />
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => print('a4')} disabled={!data}><Printer size={15} className="me-1" /> {t('printPage')}</Button>
          <Button variant="outline" onClick={() => print('thermal')} disabled={!data}><ReceiptText size={15} className="me-1" /> {t('printReceipt')}</Button>
        </div>
      </div>

      {/* Date range + presets */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-100 bg-white p-4">
        <label className="text-xs text-gray-500 space-y-1">
          <span className="block">{t('from')}</span>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
        </label>
        <label className="text-xs text-gray-500 space-y-1">
          <span className="block">{t('to')}</span>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
        </label>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setPreset('today')}>{t('today')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setPreset('week')}>{t('thisWeek')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setPreset('month')}>{t('thisMonth')}</Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="text-xs text-gray-500">{k.label}</p>
            <p className={`text-2xl font-bold mt-1 ${k.accent === false ? 'text-red-600' : k.accent === true ? 'text-emerald-600' : 'text-gray-900'}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {data && !loading && (
        <div className="grid gap-6 lg:grid-cols-2">
          <ReportCard title={t('paymentMethods')}>
            <SimpleTable head={[t('method'), t('amount')]} align="end"
              rows={data.payments.map((p) => [p.label || p.method, currencyFmt(p.amount)])}
              empty={t('noData')} />
          </ReportCard>

          <ReportCard title={t('byCategory')} subtitle={t('expenses')}>
            <SimpleTable head={[t('category'), t('total')]} align="end"
              rows={data.expenses.by_category.map((e) => [expenseCatLabel(e.category), currencyFmt(e.total)])}
              empty={t('noData')} />
          </ReportCard>

          <ReportCard title={t('staff')}>
            <SimpleTable head={[t('staff'), t('orders'), t('sales')]} align="end"
              rows={data.staff.map((s) => [s.staff_name || '—', fmtNum(s.order_count), currencyFmt(s.sales)])}
              empty={t('noData')} />
          </ReportCard>

          <ReportCard title={t('categories')}>
            <SimpleTable head={[t('category'), t('quantity'), t('revenue')]} align="end"
              rows={data.categories.map((c) => [c.category, fmtNum(c.quantity), currencyFmt(c.revenue)])}
              empty={t('noData')} />
          </ReportCard>

          <ReportCard title={t('topItems')} className="lg:col-span-2">
            <SimpleTable head={[t('item'), t('quantity'), t('revenue')]} align="end"
              rows={data.items.slice(0, 25).map((i) => [i.product_name, fmtNum(i.quantity), currencyFmt(i.revenue)])}
              empty={t('noData')} />
          </ReportCard>
        </div>
      )}
    </div>
  );
}

function ReportCard({ title, subtitle, className, children }: { title: string; subtitle?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-gray-100 bg-white overflow-hidden ${className ?? ''}`}>
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
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
  d: Financial,
  format: 'a4' | 'thermal',
  ctx: { title: string; currency: (n: number) => string; num: (n: number) => string; expenseCatLabel: (c: string) => string; labels: Record<string, string> },
): string {
  const { currency, num, expenseCatLabel: cat, labels: L } = ctx;
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const thermal = format === 'thermal';
  const rows = (r: string[][]) => r.map((cells) => `<tr>${cells.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  const section = (title: string, headCells: string[], body: string[][]) => body.length
    ? `<h2>${esc(title)}</h2><table><thead><tr>${headCells.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows(body)}</tbody></table>`
    : '';
  const avg = d.sales.order_count ? d.sales.net / d.sales.order_count : 0;

  const summaryRows: string[][] = [
    [L.grossSales, currency(d.sales.gross)],
    [L.discounts, '-' + currency(d.sales.discounts)],
    [L.tax, currency(d.sales.tax)],
    [L.netSales, currency(d.sales.net)],
    [L.collected, currency(d.sales.collected)],
    [L.orders, num(d.sales.order_count)],
    [L.avgTicket, currency(avg)],
    [L.expenses, '-' + currency(d.expenses.total)],
    [L.netProfit, currency(d.profit.net)],
  ];

  const body = `
    <h1>${esc(ctx.title)}</h1>
    <p class="period">${esc(d.period.start_date)} → ${esc(d.period.end_date)}</p>
    <table class="summary">${rows(summaryRows)}</table>
    ${section(L.paymentMethods, [L.method, L.amount], d.payments.map((p) => [p.label || p.method, currency(p.amount)]))}
    ${section(L.expenses + ' — ' + L.byCategory, [L.category, L.total], d.expenses.by_category.map((e) => [cat(e.category), currency(e.total)]))}
    ${section(L.staff, [L.staff, L.sales], d.staff.map((s) => [s.staff_name || '-', currency(s.sales)]))}
    ${section(L.categories, [L.category, L.revenue], d.categories.map((c) => [c.category, currency(c.revenue)]))}
    ${section(L.topItems, [L.item, L.quantity], d.items.slice(0, thermal ? 20 : 60).map((i) => [i.product_name, num(i.quantity)]))}
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ctx.title)}</title><style>
    @page { size: ${thermal ? '80mm auto' : 'A4'}; margin: ${thermal ? '4mm' : '16mm'}; }
    * { box-sizing: border-box; }
    body { font-family: ${thermal ? "'Courier New', monospace" : 'system-ui, sans-serif'}; color: #111; margin: 0; ${thermal ? 'width: 72mm; font-size: 11px;' : 'font-size: 13px;'} }
    h1 { font-size: ${thermal ? '14px' : '20px'}; margin: 0 0 2px; text-align: ${thermal ? 'center' : 'start'}; }
    h2 { font-size: ${thermal ? '12px' : '15px'}; margin: 16px 0 4px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
    .period { color: #666; margin: 0 0 10px; text-align: ${thermal ? 'center' : 'start'}; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: ${thermal ? '2px 0' : '4px 6px'}; text-align: start; border-bottom: 1px solid #eee; }
    th { font-weight: 700; }
    .num { text-align: end; white-space: nowrap; }
    .summary td { border-bottom: 1px dashed #ddd; font-weight: 600; }
  </style></head><body>${body}</body></html>`;
}
