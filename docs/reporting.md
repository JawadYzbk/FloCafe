# Reporting & Analytics — CURRENT

Offline-first reporting subsystem. All aggregation runs against the local SQLite
database; no report depends on the internet or cloud services.

## Architecture

One **centralized reporting engine** — `main/services/reports/` — is the single
authoritative source for every metric. Route handlers stay thin (resolve a
window → call the engine → return JSON); the UI and exports **consume** the
engine's results and never recompute totals.

```
main/services/reports/
├── date-range.ts   named periods, comparison, half-open UTC bounds
├── sales.ts        gross/net/tax/orders/items, daily/hourly/day-of-week
├── products.ts     product & category sales (+cost/profit), modifiers
├── operations.ts   order type/status, discounts, voids, per-employee sales
├── finance.ts      payment breakdown, expenses, profit & loss
└── index.ts        executive overview composer + meta/timezone helpers
```

Frontend: `frontend/src/app/(dashboard)/reports/page.tsx` and the
`Expenses` screen. Reuses the existing shadcn design system, `useFormatCurrency`
/`useFormatNumber` for tenant-currency formatting, and the app's role gating.

## Financial definitions (authoritative)

| Term | Definition |
| --- | --- |
| Gross sales | Σ `orders.subtotal` (pre-discount item subtotal) |
| Discounts | Σ `orders.discount_amount` |
| Tax | Σ `orders.tax_amount` |
| **Net sales** | Σ `orders.total` (payable incl. tax + charges − discount) |
| **Collected** | Σ `bills.paid_amount` (cash actually taken — a *cash* figure, not a sales figure) |
| Items sold | Σ `order_items.quantity` for non-cancelled/voided lines |
| Avg order | Net sales ÷ order count |
| COGS | Σ `order_items.quantity × unit_cost` (cost snapshotted at sale time; falls back to current `products.cost` for pre-v77 rows) |
| Gross profit | Net sales − COGS |
| Operating expenses | Σ `expenses.amount` (Expenses module) |
| **Net operating profit** | Gross profit − Operating expenses |
| Product/category revenue | Σ `order_items.subtotal` (base line, **excludes** modifiers) |
| Modifier revenue | Σ `order_item_addons.price × quantity` (reported separately, never double-counted against products) |

Cancelled orders and cancelled/voided/void_adjustment item lines are excluded
from sales everywhere. Revenue, tax and quantities come from per-transaction
snapshots (`orders.total`, `order_items.tax_snapshot`), so historical price/tax/
discount changes do **not** alter past reports.

## Date handling

Windows resolve to a **half-open UTC interval `[start, end)`** via
`utcDayBounds` (never `23:59:59`). Presets: `today`, `yesterday`, `this_week`,
`last_week`, `this_month`, `last_month`, `this_quarter`, `this_year`,
`last_year`, `last_7/30/90_days`, `custom`. `previousEquivalent` yields the
immediately-preceding window of equal length for comparison. Hourly and
day-of-week buckets use the store timezone offset (DST-aware, `tzOffsetMinutes`).

## API

All under `/api/reports`, all **owner/manager** (financial data). Each response
carries `meta` = `{ generatedAt, timezone, range: {startDate,endDate,days},
comparison? }`. Query params: `preset` OR `start_date`/`end_date`, plus
`compare=true` for period-over-period.

| Endpoint | Returns |
| --- | --- |
| `/overview` | Executive dashboard: summary, profit, payments, expenses, top products, categories, modifiers, staff, order types, discounts, voids, daily, hourly (+ comparison deltas) |
| `/sales-summary` `/daily` `/hourly` `/day-of-week` | Sales aggregations |
| `/products` `/categories` `/modifiers` | Product/category/modifier sales |
| `/order-types` `/discounts` `/voids` `/staff` | Operations |
| `/payments` `/profit-loss` | Finance |

(Existing `/summary`, `/sales`, `/topProducts`, `/tax-components`, `/insights`,
`/daily-stats`, `/tables`, and `/financial` remain for back-compat.)

## Permissions

Reports and Expenses are gated to **owner/manager** in the sidebar and enforced
server-side with the existing `requireRole` middleware. Expense deletion is
**owner-only**. No parallel authorization system is introduced.

## Data availability (audit result)

**Backed by real data:** sales, products + profit/margin, categories,
modifiers, order type/status, payments (split-aware), discounts, voids, taxes
(snapshotted), employees, cash/shift context, loyalty (`loyalty_ledger`),
tables, P&L, expenses, low-stock/stock-value.

**Gracefully unavailable (no backing data — do not fabricate):** tips,
service-charge amount, inventory *movements*/waste/purchases/suppliers,
recipe-based food cost, per-station KDS prep timing (only order created→completed
exists), price-change history, and a general audit trail (only
`tax_config_audit` + `print_logs` exist).

## Known limitations

- **COGS/profit are historically accurate** — as of migration v77 each line
  snapshots the product cost into `order_items.unit_cost` at sale time (the
  reporting engine falls back to current `products.cost` only for rows created
  before v77). Revenue/tax/quantity were already snapshotted.
- Money is aggregated as SQLite `REAL` (the app's storage type); values are
  rounded for display.

## Adding a report

1. Add the aggregation to the appropriate `main/services/reports/*.ts` (one
   authoritative definition; reuse existing helpers/date bounds).
2. Add a thin `/api/reports/<name>` handler (owner/manager, `withMeta`).
3. Consume it in the Reports page; never recompute totals in React.
4. Add assertions to `tests/reports-engine.test.ts`.
