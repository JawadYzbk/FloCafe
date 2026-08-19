import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundToIncrement,
  normalizeRoundingRule,
  convertBaseToTender,
  convertTenderToBase,
  DEFAULT_ROUNDING_RULE,
} from '../main/countries';

// ── roundToIncrement: half_up ────────────────────────────────────────────────
test('half_up: rounds to nearest increment, ties go up', () => {
  assert.equal(roundToIncrement(1234, 100, 'half_up'), 1200);
  assert.equal(roundToIncrement(1250, 100, 'half_up'), 1300); // tie → up
  assert.equal(roundToIncrement(1251, 100, 'half_up'), 1300);
  assert.equal(roundToIncrement(1249, 100, 'half_up'), 1200);
});

test('half_up: nearest 1,000 and 5,000', () => {
  assert.equal(roundToIncrement(1_234_000, 1000, 'half_up'), 1_234_000);
  assert.equal(roundToIncrement(1_234_400, 1000, 'half_up'), 1_234_000);
  assert.equal(roundToIncrement(1_234_500, 1000, 'half_up'), 1_235_000);
  assert.equal(roundToIncrement(12_300, 5000, 'half_up'), 10_000);
  assert.equal(roundToIncrement(12_500, 5000, 'half_up'), 15_000); // tie → up
});

// ── roundToIncrement: floor (down) ───────────────────────────────────────────
test('floor: always rounds down to the increment', () => {
  assert.equal(roundToIncrement(1299, 100, 'floor'), 1200);
  assert.equal(roundToIncrement(1200, 100, 'floor'), 1200);
  assert.equal(roundToIncrement(19_999, 5000, 'floor'), 15_000);
});

// ── roundToIncrement: ceil (up) ──────────────────────────────────────────────
test('ceil: always rounds up to the increment', () => {
  assert.equal(roundToIncrement(1201, 100, 'ceil'), 1300);
  assert.equal(roundToIncrement(1200, 100, 'ceil'), 1200);
  assert.equal(roundToIncrement(15_001, 5000, 'ceil'), 20_000);
});

// ── Arbitrary user-supplied increment ────────────────────────────────────────
test('arbitrary increment: nearest 250', () => {
  assert.equal(roundToIncrement(1000, 250, 'half_up'), 1000);
  assert.equal(roundToIncrement(1100, 250, 'half_up'), 1000);
  assert.equal(roundToIncrement(1125, 250, 'half_up'), 1250); // tie → up
});

// ── Edge cases ───────────────────────────────────────────────────────────────
test('increment <= 1 disables snapping (rounds to whole units)', () => {
  assert.equal(roundToIncrement(1234.4, 1, 'half_up'), 1234);
  assert.equal(roundToIncrement(1234.6, 0, 'half_up'), 1235);
  assert.equal(roundToIncrement(1234.5, -5, 'floor'), 1235);
});

test('non-finite amount is treated as 0', () => {
  assert.equal(roundToIncrement(NaN, 100, 'half_up'), 0);
  assert.equal(roundToIncrement(Infinity, 100, 'ceil'), 0);
});

test('floating-point noise does not push a clean multiple over the edge', () => {
  // 0.1 * 3 === 0.30000000000000004; scaled tender amounts hit this constantly.
  assert.equal(roundToIncrement(3000.0000000004, 1000, 'ceil'), 3000);
  assert.equal(roundToIncrement(2999.9999999996, 1000, 'floor'), 3000);
});

// ── normalizeRoundingRule ────────────────────────────────────────────────────
test('normalizeRoundingRule: fills defaults and rejects junk', () => {
  assert.deepEqual(normalizeRoundingRule(undefined), DEFAULT_ROUNDING_RULE);
  assert.deepEqual(normalizeRoundingRule({ increment: 5000, mode: 'ceil' }), { increment: 5000, mode: 'ceil' });
  assert.deepEqual(normalizeRoundingRule({ increment: 0.5, mode: 'floor' }), { increment: 1, mode: 'floor' });
  // @ts-expect-error invalid mode falls back to default
  assert.deepEqual(normalizeRoundingRule({ increment: 100, mode: 'bankers' }), { increment: 100, mode: 'half_up' });
});

// ── convertBaseToTender ──────────────────────────────────────────────────────
test('convertBaseToTender: USD→LBP at 89,000 rounded to nearest 5,000', () => {
  const out = convertBaseToTender(13.5, { rate: 89_000, rounding: { increment: 5000, mode: 'half_up' } });
  assert.equal(out.raw, 1_201_500);
  assert.equal(out.rounded, 1_200_000);
});

test('convertBaseToTender: ceil favours merchant', () => {
  const out = convertBaseToTender(1, { rate: 89_000, rounding: { increment: 5000, mode: 'ceil' } });
  assert.equal(out.raw, 89_000);
  assert.equal(out.rounded, 90_000);
});

test('convertBaseToTender: non-positive rate yields zero', () => {
  assert.deepEqual(convertBaseToTender(10, { rate: 0, rounding: DEFAULT_ROUNDING_RULE }), { raw: 0, rounded: 0 });
  assert.deepEqual(convertBaseToTender(10, { rate: -1, rounding: DEFAULT_ROUNDING_RULE }), { raw: 0, rounded: 0 });
});

// ── convertTenderToBase ──────────────────────────────────────────────────────
test('convertTenderToBase: LBP→USD at 89,000', () => {
  assert.equal(Number(convertTenderToBase(890_000, 89_000).toFixed(2)), 10);
  assert.equal(Number(convertTenderToBase(1_200_000, 89_000).toFixed(2)), 13.48);
});

test('convertTenderToBase: invalid rate yields zero', () => {
  assert.equal(convertTenderToBase(1000, 0), 0);
  assert.equal(convertTenderToBase(1000, NaN), 0);
});
