import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { requireRole } from '../middleware/security';

const router = Router();

// Finances are sensitive (salaries, operating costs), so every expenses route is
// gated to owner/manager — the same authority level as reports. Cashiers/servers
// never see or touch expense data.
const MANAGE_ROLES = ['owner', 'manager'] as const;

export const EXPENSE_CATEGORIES = [
  'salary', 'rent', 'utilities', 'supplies', 'inventory',
  'maintenance', 'marketing', 'fees', 'tax', 'other',
] as const;
type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

interface ParsedExpense {
  category: ExpenseCategory;
  description: string | null;
  amount: number;
  staff_id: string | null;
  payment_method: string | null;
  incurred_at: string;
  notes: string | null;
}

function parseExpenseBody(body: any): { value: ParsedExpense } | { error: string } {
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: 'A valid non-negative amount is required' };
  }
  const category: ExpenseCategory = EXPENSE_CATEGORIES.includes(body?.category)
    ? body.category
    : 'other';
  const rawIncurred = typeof body?.incurred_at === 'string' ? body.incurred_at.trim() : '';
  return {
    value: {
      category,
      description: typeof body?.description === 'string' && body.description.trim() ? body.description.trim() : null,
      amount: Number(amount.toFixed(2)),
      staff_id: body?.staff_id != null && String(body.staff_id).trim() ? String(body.staff_id) : null,
      payment_method: typeof body?.payment_method === 'string' && body.payment_method.trim() ? body.payment_method.trim() : null,
      incurred_at: rawIncurred || now(),
      notes: typeof body?.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
    },
  };
}

// ── List (optional date range / category / staff filter) ─────────────────────
router.get('/', requireRole(...MANAGE_ROLES), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const { start_date, end_date, category, staff_id } = req.query;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (isDate(start_date)) { clauses.push('date(e.incurred_at) >= date(?)'); params.push(start_date); }
    if (isDate(end_date)) { clauses.push('date(e.incurred_at) <= date(?)'); params.push(end_date); }
    if (typeof category === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
      clauses.push('e.category = ?'); params.push(category);
    }
    if (typeof staff_id === 'string' && staff_id) { clauses.push('e.staff_id = ?'); params.push(staff_id); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT e.*, u.name AS staff_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.staff_id
      ${where}
      ORDER BY e.incurred_at DESC, e.id DESC
      LIMIT 2000
    `).all(...params);
    res.json({ expenses: rows });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Summary (totals by category + grand total for a period) ──────────────────
router.get('/summary', requireRole(...MANAGE_ROLES), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const { start_date, end_date } = req.query;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (isDate(start_date)) { clauses.push('date(incurred_at) >= date(?)'); params.push(start_date); }
    if (isDate(end_date)) { clauses.push('date(incurred_at) <= date(?)'); params.push(end_date); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const byCategory = db.prepare(`
      SELECT category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM expenses ${where}
      GROUP BY category
      ORDER BY total DESC
    `).all(...params);
    const total = (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses ${where}`).get(...params) as { total: number }).total;
    res.json({ total, by_category: byCategory });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', requireRole(...MANAGE_ROLES), (req: Request, res: Response) => {
  try {
    const parsed = parseExpenseBody(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const e = parsed.value;
    const db = getDatabase();
    if (e.staff_id && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(e.staff_id)) {
      return res.status(400).json({ error: 'Unknown staff member' });
    }
    const createdBy = String((req as any).user?.userId || '') || null;
    const ts = now();
    const result = db.prepare(`
      INSERT INTO expenses (category, description, amount, staff_id, payment_method, incurred_at, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.category, e.description, e.amount, e.staff_id, e.payment_method, e.incurred_at, e.notes, createdBy, ts, ts);
    const row = db.prepare('SELECT e.*, u.name AS staff_name FROM expenses e LEFT JOIN users u ON u.id = e.staff_id WHERE e.id = ?').get(result.lastInsertRowid);
    res.status(201).json({ expense: row });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Update ───────────────────────────────────────────────────────────────────
router.put('/:id', requireRole(...MANAGE_ROLES), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    const parsed = parseExpenseBody(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const e = parsed.value;
    if (e.staff_id && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(e.staff_id)) {
      return res.status(400).json({ error: 'Unknown staff member' });
    }
    db.prepare(`
      UPDATE expenses
      SET category = ?, description = ?, amount = ?, staff_id = ?, payment_method = ?, incurred_at = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(e.category, e.description, e.amount, e.staff_id, e.payment_method, e.incurred_at, e.notes, now(), req.params.id);
    const row = db.prepare('SELECT e.*, u.name AS staff_name FROM expenses e LEFT JOIN users u ON u.id = e.staff_id WHERE e.id = ?').get(req.params.id);
    res.json({ expense: row });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete (owner only — deleting financial records is the most privileged) ───
router.delete('/:id', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json({ success: true });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const expenseRoutes = router;
