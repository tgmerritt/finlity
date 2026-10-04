/**
 * DOM builders and fixed copy shared by the smart import wizard steps. Every
 * value goes in with textContent or an element property: statement text and
 * file names are user data.
 */

import { formatCurrency } from '@/utils/format';
import type { SmartImportAccountKind } from '@/types/api';
import type { WizardStatement } from '@/utils/smart-import-state';

export const ACCEPT = '.csv,.ofx,.qfx,.pdf';
export const MAX_FILES = 12;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LABEL_CHARS = 190;

export const STEP_LABELS = [
  'Upload',
  'Accounts',
  'Categorize',
  'Recurring bills',
  'Review',
] as const;

export const PRIVACY_LINE =
  'Files are read once and never kept. Only masked transactions are saved, in your own database.';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className: string, action: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.setAttribute('data-si', action);
  return b;
}

/** A labelled form control wrapper. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'form-group');
  const id = control.id || `si-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  const l = el('label', undefined, label);
  l.htmlFor = id;
  wrap.append(l, control);
  if (hint) wrap.appendChild(el('p', 'smart-import-hint', hint));
  return wrap;
}

export function select(
  options: readonly { value: string; label: string }[],
  value: string,
  attrs: Record<string, string> = {}
): HTMLSelectElement {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    s.appendChild(opt);
  }
  s.value = value;
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  return s;
}

// ---------------------------------------------------------------- copy

export const KIND_LABEL: Record<SmartImportAccountKind, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  loan: 'Loan',
  unknown: 'Account',
};

export const KIND_CHOICES: readonly { value: string; label: string }[] = [
  { value: 'unknown', label: 'Choose a type' },
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'loan', label: 'Loan' },
];

/** The server's fixed `detail` strings (src/smart_import/errors.py) mapped to a catalog code. */
const DETAIL_TO_TYPE: Record<string, string> = {
  'The file is larger than the 10 MB limit.': 'file_too_large',
  'This file type is not supported. Use CSV, OFX, QFX or PDF.': 'unsupported_type',
  'The statement has more rows than the import limit allows.': 'too_many_rows',
  'A field in the file is larger than the import limit allows.': 'field_too_large',
  'The OFX file is larger than the import limit allows.': 'ofx_too_large',
  'This OFX file uses features that are not supported.': 'unsupported_ofx',
  'The PDF has more pages than the import limit allows.': 'too_many_pages',
  'The PDF contains more text than the import limit allows.': 'pdf_text_too_large',
  'The file took too long to read.': 'parse_timeout',
  'The PDF has no readable text. Scanned statements are not supported.': 'no_text_layer',
  'The PDF is password protected.': 'encrypted_pdf',
  'Too many files are being read right now. Try again in a moment.': 'busy',
};

const ERROR_COPY: Record<string, string> = {
  file_too_large: 'This file is larger than the 10 MB limit.',
  unsupported_type: 'Only CSV, OFX, QFX and PDF files can be imported.',
  too_many_rows: 'This statement has more rows than the import limit allows.',
  field_too_large: 'This file has a value that is too large to import.',
  ofx_too_large: 'This OFX file is larger than the import limit allows.',
  unsupported_ofx: 'This OFX file uses features that are not supported.',
  too_many_pages: 'This PDF has more pages than the import limit allows.',
  pdf_text_too_large: 'This PDF has more text than the import limit allows.',
  parse_timeout: 'This file took too long to read.',
  no_text_layer: 'This PDF has no readable text. Scanned statements are not supported.',
  encrypted_pdf: 'This PDF is password protected.',
  busy: 'Too many files are being read right now. Try again in a moment.',
  network: 'The file could not be sent. Check your connection and try again.',
  unreadable: 'This file could not be read as a statement.',
};

/** A catalog code for a failed analyze call. Never uses the server's text beyond matching it. */
export function analyzeErrorType(status: number, detail: string): string {
  const known = DETAIL_TO_TYPE[detail];
  if (known) return known;
  if (status === 0) return 'network';
  if (status === 413) return 'file_too_large';
  if (status === 415) return 'unsupported_type';
  if (status === 503 || status === 429) return 'busy';
  return 'unreadable';
}

export function analyzeErrorText(errorType: string | null): string {
  return (errorType && ERROR_COPY[errorType]) || ERROR_COPY.unreadable!;
}

/** Fixed copy for a failed PDF extract call. */
export function extractErrorText(status: number): string {
  if (status === 403) {
    return 'AI for unreadable PDFs is turned off. Turn it on in Settings, or try your bank’s CSV or OFX download.';
  }
  if (status === 503) {
    return 'AI is not available right now. Try your bank’s CSV or OFX download.';
  }
  return 'The AI service could not read these lines. Try your bank’s CSV or OFX download.';
}

export const WARNING_COPY: Record<string, string> = {
  rows_skipped: 'Some rows could not be read and were skipped.',
  available_balance_used: 'The balance shown is the available balance.',
  duplicate_fitid: 'Some transactions shared an id in the file.',
  truncated_file: 'The file looks cut off, so some transactions may be missing.',
  year_assumed: 'The year was not printed, so it was assumed.',
  sign_assumed: 'The direction of the amounts was assumed.',
};

// ---------------------------------------------------------------- formatting

/**
 * "Jul 1, 2026" for a 'YYYY-MM-DD' day. Built from the parts so the day never
 * shifts with the time zone (new Date('2026-07-01') is midnight UTC).
 */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function periodText(period: WizardStatement['period']): string {
  const { start, end } = period;
  if (start && end) return `${formatDay(start)} to ${formatDay(end)}`;
  if (end) return `Through ${formatDay(end)}`;
  if (start) return `From ${formatDay(start)}`;
  return 'Period not shown in the file';
}

export function isDebtKind(kind: SmartImportAccountKind): boolean {
  return kind === 'credit_card' || kind === 'loan';
}

/** "Balance owed $1,200.00" for debts, "Closing balance $2,500.50" otherwise. */
export function balanceText(stmt: WizardStatement): string | null {
  const bal = stmt.closing_balance;
  if (!bal) return null;
  const label = isDebtKind(stmt.account_kind) ? 'Balance owed' : 'Closing balance';
  return `${label} ${formatCurrency(bal.amount)} on ${formatDay(bal.as_of)}`;
}

export function countText(n: number, singular: string): string {
  return `${n.toLocaleString('en-US')} ${singular}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- mapping

export const MAPPING_FIELDS: readonly { key: string; label: string; required: boolean }[] = [
  { key: 'date', label: 'Date', required: true },
  { key: 'description', label: 'Description', required: true },
  { key: 'amount', label: 'Amount (one signed column)', required: false },
  { key: 'debit', label: 'Debit (money out)', required: false },
  { key: 'credit', label: 'Credit (money in)', required: false },
];

const GUESS: [string, RegExp][] = [
  ['date', /date|posted|when/i],
  ['description', /descr|memo|payee|merchant|name|detail/i],
  ['amount', /^amount$|amount/i],
  ['debit', /debit|withdraw|money out|charge/i],
  ['credit', /credit|deposit|money in|payment/i],
];

/** A first guess at which header is which field (the person can change it). */
export function guessMapping(headers: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const [key, pattern] of GUESS) {
    const hit = headers.find((h) => !used.has(h) && pattern.test(h));
    if (hit) {
      out[key] = hit;
      used.add(hit);
    }
  }
  return out;
}

/** Date, description and an amount (or both debit and credit) are needed. */
export function mappingComplete(mapping: Record<string, string>): boolean {
  const has = (k: string): boolean => !!mapping[k];
  return has('date') && has('description') && (has('amount') || (has('debit') && has('credit')));
}
