/**
 * Reporting engine entry point.
 *
 * Composes the per-domain aggregation services into higher-level reports (the
 * executive overview) and provides shared metadata + timezone helpers. Route
 * handlers stay thin: resolve the range, call the engine, return the result.
 */
import type Database from 'better-sqlite3';
import { getSettingValue } from '../../db';
import { resolveRange, type ResolvedRange } from './date-range';
import { salesSummary, dailySales, hourlySales, type SalesSummary } from './sales';
import { productSales, categorySales, modifierSales } from './products';
import { orderTypeBreakdown, discountReport, voidReport, staffSales } from './operations';
import { paymentBreakdown, expensesSummary, profitAndLoss } from './finance';

export * from './date-range';
export * from './sales';
export * from './products';
export * from './operations';
export * from './finance';

/** Minutes the store timezone is offset from UTC at `at` (DST-aware). */
export function tzOffsetMinutes(timeZone: string | undefined, at = new Date()): number {
  if (!timeZone) return 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(at)) map[p.type] = p.value;
    const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
    return Math.round((asUTC - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

export function storeTzOffset(): number {
  return tzOffsetMinutes(getSettingValue('timezone') || undefined);
}

export interface ReportMeta {
  generatedAt: string;
  timezone: string;
  range: { startDate: string; endDate: string; days: number };
  comparison?: { startDate: string; endDate: string };
}

export function reportMeta(resolved: ResolvedRange): ReportMeta {
  return {
    generatedAt: new Date().toISOString(),
    timezone: getSettingValue('timezone') || 'UTC',
    range: { ...resolved.range, days: resolved.days },
    comparison: resolved.comparison?.range,
  };
}

export interface Overview {
  meta: ReportMeta;
  summary: SalesSummary;
  comparison?: { summary: SalesSummary; deltaPct: Partial<Record<keyof SalesSummary, number | null>> };
  profit: ReturnType<typeof profitAndLoss>;
  payments: ReturnType<typeof paymentBreakdown>;
  expenses: ReturnType<typeof expensesSummary>;
  topProducts: ReturnType<typeof productSales>;
  categories: ReturnType<typeof categorySales>;
  modifiers: ReturnType<typeof modifierSales>;
  staff: ReturnType<typeof staffSales>;
  orderTypes: ReturnType<typeof orderTypeBreakdown>;
  discounts: ReturnType<typeof discountReport>;
  voids: ReturnType<typeof voidReport>;
  daily: ReturnType<typeof dailySales>;
  hourly: ReturnType<typeof hourlySales>;
}

function pctDelta(current: number, previous: number): number | null {
  if (!(previous > 0)) return null; // avoid meaningless "↑100%" from a zero base
  return (current - previous) / previous;
}

/** The executive overview: everything for the dashboard, from one resolved range. */
export function buildOverview(db: Database.Database, resolved: ResolvedRange): Overview {
  const tz = storeTzOffset();
  const [startISO, endISO] = resolved.bounds;
  const summary = salesSummary(db, startISO, endISO);

  const overview: Overview = {
    meta: reportMeta(resolved),
    summary,
    profit: profitAndLoss(db, resolved.bounds, resolved.range),
    payments: paymentBreakdown(db, startISO, endISO),
    expenses: expensesSummary(db, resolved.range.startDate, resolved.range.endDate),
    topProducts: productSales(db, startISO, endISO, 25),
    categories: categorySales(db, startISO, endISO),
    modifiers: modifierSales(db, startISO, endISO),
    staff: staffSales(db, startISO, endISO),
    orderTypes: orderTypeBreakdown(db, startISO, endISO),
    discounts: discountReport(db, startISO, endISO),
    voids: voidReport(db, startISO, endISO),
    daily: dailySales(db, startISO, endISO),
    hourly: hourlySales(db, startISO, endISO, tz),
  };

  if (resolved.comparison) {
    const prev = salesSummary(db, resolved.comparison.bounds[0], resolved.comparison.bounds[1]);
    overview.comparison = {
      summary: prev,
      deltaPct: {
        gross: pctDelta(summary.gross, prev.gross),
        net: pctDelta(summary.net, prev.net),
        collected: pctDelta(summary.collected, prev.collected),
        orders: pctDelta(summary.orders, prev.orders),
        itemsSold: pctDelta(summary.itemsSold, prev.itemsSold),
        avgOrder: pctDelta(summary.avgOrder, prev.avgOrder),
      },
    };
  }
  return overview;
}

export { resolveRange };
