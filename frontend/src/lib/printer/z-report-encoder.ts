/**
 * z-report-encoder.ts
 *
 * Renders a cash shift's closing report (the "Z-report") as ESC/POS bytes.
 * Counts each physical currency independently — opening float, cash sales,
 * expected, counted, and variance — which is the point of the shift module for
 * a dual-currency (USD/LBP) drawer.
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';

export interface ZReportShift {
  id: number;
  opened_at: string;
  closed_at: string | null;
  base_currency: string;
  currencies: string[];
  opening_floats: Record<string, number>;
  cash_sales: Record<string, number>;
  expected: Record<string, number>;
  counted_close: Record<string, number> | null;
  variance: Record<string, number> | null;
  movements: Array<{
    type: 'pay_in' | 'pay_out' | 'exchange';
    currency: string | null; amount: number | null;
    from_currency: string | null; from_amount: number | null;
    to_currency: string | null; to_amount: number | null;
    reason: string | null;
  }>;
}

// Must match main/printers/profiles.ts generic-escpos-58/80 fontAColumns.
const CHARS: Record<58 | 80, number> = { 58: 42, 80: 48 };

const fmt = (n: number): string => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

function padRow(left: string, right: string, cols: number): string {
  const l = left.length + right.length >= cols ? left.slice(0, Math.max(0, cols - right.length - 1)) : left;
  const gap = Math.max(1, cols - l.length - right.length);
  return l + ' '.repeat(gap) + right;
}

function formatTs(ts: string | null): string {
  if (!ts) return '—';
  try { return new Date(ts.replace(' ', 'T') + 'Z').toLocaleString(); } catch { return ts; }
}

export function buildZReportBytes(shift: ZReportShift, businessName: string, paperWidth: 58 | 80 = 58): Uint8Array {
  const cols = CHARS[paperWidth];
  const enc = new ReceiptPrinterEncoder({ columns: cols });
  const line = (l: string, r: string) => enc.text(padRow(l, r, cols)).newline();

  enc.initialize();
  enc.align('center').bold(true);
  if (businessName) enc.text(businessName.slice(0, cols)).newline();
  enc.width(2).height(2).text('Z-REPORT').width(1).height(1).newline();
  enc.bold(false).align('left');
  enc.rule({ style: 'double' });

  line(`Shift #${shift.id}`, '');
  line('Opened', formatTs(shift.opened_at));
  line('Closed', formatTs(shift.closed_at));
  enc.rule({ style: 'single' });

  // Per-currency reconciliation — each currency counted on its own.
  for (const cur of shift.currencies) {
    enc.bold(true).text(cur).newline().bold(false);
    line('  Opening float', fmt(shift.opening_floats[cur] || 0));
    line('  Cash sales', fmt(shift.cash_sales[cur] || 0));
    enc.bold(true);
    line('  Expected', fmt(shift.expected[cur] || 0));
    enc.bold(false);
    if (shift.counted_close) line('  Counted', fmt(shift.counted_close[cur] || 0));
    if (shift.variance) {
      const v = shift.variance[cur] || 0;
      line('  Variance', `${v > 0 ? '+' : ''}${fmt(v)}`);
    }
    enc.newline();
  }

  // Movements
  if (shift.movements.length > 0) {
    enc.rule({ style: 'single' });
    enc.bold(true).text('Movements').newline().bold(false);
    for (const m of shift.movements) {
      if (m.type === 'exchange') {
        line('  Exchange', `${fmt(m.from_amount || 0)} ${m.from_currency} > ${fmt(m.to_amount || 0)} ${m.to_currency}`);
      } else {
        const label = m.type === 'pay_in' ? 'Pay in' : 'Pay out';
        line(`  ${label}`, `${fmt(m.amount || 0)} ${m.currency}`);
      }
      if (m.reason) enc.text(`    ${m.reason.slice(0, cols - 4)}`).newline();
    }
  }

  enc.rule({ style: 'double' });
  enc.align('center').text('--- End of Z-Report ---').newline();
  enc.newline().newline().newline().cut();

  return enc.encode();
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Minimal printable HTML for the browser (A4/system) print path. */
export function buildZReportHtml(shift: ZReportShift, businessName: string): string {
  const rows = shift.currencies.map((cur) => {
    const v = shift.variance ? (shift.variance[cur] || 0) : null;
    return `<tr>
      <td class="c">${esc(cur)}</td>
      <td class="n">${fmt(shift.opening_floats[cur] || 0)}</td>
      <td class="n">${fmt(shift.cash_sales[cur] || 0)}</td>
      <td class="n b">${fmt(shift.expected[cur] || 0)}</td>
      <td class="n">${shift.counted_close ? fmt(shift.counted_close[cur] || 0) : '—'}</td>
      <td class="n ${v === null ? '' : v === 0 ? 'ok' : 'bad'}">${v === null ? '—' : `${v > 0 ? '+' : ''}${fmt(v)}`}</td>
    </tr>`;
  }).join('');
  const moves = shift.movements.map((m) => m.type === 'exchange'
    ? `<li>Exchange · ${fmt(m.from_amount || 0)} ${esc(m.from_currency || '')} → ${fmt(m.to_amount || 0)} ${esc(m.to_currency || '')}${m.reason ? ` — ${esc(m.reason)}` : ''}</li>`
    : `<li>${m.type === 'pay_in' ? 'Pay in' : 'Pay out'} · ${fmt(m.amount || 0)} ${esc(m.currency || '')}${m.reason ? ` — ${esc(m.reason)}` : ''}</li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Z-Report</title><style>
    body{font-family:system-ui,-apple-system,sans-serif;color:#111;max-width:520px;margin:24px auto;padding:0 16px}
    h1{font-size:20px;margin:0 0 2px}.sub{color:#666;font-size:13px;margin:0 0 16px}
    table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 4px;border-bottom:1px solid #eee}
    th{text-align:right;color:#888;font-weight:600;font-size:11px;text-transform:uppercase}th:first-child,.c{text-align:left}
    .n{text-align:right;font-variant-numeric:tabular-nums}.b{font-weight:700}.ok{color:#059669}.bad{color:#dc2626;font-weight:700}
    ul{font-size:13px;color:#444;padding-left:18px}h2{font-size:13px;text-transform:uppercase;color:#888;margin:18px 0 6px}
  </style></head><body>
    ${businessName ? `<h1>${esc(businessName)}</h1>` : ''}<h1>Z-Report · Shift #${shift.id}</h1>
    <p class="sub">Opened ${esc(formatTs(shift.opened_at))} · Closed ${esc(formatTs(shift.closed_at))}</p>
    <table><thead><tr><th>Currency</th><th>Opening</th><th>Cash sales</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead><tbody>${rows}</tbody></table>
    ${moves ? `<h2>Movements</h2><ul>${moves}</ul>` : ''}
  </body></html>`;
}
