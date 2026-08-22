/**
 * Integration Test: Cash shift reconciliation (USD/LBP)
 *
 * Verifies the shift module counts each physical currency independently:
 * opening float + cash sales (base + secondary tender) + pay-in/out/exchange,
 * and reports the expected balance and variance against the counted cash.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-shifts.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shifts-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual,
  getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { shiftRoutes } = require('../main/routes/shifts');

async function main() {
  console.log('Integration Test: Cash Shift Reconciliation (USD/LBP)');
  console.log('='.repeat(50));

  const db = initTestDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('base_currency', 'USD', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('secondary_currencies', ?, ?)")
    .run(JSON.stringify([{ code: 'LBP', rate: 89000, rate_source: 'manual', rounding: { increment: 1000, mode: 'half_up' } }]), now());

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-s', 'Shift Menu');
  seedProduct(db, 'prod-5', 'cat-s', 'Coffee', 5);
  seedProduct(db, 'prod-10', 'cat-s', 'Meal', 10);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/shifts': shiftRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const pay = async (productId: string, body: any) => {
    const order = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: productId, quantity: 1 }] }, headers: authHeader });
    const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order.data.order.id }, headers: authHeader });
    const res = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payments`, { method: 'POST', body, headers: authHeader });
    assertEqual(res.status, 200, `payment for ${productId} accepted`);
    return res;
  };

  try {
    // No shift open yet.
    const none = await api(baseUrl, '/api/shifts/current', { headers: authHeader });
    assertEqual(none.data.shift, null, 'no shift open initially');

    // Open with a per-currency float.
    const opened = await api(baseUrl, '/api/shifts/open', { method: 'POST', body: { opening_floats: { USD: 100, LBP: 5000000 } }, headers: authHeader });
    assertEqual(opened.status, 201, 'shift opened');
    assertEqual(opened.data.shift.status, 'open', 'status open');

    // Opening a second shift is rejected.
    const dup = await api(baseUrl, '/api/shifts/open', { method: 'POST', body: { opening_floats: {} }, headers: authHeader });
    assertEqual(dup.status, 409, 'second open shift rejected');

    // A $5 sale paid in USD cash → +5 USD in the drawer.
    await pay('prod-5', { payments: [{ method: 'cash', amount: 5 }] });
    // A $10 sale paid in LBP cash (890,000 LBP at 89,000) → +890,000 LBP.
    await pay('prod-10', { payments: [{ method: 'cash', amount: 890000, tender_currency: 'LBP', exchange_rate: 89000 }] });

    // Drawer movements.
    await api(baseUrl, '/api/shifts/movements', { method: 'POST', body: { type: 'pay_in', currency: 'USD', amount: 20, reason: 'float top-up' }, headers: authHeader });
    await api(baseUrl, '/api/shifts/movements', { method: 'POST', body: { type: 'pay_out', currency: 'LBP', amount: 100000, reason: 'supplier' }, headers: authHeader });
    await api(baseUrl, '/api/shifts/movements', { method: 'POST', body: { type: 'exchange', from_currency: 'USD', from_amount: 50, to_currency: 'LBP', to_amount: 4450000 }, headers: authHeader });

    // Live expected reconciliation before close.
    const current = await api(baseUrl, '/api/shifts/current', { headers: authHeader });
    const expected = current.data.shift.expected;
    // USD: 100 + 5 + 20 − 50 = 75. LBP: 5,000,000 + 890,000 − 100,000 + 4,450,000 = 10,240,000.
    assertEqual(expected.USD, 75, `expected USD = 75 (got ${expected.USD})`);
    assertEqual(expected.LBP, 10240000, `expected LBP = 10,240,000 (got ${expected.LBP})`);
    assertEqual(current.data.shift.cash_sales.USD, 5, 'USD cash sales = 5');
    assertEqual(current.data.shift.cash_sales.LBP, 890000, 'LBP cash sales = 890,000');

    // Close with a counted drawer that is $1 short on USD, exact on LBP.
    const closed = await api(baseUrl, '/api/shifts/close', { method: 'POST', body: { counted: { USD: 74, LBP: 10240000 }, notes: 'end of day' }, headers: authHeader });
    assertEqual(closed.status, 200, 'shift closed');
    assertEqual(closed.data.shift.status, 'closed', 'status closed');
    assertEqual(closed.data.shift.variance.USD, -1, `USD variance = -1 (got ${closed.data.shift.variance.USD})`);
    assertEqual(closed.data.shift.variance.LBP, 0, `LBP variance = 0 (got ${closed.data.shift.variance.LBP})`);

    // The closed shift appears in the list with the full report the Z-report
    // reprint needs (expected + variance per currency).
    const list = await api(baseUrl, '/api/shifts', { headers: authHeader });
    assertEqual(list.status, 200, 'shift list loaded');
    assert(Array.isArray(list.data.shifts) && list.data.shifts.length >= 1, 'list has the closed shift');
    const listed = list.data.shifts.find((s: any) => s.id === closed.data.shift.id);
    assert(!!listed, 'closed shift is in the list');
    assertEqual(listed.variance.USD, -1, 'listed shift carries its variance for reprint');
    assert(Array.isArray(listed.currencies) && listed.movements !== undefined, 'listed shift carries currencies + movements');

    // After close, current is null again and a new shift can open.
    const afterClose = await api(baseUrl, '/api/shifts/current', { headers: authHeader });
    assertEqual(afterClose.data.shift, null, 'no open shift after close');
    const reopen = await api(baseUrl, '/api/shifts/open', { method: 'POST', body: { opening_floats: { USD: 50 } }, headers: authHeader });
    assertEqual(reopen.status, 201, 'can open a new shift after closing');

    // Movement validation.
    const badMove = await api(baseUrl, '/api/shifts/movements', { method: 'POST', body: { type: 'pay_in', currency: 'USD', amount: -5 }, headers: authHeader });
    assertEqual(badMove.status, 400, 'negative pay-in rejected');
    const badExchange = await api(baseUrl, '/api/shifts/movements', { method: 'POST', body: { type: 'exchange', from_currency: 'USD', from_amount: 10, to_currency: 'USD', to_amount: 10 }, headers: authHeader });
    assertEqual(badExchange.status, 400, 'same-currency exchange rejected');
  } finally {
    server.close();
    closeDatabase();
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
