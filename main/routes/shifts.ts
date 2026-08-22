import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { getBaseCurrency, getSecondaryCurrencies } from '../currency-config';

/**
 * Cash shift (drawer) management with per-physical-currency reconciliation.
 *
 * Lebanon runs on USD and LBP at once, so a drawer holds notes in more than one
 * currency and each must be counted independently at close. A shift records an
 * opening float per currency, every pay-in / pay-out / exchange during the
 * shift, and — server-authoritatively — the cash sales taken in each currency
 * derived from the persisted payment snapshots. At close it computes the
 * expected balance per currency and the variance against the counted cash.
 */
export const shiftRoutes = Router();

type Amounts = Record<string, number>;

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Currencies the tenant deals in (base + accepted secondary tenders). */
function acceptedCurrencies(): string[] {
  const base = getBaseCurrency();
  const secondary = getSecondaryCurrencies().map((c) => c.code);
  return [base, ...secondary.filter((c) => c !== base)];
}

/** Parse a { currency: amount } map, keeping only accepted currencies and non-negative finite numbers. */
function parseFloats(raw: unknown, accepted: Set<string>): Amounts {
  const out: Amounts = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(key).toUpperCase();
    const amount = Number(value);
    if (accepted.has(code) && Number.isFinite(amount) && amount >= 0) out[code] = round2(amount);
  }
  return out;
}

function safeJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/**
 * Sum the physical cash taken in each currency from every cash payment line
 * whose timestamp falls in [from, to). A base-currency cash line adds its
 * tendered amount to the base drawer; a secondary-tender cash line adds its
 * physical `tender_amount` to that currency's drawer. Change is given from the
 * base drawer (how a dual-currency till is typically run), so it is subtracted
 * from base. Non-cash lines (card, wallet, custom) never touch the drawer.
 */
function cashByCurrency(db: ReturnType<typeof getDatabase>, base: string, from: string, to: string | null): Amounts {
  const drawer: Amounts = {};
  const add = (cur: string, amount: number) => {
    if (!Number.isFinite(amount) || amount === 0) return;
    drawer[cur] = round2((drawer[cur] || 0) + amount);
  };
  const rows = db.prepare(
    `SELECT payment_details FROM bills WHERE payment_details IS NOT NULL AND payment_details != '' AND (paid_at >= ? OR updated_at >= ?)`,
  ).all(from, from) as { payment_details: string }[];
  for (const row of rows) {
    const parsed = safeJson<unknown>(row.payment_details, []);
    const lines = Array.isArray(parsed) ? parsed : [parsed];
    for (const line of lines as Record<string, unknown>[]) {
      if (!line || line.method !== 'cash') continue;
      const ts = typeof line.timestamp === 'string' ? line.timestamp : '';
      // Inclusive window [opened_at, closed_at]: a close in the same second as
      // the last sale (timestamps are second-precision) must still include it.
      if (!ts || ts < from || (to !== null && ts > to)) continue;
      const tenderCurrency = typeof line.tender_currency === 'string' ? String(line.tender_currency).toUpperCase() : base;
      if (tenderCurrency === base) {
        // Physical base cash in = amount tendered (falls back to applied).
        const tendered = Number(line.tendered_amount);
        add(base, Number.isFinite(tendered) && tendered > 0 ? tendered : Number(line.amount) || 0);
      } else {
        const physical = Number(line.tender_amount);
        add(tenderCurrency, Number.isFinite(physical) ? physical : 0);
      }
      // Change is handed back from the base drawer.
      const change = Number(line.change_amount);
      if (Number.isFinite(change) && change > 0) add(base, -change);
    }
  }
  return drawer;
}

interface MovementRow {
  id: number; type: string; currency: string | null; amount: number | null;
  from_currency: string | null; from_amount: number | null; to_currency: string | null; to_amount: number | null;
  reason: string | null; created_at: string;
}

/** Expected cash per currency = opening float + cash sales + pay-ins − pay-outs ± exchanges. */
function computeExpected(opening: Amounts, cash: Amounts, movements: MovementRow[]): Amounts {
  const expected: Amounts = { ...opening };
  const bump = (cur: string | null | undefined, delta: number) => {
    if (!cur) return;
    const code = cur.toUpperCase();
    expected[code] = round2((expected[code] || 0) + delta);
  };
  for (const [cur, amt] of Object.entries(cash)) bump(cur, amt);
  for (const m of movements) {
    if (m.type === 'pay_in') bump(m.currency, Number(m.amount) || 0);
    else if (m.type === 'pay_out') bump(m.currency, -(Number(m.amount) || 0));
    else if (m.type === 'exchange') {
      bump(m.from_currency, -(Number(m.from_amount) || 0));
      bump(m.to_currency, Number(m.to_amount) || 0);
    }
  }
  return expected;
}

function getMovements(db: ReturnType<typeof getDatabase>, shiftId: number): MovementRow[] {
  return db.prepare('SELECT * FROM shift_movements WHERE shift_id = ? ORDER BY id').all(shiftId) as MovementRow[];
}

/** Build the full report view for a shift (expected drawer, cash sales, movements). */
function shiftReport(db: ReturnType<typeof getDatabase>, shift: any) {
  const base = shift.base_currency || getBaseCurrency();
  const opening = safeJson<Amounts>(shift.opening_floats, {});
  const movements = getMovements(db, shift.id);
  const windowEnd = shift.status === 'closed' ? shift.closed_at : null;
  const cash = cashByCurrency(db, base, shift.opened_at, windowEnd);
  // A closed shift reports the expected balance snapshotted at close; an open
  // one recomputes live.
  const expected = shift.status === 'closed'
    ? safeJson<Amounts>(shift.expected_close, computeExpected(opening, cash, movements))
    : computeExpected(opening, cash, movements);
  const counted = safeJson<Amounts | null>(shift.counted_close, null);
  const currencies = acceptedCurrencies();
  const variance: Amounts = {};
  if (counted) {
    for (const cur of currencies) variance[cur] = round2((counted[cur] || 0) - (expected[cur] || 0));
  }
  return {
    ...shift,
    base_currency: base,
    opening_floats: opening,
    counted_close: counted,
    currencies,
    cash_sales: cash,
    expected,
    variance: counted ? variance : null,
    movements,
  };
}

function getOpenShift(db: ReturnType<typeof getDatabase>): any {
  return db.prepare("SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
}

// ── Routes ───────────────────────────────────────────────────────────────────

shiftRoutes.get('/current', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const shift = getOpenShift(db);
    res.json({ shift: shift ? shiftReport(db, shift) : null });
  } catch (error) {
    console.error('[API] shifts/current failed:', error);
    res.status(500).json({ error: 'Failed to load current shift' });
  }
});

shiftRoutes.get('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = db.prepare("SELECT * FROM shifts WHERE status = 'closed' ORDER BY id DESC LIMIT ?").all(limit) as any[];
    res.json({ shifts: rows.map((s) => shiftReport(db, s)) });
  } catch (error) {
    console.error('[API] shifts list failed:', error);
    res.status(500).json({ error: 'Failed to load shifts' });
  }
});

shiftRoutes.get('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json({ shift: shiftReport(db, shift) });
  } catch (error) {
    console.error('[API] shift report failed:', error);
    res.status(500).json({ error: 'Failed to load shift' });
  }
});

shiftRoutes.post('/open', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const accepted = new Set(acceptedCurrencies());
    const base = getBaseCurrency();
    const opening = parseFloats(req.body?.opening_floats, accepted);
    const userId = String((req as any).user?.userId ?? '');
    const result = withTxn(() => {
      if (getOpenShift(db)) throw Object.assign(new Error('A shift is already open — close it first'), { statusCode: 409 });
      const ts = now();
      const info = db.prepare(
        `INSERT INTO shifts (status, opened_by, opened_at, base_currency, opening_floats, created_at, updated_at)
         VALUES ('open', ?, ?, ?, ?, ?, ?)`,
      ).run(userId, ts, base, JSON.stringify(opening), ts, ts);
      return db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid);
    });
    res.status(201).json({ shift: shiftReport(db, result) });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[API] shift open failed:', error);
    res.status(status).json({ error: status >= 500 ? 'Failed to open shift' : error.message });
  }
});

shiftRoutes.post('/movements', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const accepted = new Set(acceptedCurrencies());
    const userId = String((req as any).user?.userId ?? '');
    const { type, currency, amount, from_currency, from_amount, to_currency, to_amount, reason } = req.body ?? {};
    const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : null;

    const result = withTxn(() => {
      const shift = getOpenShift(db);
      if (!shift) throw Object.assign(new Error('No open shift'), { statusCode: 400 });
      const ts = now();
      if (type === 'pay_in' || type === 'pay_out') {
        const code = String(currency || '').toUpperCase();
        const value = Number(amount);
        if (!accepted.has(code)) throw Object.assign(new Error('Unknown currency'), { statusCode: 400 });
        if (!Number.isFinite(value) || value <= 0) throw Object.assign(new Error('Amount must be greater than zero'), { statusCode: 400 });
        db.prepare(
          `INSERT INTO shift_movements (shift_id, type, currency, amount, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(shift.id, type, code, round2(value), reasonText, userId, ts);
      } else if (type === 'exchange') {
        const fromCode = String(from_currency || '').toUpperCase();
        const toCode = String(to_currency || '').toUpperCase();
        const fromValue = Number(from_amount);
        const toValue = Number(to_amount);
        if (!accepted.has(fromCode) || !accepted.has(toCode)) throw Object.assign(new Error('Unknown currency'), { statusCode: 400 });
        if (fromCode === toCode) throw Object.assign(new Error('Exchange currencies must differ'), { statusCode: 400 });
        if (!Number.isFinite(fromValue) || fromValue <= 0 || !Number.isFinite(toValue) || toValue <= 0) {
          throw Object.assign(new Error('Exchange amounts must be greater than zero'), { statusCode: 400 });
        }
        db.prepare(
          `INSERT INTO shift_movements (shift_id, type, from_currency, from_amount, to_currency, to_amount, reason, user_id, created_at)
           VALUES (?, 'exchange', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(shift.id, fromCode, round2(fromValue), toCode, round2(toValue), reasonText, userId, ts);
      } else {
        throw Object.assign(new Error('Invalid movement type'), { statusCode: 400 });
      }
      db.prepare('UPDATE shifts SET updated_at = ? WHERE id = ?').run(ts, shift.id);
      return getOpenShift(db);
    });
    res.status(201).json({ shift: shiftReport(db, result) });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[API] shift movement failed:', error);
    res.status(status).json({ error: status >= 500 ? 'Failed to record movement' : error.message });
  }
});

shiftRoutes.post('/close', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const accepted = new Set(acceptedCurrencies());
    const userId = String((req as any).user?.userId ?? '');
    const counted = parseFloats(req.body?.counted, accepted);
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 1000) : null;

    const result = withTxn(() => {
      const shift = getOpenShift(db);
      if (!shift) throw Object.assign(new Error('No open shift to close'), { statusCode: 400 });
      const base = shift.base_currency || getBaseCurrency();
      const ts = now();
      const opening = safeJson<Amounts>(shift.opening_floats, {});
      const movements = getMovements(db, shift.id);
      const cash = cashByCurrency(db, base, shift.opened_at, ts);
      const expected = computeExpected(opening, cash, movements);
      db.prepare(
        `UPDATE shifts SET status = 'closed', closed_by = ?, closed_at = ?, counted_close = ?, expected_close = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(userId, ts, JSON.stringify(counted), JSON.stringify(expected), notes, ts, shift.id);
      return db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
    });
    res.json({ shift: shiftReport(db, result) });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[API] shift close failed:', error);
    res.status(status).json({ error: status >= 500 ? 'Failed to close shift' : error.message });
  }
});
