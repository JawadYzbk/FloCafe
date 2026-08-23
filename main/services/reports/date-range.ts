/**
 * Shared date-range + comparison utilities for the reporting engine.
 *
 * All reports resolve their window through here so period logic lives in one
 * place. Bounds are produced as a half-open UTC interval `[start, end)` via the
 * existing `utcDayBounds` convention (main/db.ts) — reports must never use
 * fragile `23:59:59` end-of-day logic. Named presets map to calendar periods;
 * `previousEquivalent` yields the immediately-preceding window of equal length
 * for period-over-period comparison.
 */
import { utcDayBounds, utcTodayDate } from '../../db';

export type DatePreset =
  | 'today' | 'yesterday'
  | 'this_week' | 'last_week'
  | 'this_month' | 'last_month'
  | 'this_quarter'
  | 'this_year' | 'last_year'
  | 'last_7_days' | 'last_30_days' | 'last_90_days'
  | 'custom';

/** Inclusive calendar range as `YYYY-MM-DD` strings. */
export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface ResolvedRange {
  range: DateRange;
  /** Half-open UTC interval [startISO, endISO). */
  bounds: [string, string];
  /** Number of whole days the range spans (inclusive). */
  days: number;
  comparison?: {
    range: DateRange;
    bounds: [string, string];
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateStr(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v);
}

/** Parse a `YYYY-MM-DD` string as a UTC-midnight Date. */
function toUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** ISO day-of-week with Monday = 0 … Sunday = 6 (business-week convention). */
function mondayIndex(date: string): number {
  return (toUtc(date).getUTCDay() + 6) % 7;
}

function startOfMonth(date: string): string {
  const d = toUtc(date);
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
}

function endOfMonth(date: string): string {
  const d = toUtc(date);
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** Inclusive whole-day span of a range (min 1). */
export function rangeDays(range: DateRange): number {
  const ms = toUtc(range.endDate).getTime() - toUtc(range.startDate).getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** Resolve a named preset (or a validated custom range) to an inclusive range. */
export function resolvePreset(preset: DatePreset, custom?: Partial<DateRange>, today = utcTodayDate()): DateRange {
  switch (preset) {
    case 'today': return { startDate: today, endDate: today };
    case 'yesterday': { const y = addDays(today, -1); return { startDate: y, endDate: y }; }
    case 'this_week': { const s = addDays(today, -mondayIndex(today)); return { startDate: s, endDate: today }; }
    case 'last_week': { const thisMon = addDays(today, -mondayIndex(today)); const s = addDays(thisMon, -7); return { startDate: s, endDate: addDays(s, 6) }; }
    case 'this_month': return { startDate: startOfMonth(today), endDate: today };
    case 'last_month': { const firstThis = startOfMonth(today); const lastPrev = addDays(firstThis, -1); return { startDate: startOfMonth(lastPrev), endDate: lastPrev }; }
    case 'this_quarter': { const d = toUtc(today); const qStartMonth = Math.floor(d.getUTCMonth() / 3) * 3; return { startDate: fmt(new Date(Date.UTC(d.getUTCFullYear(), qStartMonth, 1))), endDate: today }; }
    case 'this_year': { const d = toUtc(today); return { startDate: fmt(new Date(Date.UTC(d.getUTCFullYear(), 0, 1))), endDate: today }; }
    case 'last_year': { const y = toUtc(today).getUTCFullYear() - 1; return { startDate: `${y}-01-01`, endDate: `${y}-12-31` }; }
    case 'last_7_days': return { startDate: addDays(today, -6), endDate: today };
    case 'last_30_days': return { startDate: addDays(today, -29), endDate: today };
    case 'last_90_days': return { startDate: addDays(today, -89), endDate: today };
    case 'custom':
    default: {
      const start = isDateStr(custom?.startDate) ? custom!.startDate! : today;
      const end = isDateStr(custom?.endDate) ? custom!.endDate! : start;
      // Guard against a reversed range.
      return start <= end ? { startDate: start, endDate: end } : { startDate: end, endDate: start };
    }
  }
}

/** The immediately-preceding window of equal length (for period comparison). */
export function previousEquivalent(range: DateRange): DateRange {
  const days = rangeDays(range);
  const prevEnd = addDays(range.startDate, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { startDate: prevStart, endDate: prevEnd };
}

/** [startISO, endISO) UTC bounds spanning an inclusive range. */
export function rangeToBounds(range: DateRange): [string, string] {
  return [utcDayBounds(range.startDate)[0], utcDayBounds(range.endDate)[1]];
}

/**
 * Resolve report request params to a window (+ optional comparison window).
 * Accepts either a `preset` or explicit `start_date`/`end_date`, plus an
 * optional `compare` flag requesting the previous equivalent period.
 */
export function resolveRange(params: {
  preset?: string;
  start_date?: unknown;
  end_date?: unknown;
  compare?: unknown;
}, today = utcTodayDate()): ResolvedRange {
  const preset = (params.preset as DatePreset) || (isDateStr(params.start_date) ? 'custom' : 'today');
  const range = resolvePreset(preset, {
    startDate: isDateStr(params.start_date) ? params.start_date : undefined,
    endDate: isDateStr(params.end_date) ? params.end_date : undefined,
  }, today);
  const resolved: ResolvedRange = { range, bounds: rangeToBounds(range), days: rangeDays(range) };
  const compare = params.compare === true || params.compare === 'true' || params.compare === '1';
  if (compare) {
    const cmp = previousEquivalent(range);
    resolved.comparison = { range: cmp, bounds: rangeToBounds(cmp) };
  }
  return resolved;
}
