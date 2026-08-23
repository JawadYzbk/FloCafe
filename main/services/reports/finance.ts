/**
 * Financial aggregations: payment-method breakdown, expenses, and profit & loss.
 *
 * Accounting terms are kept distinct (see docs/reporting.md):
 *   Net Sales           = Σ orders.total (payable)      — a sales figure
 *   Collected           = Σ bills.paid_amount           — a cash figure
 *   COGS                = Σ order_items.qty × products.cost (current cost)
 *   Gross Profit        = Net Sales − COGS
 *   Operating Expenses  = Σ expenses.amount (expenses module)
 *   Net Operating Profit= Gross Profit − Operating Expenses
 */
import type Database from 'better-sqlite3';

const ACTIVE = `o.status != 'cancelled' AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')`;

export interface PaymentMethodRow { method: string; amount: number; count: number; }

/**
 * Split-payment aware breakdown by method. Reads bill payment_details (a JSON
 * array of {method, amount}); an order paying part cash + part card contributes
 * one line to each method while the order itself is counted once elsewhere.
 * Amounts are the recorded base-currency figures.
 */
export function paymentBreakdown(db: Database.Database, startISO: string, endISO: string): PaymentMethodRow[] {
  return db.prepare(`
    WITH lines AS (
      SELECT je.value AS line
      FROM bills b
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
        WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.created_at >= ? AND b.created_at < ?
    )
    SELECT COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
      COUNT(*) AS count,
      COALESCE(SUM(json_extract(line, '$.amount')), 0) AS amount
    FROM lines
    GROUP BY method ORDER BY amount DESC
  `).all(startISO, endISO) as PaymentMethodRow[];
}

export interface ExpenseSummary {
  total: number;
  byCategory: Array<{ category: string; count: number; total: number }>;
}

export function expensesSummary(db: Database.Database, startDate: string, endDate: string): ExpenseSummary {
  const total = (db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE date(incurred_at) >= date(?) AND date(incurred_at) <= date(?)`,
  ).get(startDate, endDate) as { t: number }).t;
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM expenses WHERE date(incurred_at) >= date(?) AND date(incurred_at) <= date(?)
    GROUP BY category ORDER BY total DESC
  `).all(startDate, endDate) as ExpenseSummary['byCategory'];
  return { total, byCategory };
}

export interface ProfitAndLoss {
  netSales: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number; // 0..1
  operatingExpenses: number;
  netOperatingProfit: number;
}

export function profitAndLoss(
  db: Database.Database,
  boundsISO: [string, string],
  range: { startDate: string; endDate: string },
): ProfitAndLoss {
  const [startISO, endISO] = boundsISO;
  const netSales = (db.prepare(
    `SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'`,
  ).get(startISO, endISO) as { n: number }).n;
  const cogs = (db.prepare(`
    SELECT COALESCE(SUM(oi.quantity * COALESCE(oi.unit_cost, p.cost, 0)), 0) AS c
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.created_at >= ? AND o.created_at < ? AND ${ACTIVE}
  `).get(startISO, endISO) as { c: number }).c;
  const operatingExpenses = expensesSummary(db, range.startDate, range.endDate).total;
  const grossProfit = netSales - cogs;
  return {
    netSales, cogs, grossProfit,
    grossMargin: netSales > 0 ? grossProfit / netSales : 0,
    operatingExpenses,
    netOperatingProfit: grossProfit - operatingExpenses,
  };
}
