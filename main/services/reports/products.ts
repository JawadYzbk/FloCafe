/**
 * Product, category and modifier aggregations.
 *
 * Revenue convention (consistent across the whole reporting system):
 *   - product/category "revenue" = Σ order_items.subtotal (the base line, which
 *     excludes modifier/add-on prices).
 *   - modifier "revenue" = Σ order_item_addons.price × quantity, reported
 *     separately so add-on revenue is never double-counted against products.
 *
 * COGS/profit use the cost snapshotted onto each line at sale time
 * (order_items.unit_cost, migration v77), falling back to the current
 * products.cost only for rows written before that migration. Revenue, tax and
 * quantities also come from per-line snapshots — all historically accurate.
 */
import type Database from 'better-sqlite3';

const ACTIVE = `o.status != 'cancelled' AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')`;

export interface ProductSalesRow {
  product_id: string | null;
  product_name: string;
  quantity: number;
  revenue: number;
  cost: number;
  profit: number;
  margin: number; // 0..1
}

export function productSales(db: Database.Database, startISO: string, endISO: string, limit = 500): ProductSalesRow[] {
  const rows = db.prepare(`
    SELECT oi.product_id, oi.product_name,
      SUM(oi.quantity) AS quantity,
      COALESCE(SUM(oi.subtotal), 0) AS revenue,
      COALESCE(SUM(oi.quantity * COALESCE(oi.unit_cost, p.cost, 0)), 0) AS cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.created_at >= ? AND o.created_at < ? AND ${ACTIVE}
    GROUP BY oi.product_name, oi.product_id
    ORDER BY quantity DESC
    LIMIT ?
  `).all(startISO, endISO, limit) as Array<Omit<ProductSalesRow, 'profit' | 'margin'>>;
  return rows.map((r) => {
    const profit = r.revenue - r.cost;
    return { ...r, profit, margin: r.revenue > 0 ? profit / r.revenue : 0 };
  });
}

export interface CategorySalesRow {
  category: string;
  quantity: number;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
}

export function categorySales(db: Database.Database, startISO: string, endISO: string): CategorySalesRow[] {
  const rows = db.prepare(`
    SELECT COALESCE(c.name, '—') AS category,
      SUM(oi.quantity) AS quantity,
      COALESCE(SUM(oi.subtotal), 0) AS revenue,
      COALESCE(SUM(oi.quantity * COALESCE(oi.unit_cost, p.cost, 0)), 0) AS cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE o.created_at >= ? AND o.created_at < ? AND ${ACTIVE}
    GROUP BY category
    ORDER BY revenue DESC
  `).all(startISO, endISO) as Array<Omit<CategorySalesRow, 'profit' | 'margin'>>;
  return rows.map((r) => {
    const profit = r.revenue - r.cost;
    return { ...r, profit, margin: r.revenue > 0 ? profit / r.revenue : 0 };
  });
}

export interface ModifierSalesRow {
  addon_id: string | null;
  addon_name: string;
  quantity: number;
  revenue: number;
  uses: number; // distinct item lines the modifier was attached to
  attachmentRate: number; // uses / active item lines
}

export function modifierSales(db: Database.Database, startISO: string, endISO: string): ModifierSalesRow[] {
  const activeItemLines = (db.prepare(`
    SELECT COUNT(*) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND ${ACTIVE}
  `).get(startISO, endISO) as { n: number }).n || 0;

  const rows = db.prepare(`
    SELECT a.addon_id, a.addon_name,
      COALESCE(SUM(a.quantity), 0) AS quantity,
      COALESCE(SUM(a.price * a.quantity), 0) AS revenue,
      COUNT(DISTINCT a.order_item_id) AS uses
    FROM order_item_addons a
    JOIN order_items oi ON oi.id = a.order_item_id
    JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND ${ACTIVE}
    GROUP BY a.addon_name, a.addon_id
    ORDER BY quantity DESC
  `).all(startISO, endISO) as Array<Omit<ModifierSalesRow, 'attachmentRate'>>;
  return rows.map((r) => ({ ...r, attachmentRate: activeItemLines > 0 ? r.uses / activeItemLines : 0 }));
}
