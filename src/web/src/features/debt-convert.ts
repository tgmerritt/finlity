/**
 * Conversion dialog: turn a real estate row into a mortgage, only after the
 * person has said what the row means and has seen every change. Steps: (1)
 * what the row represents and the amounts that follow from it, (2) the
 * mortgage details, (3) the confirm screen with each change plus portfolio
 * value and net worth before and after. Nothing is sent until Confirm; the
 * reads that fill the screens are GETs. Also holds the "Undo conversion" prompt.
 *
 * Contract: POST /api/liabilities/convert-position and
 * POST /api/liabilities/{id}/revert-conversion (see the liabilities design,
 * section 8). All values go into the DOM with textContent.
 */

import { apiCall, ApiError } from '@/api/client';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { showToast } from '@/ui/toast';
import { emit } from '@/state/events';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import {
  applyFieldErrors,
  buildDebtFields,
  showFormError,
  type DebtFieldsHandle,
} from '@/features/debt-form';
import { today } from '@/utils/clock';
import { formatCurrency } from '@/utils/format';
import { defaultsFor, toCreateInput, validateDraft, type DebtDraft } from '@/utils/debt-fields';
import { effectivePayment, reviewDebt, suggestExpense } from '@/utils/debt-review';
import type {
  ConvertPositionInput,
  ConvertPositionResult,
  Entity,
  Expense,
  LiabilityResponse,
  PositionResponse,
} from '@/types/api';

export type ConvertMode = 'property_value' | 'equity' | 'loan';
type CashMode = 'create' | 'link' | 'none';

export interface OpenDebtConvertOptions {
  entities?: readonly Entity[];
  /** Called after a successful conversion, with the server's result. */
  onDone?: (result: ConvertPositionResult) => void;
}

export interface DebtConvertHandle {
  modal: HTMLElement;
  close: () => void;
}

/** Messages the contract fixes. Only these are shown from the server; anything else gets generic text. */
const KNOWN_MESSAGES: ReadonlySet<string> = new Set([
  'Position not found',
  'Expense not found',
  'Expense category not found',
  'Only real estate positions can be converted',
  'This position is already converted',
  'This position is already linked to a debt',
  'This position has tax lots and cannot be converted to a loan',
  'This position has no units to price',
  'Expense is already linked to another liability',
  'Date cannot be in the future',
  'A payment amount is required to create an expense',
  'No expense category exists',
  'Could not save the liability',
  'Liability not found',
  'Only converted debts can be undone',
  'This conversion cannot be undone',
  'The property value changed after the conversion, so it cannot be undone',
  'The property was removed after the conversion, so it cannot be undone',
  'The original position already exists',
  'The account that held this position no longer exists',
]);

/** Friendly text for a failed request. The server's own detail is shown only when the contract fixes it. */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (KNOWN_MESSAGES.has(error.message)) return error.message;
    if (error.status === 403) return 'Changes are turned off in the demo.';
    if (error.status === 422) return 'Some details were not accepted. Check the amounts and dates.';
    if (error.status === 409)
      return 'That could not be done because something changed. Nothing was changed.';
  }
  return fallback;
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

function button(label: string, className: string, action: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.setAttribute('data-convert', action);
  return b;
}

const money = (raw: string): number => {
  const t = raw.replace(/[$,\s]/g, '');
  return t === '' ? NaN : Number(t);
};
const round2 = (n: number): number => Math.round(n * 100) / 100;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const MODES: ReadonlyArray<{ mode: ConvertMode; title: string; hint: string }> = [
  {
    mode: 'property_value',
    title: 'The home’s value',
    hint: 'The row stays exactly as it is. The new mortgage links to it.',
  },
  {
    mode: 'equity',
    title: 'My equity (value minus what I owe)',
    hint: 'The row’s value becomes the home’s market value, and a mortgage is added for the loan.',
  },
  {
    mode: 'loan',
    title: 'The loan itself',
    hint: 'The row is removed and a mortgage is added in its place. You can add the home too.',
  },
];

interface Totals {
  portfolio: number;
  netWorth: number;
  debts: number;
}

interface ConvertState {
  step: 1 | 2 | 3 | 4;
  mode: ConvertMode | null;
  balance: string;
  balanceTouched: boolean;
  homeValue: string;
  homeTouched: boolean;
  addHome: boolean;
  newHomeName: string;
  newHomeValue: string;
  newHomeCost: string;
  newHomeDate: string;
  draft: DebtDraft;
  cash: { mode: CashMode; expenseId: string };
  cashTouched: boolean;
}

const positionLabel = (p: PositionResponse): string => p.name || p.ticker;
const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** "$1.00 to $2.00", or "$1.00 (unchanged)". */
export function beforeAfter(before: number, after: number): string {
  return same(before, after)
    ? `${formatCurrency(before)} (unchanged)`
    : `${formatCurrency(before)} to ${formatCurrency(after)}`;
}

/** Open the dialog for one position. The position is read fresh; nothing is written until Confirm. */
export function openDebtConvert(
  positionId: string,
  options: OpenDebtConvertOptions = {}
): DebtConvertHandle {
  const state: ConvertState = {
    step: 1,
    mode: null,
    balance: '',
    balanceTouched: false,
    homeValue: '',
    homeTouched: false,
    addHome: false,
    newHomeName: '',
    newHomeValue: '',
    newHomeCost: '',
    newHomeDate: '',
    draft: { ...defaultsFor('mortgage'), name: 'Mortgage' },
    cash: { mode: 'none', expenseId: '' },
    cashTouched: false,
  };
  let position: PositionResponse | null = null;
  let totals: Totals | null = null;
  let expenses: Expense[] = [];
  let takenExpenseIds = new Set<string>();
  let fields: DebtFieldsHandle | null = null;
  let submitting = false;
  let blocked = false;

  const shell = el('div', 'debt-wizard debt-convert');
  const progress = el('p', 'debt-wizard-progress');
  const body = el('div', 'debt-wizard-step');
  shell.append(progress, body);
  const modal = createDynamicModal({
    title: 'Loan or property',
    content: shell,
    showFooter: false,
    modalClass: 'debt-wizard-modal debt-convert-modal modal-sheet',
  });
  const content = modal.querySelector<HTMLElement>('.modal-content')!;
  const footer = el('div', 'debt-wizard-footer');
  content.appendChild(footer);

  const close = (): void => closeDynamicModal();

  function setStep(step: ConvertState['step'], title: string): HTMLElement {
    state.step = step;
    progress.textContent = step === 4 ? '' : `Step ${step} of 3`;
    body.textContent = '';
    const h = el('h3', 'debt-wizard-heading debt-convert-heading', title);
    h.tabIndex = -1;
    body.appendChild(h);
    footer.textContent = '';
    return h;
  }

  function footerButtons(left: HTMLButtonElement, right?: HTMLButtonElement): void {
    footer.textContent = '';
    footer.appendChild(left);
    if (right) footer.appendChild(right);
  }

  // ---- loading --------------------------------------------------------

  function renderLoading(): void {
    setStep(1, 'Loading...');
    progress.textContent = '';
    const cancel = button('Cancel', 'btn btn-secondary', 'cancel');
    cancel.addEventListener('click', close);
    footerButtons(cancel);
  }

  function renderProblem(message: string): void {
    setStep(1, 'Loan or property');
    progress.textContent = '';
    const note = el('p', 'debt-form-error', message);
    note.setAttribute('role', 'alert');
    body.appendChild(note);
    const done = button('Close', 'btn btn-primary', 'cancel');
    done.addEventListener('click', close);
    footerButtons(done);
  }

  async function load(): Promise<void> {
    const [all, dash, list, debts] = await Promise.all([
      apiCall<PositionResponse[]>('/api/portfolio/positions').catch((error: unknown) => {
        console.error('Position load failed:', error instanceof Error ? error.name : 'error');
        return null;
      }),
      apiCall<{ summary?: Record<string, number | undefined> }>('/api/dashboard/data').catch(
        () => null
      ),
      apiCall<Expense[]>('/api/budget/expenses').catch(() => [] as Expense[]),
      apiCall<LiabilityResponse[]>('/api/liabilities').catch(() => [] as LiabilityResponse[]),
    ]);
    if (!modal.isConnected) return;
    if (all === null) {
      renderProblem('Could not load this position. Close this and try again.');
      return;
    }
    position = (Array.isArray(all) ? all : []).find((p) => p.id === positionId) ?? null;
    if (!position) {
      renderProblem('That position could not be found. It may have been removed.');
      return;
    }
    const summary = dash && !Array.isArray(dash) ? dash.summary : undefined;
    if (summary && typeof summary.total_value === 'number') {
      const debtsTotal = summary.liabilities_total ?? 0;
      totals = {
        portfolio: summary.total_value,
        netWorth: summary.net_worth ?? summary.total_value - debtsTotal,
        debts: debtsTotal,
      };
    }
    const debtList = Array.isArray(debts) ? debts : [];
    // Refuse early with the server's own wording, before asking any questions.
    if (debtList.some((d) => d.source === 'converted_position' && d.source_ref === positionId)) {
      renderProblem('This position is already converted');
      return;
    }
    if (debtList.some((d) => d.linked_position_id === positionId)) {
      renderProblem('This position is already linked to a debt');
      return;
    }
    expenses = Array.isArray(list) ? list : [];
    takenExpenseIds = new Set(debtList.flatMap((d) => (d.expense_id ? [d.expense_id] : [])));
    state.homeValue = String(round2(position.market_value));
    renderQuestion();
  }

  // ---- step 1: the question -------------------------------------------

  function amountInput(
    key: string,
    label: string,
    value: string,
    kind: 'text' | 'money' | 'date',
    onInput?: () => void
  ): HTMLElement {
    const wrap = el('div', 'form-group');
    const l = el('label', undefined, label);
    l.htmlFor = `debt-field-${key}`;
    const input = el('input');
    input.id = `debt-field-${key}`;
    input.setAttribute('data-debt-field', key);
    input.setAttribute('data-convert-field', key);
    input.type = kind === 'date' ? 'date' : 'text';
    if (kind === 'money') input.inputMode = 'decimal';
    if (kind === 'text') input.maxLength = 120;
    input.value = value;
    if (onInput) input.addEventListener('input', onInput);
    wrap.append(l, input);
    return wrap;
  }

  const inputOf = (key: string): HTMLInputElement | null =>
    body.querySelector<HTMLInputElement>(`[data-convert-field="${key}"]`);

  /** Copy the visible step 1 inputs into state. */
  function readQuestion(): void {
    const val = (key: string, fallback: string): string => inputOf(key)?.value ?? fallback;
    state.balance = val('balance', state.balance);
    state.homeValue = val('homeValue', state.homeValue);
    const add = inputOf('addHome');
    if (add) state.addHome = add.checked;
    state.newHomeName = val('newHomeName', state.newHomeName);
    state.newHomeValue = val('newHomeValue', state.newHomeValue);
    state.newHomeCost = val('newHomeCost', state.newHomeCost);
    state.newHomeDate = val('newHomeDate', state.newHomeDate);
  }

  function renderAmounts(host: HTMLElement): void {
    host.textContent = '';
    const p = position!;
    if (state.mode === 'equity') {
      const note = el('p', 'debt-field-hint debt-convert-sum');
      note.setAttribute('aria-live', 'polite');
      const updateNote = (): void => {
        const home = money(inputOf('homeValue')?.value ?? state.homeValue);
        const owed = money(inputOf('balance')?.value ?? state.balance);
        note.textContent =
          Number.isFinite(home) && Number.isFinite(owed)
            ? `Home value minus the loan is ${formatCurrency(home - owed)}. This row is ${formatCurrency(p.market_value)} now.`
            : '';
      };
      const grid = el('div', 'debt-form-grid');
      grid.append(
        amountInput('homeValue', 'The home’s market value', state.homeValue, 'money', () => {
          state.homeTouched = true;
          updateNote();
        }),
        amountInput('balance', 'What you owe on the loan', state.balance, 'money', () => {
          state.balanceTouched = true;
          if (!state.homeTouched) {
            const owed = money(inputOf('balance')!.value);
            const home = inputOf('homeValue')!;
            home.value = String(round2(p.market_value + (Number.isFinite(owed) ? owed : 0)));
          }
          updateNote();
        })
      );
      host.append(grid, note);
      updateNote();
    } else if (state.mode === 'loan') {
      const grid = el('div', 'debt-form-grid');
      grid.appendChild(
        amountInput('balance', 'What you owe on the loan', state.balance, 'money', () => {
          state.balanceTouched = true;
        })
      );
      host.appendChild(grid);
      const row = el('label', 'debt-wizard-choice');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = state.addHome;
      box.setAttribute('data-convert-field', 'addHome');
      box.addEventListener('change', () => {
        readQuestion();
        renderAmounts(host);
        inputOf('addHome')?.focus();
      });
      row.append(box, el('span', undefined, 'Also add the home'));
      host.appendChild(row);
      if (state.addHome) {
        const homeGrid = el('div', 'debt-form-grid');
        homeGrid.append(
          amountInput('newHomeName', 'Home name', state.newHomeName, 'text'),
          amountInput('newHomeValue', 'Market value', state.newHomeValue, 'money'),
          amountInput('newHomeCost', 'Purchase price (optional)', state.newHomeCost, 'money'),
          amountInput('newHomeDate', 'Purchase date (optional)', state.newHomeDate, 'date')
        );
        host.appendChild(homeGrid);
      }
    }
  }

  function renderQuestion(): void {
    const p = position!;
    fields = null;
    const h = setStep(
      1,
      `What does ${positionLabel(p)} (${formatCurrency(p.market_value)}) represent?`
    );
    const group = el('div', 'debt-convert-modes');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'What this row represents');
    const amounts = el('div', 'debt-convert-amounts');
    for (const m of MODES) {
      const card = el('label', 'debt-wizard-type debt-convert-mode');
      const radio = el('input', 'debt-wizard-radio');
      radio.type = 'radio';
      radio.name = 'debt-convert-mode';
      radio.value = m.mode;
      radio.checked = state.mode === m.mode;
      radio.setAttribute('data-convert-mode', m.mode);
      card.classList.toggle('is-selected', state.mode === m.mode);
      const text = el('span', 'debt-wizard-type-text');
      text.append(
        el('span', 'debt-wizard-type-name', m.title),
        el('span', 'debt-wizard-type-hint', m.hint)
      );
      card.append(radio, text);
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        readQuestion();
        state.mode = m.mode;
        if (m.mode === 'loan' && !state.balanceTouched) {
          state.balance = String(round2(Math.abs(p.market_value)));
        } else if (m.mode === 'equity' && !state.balanceTouched) {
          state.balance = '';
        }
        group.querySelectorAll('.debt-convert-mode').forEach((c) => {
          c.classList.toggle('is-selected', c === card);
        });
        renderAmounts(amounts);
        footerNext().disabled = false;
      });
      group.appendChild(card);
    }
    // A form rebuilt on every render, so Enter handling cannot stack or leak into
    // later steps (the step 2 form has its own).
    const form = el('form', 'debt-form');
    form.noValidate = true;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('keydown', onEnter(goFromQuestion));
    form.append(group, amounts);
    body.appendChild(form);
    renderAmounts(amounts);

    const cancel = button('Cancel', 'btn btn-secondary', 'cancel');
    cancel.addEventListener('click', close);
    const next = button('Next', 'btn btn-primary', 'next');
    next.disabled = state.mode === null;
    next.addEventListener('click', goFromQuestion);
    footerButtons(cancel, next);
    h.focus();
  }

  const footerNext = (): HTMLButtonElement =>
    footer.querySelector<HTMLButtonElement>('[data-convert="next"]')!;

  function onEnter(go: () => void): (event: KeyboardEvent) => void {
    return (event) => {
      const target = event.target;
      if (event.key !== 'Enter' || !(target instanceof HTMLInputElement)) return;
      if (target.type === 'radio' || target.type === 'checkbox' || target.type === 'button') return;
      event.preventDefault();
      go();
    };
  }

  function questionErrors(): Partial<Record<string, string>> {
    const errors: Partial<Record<string, string>> = {};
    if (state.mode === 'equity') {
      const home = money(state.homeValue);
      if (!Number.isFinite(home) || home <= 0) errors.homeValue = 'Enter the home’s value';
    }
    if (state.mode === 'equity' || state.mode === 'loan') {
      const owed = money(state.balance);
      if (!Number.isFinite(owed) || owed <= 0 || owed > 1e10) {
        errors.balance = 'Enter what you owe';
      }
    }
    if (state.mode === 'loan' && state.addHome) {
      if (!state.newHomeName.trim()) errors.newHomeName = 'Enter a name for the home';
      const value = money(state.newHomeValue);
      if (!Number.isFinite(value) || value <= 0) errors.newHomeValue = 'Enter the home’s value';
      if (state.newHomeCost.trim()) {
        const cost = money(state.newHomeCost);
        if (!Number.isFinite(cost) || cost < 0) errors.newHomeCost = 'Enter an amount';
      }
      if (state.newHomeDate && !ISO_DAY.test(state.newHomeDate)) {
        errors.newHomeDate = 'Use the date format YYYY-MM-DD';
      }
    }
    return errors;
  }

  function goFromQuestion(): void {
    if (state.mode === null) return;
    readQuestion();
    const errors = questionErrors();
    applyFieldErrors(body, errors);
    if (Object.keys(errors).length > 0) return;
    if (state.mode !== 'property_value') {
      state.draft = { ...state.draft, currentBalance: String(round2(money(state.balance))) };
    }
    renderDetails();
  }

  // ---- step 2: mortgage details ---------------------------------------

  function renderDetails(): void {
    const h = setStep(2, 'Mortgage details');
    const form = el('form', 'debt-form');
    form.noValidate = true;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('keydown', onEnter(goFromDetails));
    fields = buildDebtFields(state.draft, {
      ...(options.entities ? { entities: options.entities } : {}),
      hideType: true,
      omit: state.mode === 'property_value' ? [] : ['currentBalance'],
    });
    form.appendChild(fields.element);
    body.appendChild(form);
    const back = button('Back', 'btn btn-secondary', 'back');
    back.addEventListener('click', () => {
      if (fields) state.draft = fields.read();
      renderQuestion();
    });
    const next = button('Next', 'btn btn-primary', 'next');
    next.addEventListener('click', goFromDetails);
    footerButtons(back, next);
    h.focus();
  }

  function goFromDetails(): void {
    if (!fields) return;
    state.draft = fields.read();
    const errors: Partial<Record<string, string>> = { ...validateDraft(state.draft).errors };
    applyFieldErrors(body, errors);
    if (Object.keys(errors).length > 0) return;
    renderConfirm();
  }

  // ---- step 3: confirm ------------------------------------------------

  /** The balance the new mortgage starts with. */
  const loanBalance = (): number => round2(money(state.draft.currentBalance));

  function monthlyPayment(): number | null {
    return reviewDebt(state.draft, today()).monthlyCashFlow;
  }

  function chosenExpense(): Expense | undefined {
    return state.cash.mode === 'link'
      ? expenses.find((e) => e.id === state.cash.expenseId)
      : undefined;
  }

  /** One line per change the conversion will make. */
  function changeLines(): string[] {
    const p = position!;
    const out: string[] = [];
    if (state.mode === 'property_value') {
      out.push(
        `Home: ${positionLabel(p)} stays at ${formatCurrency(p.market_value)}, linked to the new debt`
      );
    } else if (state.mode === 'equity') {
      out.push(
        `Home: value ${formatCurrency(p.market_value)} to ${formatCurrency(round2(money(state.homeValue)))}`
      );
    } else {
      out.push(`Removed position: ${positionLabel(p)}`);
      if (state.addHome) {
        out.push(
          `New home: ${state.newHomeName.trim()} ${formatCurrency(round2(money(state.newHomeValue)))}`
        );
      }
    }
    out.push(`New debt: ${state.draft.name.trim()} ${formatCurrency(loanBalance())}`);
    const monthly = monthlyPayment();
    if (state.cash.mode === 'create' && monthly !== null) {
      out.push(`New expense: ${state.draft.name.trim()} ${formatCurrency(monthly)}/mo`);
    } else if (state.cash.mode === 'link') {
      const e = chosenExpense();
      if (e) {
        out.push(`Linked expense: ${e.name} (${formatCurrency(e.monthly_amount)}/mo)`);
      }
    }
    return out;
  }

  /** Portfolio value and net worth after the conversion. */
  function effects(): { portfolio: [number, number]; netWorth: [number, number] } | null {
    if (!totals) return null;
    const p = position!;
    let after = totals.portfolio;
    if (state.mode === 'equity') after += round2(money(state.homeValue)) - p.market_value;
    else if (state.mode === 'loan') {
      after -= p.market_value;
      if (state.addHome) after += round2(money(state.newHomeValue));
    }
    return {
      portfolio: [totals.portfolio, after],
      netWorth: [totals.netWorth, after - (totals.debts + loanBalance())],
    };
  }

  function renderChanges(list: HTMLElement): void {
    list.textContent = '';
    for (const line of changeLines()) list.appendChild(el('li', undefined, line));
  }

  function renderCash(host: HTMLElement, list: HTMLElement): void {
    host.textContent = '';
    host.appendChild(el('legend', 'debt-wizard-legend', 'Cash flow'));
    const monthly = monthlyPayment();
    if (monthly === null) {
      state.cash = { mode: 'none', expenseId: '' };
      host.appendChild(
        el(
          'p',
          'debt-field-hint',
          'Add a payment on the previous step to include this debt in Cash flow.'
        )
      );
      renderChanges(list);
      return;
    }
    const free = expenses.filter((e) => e.is_active !== false && !takenExpenseIds.has(e.id));
    const suggestion = suggestExpense(free, 'mortgage', monthly);
    if (!state.cashTouched) {
      state.cash = suggestion
        ? { mode: 'link', expenseId: suggestion.id }
        : { mode: 'create', expenseId: '' };
    }
    if (state.cash.mode === 'link' && !state.cash.expenseId) {
      state.cash.expenseId = (suggestion ?? free[0])?.id ?? '';
    }
    const choices: [CashMode, string, boolean][] = [
      ['create', `Add ${formatCurrency(monthly)} a month to Cash flow`, true],
      ['link', 'Link an expense I already track', free.length > 0],
      ['none', 'Do not add this to Cash flow', true],
    ];
    for (const [mode, label, enabled] of choices) {
      const wrap = el('label', 'debt-wizard-choice');
      if (!enabled) wrap.classList.add('is-disabled');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'debt-convert-cash';
      radio.setAttribute('data-cash-mode', mode);
      radio.checked = state.cash.mode === mode;
      radio.disabled = !enabled;
      radio.addEventListener('change', () => {
        state.cash.mode = mode;
        state.cashTouched = true;
        renderCash(host, list);
        host.querySelector<HTMLElement>(`[data-cash-mode="${mode}"]`)?.focus();
      });
      wrap.append(radio, el('span', undefined, label));
      host.appendChild(wrap);
      if (mode === 'link' && !enabled) {
        const hint = el('p', 'debt-field-hint debt-wizard-choice-hint', 'No unlinked expenses yet');
        hint.id = 'debt-convert-link-hint';
        radio.setAttribute('aria-describedby', hint.id);
        host.appendChild(hint);
      }
    }
    if (state.cash.mode === 'link') {
      const group = el('div', 'form-group');
      const l = el('label', undefined, 'Expense');
      l.htmlFor = 'debt-field-cashExpenseId';
      const select = el('select');
      select.id = 'debt-field-cashExpenseId';
      for (const e of free) {
        const o = el(
          'option',
          undefined,
          `${e.name} (${formatCurrency(e.monthly_amount)} a month)`
        );
        o.value = e.id;
        select.appendChild(o);
      }
      select.value = state.cash.expenseId;
      select.addEventListener('change', () => {
        state.cash.expenseId = select.value;
        state.cashTouched = true;
        renderChanges(list);
      });
      group.append(l, select);
      host.appendChild(group);
    }
    renderChanges(list);
  }

  function renderConfirm(): void {
    const h = setStep(3, 'Review the changes');
    const review = reviewDebt(state.draft, today());
    blocked = review.neverPaysOff;
    body.appendChild(
      el('p', 'debt-field-hint', 'Nothing changes until you press the button below.')
    );
    const list = el('ul', 'debt-convert-changes');
    body.appendChild(list);

    const fx = effects();
    const grid = el('dl', 'debt-review-grid debt-convert-effect');
    const row = (label: string, value: string): void => {
      const wrap = el('div', 'debt-review-row');
      wrap.append(el('dt', undefined, label), el('dd', undefined, value));
      grid.appendChild(wrap);
    };
    if (fx) {
      row('Portfolio value', beforeAfter(...fx.portfolio));
      row('Net worth', beforeAfter(...fx.netWorth));
      body.appendChild(grid);
    } else {
      body.appendChild(
        el(
          'p',
          'debt-field-hint',
          'Portfolio value and net worth could not be loaded for this preview.'
        )
      );
    }
    if (review.neverPaysOff) {
      const warn = el(
        'p',
        'debt-review-warning',
        'At this payment the debt never pays off: the payment does not cover the interest. Go back and raise the payment or shorten the term.'
      );
      warn.setAttribute('role', 'alert');
      body.appendChild(warn);
    }
    const cashHost = el('fieldset', 'debt-wizard-home debt-wizard-cashflow');
    body.appendChild(cashHost);
    renderCash(cashHost, list);

    const back = button('Back', 'btn btn-secondary', 'back');
    back.addEventListener('click', renderDetails);
    const confirm = button('Convert to mortgage', 'btn btn-primary', 'confirm');
    confirm.disabled = blocked;
    confirm.addEventListener('click', () => void submit(confirm));
    footerButtons(back, confirm);
    h.focus();
  }

  // ---- confirm: the only write ----------------------------------------

  function buildInput(): ConvertPositionInput | null {
    const draft = { ...state.draft };
    const { payment } = effectivePayment(draft);
    if (payment !== null && draft.paymentAmount.trim() === '')
      draft.paymentAmount = String(payment);
    const base = toCreateInput(draft);
    if (!base || !state.mode) return null;
    const mortgage: ConvertPositionInput['mortgage'] = { name: base.name };
    const copy: [keyof ConvertPositionInput['mortgage'], unknown][] = [
      ['lender', base.lender],
      ['current_balance', base.current_balance],
      ['interest_rate', base.interest_rate],
      ['payment_amount', base.payment_amount],
      ['payment_frequency', base.payment_frequency],
      ['next_payment_date', base.next_payment_date],
      ['escrow_amount', base.escrow_amount],
      ['original_principal', base.original_principal],
      ['origination_date', base.origination_date],
      ['term_months', base.term_months],
      ['maturity_date', base.maturity_date],
      ['entity_id', base.entity_id],
      ['notes', base.notes],
    ];
    for (const [key, value] of copy) {
      if (value !== undefined && value !== null && value !== '') {
        Object.assign(mortgage, { [key]: value });
      }
    }
    const input: ConvertPositionInput = {
      position_id: positionId,
      mode: state.mode,
      mortgage,
    };
    if (state.mode === 'equity') input.home_value = round2(money(state.homeValue));
    if (state.mode === 'loan' && state.addHome) {
      input.add_home = {
        name: state.newHomeName.trim(),
        value: round2(money(state.newHomeValue)),
        ...(state.newHomeCost.trim() ? { cost_basis: round2(money(state.newHomeCost)) } : {}),
        ...(state.newHomeDate ? { purchase_date: state.newHomeDate } : {}),
      };
    }
    if (state.cash.mode === 'link' && state.cash.expenseId) {
      input.cash_flow = { mode: 'link', expense_id: state.cash.expenseId };
    } else if (state.cash.mode === 'create') input.cash_flow = { mode: 'create' };
    else input.cash_flow = { mode: 'none' };
    return input;
  }

  async function submit(btn: HTMLButtonElement): Promise<void> {
    if (submitting || blocked) return;
    const input = buildInput();
    if (!input) return;
    submitting = true;
    try {
      const result = await withSubmitGuard(btn, 'Converting...', () =>
        apiCall<ConvertPositionResult>('/api/liabilities/convert-position', {
          method: 'POST',
          body: input,
        })
      );
      announceChange('added', state.mode === 'loan' ? 'deleted' : 'updated');
      try {
        options.onDone?.(result);
      } catch (error) {
        console.error('Convert callback failed:', error instanceof Error ? error.name : 'error');
      }
      renderDone(result);
    } catch (error) {
      submitting = false;
      console.error('Conversion failed:', error instanceof Error ? error.name : 'error');
      showFormError(
        body,
        failureMessage(error, 'Could not convert this position. Nothing was changed.')
      );
    }
  }

  function renderDone(result: ConvertPositionResult): void {
    const h = setStep(4, 'Converted');
    const name = result?.liability?.name || state.draft.name.trim() || 'The mortgage';
    body.appendChild(
      el(
        'p',
        'debt-wizard-success',
        `${name} is now a debt of ${formatCurrency(loanBalance())}. If this was not what you meant, open the debt on the Debts page and choose Undo conversion.`
      )
    );
    const done = button('Done', 'btn btn-primary', 'done');
    done.addEventListener('click', close);
    footerButtons(done);
    h.focus();
  }

  renderLoading();
  void load();
  return { modal, close };
}

/** Tell the rest of the app: debts changed (net worth) and positions changed (Holdings). */
function announceChange(
  reason: 'added' | 'deleted',
  positionReason: 'updated' | 'deleted' | 'added'
): void {
  emit({ type: 'liabilities:changed', reason });
  // Holdings refreshes through this legacy event; the typed one is additive.
  document.dispatchEvent(new CustomEvent('holdings:positionUpdated'));
  emit({ type: 'positions:changed', reason: positionReason });
}

// ---------------------------------------------------------------------------
// Undo conversion
// ---------------------------------------------------------------------------

export interface UndoConversionOptions {
  /** Called after the conversion was undone. */
  onDone?: () => void;
}

/** Ask first; call revert only on confirm. On any failure nothing changes and the dialog stays. */
export function openUndoConversion(
  debt: Pick<LiabilityResponse, 'id' | 'name'>,
  options: UndoConversionOptions = {}
): HTMLElement {
  const body = el('div', 'debt-delete');
  body.appendChild(el('p', 'debt-convert-undo-title', 'Undo this conversion?'));
  body.appendChild(
    el(
      'p',
      undefined,
      `${debt.name} is removed, along with its balance history and anything the conversion added. The original position comes back as it was. If you changed the property since, the undo is refused and nothing changes.`
    )
  );
  let busy = false;
  const modal = createDynamicModal({
    title: 'Undo conversion',
    content: body,
    saveButtonText: 'Undo conversion',
    modalClass: 'modal-danger debt-form-modal',
    onSave: async (event) => {
      if (busy) return;
      busy = true;
      const btn = event.currentTarget as HTMLButtonElement | null;
      try {
        await withSubmitGuard(btn, 'Undoing...', () =>
          apiCall(`/api/liabilities/${encodeURIComponent(debt.id)}/revert-conversion`, {
            method: 'POST',
          })
        );
        closeDynamicModal();
        showToast('Conversion undone', 'success');
        announceChange('deleted', 'updated');
        options.onDone?.();
      } catch (error) {
        busy = false;
        console.error('Undo conversion failed:', error instanceof Error ? error.name : 'error');
        showFormError(
          body,
          failureMessage(error, 'Could not undo this conversion. Nothing was changed.')
        );
      }
    },
  });
  modal.querySelector('[data-action="save"]')?.classList.replace('btn-primary', 'btn-danger');
  return modal;
}
