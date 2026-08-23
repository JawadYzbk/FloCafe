/**
 * Unit tests for the reporting engine (main/services/reports): authoritative
 * sales/product/payment/P&L aggregations, date-range math, and empty-data
 * behavior. Runs against a seeded temp database via initDatabase().
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-engine-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, now } = require('../main/db');
const R = require('../main/services/reports');

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function eq(a: any, b: any, msg: string) {
  const pass = Math.abs(Number(a) - Number(b)) < 1e-6 || a === b;
  if (pass) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
function isAbiMismatch(e: any): boolean {
  return e?.code === 'ERR_DLOPEN_FAILED' && String(e?.message || '').includes('NODE_MODULE_VERSION');
}

function seed() {
  const db = getDatabase();
  const t = now();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('u1','Owner','o@t.local','x','owner',1,?,?)`).run(t, t);
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1','Coffee',?,?)`).run(t, t);
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, created_at, updated_at) VALUES ('p1','c1','Latte',5,3,?,?)`).run(t, t);
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, created_at, updated_at) VALUES ('p2','c1','Cake',20,5,?,?)`).run(t, t);

  const D = '2026-01-15 10:00:00';
  const mkOrder = (id: number, num: string, status: string, subtotal: number, discount: number, tax: number, total: number) =>
    db.prepare(`INSERT INTO orders (id, order_number, user_id, type, status, subtotal, tax_amount, discount_amount, total, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, num, 'u1', 'dine_in', status, subtotal, tax, discount, total, D, D);
  const mkItem = (order: number, pid: string, pname: string, price: number, qty: number, subtotal: number, total: number, status: string) =>
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, discount_amount, total, status, created_at, updated_at) VALUES (?,?,?,?,?,?,0,0,?,?,?,?)`)
      .run(order, pid, pname, price, qty, subtotal, total, status, D, D);
  const mkBill = (order: number, num: string, total: number, paid: number, details: any) =>
    db.prepare(`INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, discount_amount, total, paid_amount, payment_status, payment_details, created_at, updated_at) VALUES (?,?,?,0,0,?,?,'paid',?,?,?)`)
      .run(order, num, total, total, paid, JSON.stringify(details), D, D);

  mkOrder(1, 'A', 'completed', 10, 2, 1, 9);
  mkItem(1, 'p1', 'Latte', 5, 2, 10, 9, 'completed');
  mkBill(1, 'BA', 9, 9, [{ method: 'cash', amount: 9 }]);

  mkOrder(2, 'B', 'completed', 20, 0, 2, 22);
  mkItem(2, 'p2', 'Cake', 20, 1, 20, 22, 'completed');
  mkItem(2, 'p1', 'Latte', 5, 1, 5, 5, 'voided');
  mkBill(2, 'BB', 22, 22, [{ method: 'cash', amount: 10 }, { method: 'card', amount: 12 }]);

  mkOrder(3, 'C', 'cancelled', 100, 0, 0, 100); // excluded from sales

  db.prepare(`INSERT INTO expenses (category, amount, incurred_at, created_at, updated_at) VALUES ('salary', 8, '2026-01-15', ?, ?)`).run(t, t);
}

async function main() {
  console.log('Reporting engine');
  console.log('='.repeat(40));
  try { initDatabase(); } catch (e: any) {
    if (isAbiMismatch(e)) { console.log('  ⏭ Skipping: better-sqlite3 ABI mismatch'); process.exit(77); }
    throw e;
  }
  const db = getDatabase();
  seed();

  const [start, end] = R.rangeToBounds({ startDate: '2026-01-15', endDate: '2026-01-15' });

  const s = R.salesSummary(db, start, end);
  eq(s.gross, 30, 'gross = Σ subtotal (excl. cancelled)');
  eq(s.discounts, 2, 'discounts');
  eq(s.tax, 3, 'tax');
  eq(s.net, 31, 'net = Σ total');
  eq(s.orders, 2, 'orders excludes cancelled');
  eq(s.itemsSold, 3, 'itemsSold excludes voided line');
  eq(s.avgOrder, 15.5, 'avgOrder = net / orders');
  eq(s.collected, 31, 'collected = Σ paid_amount');

  const prod = R.productSales(db, start, end);
  const p1 = prod.find((p: any) => p.product_id === 'p1');
  const p2 = prod.find((p: any) => p.product_id === 'p2');
  eq(p1.quantity, 2, 'p1 quantity');
  eq(p1.revenue, 10, 'p1 revenue = Σ subtotal');
  eq(p1.cost, 6, 'p1 cost = qty × products.cost');
  eq(p1.profit, 4, 'p1 profit = revenue − cost');
  eq(p2.profit, 15, 'p2 profit');

  const cats = R.categorySales(db, start, end);
  eq(cats[0].category, 'Coffee', 'category name resolved');
  eq(cats.reduce((a: number, c: any) => a + c.revenue, 0), 30, 'category revenue totals to gross');

  const pay = R.paymentBreakdown(db, start, end);
  const cash = pay.find((p: any) => p.method === 'cash');
  const card = pay.find((p: any) => p.method === 'card');
  eq(cash.amount, 19, 'cash = 9 + split 10 (split-aware)');
  eq(card.amount, 12, 'card = split 12');

  const voids = R.voidReport(db, start, end);
  eq(voids.voidedItems, 1, 'one voided item');
  eq(voids.voidValue, 5, 'void value = |total|');

  const pnl = R.profitAndLoss(db, [start, end], { startDate: '2026-01-15', endDate: '2026-01-15' });
  eq(pnl.netSales, 31, 'P&L net sales');
  eq(pnl.cogs, 11, 'P&L COGS = 6 + 5');
  eq(pnl.grossProfit, 20, 'P&L gross profit');
  eq(pnl.operatingExpenses, 8, 'P&L operating expenses');
  eq(pnl.netOperatingProfit, 12, 'P&L net operating profit = 20 − 8');

  // Date-range math
  eq(R.resolvePreset('yesterday', {}, '2026-01-16').startDate, '2026-01-15', 'yesterday preset');
  const prev = R.previousEquivalent({ startDate: '2026-01-15', endDate: '2026-01-15' });
  eq(prev.startDate, '2026-01-14', 'previousEquivalent start');
  eq(R.rangeDays({ startDate: '2026-01-15', endDate: '2026-01-17' }), 3, 'rangeDays inclusive');

  // Cost snapshot (v77): a line's stored unit_cost wins over the current
  // products.cost, so profit stays accurate after a later cost change.
  const D2 = '2026-02-01 12:00:00';
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, created_at, updated_at) VALUES ('p3','c1','Mocha',8,100,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO orders (id, order_number, user_id, type, status, subtotal, tax_amount, discount_amount, total, created_at, updated_at) VALUES (10,'D','u1','dine_in','completed',8,0,0,8,?,?)`).run(D2, D2);
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, unit_cost, quantity, subtotal, tax_amount, discount_amount, total, status, created_at, updated_at) VALUES (10,'p3','Mocha',8,2,1,8,0,0,8,'completed',?,?)`).run(D2, D2);
  const [fs, fe2] = R.rangeToBounds({ startDate: '2026-02-01', endDate: '2026-02-01' });
  const snap = R.productSales(db, fs, fe2).find((p: any) => p.product_id === 'p3');
  eq(snap.cost, 2, 'COGS uses snapshotted unit_cost (2), not current products.cost (100)');
  eq(snap.profit, 6, 'profit reflects the historical cost snapshot');

  // Empty window
  const [es, ee] = R.rangeToBounds({ startDate: '2020-01-01', endDate: '2020-01-01' });
  const empty = R.salesSummary(db, es, ee);
  eq(empty.net, 0, 'empty window net = 0');
  eq(empty.orders, 0, 'empty window orders = 0');
  eq(empty.avgOrder, 0, 'empty window avgOrder = 0 (no divide-by-zero)');

  console.log('='.repeat(40));
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  ok(failed === 0, 'all reporting-engine checks passed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
