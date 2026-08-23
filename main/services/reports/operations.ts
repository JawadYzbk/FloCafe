/**
 * Operational aggregations: order type/status mix, discounts, voids and
 * per-employee sales. All exclude cancelled orders except where a breakdown is
 * explicitly about cancellations/voids.
 */
import type Database from 'better-sqlite3';

const ACTIVE_ORDER = `status != 'cancelled'`;

export interface OrderTypeRow { type: string; orders: number; net: number; itemsSold: number; avgOrder: number; }

export function orderTypeBreakdown(db: Database.Database, startISO: string, endISO: string): OrderTypeRow[] {
  const rows = db.prepare(`
    SELECT type, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS net, COALESCE(SUM(items), 0) AS itemsSold
    FROM (
      SELECT o.id,
        COALESCE(NULLIF(o.type, ''), 'unknown') AS type,
        o.total,
        (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
          WHERE oi.order_id = o.id AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')) AS items
      FROM orders o WHERE o.created_at >= ? AND o.created_at < ? AND o.${ACTIVE_ORDER}
    ) GROUP BY type ORDER BY net DESC
  `).all(startISO, endISO) as Array<Omit<OrderTypeRow, 'avgOrder'>>;
  return rows.map((r) => ({ ...r, avgOrder: r.orders > 0 ? r.net / r.orders : 0 }));
}

export interface OrderStatusRow { status: string; orders: number; net: number; }

export function orderStatusBreakdown(db: Database.Database, startISO: string, endISO: string): OrderStatusRow[] {
  return db.prepare(`
    SELECT COALESCE(NULLIF(status, ''), 'unknown') AS status, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS net
    FROM orders WHERE created_at >= ? AND created_at < ?
    GROUP BY status ORDER BY orders DESC
  `).all(startISO, endISO) as OrderStatusRow[];
}

export interface DiscountReport {
  total: number;
  discountedOrders: number;
  byReason: Array<{ reason: string; count: number; total: number }>;
  byStaff: Array<{ user_id: string | null; staff_name: string | null; count: number; total: number }>;
}

export function discountReport(db: Database.Database, startISO: string, endISO: string): DiscountReport {
  const head = db.prepare(`
    SELECT COALESCE(SUM(discount_amount), 0) AS total, COUNT(*) AS discountedOrders
    FROM orders WHERE created_at >= ? AND created_at < ? AND ${ACTIVE_ORDER} AND COALESCE(discount_amount, 0) > 0
  `).get(startISO, endISO) as { total: number; discountedOrders: number };
  const byReason = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(discount_reason), ''), '—') AS reason, COUNT(*) AS count, COALESCE(SUM(discount_amount), 0) AS total
    FROM orders WHERE created_at >= ? AND created_at < ? AND ${ACTIVE_ORDER} AND COALESCE(discount_amount, 0) > 0
    GROUP BY reason ORDER BY total DESC
  `).all(startISO, endISO) as DiscountReport['byReason'];
  const byStaff = db.prepare(`
    SELECT o.user_id, u.name AS staff_name, COUNT(*) AS count, COALESCE(SUM(o.discount_amount), 0) AS total
    FROM orders o LEFT JOIN users u ON u.id = o.user_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.${ACTIVE_ORDER} AND COALESCE(o.discount_amount, 0) > 0
    GROUP BY o.user_id ORDER BY total DESC
  `).all(startISO, endISO) as DiscountReport['byStaff'];
  return { total: head.total, discountedOrders: head.discountedOrders, byReason, byStaff };
}

export interface VoidReport {
  voidedItems: number;
  voidValue: number;
  byProduct: Array<{ product_name: string; count: number; value: number }>;
}

// Voids are item-level: a 'voided' line keeps its positive total and a mirrored
// 'void_adjustment' negative line nets it off the bill. We report the voided
// lines' value as the (positive) amount removed.
export function voidReport(db: Database.Database, startISO: string, endISO: string): VoidReport {
  const head = db.prepare(`
    SELECT COUNT(*) AS voidedItems, COALESCE(SUM(ABS(oi.total)), 0) AS voidValue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND oi.status = 'voided'
  `).get(startISO, endISO) as { voidedItems: number; voidValue: number };
  const byProduct = db.prepare(`
    SELECT oi.product_name, COUNT(*) AS count, COALESCE(SUM(ABS(oi.total)), 0) AS value
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND oi.status = 'voided'
    GROUP BY oi.product_name ORDER BY value DESC
  `).all(startISO, endISO) as VoidReport['byProduct'];
  return { voidedItems: head.voidedItems, voidValue: head.voidValue, byProduct };
}

export interface StaffSalesRow {
  user_id: string | null;
  staff_name: string | null;
  orders: number;
  net: number;
  itemsSold: number;
  discounts: number;
  avgOrder: number;
}

export function staffSales(db: Database.Database, startISO: string, endISO: string): StaffSalesRow[] {
  const rows = db.prepare(`
    SELECT o.user_id, u.name AS staff_name,
      COUNT(*) AS orders,
      COALESCE(SUM(o.total), 0) AS net,
      COALESCE(SUM(o.discount_amount), 0) AS discounts,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
        WHERE oi.order_id = o.id AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')) AS itemsSold
    FROM orders o LEFT JOIN users u ON u.id = o.user_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.${ACTIVE_ORDER}
    GROUP BY o.user_id ORDER BY net DESC
  `).all(startISO, endISO) as Array<Omit<StaffSalesRow, 'avgOrder'>>;
  return rows.map((r) => ({ ...r, avgOrder: r.orders > 0 ? r.net / r.orders : 0 }));
}
