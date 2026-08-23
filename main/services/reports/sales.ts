/**
 * Authoritative sales aggregations for the reporting engine.
 *
 * Every sales metric across the reporting system (dashboard KPIs, sales report,
 * profit & loss) is computed here so there is ONE definition of gross/net sales,
 * order counts, etc. — the UI consumes these results and never recomputes them.
 *
 * Definitions (documented once, used everywhere):
 *   gross    = Σ orders.subtotal   (pre-discount item subtotal)
 *   discounts= Σ orders.discount_amount
 *   tax      = Σ orders.tax_amount
 *   net      = Σ orders.total       (payable incl. tax + charges − discount)
 *   collected= Σ bills.paid_amount  (cash actually taken — payment basis)
 *   orders   = COUNT(orders) excluding cancelled
 *   itemsSold= Σ order_items.quantity for non-cancelled/voided lines
 *   avgOrder = net / orders
 *
 * Cancelled orders and cancelled/voided/void_adjustment item lines are excluded
 * from sales. `net` uses stored order totals, so historical tax/price/discount
 * values are preserved automatically.
 */
import type Database from 'better-sqlite3';

const ACTIVE_ORDER = `status != 'cancelled'`;
const ACTIVE_ITEM = `status NOT IN ('cancelled', 'voided', 'void_adjustment')`;

export interface SalesSummary {
  gross: number;
  discounts: number;
  tax: number;
  net: number;
  collected: number;
  orders: number;
  itemsSold: number;
  avgOrder: number;
}

export function salesSummary(db: Database.Database, startISO: string, endISO: string): SalesSummary {
  const o = db.prepare(`
    SELECT COUNT(*) AS orders,
      COALESCE(SUM(subtotal), 0) AS gross,
      COALESCE(SUM(discount_amount), 0) AS discounts,
      COALESCE(SUM(tax_amount), 0) AS tax,
      COALESCE(SUM(total), 0) AS net
    FROM orders WHERE created_at >= ? AND created_at < ? AND ${ACTIVE_ORDER}
  `).get(startISO, endISO) as { orders: number; gross: number; discounts: number; tax: number; net: number };

  const items = (db.prepare(`
    SELECT COALESCE(SUM(oi.quantity), 0) AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.${ACTIVE_ORDER} AND oi.${ACTIVE_ITEM}
  `).get(startISO, endISO) as { qty: number }).qty;

  const collected = (db.prepare(
    `SELECT COALESCE(SUM(paid_amount), 0) AS c FROM bills WHERE created_at >= ? AND created_at < ?`,
  ).get(startISO, endISO) as { c: number }).c;

  return {
    gross: o.gross, discounts: o.discounts, tax: o.tax, net: o.net,
    collected, orders: o.orders, itemsSold: items,
    avgOrder: o.orders > 0 ? o.net / o.orders : 0,
  };
}

export interface DailySalesRow { date: string; orders: number; gross: number; discounts: number; net: number; tax: number; }

/** Sales bucketed by UTC calendar day across the window. */
export function dailySales(db: Database.Database, startISO: string, endISO: string): DailySalesRow[] {
  return db.prepare(`
    SELECT substr(created_at, 1, 10) AS date,
      COUNT(*) AS orders,
      COALESCE(SUM(subtotal), 0) AS gross,
      COALESCE(SUM(discount_amount), 0) AS discounts,
      COALESCE(SUM(total), 0) AS net,
      COALESCE(SUM(tax_amount), 0) AS tax
    FROM orders WHERE created_at >= ? AND created_at < ? AND ${ACTIVE_ORDER}
    GROUP BY date ORDER BY date
  `).all(startISO, endISO) as DailySalesRow[];
}

export interface HourlySalesRow { hour: number; orders: number; net: number; itemsSold: number; }

/**
 * Sales bucketed by hour-of-day (0–23) in the tenant's timezone. `tzOffsetMin`
 * is the store's UTC offset in minutes (business-local hour, not server/UTC).
 */
export function hourlySales(db: Database.Database, startISO: string, endISO: string, tzOffsetMin = 0): HourlySalesRow[] {
  const rows = db.prepare(`
    SELECT o.id, o.created_at,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.${ACTIVE_ITEM}) AS items,
      o.total AS net
    FROM orders o WHERE o.created_at >= ? AND o.created_at < ? AND o.${ACTIVE_ORDER}
  `).all(startISO, endISO) as Array<{ created_at: string; items: number; net: number }>;

  const buckets: HourlySalesRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, net: 0, itemsSold: 0 }));
  for (const r of rows) {
    const local = new Date(new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() + tzOffsetMin * 60_000);
    const h = local.getUTCHours();
    buckets[h].orders += 1;
    buckets[h].net += Number(r.net) || 0;
    buckets[h].itemsSold += Number(r.items) || 0;
  }
  return buckets;
}

export interface DowSalesRow { dow: number; orders: number; net: number; itemsSold: number; }

/** Sales bucketed by local day-of-week (0=Monday … 6=Sunday). */
export function dayOfWeekSales(db: Database.Database, startISO: string, endISO: string, tzOffsetMin = 0): DowSalesRow[] {
  const rows = db.prepare(`
    SELECT o.created_at,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.${ACTIVE_ITEM}) AS items,
      o.total AS net
    FROM orders o WHERE o.created_at >= ? AND o.created_at < ? AND o.${ACTIVE_ORDER}
  `).all(startISO, endISO) as Array<{ created_at: string; items: number; net: number }>;

  const buckets: DowSalesRow[] = Array.from({ length: 7 }, (_, dow) => ({ dow, orders: 0, net: 0, itemsSold: 0 }));
  for (const r of rows) {
    const local = new Date(new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() + tzOffsetMin * 60_000);
    const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
    buckets[dow].orders += 1;
    buckets[dow].net += Number(r.net) || 0;
    buckets[dow].itemsSold += Number(r.items) || 0;
  }
  return buckets;
}
