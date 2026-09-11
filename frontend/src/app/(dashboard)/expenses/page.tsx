'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Receipt } from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useConfirm } from '@/hooks/use-confirm';

type ExpenseKey = keyof AppConfig['Messages']['expenses'];

// Kept in sync with the backend CHECK constraint (main/routes/expenses.ts).
const CATEGORIES = [
  'salary', 'rent', 'utilities', 'supplies', 'inventory',
  'maintenance', 'marketing', 'fees', 'tax', 'other',
] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_KEYS: Record<Category, ExpenseKey> = {
  salary: 'catSalary', rent: 'catRent', utilities: 'catUtilities', supplies: 'catSupplies',
  inventory: 'catInventory', maintenance: 'catMaintenance', marketing: 'catMarketing',
  fees: 'catFees', tax: 'catTax', other: 'catOther',
};

interface Expense {
  id: number;
  category: Category;
  description: string | null;
  amount: number;
  staff_id: string | null;
  staff_name: string | null;
  payment_method: string | null;
  incurred_at: string;
  notes: string | null;
}

interface StaffMember { id: string; name: string; }

const todayInput = () => new Date().toISOString().slice(0, 10);

interface FormState {
  id: number | null;
  category: Category;
  amount: string;
  staff_id: string;
  payment_method: string;
  incurred_at: string;
  description: string;
  notes: string;
}

const emptyForm = (): FormState => ({
  id: null, category: 'other', amount: '', staff_id: '', payment_method: '',
  incurred_at: todayInput(), description: '', notes: '',
});

export default function ExpensesPage() {
  const t = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const currencyFmt = useFormatCurrency();
  const { formatDate } = useFormatDate();
  const { confirm, ConfirmDialog } = useConfirm();

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [byCategory, setByCategory] = useState<Array<{ category: Category; total: number; count: number }>>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Category>('all');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const load = () => setReloadSeq((n) => n + 1);

  const categoryLabel = (c: Category) => t(CATEGORY_KEYS[c]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const params: Record<string, string> = {};
        if (startDate) params.start_date = startDate;
        if (endDate) params.end_date = endDate;
        if (categoryFilter !== 'all') params.category = categoryFilter;
        const [list, summary] = await Promise.all([
          api.get('/expenses', { params }),
          api.get('/expenses/summary', { params: { ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}) } }),
        ]);
        if (!cancelled) {
          setExpenses(list.data.expenses || []);
          setTotal(Number(summary.data.total) || 0);
          setByCategory(summary.data.by_category || []);
        }
      } catch {
        if (!cancelled) toast.error(t('loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [startDate, endDate, categoryFilter, reloadSeq, t]);

  useEffect(() => {
    api.get('/staff').then(({ data }) => setStaff((data.staff || []).map((s: StaffMember) => ({ id: s.id, name: s.name })))).catch(() => {});
  }, []);

  const openAdd = () => { setForm(emptyForm()); setDialogOpen(true); };
  const openEdit = (e: Expense) => {
    setForm({
      id: e.id, category: e.category, amount: String(e.amount), staff_id: e.staff_id || '',
      payment_method: e.payment_method || '', incurred_at: (e.incurred_at || '').slice(0, 10) || todayInput(),
      description: e.description || '', notes: e.notes || '',
    });
    setDialogOpen(true);
  };

  const save = async () => {
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount < 0) { toast.error(t('amountInvalid')); return; }
    setSaving(true);
    try {
      const body = {
        category: form.category,
        amount,
        staff_id: form.category === 'salary' ? (form.staff_id || null) : null,
        payment_method: form.payment_method || null,
        incurred_at: form.incurred_at,
        description: form.description || null,
        notes: form.notes || null,
      };
      if (form.id) await api.put(`/expenses/${form.id}`, body);
      else await api.post('/expenses', body);
      toast.success(t('saved'));
      setDialogOpen(false);
      void load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (e: Expense) => {
    const ok = await confirm(t('deleteConfirm'), { confirmLabel: tCommon('delete'), destructive: true });
    if (!ok) return;
    try {
      await api.delete(`/expenses/${e.id}`);
      toast.success(t('deleted'));
      void load();
    } catch {
      toast.error(t('deleteFailed'));
    }
  };

  const staffItems = useMemo(() => staff.map((s) => ({ value: s.id, label: s.name })), [staff]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Receipt size={22} className="text-gray-500" />
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        </div>
        <Button onClick={openAdd}><Plus size={16} className="me-1" /> {t('addExpense')}</Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs text-gray-500">{t('totalSpent')}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{currencyFmt(total)}</p>
        </div>
        {byCategory.slice(0, 3).map((c) => (
          <div key={c.category} className="rounded-xl border border-gray-100 bg-white p-4">
            <p className="text-xs text-gray-500">{categoryLabel(c.category)}</p>
            <p className="text-lg font-semibold text-gray-900 mt-1">{currencyFmt(c.total)}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-100 bg-white p-4">
        <label className="text-xs text-gray-500 space-y-1">
          <span className="block">{t('from')}</span>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
        </label>
        <label className="text-xs text-gray-500 space-y-1">
          <span className="block">{t('to')}</span>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
        </label>
        <label className="text-xs text-gray-500 space-y-1">
          <span className="block">{t('category')}</span>
          <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as 'all' | Category)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allCategories')}</SelectItem>
              {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{categoryLabel(c)}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {(startDate || endDate || categoryFilter !== 'all') && (
          <Button variant="ghost" onClick={() => { setStartDate(''); setEndDate(''); setCategoryFilter('all'); }}>{t('clearFilters')}</Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-100 bg-white overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('date')}</TableHead>
              <TableHead>{t('category')}</TableHead>
              <TableHead>{t('description')}</TableHead>
              <TableHead>{t('staff')}</TableHead>
              <TableHead className="text-end">{t('amount')}</TableHead>
              <TableHead className="text-end">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {expenses.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap">{formatDate(e.incurred_at)}</TableCell>
                <TableCell><span className="inline-block px-2 py-0.5 rounded-full bg-gray-100 text-xs font-medium">{categoryLabel(e.category)}</span></TableCell>
                <TableCell className="max-w-xs truncate text-gray-600">{e.description || '—'}</TableCell>
                <TableCell className="text-gray-600">{e.staff_name || '—'}</TableCell>
                <TableCell className="text-end font-semibold tabular-nums">{currencyFmt(e.amount)}</TableCell>
                <TableCell className="text-end whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(e)} aria-label={tCommon('edit')}><Pencil size={14} /></Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(e)} aria-label={tCommon('delete')} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!loading && expenses.length === 0 && <p className="text-center text-gray-500 py-12">{t('empty')}</p>}
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{form.id ? t('editExpense') : t('addExpense')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500 space-y-1">
                <span className="block">{t('category')}</span>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as Category }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{categoryLabel(c)}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <label className="text-xs text-gray-500 space-y-1">
                <span className="block">{t('amount')}</span>
                <Input type="number" min="0" step="any" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
              </label>
            </div>
            {form.category === 'salary' && (
              <label className="text-xs text-gray-500 space-y-1 block">
                <span className="block">{t('staff')}</span>
                <Combobox items={staffItems} value={form.staff_id || undefined} onValueChange={(v) => setForm((f) => ({ ...f, staff_id: v }))} placeholder={t('selectStaff')} searchPlaceholder={tCommon('search')} />
              </label>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500 space-y-1">
                <span className="block">{t('date')}</span>
                <Input type="date" value={form.incurred_at} onChange={(e) => setForm((f) => ({ ...f, incurred_at: e.target.value }))} />
              </label>
              <label className="text-xs text-gray-500 space-y-1">
                <span className="block">{t('paymentMethod')}</span>
                <Input value={form.payment_method} onChange={(e) => setForm((f) => ({ ...f, payment_method: e.target.value }))} placeholder={t('paymentMethodPlaceholder')} />
              </label>
            </div>
            <label className="text-xs text-gray-500 space-y-1 block">
              <span className="block">{t('description')}</span>
              <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </label>
            <label className="text-xs text-gray-500 space-y-1 block">
              <span className="block">{t('notes')}</span>
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{tCommon('cancel')}</Button>
            <Button onClick={save} disabled={saving}>{tCommon('save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {ConfirmDialog}
    </div>
  );
}
