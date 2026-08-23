import Decimal from 'decimal.js';
import type Database from 'better-sqlite3';
import { getSettingValue } from '../db';
import {
  calculateConfiguredChargeTaxes,
  combineItemAndChargeTaxes,
  type TaxRollup,
} from './tax';

/**
 * Tenant fields read from settings that influence order-total recalculation.
 */
export interface RecalcTenantInfo {
  country: string;
  business_type: string;
  state_code: string;
  taxes_enabled: boolean;
}

/**
 * Everything the item-cancel/restore handlers need to persist an order after
 * its active line-items change. All money math here is Decimal.js-based
 * (ROUND_HALF_UP), matching services/tax.ts — the single source of truth for
 * order totals. Callers apply their own status/table side-effects, but the
 * numeric fields (subtotal, discount, tax rollup, total) come only from here.
 */
export interface OrderRecalcResult {
  subtotal: number;
  newDiscountAmount: number;
  taxRollup: TaxRollup;
  total: number;
  roundOff: number;
  /** Count of items remaining after excluding cancelled/voided lines. */
  activeItemCount: number;
  tenantInfo: RecalcTenantInfo;
}

function money(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Recompute an order's subtotal, order-level discount, tax rollup and grand
 * total from its currently active line-items. Shared by the item-cancel and
 * item-restore handlers so there is exactly one order-total engine (previously
 * duplicated ~90 lines each, with raw float math that could drift cents on
 * percentage discounts).
 *
 * `currentOrder` MUST be the transaction-local order row (read inside the same
 * withTxn), not a pre-transaction snapshot — discount type/value, charges and
 * customer are all read from it.
 */
export function recalculateOrderTotals(
  db: Database.Database,
  orderId: string,
  currentOrder: any,
): OrderRecalcResult {
  const activeItems = db.prepare(
    "SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment')",
  ).all(orderId) as any[];

  let subtotal = new Decimal(0);
  let totalTax = new Decimal(0);
  let exclusiveTax = new Decimal(0);
  const allTaxBreakdowns: any[] = [];
  const allTaxSnapshots: (string | null)[] = [];
  for (const i of activeItems) {
    subtotal = subtotal.plus(i.subtotal || 0);
    totalTax = totalTax.plus(i.tax_amount || 0);
    if (i.tax_type !== 'inclusive') {
      exclusiveTax = exclusiveTax.plus(i.tax_amount || 0);
    }
    if (i.tax_breakdown) {
      try {
        const breakdown = JSON.parse(i.tax_breakdown);
        if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
      } catch { /* malformed breakdown JSON is skipped, same as legacy path */ }
    }
    allTaxSnapshots.push(i.tax_snapshot || null);
  }

  // Preserve order-level discount, scaling a percentage discount against the
  // new subtotal (an absolute-amount discount is kept as-is). Guarded on the
  // *original* order subtotal so a discount only ever scales down as lines are
  // removed — identical to the legacy per-handler logic.
  const existingDiscountAmount = new Decimal(currentOrder.discount_amount || 0);
  let newDiscountAmount = existingDiscountAmount;
  if (existingDiscountAmount.gt(0) && (currentOrder.subtotal || 0) > 0) {
    if (currentOrder.discount_type === 'percentage') {
      const pct = new Decimal(currentOrder.discount_value || 0);
      newDiscountAmount = money(subtotal.times(pct).div(100));
    }
  }

  const discountedSubtotal = Decimal.max(0, subtotal.minus(newDiscountAmount));
  let newTaxAmount = totalTax;
  let newExclusiveTax = exclusiveTax;
  let taxRatio = 1;
  if (newDiscountAmount.gt(0) && subtotal.gt(0)) {
    taxRatio = discountedSubtotal.div(subtotal).toNumber();
    newTaxAmount = money(totalTax.times(taxRatio));
    newExclusiveTax = money(exclusiveTax.times(taxRatio));
  }

  const tenantInfo: RecalcTenantInfo = {
    country: getSettingValue('country') || 'IN',
    business_type: getSettingValue('business_type') || 'restaurant',
    state_code: getSettingValue('state_code') || '',
    taxes_enabled: getSettingValue('taxes_enabled') === 'true',
  };

  const customer = currentOrder.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any
    : null;

  const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
    ...currentOrder,
    service_charge: 0,
  }, customer);

  const taxRollup = combineItemAndChargeTaxes({
    itemTaxAmount: newTaxAmount.toNumber(),
    itemExclusiveTaxAmount: newExclusiveTax.toNumber(),
    itemBreakdowns: allTaxBreakdowns,
    itemSnapshots: allTaxSnapshots,
    itemTaxRatio: taxRatio,
    chargeTaxes,
  });

  // BUG #24: include delivery_charge/packaging_charge so the order total matches
  // bill generation. round_off is intentionally 0 (round-off is a display-time
  // concern applied at billing, not stored here).
  const preRoundTotal = discountedSubtotal
    .plus(taxRollup.exclusiveTaxAmount)
    .plus(currentOrder.delivery_charge || 0)
    .plus(currentOrder.packaging_charge || 0);
  const roundOff = 0;
  const total = money(preRoundTotal).toNumber();

  return {
    subtotal: subtotal.toNumber(),
    newDiscountAmount: newDiscountAmount.toNumber(),
    taxRollup,
    total,
    roundOff,
    activeItemCount: activeItems.length,
    tenantInfo,
  };
}
