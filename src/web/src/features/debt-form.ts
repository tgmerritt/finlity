/**
 * Plain add/edit form for a debt, and the field module the wizard reuses.
 *
 * `buildDebtFields` renders the fields for a draft and reads them back; it
 * knows nothing about modals or the API. `openDebtForm` wraps it in a dialog
 * and saves through /api/liabilities. All values go into the DOM with
 * textContent or element properties, never as markup.
 */

import { apiCall, ApiError } from '@/api/client';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { showToast } from '@/ui/toast';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import { annuityPayment, firstDueAfter, periodsPerYear } from '@/utils/amortization';
import { today } from '@/utils/clock';
import { formatCurrency } from '@/utils/format';
import {
  DEBT_TYPES,
  FREQUENCIES,
  defaultsFor,
  fieldsFor,
  switchType,
  toCreateInput,
  toUpdateInput,
  validateDraft,
  type DebtDraft,
  type DebtField,
  type DebtFieldKey,
} from '@/utils/debt-fields';
import { LIABILITY_TYPE_LABELS } from '@/utils/liabilities';
import type { Entity, LiabilityFrequency, LiabilityResponse } from '@/types/api';

const FREQUENCY_WORD: Record<LiabilityFrequency, string> = {
  weekly: 'week',
  biweekly: '2 weeks',
  monthly: 'month',
  quarterly: 'quarter',
  annual: 'year',
};

const FREQUENCY_LABELS: Record<LiabilityFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly',
};

/** Friendly text for a failed debt request. Never the server's own detail. */
export function debtErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 404) return 'This debt no longer exists. Refresh the page and try again.';
  if (status === 409) return 'That budget expense is already linked to another debt.';
  if (status === 403) return 'Changes are turned off in the demo.';
  if (status === 422) return 'Some details were not accepted. Check the amounts and dates.';
  if (status === 400) return 'That request could not be completed. Check the details.';
  return 'Could not save your changes. Please try again.';
}

const day = (value: string | null | undefined): string => (value ?? '').slice(0, 10);
const str = (value: number | null | undefined): string => (value == null ? '' : String(value));

const MONTH_BASED = new Set(['monthly', 'quarterly', 'annual']);

/**
 * The stored next payment date can be long past. Show the first due date after
 * today instead, unless that changes the day of the month (a 31st clamped to a
 * 30th): then keep the stored anchor so saving does not shift later due dates.
 */
function nextDueForForm(d: LiabilityResponse): string {
  const anchor = day(d.next_payment_date);
  if (!anchor) return '';
  const freq = d.payment_frequency || 'monthly';
  const rolled = firstDueAfter(anchor, freq, today());
  if (MONTH_BASED.has(freq) && rolled.slice(8, 10) !== anchor.slice(8, 10)) return anchor;
  return rolled;
}

/**
 * Payment calculated from balance, APR and term, when the payment field is
 * blank and those are all usable. Rounded to cents; null otherwise.
 */
export function computedPayment(draft: DebtDraft): number | null {
  if (draft.paymentAmount.trim() !== '') return null;
  if (!fieldsFor(draft.liabilityType).some((f) => f.key === 'termMonths')) return null;
  // The name does not affect the payment: show the figure before it is typed.
  const { values } = validateDraft(draft.name.trim() ? draft : { ...draft, name: 'x' });
  if (!values || values.termMonths === null || values.currentBalance <= 0) return null;
  const perYear = periodsPerYear(draft.paymentFrequency);
  const periods = Math.max(1, Math.round((values.termMonths / 12) * perYear));
  const payment = annuityPayment(
    values.currentBalance,
    values.interestRate ?? 0,
    periods,
    draft.paymentFrequency
  );
  return Number.isFinite(payment) ? Math.round(payment * 100) / 100 : null;
}

/** The draft with a blank payment filled from `computedPayment`, when there is one. */
export function withComputedPayment(draft: DebtDraft): DebtDraft {
  const payment = computedPayment(draft);
  return payment === null ? draft : { ...draft, paymentAmount: String(payment) };
}

/** Prefill a draft from a debt. Owner and linked home are kept: blanks would unlink. */
export function draftFromDebt(d: LiabilityResponse): DebtDraft {
  return {
    ...defaultsFor(d.liability_type),
    name: d.name,
    currentBalance: String(d.current_balance),
    aprPercent: d.interest_rate == null ? '' : String(Number((d.interest_rate * 100).toFixed(4))),
    paymentAmount: str(d.payment_amount),
    paymentFrequency: (d.payment_frequency as LiabilityFrequency) || 'monthly',
    nextPaymentDate: nextDueForForm(d),
    escrowAmount: str(d.escrow_amount),
    creditLimit: str(d.credit_limit),
    termMonths: str(d.term_months),
    originalPrincipal: str(d.original_principal),
    originationDate: day(d.origination_date),
    maturityDate: day(d.maturity_date),
    lender: d.lender ?? '',
    entityId: d.entity_id ?? '',
    linkedPositionId: d.linked_position_id ?? '',
    notes: d.notes ?? '',
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = el('option', undefined, label);
  o.value = value;
  return o;
}

export interface DebtFieldsOptions {
  entities?: readonly Entity[];
  /** Field keys to leave out (the edit form has no balance). */
  omit?: readonly DebtFieldKey[];
  /** Hide the type picker (the wizard chooses the type in its own step). */
  hideType?: boolean;
}

export interface DebtFieldsHandle {
  element: HTMLElement;
  read(): DebtDraft;
  /** Show messages under fields and focus the first one. */
  showErrors(errors: Partial<Record<DebtFieldKey, string>>): void;
}

function inputFor(field: DebtField, draft: DebtDraft, opts: DebtFieldsOptions): HTMLElement {
  const id = `debt-field-${field.key}`;
  let input: HTMLInputElement | HTMLSelectElement;
  if (field.kind === 'select') {
    input = el('select');
    if (field.key === 'paymentFrequency') {
      for (const f of FREQUENCIES) input.appendChild(option(f, FREQUENCY_LABELS[f]));
    } else {
      input.appendChild(option('', 'Household'));
      const people = (opts.entities ?? []).filter((p) => !p.is_household);
      for (const p of people) input.appendChild(option(p.id, p.name));
      const current = draft.entityId;
      if (current && !people.some((p) => p.id === current)) {
        input.appendChild(option(current, 'Current owner'));
      }
    }
  } else {
    input = el('input');
    if (field.kind === 'date') {
      input.type = 'date';
    } else {
      input.type = 'text';
      if (field.kind === 'money' || field.kind === 'percent') input.inputMode = 'decimal';
      if (field.kind === 'integer') input.inputMode = 'numeric';
    }
    if (field.key === 'name') input.maxLength = 120;
  }
  input.id = id;
  input.setAttribute('data-debt-field', field.key);
  input.value = draft[field.key];
  return input;
}

/** Keep the ids of aria-describedby that pass `keep`, then add `extra`. */
function setDescribedBy(node: Element, keep: (id: string) => boolean, extra?: string): void {
  const ids = (node.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((i) => i && keep(i));
  if (extra && !ids.includes(extra)) ids.push(extra);
  if (ids.length > 0) node.setAttribute('aria-describedby', ids.join(' '));
  else node.removeAttribute('aria-describedby');
}

/**
 * Show a message under each named field (matched by data-debt-field), clearing
 * earlier ones, and focus the first. Also used by the Update balance dialog.
 */
export function applyFieldErrors(root: HTMLElement, errors: Partial<Record<string, string>>): void {
  root.querySelectorAll('.debt-field-error').forEach((n) => n.remove());
  root.querySelectorAll('[aria-invalid]').forEach((n) => {
    n.removeAttribute('aria-invalid');
    setDescribedBy(n, (id) => !id.startsWith('debt-error-'));
  });
  let first: HTMLElement | null = null;
  for (const [key, message] of Object.entries(errors)) {
    const input = root.querySelector<HTMLElement>(`[data-debt-field="${key}"]`);
    if (!input || !message) continue;
    input.setAttribute('aria-invalid', 'true');
    const msg = el('span', 'debt-field-error', message);
    msg.id = `debt-error-${key}`;
    msg.setAttribute('role', 'alert');
    setDescribedBy(input, () => true, msg.id);
    input.parentElement?.appendChild(msg);
    const details = input.closest('details');
    if (details) details.open = true;
    first ??= input;
  }
  first?.focus();
}

/** Fields for a debt draft, re-rendered when the type changes. */
export function buildDebtFields(
  initial: DebtDraft,
  opts: DebtFieldsOptions = {}
): DebtFieldsHandle {
  const root = el('div', 'debt-form-fields');
  let draft = initial;

  const read = (): DebtDraft => {
    const next = { ...draft };
    const typeSelect = root.querySelector<HTMLSelectElement>('[data-debt-field="liabilityType"]');
    if (typeSelect) next.liabilityType = typeSelect.value as DebtDraft['liabilityType'];
    root
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-debt-field]')
      .forEach((n) => {
        const key = n.getAttribute('data-debt-field') as DebtFieldKey | 'liabilityType';
        if (key !== 'liabilityType') Object.assign(next, { [key]: n.value });
      });
    return next;
  };

  const group = (field: DebtField): HTMLElement => {
    const wrap = el('div', 'form-group');
    const label = el('label', undefined, field.label);
    label.htmlFor = `debt-field-${field.key}`;
    wrap.appendChild(label);
    const input = inputFor(field, draft, opts);
    wrap.appendChild(input);
    if (field.hint) {
      const hint = el('span', 'debt-field-hint', field.hint);
      hint.id = `debt-hint-${field.key}`;
      setDescribedBy(input, () => true, hint.id);
      wrap.appendChild(hint);
    }
    if (field.key === 'paymentAmount') {
      const note = el('span', 'debt-field-hint debt-computed');
      note.id = 'debt-computed-paymentAmount';
      note.setAttribute('aria-live', 'polite');
      setDescribedBy(input, () => true, note.id);
      wrap.appendChild(note);
    }
    return wrap;
  };

  /** Show the calculated payment under the payment field while it is blank. */
  const updateNote = (): void => {
    const note = root.querySelector<HTMLElement>('.debt-computed');
    if (!note) return;
    const payment = computedPayment(read());
    note.textContent =
      payment === null
        ? ''
        : `Calculated from the balance, rate and term: ${formatCurrency(payment)} per ${FREQUENCY_WORD[read().paymentFrequency]}. It is used when the payment is left blank.`;
  };
  root.addEventListener('input', updateNote);
  root.addEventListener('change', updateNote);

  const render = (): void => {
    root.textContent = '';
    if (!opts.hideType) {
      const wrap = el('div', 'form-group');
      const label = el('label', undefined, 'Type of debt');
      label.htmlFor = 'debt-field-liabilityType';
      const select = el('select');
      select.id = 'debt-field-liabilityType';
      select.setAttribute('data-debt-field', 'liabilityType');
      for (const t of DEBT_TYPES) select.appendChild(option(t, LIABILITY_TYPE_LABELS[t]));
      select.value = draft.liabilityType;
      select.addEventListener('change', () => {
        draft = switchType(read(), select.value as DebtDraft['liabilityType']);
        render();
        root.querySelector<HTMLElement>('[data-debt-field="liabilityType"]')?.focus();
      });
      wrap.appendChild(label);
      wrap.appendChild(select);
      root.appendChild(wrap);
    }
    const omit = new Set(opts.omit ?? []);
    const fields = fieldsFor(draft.liabilityType).filter((f) => !omit.has(f.key));
    const grid = el('div', 'debt-form-grid');
    for (const f of fields.filter((x) => !x.advanced)) grid.appendChild(group(f));
    root.appendChild(grid);
    const advanced = fields.filter((x) => x.advanced);
    if (advanced.length > 0) {
      const more = el('details', 'debt-form-more');
      more.appendChild(el('summary', undefined, 'More details'));
      const moreGrid = el('div', 'debt-form-grid');
      for (const f of advanced) moreGrid.appendChild(group(f));
      more.appendChild(moreGrid);
      root.appendChild(more);
    }
    updateNote();
  };
  render();

  const showErrors = (errors: Partial<Record<DebtFieldKey, string>>): void => {
    applyFieldErrors(root, errors);
  };

  return { element: root, read, showErrors };
}

/** Pressing Enter in a text field saves the dialog, like clicking its save button. */
export function submitOnEnter(form: HTMLElement, modal: HTMLElement): void {
  form.addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.key !== 'Enter' || !(target instanceof HTMLInputElement)) return;
    if (target.type === 'checkbox' || target.type === 'button') return;
    event.preventDefault();
    modal.querySelector<HTMLButtonElement>('[data-action="save"]')?.click();
  });
}

/** A banner under the form fields for a failed request. */
export function showFormError(host: HTMLElement, message: string): void {
  let banner = host.querySelector<HTMLElement>('.debt-form-error');
  if (!banner) {
    banner = el('p', 'debt-form-error');
    banner.setAttribute('role', 'alert');
    host.appendChild(banner);
  }
  banner.textContent = message;
}

export interface OpenDebtFormOptions {
  /** Set to edit this debt; omit to add a new one. */
  debt?: LiabilityResponse;
  entities?: readonly Entity[];
  onSaved?: (saved: LiabilityResponse) => void | Promise<void>;
}

/** Open the plain add or edit dialog. */
export function openDebtForm(options: OpenDebtFormOptions = {}): void {
  const { debt, entities } = options;
  const draft = debt ? draftFromDebt(debt) : defaultsFor('mortgage');
  const fields = buildDebtFields(draft, {
    ...(entities ? { entities } : {}),
    omit: debt ? ['currentBalance'] : [],
  });
  const content = el('form', 'debt-form');
  content.noValidate = true;
  content.addEventListener('submit', (e) => e.preventDefault());
  content.appendChild(fields.element);

  const modal = createDynamicModal({
    title: debt ? 'Edit debt' : 'Add a debt',
    content,
    saveButtonText: debt ? 'Save changes' : 'Add debt',
    modalClass: 'debt-form-modal',
    onSave: async (event) => {
      const current = withComputedPayment(fields.read());
      const { errors } = validateDraft(current);
      // A linked budget expense is synced from the payment, which the server
      // refuses to do without one (422): ask for it here instead.
      if (debt?.expense_id && current.paymentAmount.trim() === '' && !errors.paymentAmount) {
        errors.paymentAmount = 'Enter a payment: your linked budget expense follows it';
      }
      fields.showErrors(errors);
      if (Object.keys(errors).length > 0) return;
      const button = event.currentTarget as HTMLButtonElement | null;
      try {
        const saved = await withSubmitGuard(button, 'Saving...', async () => {
          if (debt) {
            return apiCall<LiabilityResponse>(`/api/liabilities/${encodeURIComponent(debt.id)}`, {
              method: 'PUT',
              body: toUpdateInput(current),
            });
          }
          return apiCall<LiabilityResponse>('/api/liabilities', {
            method: 'POST',
            body: toCreateInput(current),
          });
        });
        closeDynamicModal();
        showToast(debt ? 'Debt updated' : 'Debt added', 'success');
        await options.onSaved?.(saved);
      } catch (error) {
        console.error('Debt save failed:', error instanceof Error ? error.name : 'error');
        showFormError(content, debtErrorMessage(error));
      }
    },
  });
  submitOnEnter(content, modal);
  modal.querySelector<HTMLElement>('[data-debt-field]')?.focus();
}
