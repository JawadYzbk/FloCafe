import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { getDatabase, getSettingValue, parseDbTimestamp, utcDayBounds, utcTodayDate } from '../db';
import { requireRole } from '../middleware/security';
import { getOrdersWithItemsForBills } from './bills';
import { aggregateTaxComponents } from '../services/tax-components';
import {
  resolveRange, reportMeta, buildOverview,
  salesSummary, dailySales, hourlySales, dayOfWeekSales,
  productSales, categorySales, modifierSales,
  orderTypeBreakdown, orderStatusBreakdown, discountReport, voidReport, staffSales,
  paymentBreakdown, expensesSummary, profitAndLoss, storeTzOffset,
} from '../services/reports';

const router = Router();

/** Resolve a report window (+ optional comparison) from query params. */
function resolvedRange(req: Request) {
  return resolveRange({
    preset: typeof req.query.preset === 'string' ? req.query.preset : undefined,
    start_date: req.query.start_date,
    end_date: req.query.end_date,
    compare: req.query.compare,
  });
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function reportDate(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

/**
 * Buckets order timestamps into local hour-of-day (0-23) and local
 * day-of-week (0=Sunday..6=Saturday), using the tenant's configured
 * timezone rather than server/UTC time — otherwise "busiest hour" would
 * reflect UTC, not when the restaurant is actually busy. SQLite has no
 * IANA timezone support (only fixed offsets), so this bucketing happens
 * in JS via Intl instead of in SQL.
 */
function bucketByLocalHourAndWeekday(timestamps: string[], timeZone: string): { hourCounts: number[]; dayCounts: number[] } {
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' });

  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const ts of timestamps) {
    const d = parseDbTimestamp(ts);
    if (isNaN(d.getTime())) continue;
    const hour = parseInt(hourFmt.format(d), 10);
    if (hour >= 0 && hour <= 23) hourCounts[hour]++;
    const dayIdx = WEEKDAY_NAMES.indexOf(weekdayFmt.format(d));
    if (dayIdx >= 0) dayCounts[dayIdx]++;
  }

  return { hourCounts, dayCounts };
}

/**
 * Return payment lines in a UTC half-open range using SQLite JSON1. Keeping
 * expansion in SQL avoids loading every bill and tolerates both the current
 * array shape, legacy top-level objects, and invalid JSON.
 */
function paymentMethodBreakdown(
  db: ReturnType<typeof getDatabase>,
  startDate: string,
  endDate = startDate,
  paidOnly = false,
) {
  const start = utcDayBounds(startDate)[0];
  const end = utcDayBounds(endDate)[1];
  return db.prepare(`
    WITH payment_lines AS (
      SELECT b.paid_at, b.created_at, je.value AS line
      FROM bills b
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
          THEN b.payment_details
        WHEN json_valid(b.payment_details)
          THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.payment_details IS NOT NULL
        AND b.created_at < ?
        AND (b.paid_at IS NULL OR b.paid_at >= ?)
        AND (? = 0 OR b.payment_status = 'paid')
        AND json_type(je.value) = 'object'
    ), normalized AS (
      SELECT
        COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
        CAST(json_extract(line, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(json_extract(line, '$.timestamp'), '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
    )
    SELECT COALESCE(pm.name, normalized.method) AS method, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END), 0) AS total
    FROM normalized LEFT JOIN payment_methods pm ON pm.id = normalized.payment_method_id
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    GROUP BY COALESCE(pm.name, normalized.method)
    ORDER BY total DESC
  `).all(end, start, paidOnly ? 1 : 0, start, end);
}

/** argmax/argmin over counts, restricted to indices where include(count) is true. Returns null if nothing qualifies. */
function pickExtreme(counts: number[], mode: 'max' | 'min', include: (count: number) => boolean): { index: number; count: number } | null {
  let best: { index: number; count: number } | null = null;
  counts.forEach((count, index) => {
    if (!include(count)) return;
    if (!best || (mode === 'max' ? count > best.count : count < best.count)) {
      best = { index, count };
    }
  });
  return best;
}

router.get('/daily-stats', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const [start, end] = utcDayBounds(today);
    const salesToday = db.prepare(`
      SELECT COALESCE(SUM(paid_amount), 0) AS sales
      FROM bills WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { sales: number };
    const paymentMethodsToday = paymentMethodBreakdown(db, today) as { total: number }[];

    const runningOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'preparing')
    `).get() as { count: number };

    const pendingOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status = 'pending'
    `).get() as { count: number };

    const tablesOccupied = db.prepare(`
      SELECT COUNT(*) as count FROM tables WHERE status = 'occupied'
    `).get() as { count: number };

    res.json({
      sales: salesToday.sales,
      runningOrders: runningOrders.count,
      pendingOrders: pendingOrders.count,
      tablesOccupied: tablesOccupied.count,
      paymentMethods: paymentMethodsToday,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/summary', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    // #208: an explicit date param is a UTC `YYYY-MM-DD`; resolve to the
    // half-open UTC range. `reportDate` validates the param shape.
    const date = reportDate(req.query.date, utcTodayDate());
    const [start, end] = utcDayBounds(date);

    const ordersToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM orders WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number; total: number };

    const billsToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total,
        COALESCE(SUM(paid_amount), 0) as collected
      FROM bills WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number; total: number; collected: number };
    const paymentMethodsToday = paymentMethodBreakdown(db, date);

    const customersToday = db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number };

    const ordersByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status
    `).all(start, end);

    res.json({
      summary: {
        date,
        orders: { count: ordersToday.count, total: ordersToday.total },
        bills: { count: billsToday.count, total: billsToday.total, collected: billsToday.collected },
        customers: { new: customersToday.count },
        ordersByStatus,
        paymentMethods: paymentMethodsToday,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Unified ERP-style financial report over a date range: sales, payment-method
// breakdown, expenses, profit & loss, per-staff sales, item/category sales, and
// a shift summary — everything connected in one payload so the Reports screen
// and any accounting export see a single consistent picture of a period.
router.get('/financial', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const startDate = reportDate(req.query.start_date, utcTodayDate());
    const endDate = reportDate(req.query.end_date, startDate);
    const start = utcDayBounds(startDate)[0];
    const end = utcDayBounds(endDate)[1];

    // Sales — exclude cancelled orders. "net" is the order total (incl. tax and
    // charges), "gross" the pre-discount item subtotal.
    const sales = db.prepare(`
      SELECT COUNT(*) AS order_count,
        COALESCE(SUM(subtotal), 0) AS gross,
        COALESCE(SUM(discount_amount), 0) AS discounts,
        COALESCE(SUM(tax_amount), 0) AS tax,
        COALESCE(SUM(total), 0) AS net
      FROM orders
      WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'
    `).get(start, end) as { order_count: number; gross: number; discounts: number; tax: number; net: number };
    const collected = (db.prepare(
      `SELECT COALESCE(SUM(paid_amount), 0) AS collected FROM bills WHERE created_at >= ? AND created_at < ?`,
    ).get(start, end) as { collected: number }).collected;

    const payments = paymentMethodBreakdown(db, startDate, endDate, true);

    // Expenses (the expenses module) — compared by local incurred date.
    const expenseTotal = (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE date(incurred_at) >= date(?) AND date(incurred_at) <= date(?)`,
    ).get(startDate, endDate) as { total: number }).total;
    const expensesByCategory = db.prepare(`
      SELECT category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM expenses WHERE date(incurred_at) >= date(?) AND date(incurred_at) <= date(?)
      GROUP BY category ORDER BY total DESC
    `).all(startDate, endDate);

    const staff = db.prepare(`
      SELECT o.user_id, u.name AS staff_name, COUNT(*) AS order_count, COALESCE(SUM(o.total), 0) AS sales
      FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled'
      GROUP BY o.user_id ORDER BY sales DESC
    `).all(start, end);

    const items = db.prepare(`
      SELECT oi.product_name, SUM(oi.quantity) AS quantity, COALESCE(SUM(oi.subtotal), 0) AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled'
        AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')
      GROUP BY oi.product_name ORDER BY quantity DESC LIMIT 200
    `).all(start, end);

    const categories = db.prepare(`
      SELECT COALESCE(c.name, '—') AS category, SUM(oi.quantity) AS quantity, COALESCE(SUM(oi.subtotal), 0) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled'
        AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')
      GROUP BY category ORDER BY revenue DESC
    `).all(start, end);

    const shifts = db.prepare(`
      SELECT COUNT(*) AS count,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count
      FROM shifts WHERE opened_at >= ? AND opened_at < ?
    `).get(start, end);

    const revenue = Number(sales.net) || 0;
    res.json({
      period: { start_date: startDate, end_date: endDate },
      sales: { ...sales, collected },
      payments,
      expenses: { total: expenseTotal, by_category: expensesByCategory },
      profit: { revenue, expenses: expenseTotal, net: revenue - expenseTotal },
      staff,
      items,
      categories,
      shifts,
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dynamic tax-component report for receipt/report consumers. Components are
// derived item by item so mixed legacy + categorized bills cannot double-count
// the categorized portion already present in the bill-level tax_breakdown.
router.get('/tax-components', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const windowStart = utcDayBounds(startDate)[0];
    const windowEnd = utcDayBounds(endDate)[1];

    const bills = db.prepare(`
      SELECT b.*
      FROM bills b
      JOIN orders o ON o.id = b.order_id
      WHERE b.created_at >= ? AND b.created_at < ?
        AND o.status != 'cancelled'
      ORDER BY b.created_at, b.id
    `).all(windowStart, windowEnd) as any[];

    const orders = getOrdersWithItemsForBills(db, bills);
    const documents = bills.map((bill) => ({
      tax_amount: bill.tax_amount,
      tax_snapshot: bill.tax_snapshot,
      tax_breakdown: bill.tax_breakdown,
      items: orders.get(Number(bill.id))?.items || [],
    }));
    const taxAmount = bills.reduce(
      (sum, bill) => sum.plus(bill.tax_amount || 0),
      new Decimal(0),
    );

    res.json({
      taxComponents: {
        startDate,
        endDate,
        billCount: bills.length,
        taxAmount: taxAmount.toDecimalPlaces(6).toNumber(),
        components: aggregateTaxComponents(documents),
      },
    });
  } catch (error: any) {
    console.error('[API] Tax component report failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sales', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    // #208: half-open UTC ranges so the orders/bills indexes apply instead
    // of `date(...)` on every row. All day boundaries are UTC.
    const windowStart = utcDayBounds(startDate)[0];
    const windowEnd = utcDayBounds(endDate)[1];

    // Daily series bucketed by UTC day (substr of the stored UTC timestamp) —
    // same labels the previous `date(created_at)` produced, at index cost.
    const dailySales = db.prepare(`
      SELECT substr(created_at, 1, 10) as date, COUNT(*) as orders, SUM(total) as sales
      FROM orders
      WHERE created_at >= ? AND created_at < ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY date
    `).all(windowStart, windowEnd);

    const byPaymentMethod = paymentMethodBreakdown(db, startDate, endDate, true) as { method: string; count: number; total: number }[];

    const byOrderType = db.prepare(`
      SELECT type, COUNT(*) as count, SUM(total) as total
      FROM orders
      WHERE created_at >= ? AND created_at < ?
      GROUP BY type
    `).all(windowStart, windowEnd);

    res.json({
      sales: {
        startDate,
        endDate,
        dailySales,
        byPaymentMethod,
        byOrderType,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/topProducts', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 10;
    const windowStart = utcDayBounds(startDate)[0];
    const windowEnd = utcDayBounds(endDate)[1];

    const topProducts = db.prepare(`
      SELECT oi.product_id, oi.product_name,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.subtotal) as total_revenue,
        COUNT(DISTINCT oi.order_id) as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at >= ? AND o.created_at < ?
      GROUP BY oi.product_id
      ORDER BY total_quantity DESC
      LIMIT ?
    `).all(windowStart, windowEnd, limit);

    res.json({ topProducts });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/recentOrders', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
    const date = req.query.date === undefined ? undefined : reportDate(req.query.date, '');
    if (req.query.date !== undefined && !date) {
      return res.status(400).json({ error: 'date must use YYYY-MM-DD format' });
    }

    // Without a date, "most recent overall" (dashboard live view). With one,
    // scoped to that day — lets the dashboard show a past day's orders
    // instead of always the latest regardless of which date is selected.
    // #208: range filter hits idx_orders_created_at instead of full scan.
    const params: any[] = [];
    let where = '';
    if (date) {
      const [s, e] = utcDayBounds(date);
      where = 'WHERE o.created_at >= ? AND o.created_at < ?';
      params.push(s, e);
    }

    const recentOrders = db.prepare(`
      SELECT o.*, t.number as table_name, c.name as customer_name
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN customers c ON o.customer_id = c.id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT ?
    `).all(...params, limit);

    // #208: batch all items in one IN() query instead of per-order N+1.
    const orderIds = recentOrders.map((o: any) => o.id);
    const itemsByOrder = new Map<number, any[]>();
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, id`).all(...orderIds);
      for (const item of items as any[]) {
        const list = itemsByOrder.get(item.order_id) || [];
        list.push(item);
        itemsByOrder.set(item.order_id, list);
      }
    }
    const ordersWithItems = recentOrders.map((order: any) => ({
      ...order,
      items: itemsByOrder.get(order.id) || [],
    }));

    res.json({ recentOrders: ordersWithItems });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/tables', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const [start, end] = utcDayBounds(utcTodayDate());

    const tableStats = db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_revenue,
        MAX(o.created_at) as last_order_at
      FROM tables t
      LEFT JOIN orders o ON t.id = o.table_id
        AND o.created_at >= ? AND o.created_at < ?
      GROUP BY t.id
    `).all(start, end);

    const tableUtilization = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) as reserved,
        SUM(CASE WHEN status = 'cleaning' THEN 1 ELSE 0 END) as cleaning,
        COUNT(*) as total
      FROM tables
    `).get();

    res.json({
      tableStats,
      tableUtilization
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /insights — dashboard metrics beyond today's snapshot ──────────────
// AOV, top staff, top categories, busiest/idlest hour & day-of-week, and
// average kitchen prep time, aggregated over a trailing window (default 30
// days) so hour/day patterns reflect a consistent trend rather than one day.
router.get('/insights', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
    // #208: "N days back" in UTC, with the UTC day range so the window
    // filters on the index. Day boundaries are UTC; the tenant timezone only
    // drives the hour/day-of-week bucketing below.
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const timeZone = getSettingValue('timezone') || 'Asia/Kolkata';
    const [windowStart] = utcDayBounds(startDate);

    // AOV — same revenue basis ("paid bills") as the existing daily-stats tile.
    const revenue = db.prepare(`
      SELECT COUNT(*) as billCount, COALESCE(SUM(paid_amount), 0) as total
      FROM bills
      WHERE payment_status = 'paid' AND paid_at >= ?
    `).get(windowStart) as { billCount: number; total: number };
    const aov = revenue.billCount > 0 ? revenue.total / revenue.billCount : 0;

    // Kitchen velocity — substitutes for "best cook", which isn't derivable:
    // order_items has no per-chef attribution (marking an item ready doesn't
    // record who did it), so there's no data to rank individual cooks by.
    // Average prep time is the closest real signal for kitchen performance.
    const prepTime = db.prepare(`
      SELECT AVG((julianday(ready_at) - julianday(cooking_started_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM orders
      WHERE cooking_started_at IS NOT NULL AND ready_at IS NOT NULL
        AND created_at >= ? AND status != 'cancelled'
    `).get(windowStart) as { avgMinutes: number | null; sampleSize: number };

    // Top staff by revenue — covers whoever creates orders (owner/manager/
    // cashier/server, per POST /orders' own role gate), i.e. "best cashier".
    const topStaff = db.prepare(`
      SELECT u.id as user_id, u.name, u.role,
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(o.id) as orderCount
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.created_at >= ? AND o.status != 'cancelled'
      GROUP BY u.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(windowStart);

    // Top categories by revenue.
    const topCategories = db.prepare(`
      SELECT c.id as category_id, COALESCE(c.name, 'Uncategorized') as name,
        COALESCE(SUM(oi.quantity), 0) as quantity,
        COALESCE(SUM(oi.subtotal), 0) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.created_at >= ? AND oi.status != 'cancelled'
      GROUP BY c.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(windowStart);

    // Busiest/idlest hour & day-of-week, bucketed in the tenant's local timezone.
    const orderTimestamps = (db.prepare(
      `SELECT created_at FROM orders WHERE created_at >= ? AND status != 'cancelled'`
    ).all(windowStart) as { created_at: string }[]).map((r) => r.created_at);

    const { hourCounts, dayCounts } = bucketByLocalHourAndWeekday(orderTimestamps, timeZone);

    // Hours with zero orders are excluded from busiest/idlest — almost
    // certainly "closed overnight" rather than a meaningful idle signal,
    // and would otherwise trivially always "win" idlest hour.
    const busiestHour = pickExtreme(hourCounts, 'max', (c) => c > 0);
    const idlestHour = pickExtreme(hourCounts, 'min', (c) => c > 0);

    // Day-of-week zero counts ARE kept — "closed Mondays" is a real,
    // useful signal, unlike an overnight hour with no foot traffic.
    const busiestDay = pickExtreme(dayCounts, 'max', () => true);
    const idlestDay = pickExtreme(dayCounts, 'min', () => true);

    res.json({
      windowDays: days,
      aov,
      ordersAnalyzed: orderTimestamps.length,
      avgPrepTimeMinutes: prepTime.sampleSize > 0 && prepTime.avgMinutes !== null ? Math.round(prepTime.avgMinutes) : null,
      topStaff,
      topCategories,
      busiestHour: busiestHour ? { hour: busiestHour.index, orderCount: busiestHour.count } : null,
      idlestHour: idlestHour ? { hour: idlestHour.index, orderCount: idlestHour.count } : null,
      busiestDayOfWeek: busiestDay ? { dayIndex: busiestDay.index, orderCount: busiestDay.count } : null,
      idlestDayOfWeek: idlestDay ? { dayIndex: idlestDay.index, orderCount: idlestDay.count } : null,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Reporting engine endpoints (main/services/reports) ───────────────────────
// Thin handlers: resolve the window, call the authoritative engine, return it.
// All are owner/manager (financial data). Every response carries `meta` (range,
// timezone, generatedAt) so the UI and exports agree on the window.

const ownerManager = requireRole('owner', 'manager');
function withMeta<T extends object>(req: Request, build: (bounds: [string, string], range: { startDate: string; endDate: string }, tz: number) => T) {
  const r = resolvedRange(req);
  return { meta: reportMeta(r), ...build(r.bounds, r.range, storeTzOffset()) } as { meta: ReturnType<typeof reportMeta> } & T;
}
function guard(res: Response, fn: () => unknown) {
  try { res.json(fn()); } catch (error: any) { console.error('[API] Internal error:', error); res.status(500).json({ error: 'Internal server error' }); }
}

// Executive overview / dashboard — everything from one window.
router.get('/overview', ownerManager, (req, res) => guard(res, () => buildOverview(getDatabase(), resolvedRange(req))));

router.get('/sales-summary', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ summary: salesSummary(getDatabase(), b[0], b[1]) }))));
router.get('/daily', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ daily: dailySales(getDatabase(), b[0], b[1]) }))));
router.get('/hourly', ownerManager, (req, res) => guard(res, () => withMeta(req, (b, _r, tz) => ({ hourly: hourlySales(getDatabase(), b[0], b[1], tz) }))));
router.get('/day-of-week', ownerManager, (req, res) => guard(res, () => withMeta(req, (b, _r, tz) => ({ dayOfWeek: dayOfWeekSales(getDatabase(), b[0], b[1], tz) }))));
router.get('/products', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ products: productSales(getDatabase(), b[0], b[1]) }))));
router.get('/categories', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ categories: categorySales(getDatabase(), b[0], b[1]) }))));
router.get('/modifiers', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ modifiers: modifierSales(getDatabase(), b[0], b[1]) }))));
router.get('/order-types', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ orderTypes: orderTypeBreakdown(getDatabase(), b[0], b[1]), orderStatuses: orderStatusBreakdown(getDatabase(), b[0], b[1]) }))));
router.get('/discounts', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ discounts: discountReport(getDatabase(), b[0], b[1]) }))));
router.get('/voids', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ voids: voidReport(getDatabase(), b[0], b[1]) }))));
router.get('/staff', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ staff: staffSales(getDatabase(), b[0], b[1]) }))));
router.get('/payments', ownerManager, (req, res) => guard(res, () => withMeta(req, (b) => ({ payments: paymentBreakdown(getDatabase(), b[0], b[1]) }))));
router.get('/profit-loss', ownerManager, (req, res) => guard(res, () => withMeta(req, (b, r) => ({ profit: profitAndLoss(getDatabase(), b, r), expenses: expensesSummary(getDatabase(), r.startDate, r.endDate) }))));

export const reportRoutes = router;
