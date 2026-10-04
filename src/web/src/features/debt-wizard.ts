/**
 * Guided "Add a debt" wizard: pick a type (1), answer that type's questions
 * (2), review the payoff picture and choose how it reaches Cash flow (3), then
 * save with one POST /api/liabilities and offer another (4). Field rendering,
 * defaults and validation come from the shared debt modules; this file owns the
 * steps, footer and discard prompt.
 *
 * All values go into the DOM with textContent or element properties.
 */

import { apiCall, ApiError } from '@/api/client';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { emit } from '@/state/events';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import {
  applyFieldErrors,
  buildDebtFields,
  debtErrorMessage,
  showFormError,
  type DebtFieldsHandle,
} from '@/features/debt-form';
import { today } from '@/utils/clock';
import { formatCurrency, formatDate } from '@/utils/format';
import {
  DEBT_TYPES,
  defaultsFor,
  switchType,
  toCreateInput,
  validateDraft,
  type DebtDraft,
} from '@/utils/debt-fields';
import { effectivePayment, reviewDebt, suggestExpense, type DebtReview } from '@/utils/debt-review';
import { LIABILITY_TYPE_LABELS } from '@/utils/liabilities';
import type {
  CreateLiabilityInput,
  Entity,
  Expense,
  LiabilityFrequency,
  LiabilityResponse,
  LiabilityType,
  PositionResponse,
} from '@/types/api';

const STEP_COUNT = 4;

const TYPE_ICON: Record<LiabilityType, string> = {
  mortgage: '\u{1F3E0}',
  auto_loan: '\u{1F697}',
  student_loan: '\u{1F393}',
  credit_card: '\u{1F4B3}',
  personal_loan: '\u{1F464}',
  heloc: '\u{1F3E6}',
  other: '\u{1F4CB}',
};

const TYPE_HINT: Record<LiabilityType, string> = {
  mortgage: 'A loan on a home',
  auto_loan: 'A loan on a car, truck or bike',
  student_loan: 'Education loans',
  credit_card: 'A card balance, paid off or carried',
  personal_loan: 'A loan with a fixed term',
  heloc: 'A credit line secured by your home',
  other: 'Anything else you owe',
};

export type HomeMode = 'pick' | 'add' | 'skip';

export interface WizardHome {
  mode: HomeMode;
  /** The real estate position chosen in "pick" mode. */
  positionId: string;
  name: string;
  value: string;
  purchasePrice: string;
  purchaseDate: string;
}

export interface WizardState {
  step: number;
  /** Raw draft: a blank payment stays blank (the "Calculated" figure is not filled in). */
  draft: DebtDraft;
  home: WizardHome;
}

export interface OpenDebtWizardOptions {
  entities?: readonly Entity[];
  /** Called with the validated details when the person presses Next on step 2. */
  onDetails?: (state: WizardState) => void;
  /** Called after the debt is saved, with the server's response. */
  onSaved?: (saved: LiabilityResponse) => void | Promise<void>;
  /**
   * Reserved for the conversion dialog: called with a tracked home's position id
   * when the person chooses "Already tracking this home? Pick it" in the mortgage
   * step. Not wired to any control yet.
   */
  onConvertHome?: (positionId: string) => void;
}

export interface DebtWizardHandle {
  modal: HTMLElement;
  /** Close the wizard without the discard prompt and remove its listeners. */
  close: () => void;
}

export type CashMode = 'create' | 'link' | 'none';

const FREQUENCY_WORD: Record<LiabilityFrequency, string> = {
  weekly: 'week',
  biweekly: '2 weeks',
  monthly: 'month',
  quarterly: 'quarter',
  annual: 'year',
};

const blankHome = (): WizardHome => ({
  mode: 'add',
  positionId: '',
  name: '',
  value: '',
  purchasePrice: '',
  purchaseDate: '',
});

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
  b.setAttribute('data-wizard', action);
  return b;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function homeErrors(home: WizardHome): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  if (home.mode === 'pick') {
    if (!home.positionId) errors.homePositionId = 'Choose a home';
  } else if (home.mode === 'add') {
    if (!home.name.trim()) errors.homeName = 'Enter a name for the home';
    const value = Number(home.value.replace(/[$,\s]/g, ''));
    if (!home.value.trim() || !Number.isFinite(value) || value <= 0) {
      errors.homeValue = 'Enter the home’s value';
    }
    if (home.purchasePrice.trim()) {
      const price = Number(home.purchasePrice.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(price) || price < 0) errors.homePurchasePrice = 'Enter an amount';
    }
    if (home.purchaseDate && !ISO_DAY.test(home.purchaseDate)) {
      errors.homePurchaseDate = 'Use the date format YYYY-MM-DD';
    }
  }
  return errors;
}

/** Open the wizard on step 1. Returns the modal element. */
export function openDebtWizard(options: OpenDebtWizardOptions = {}): DebtWizardHandle {
  const state: WizardState = { step: 1, draft: defaultsFor('mortgage'), home: blankHome() };
  let chosen: LiabilityType | null = null;
  let fields: DebtFieldsHandle | null = null;
  let homeTouched = false;
  let positions: PositionResponse[] | null = null;
  let positionsFailed = false;
  let saved = false;
  let blocked = false;
  let cash: { mode: CashMode; expenseId: string } = { mode: 'none', expenseId: '' };
  let cashTouched = false;
  let paidInFull = true;
  let expenses: Expense[] | null = null;
  let takenExpenseIds = new Set<string>();
  let expensesLoad: Promise<void> | null = null;
  let positionsLoad: Promise<void> | null = null;

  const shell = el('div', 'debt-wizard');
  const progress = el('p', 'debt-wizard-progress');
  const body = el('div', 'debt-wizard-step');
  shell.append(progress, body);

  const modal = createDynamicModal({
    title: 'Add a debt',
    content: shell,
    showFooter: false,
    modalClass: 'debt-wizard-modal modal-sheet',
  });
  const content = modal.querySelector<HTMLElement>('.modal-content')!;
  const footer = el('div', 'debt-wizard-footer');
  content.appendChild(footer);

  // ---- discard prompt -------------------------------------------------

  /** Anything typed beyond choosing a type. */
  const isDirty = (): boolean => {
    if (chosen === null || saved) return false;
    syncFromDom();
    const base = defaultsFor(chosen);
    const changed = (Object.keys(base) as (keyof DebtDraft)[]).some(
      (k) => state.draft[k] !== base[k]
    );
    const h = state.home;
    return changed || !!(h.name || h.value || h.purchasePrice || h.purchaseDate);
  };

  let confirming = false;
  let resumeFocus: HTMLElement | null = null;

  const showConfirm = (): void => {
    confirming = true;
    resumeFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    footer.textContent = '';
    footer.classList.add('debt-wizard-confirm');
    const text = el(
      'p',
      'debt-wizard-confirm-text',
      'Discard this debt? What you entered is lost.'
    );
    text.setAttribute('role', 'alert');
    const keep = button('Keep editing', 'btn btn-secondary', 'keep');
    const discard = button('Discard', 'btn btn-primary', 'discard');
    keep.addEventListener('click', () => {
      confirming = false;
      footer.classList.remove('debt-wizard-confirm');
      renderFooter();
      (resumeFocus?.isConnected ? resumeFocus : heading())?.focus();
    });
    discard.addEventListener('click', () => {
      detach();
      closeDynamicModal();
    });
    footer.append(text, keep, discard);
    keep.focus();
  };

  const requestClose = (): void => {
    if (isDirty()) showConfirm();
    else {
      detach();
      closeDynamicModal();
    }
  };

  // Capture phase, so these run before the modal's own close handlers.
  const onKey = (event: KeyboardEvent): void => {
    if (!modal.isConnected) {
      detach();
      return;
    }
    if (event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    // While the prompt shows, Escape does nothing: the buttons decide.
    if (!confirming) requestClose();
  };
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.modal-close') && !target.classList.contains('modal-backdrop')) return;
    event.stopPropagation();
    if (!confirming) requestClose();
  };
  // Removal paths: close(), the discard prompt, and any outside removal of the modal.
  const watcher = new MutationObserver(() => {
    if (!modal.isConnected) detach();
  });
  function detach(): void {
    window.removeEventListener('keydown', onKey, true);
    watcher.disconnect();
  }
  window.addEventListener('keydown', onKey, true);
  watcher.observe(document.body, { childList: true });
  modal.addEventListener('click', onClick, true);

  // ---- state helpers --------------------------------------------------

  const heading = (): HTMLElement | null => body.querySelector('.debt-wizard-heading');

  /** Copy the visible step 2 inputs into state. */
  function syncFromDom(): void {
    if (state.step !== 2 || !fields) return;
    state.draft = fields.read();
    if (state.draft.liabilityType === 'mortgage') readHome();
  }

  function readHome(): void {
    const val = (key: string): string =>
      body.querySelector<HTMLInputElement>(`[data-debt-field="${key}"]`)?.value ?? '';
    const mode = body.querySelector<HTMLInputElement>('[data-home-mode]:checked');
    if (mode) state.home.mode = mode.getAttribute('data-home-mode') as HomeMode;
    state.home.positionId = body.querySelector('[data-debt-field="homePositionId"]')
      ? val('homePositionId')
      : state.home.positionId;
    state.home.name = val('homeName');
    state.home.value = val('homeValue');
    state.home.purchasePrice = val('homePurchasePrice');
    state.home.purchaseDate = val('homePurchaseDate');
  }

  // ---- footer ---------------------------------------------------------

  function renderFooter(): void {
    footer.textContent = '';
    if (state.step === 4) {
      const another = button('Add another debt', 'btn btn-secondary', 'another');
      const done = button('Done', 'btn btn-primary', 'done');
      another.addEventListener('click', startOver);
      done.addEventListener('click', () => {
        detach();
        closeDynamicModal();
      });
      footer.append(another, done);
      return;
    }
    const left =
      state.step === 1
        ? button('Cancel', 'btn btn-secondary', 'cancel')
        : button('Back', 'btn btn-secondary', 'back');
    const right =
      state.step === 3
        ? button('Save debt', 'btn btn-primary', 'save')
        : button('Next', 'btn btn-primary', 'next');
    right.disabled = (state.step === 1 && chosen === null) || (state.step === 3 && blocked);
    left.addEventListener('click', () => {
      if (state.step === 1) requestClose();
      else goBack();
    });
    right.addEventListener('click', () => {
      if (state.step === 3) void save(right);
      else goNext();
    });
    footer.append(left, right);
  }

  function setStep(step: number, title: string): HTMLElement {
    state.step = step;
    progress.textContent = `Step ${step} of ${STEP_COUNT}`;
    body.textContent = '';
    const h = el('h3', 'debt-wizard-heading', title);
    h.tabIndex = -1;
    body.appendChild(h);
    renderFooter();
    return h;
  }

  // ---- step 1: type ---------------------------------------------------

  function renderTypeStep(): void {
    const h = setStep(1, 'What kind of debt is it?');
    const group = el('div', 'debt-wizard-types');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Type of debt');
    for (const t of DEBT_TYPES) {
      const card = el('label', 'debt-wizard-type');
      const radio = el('input', 'debt-wizard-radio');
      radio.type = 'radio';
      radio.name = 'debt-type';
      radio.value = t;
      radio.setAttribute('data-debt-type', t);
      radio.checked = chosen === t;
      card.classList.toggle('is-selected', chosen === t);
      card.appendChild(radio);
      const icon = el('span', 'debt-wizard-type-icon', TYPE_ICON[t]);
      icon.setAttribute('aria-hidden', 'true');
      card.appendChild(icon);
      const text = el('span', 'debt-wizard-type-text');
      text.append(
        el('span', 'debt-wizard-type-name', LIABILITY_TYPE_LABELS[t]),
        el('span', 'debt-wizard-type-hint', TYPE_HINT[t])
      );
      card.appendChild(text);
      radio.addEventListener('change', () => {
        if (chosen !== null && chosen !== t) state.draft = switchType(state.draft, t);
        else if (chosen === null) state.draft = defaultsFor(t);
        chosen = t;
        group.querySelectorAll('.debt-wizard-type').forEach((n) => {
          n.classList.toggle('is-selected', n === card);
        });
        footer.querySelector<HTMLButtonElement>('[data-wizard="next"]')!.disabled = false;
      });
      group.appendChild(card);
    }
    body.appendChild(group);
    h.focus();
  }

  // ---- step 2: details ------------------------------------------------

  function loadPositions(): Promise<void> {
    positionsLoad ??= apiCall<PositionResponse[]>('/api/portfolio/positions')
      .then((all) => {
        positions = (Array.isArray(all) ? all : []).filter(
          (p) => p.position_type === 'real_estate'
        );
        positionsFailed = false;
      })
      .catch((error: unknown) => {
        console.error('Homes load failed:', error instanceof Error ? error.name : 'error');
        positions = [];
        positionsFailed = true;
      });
    return positionsLoad;
  }

  function homeInput(
    key: string,
    label: string,
    kind: 'text' | 'money' | 'date',
    value: string
  ): HTMLElement {
    const wrap = el('div', 'form-group');
    const l = el('label', undefined, label);
    l.htmlFor = `debt-field-${key}`;
    const input = el('input');
    input.id = `debt-field-${key}`;
    input.setAttribute('data-debt-field', key);
    input.type = kind === 'date' ? 'date' : 'text';
    if (kind === 'money') input.inputMode = 'decimal';
    if (kind === 'text') input.maxLength = 120;
    input.value = value;
    wrap.append(l, input);
    return wrap;
  }

  function renderHome(host: HTMLElement): void {
    host.textContent = '';
    const loaded = positions !== null;
    const homes = positions ?? [];
    const typedHome = !!(state.home.name.trim() || state.home.value.trim());
    if (loaded && !homeTouched && !typedHome && state.home.mode === 'add' && homes.length > 0) {
      state.home.mode = 'pick';
    }
    if (loaded && homes.length === 0 && state.home.mode === 'pick') state.home.mode = 'add';
    if (state.home.mode === 'pick' && !state.home.positionId && homes[0]) {
      state.home.positionId = homes[0].id;
    }

    const legend = el('legend', 'debt-wizard-legend', 'The home');
    host.appendChild(legend);
    const choices: [HomeMode, string][] = [
      ['pick', 'Pick a home you already track'],
      ['add', 'Add the home’s value'],
      ['skip', 'Skip'],
    ];
    for (const [mode, text] of choices) {
      const row = el('label', 'debt-wizard-choice');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'debt-home-mode';
      radio.setAttribute('data-home-mode', mode);
      radio.checked = state.home.mode === mode;
      radio.disabled = mode === 'pick' && (!loaded || homes.length === 0);
      radio.addEventListener('change', () => {
        readHome();
        state.home.mode = mode;
        homeTouched = true;
        renderHome(host);
        host.querySelector<HTMLElement>(`[data-home-mode="${mode}"]`)?.focus();
      });
      row.append(radio, el('span', undefined, text));
      host.appendChild(row);
    }
    if (!loaded) host.appendChild(el('p', 'debt-field-hint', 'Looking for your homes...'));
    if (positionsFailed) {
      const note = el('p', 'debt-field-hint debt-wizard-homes-error');
      note.setAttribute('role', 'alert');
      note.append('Couldn\u2019t load your homes. ');
      const retry = button('Retry', 'btn btn-secondary btn-sm', 'retry-homes');
      retry.addEventListener('click', () => {
        positions = null;
        positionsFailed = false;
        positionsLoad = null;
        readHome();
        renderHome(host);
        void loadPositions().then(() => {
          if (host.isConnected) {
            readHome();
            renderHome(host);
          }
        });
      });
      note.appendChild(retry);
      host.appendChild(note);
    }

    if (state.home.mode === 'pick' && homes.length > 0) {
      const wrap = el('div', 'form-group');
      const l = el('label', undefined, 'Home');
      l.htmlFor = 'debt-field-homePositionId';
      const select = el('select');
      select.id = 'debt-field-homePositionId';
      select.setAttribute('data-debt-field', 'homePositionId');
      for (const p of homes) {
        const o = el('option', undefined, `${p.name || p.ticker} (${p.account_name})`);
        o.value = p.id;
        select.appendChild(o);
      }
      select.value = state.home.positionId;
      wrap.append(l, select);
      host.appendChild(wrap);
    } else if (state.home.mode === 'add') {
      const grid = el('div', 'debt-form-grid');
      grid.append(
        homeInput('homeName', 'Home name', 'text', state.home.name),
        homeInput('homeValue', 'Market value', 'money', state.home.value),
        homeInput(
          'homePurchasePrice',
          'Purchase price (optional)',
          'money',
          state.home.purchasePrice
        ),
        homeInput('homePurchaseDate', 'Purchase date (optional)', 'date', state.home.purchaseDate)
      );
      host.appendChild(grid);
    }
  }

  function renderDetailsStep(): void {
    const t = state.draft.liabilityType;
    const h = setStep(2, `${LIABILITY_TYPE_LABELS[t]} details`);
    const form = el('form', 'debt-form');
    form.noValidate = true;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('keydown', (event) => {
      const target = event.target;
      if (event.key !== 'Enter' || !(target instanceof HTMLInputElement)) return;
      if (target.type === 'radio' || target.type === 'checkbox' || target.type === 'button') return;
      event.preventDefault();
      goNext();
    });
    if (t === 'mortgage') {
      const set = el('fieldset', 'debt-wizard-home');
      form.appendChild(set);
      renderHome(set);
      if (positions === null) {
        void loadPositions().then(() => {
          if (set.isConnected) {
            readHome();
            renderHome(set);
          }
        });
      }
    }
    fields = buildDebtFields(state.draft, {
      ...(options.entities ? { entities: options.entities } : {}),
      hideType: true,
    });
    form.appendChild(fields.element);
    body.appendChild(form);
    h.focus();
  }

  // ---- navigation -----------------------------------------------------

  function goBack(): void {
    if (state.step === 2) {
      syncFromDom();
      fields = null;
      renderTypeStep();
    } else if (state.step === 3) {
      renderDetailsStep();
    }
  }

  function startOver(): void {
    chosen = null;
    fields = null;
    saved = false;
    homeTouched = false;
    positions = null;
    positionsLoad = null;
    positionsFailed = false;
    cash = { mode: 'none', expenseId: '' };
    cashTouched = false;
    paidInFull = true;
    expenses = null;
    expensesLoad = null;
    state.draft = defaultsFor('mortgage');
    state.home = blankHome();
    renderTypeStep();
  }

  function goNext(): void {
    if (state.step === 1) {
      if (chosen === null) return;
      renderDetailsStep();
      return;
    }
    if (state.step !== 2 || !fields) return;
    syncFromDom();
    const errors: Partial<Record<string, string>> = { ...validateDraft(state.draft).errors };
    if (state.draft.liabilityType === 'mortgage') Object.assign(errors, homeErrors(state.home));
    applyFieldErrors(body, errors);
    if (Object.keys(errors).length > 0) return;
    if (state.draft.liabilityType === 'mortgage') {
      state.draft = {
        ...state.draft,
        linkedPositionId: state.home.mode === 'pick' ? state.home.positionId : '',
      };
    }
    options.onDetails?.(state);
    renderReviewStep();
  }

  // ---- step 3: review -------------------------------------------------

  function loadExpenses(): Promise<void> {
    expensesLoad ??= (async (): Promise<void> => {
      try {
        const [list, debts] = await Promise.all([
          apiCall<Expense[]>('/api/budget/expenses'),
          apiCall<LiabilityResponse[]>('/api/liabilities').catch(() => [] as LiabilityResponse[]),
        ]);
        expenses = Array.isArray(list) ? list : [];
        takenExpenseIds = new Set(
          (Array.isArray(debts) ? debts : []).flatMap((d) => (d.expense_id ? [d.expense_id] : []))
        );
      } catch (error) {
        console.error('Expenses load failed:', error instanceof Error ? error.name : 'error');
        expenses = [];
      }
    })();
    return expensesLoad;
  }

  const freeExpenses = (): Expense[] =>
    (expenses ?? []).filter((e) => e.is_active !== false && !takenExpenseIds.has(e.id));

  function row(grid: HTMLElement, label: string, value: string): void {
    const wrap = el('div', 'debt-review-row');
    wrap.append(el('dt', undefined, label), el('dd', undefined, value));
    grid.appendChild(wrap);
  }

  function sparkline(balances: number[]): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const w = 300;
    const hgt = 48;
    const max = Math.max(...balances, 1);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('class', 'debt-review-spark-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const points = balances
      .map((b, i) => {
        const x = (i / Math.max(1, balances.length - 1)) * w;
        const y = hgt - 2 - (b / max) * (hgt - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);
    return svg;
  }

  function monthlyOf(review: DebtReview): number | null {
    return review.monthlyCashFlow;
  }

  /** The cash flow choice: radios plus an expense picker, rendered once expenses are known. */
  function renderCash(host: HTMLElement, review: DebtReview): void {
    host.textContent = '';
    host.appendChild(el('legend', 'debt-wizard-legend', 'Cash flow'));
    const type = state.draft.liabilityType;
    const monthly = monthlyOf(review);
    if (type === 'credit_card') {
      const row = el('label', 'debt-wizard-choice');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = paidInFull;
      box.setAttribute('data-wizard', 'paid-in-full');
      box.addEventListener('change', () => {
        paidInFull = box.checked;
        cashTouched = false;
        renderCash(host, review);
      });
      row.append(box, el('span', undefined, 'I pay this card in full each month'));
      host.appendChild(row);
      if (paidInFull) {
        cash = { mode: 'none', expenseId: '' };
        host.appendChild(
          el(
            'p',
            'debt-field-hint',
            'Your spending is already in your budget, so nothing is added to Cash flow.'
          )
        );
        return;
      }
    }
    if (expenses === null) {
      host.appendChild(el('p', 'debt-field-hint', 'Checking your budget...'));
      return;
    }
    if (monthly === null) {
      cash = { mode: 'none', expenseId: '' };
      host.appendChild(
        el(
          'p',
          'debt-field-hint',
          'Add a payment on the previous step to include this debt in Cash flow.'
        )
      );
      return;
    }
    const free = freeExpenses();
    const suggestion = suggestExpense(free, type, monthly);
    if (!cashTouched) {
      cash = suggestion
        ? { mode: 'link', expenseId: suggestion.id }
        : { mode: 'create', expenseId: '' };
    }
    if (cash.mode === 'link' && !cash.expenseId) cash.expenseId = (suggestion ?? free[0])?.id ?? '';
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
      radio.name = 'debt-cash-mode';
      radio.setAttribute('data-cash-mode', mode);
      radio.checked = cash.mode === mode;
      radio.disabled = !enabled;
      radio.addEventListener('change', () => {
        cash.mode = mode;
        cashTouched = true;
        renderCash(host, review);
        host.querySelector<HTMLElement>(`[data-cash-mode="${mode}"]`)?.focus();
      });
      wrap.append(radio, el('span', undefined, label));
      host.appendChild(wrap);
      if (mode === 'link' && !enabled) {
        const hint = el('p', 'debt-field-hint debt-wizard-choice-hint', 'No unlinked expenses yet');
        hint.id = 'debt-cash-link-hint';
        radio.setAttribute('aria-describedby', hint.id);
        host.appendChild(hint);
      }
    }
    if (cash.mode === 'link') {
      const group = el('div', 'form-group');
      const l = el('label', undefined, 'Expense');
      l.htmlFor = 'debt-field-cashExpenseId';
      const select = el('select');
      select.id = 'debt-field-cashExpenseId';
      select.setAttribute('data-debt-field', 'cashExpenseId');
      for (const e of free) {
        const o = el(
          'option',
          undefined,
          `${e.name} (${formatCurrency(e.monthly_amount)} a month)`
        );
        o.value = e.id;
        select.appendChild(o);
      }
      select.value = cash.expenseId;
      const compare = el('span', 'debt-field-hint');
      compare.id = 'debt-cash-compare';
      select.setAttribute('aria-describedby', compare.id);
      const showCompare = (): void => {
        const e = free.find((x) => x.id === select.value);
        compare.textContent = e
          ? `Expense ${formatCurrency(e.monthly_amount)} a month vs payment ${formatCurrency(monthly)}`
          : '';
      };
      showCompare();
      select.addEventListener('change', () => {
        cash.expenseId = select.value;
        cashTouched = true;
        showCompare();
      });
      group.append(l, select, compare);
      host.appendChild(group);
    }
  }

  function renderReviewStep(): void {
    const review = reviewDebt(state.draft, today());
    blocked = review.neverPaysOff;
    const h = setStep(3, 'Review your debt');
    const wrap = el('div', 'debt-review');
    const grid = el('dl', 'debt-review-grid');
    const freq = state.draft.paymentFrequency;
    row(grid, 'Balance', formatCurrency(Number(state.draft.currentBalance.replace(/[$,\s]/g, ''))));
    if (review.payment !== null) {
      row(
        grid,
        'Payment',
        `${formatCurrency(review.payment)} per ${FREQUENCY_WORD[freq]}${review.paymentCalculated ? ' (calculated)' : ''}`
      );
    }
    const escrow = Number(state.draft.escrowAmount.replace(/[$,\s]/g, ''));
    if (state.draft.liabilityType === 'mortgage' && escrow > 0) {
      row(grid, 'Escrow', `${formatCurrency(escrow)} per ${FREQUENCY_WORD[freq]}`);
    }
    if (state.draft.liabilityType === 'mortgage') {
      const home = state.home;
      if (home.mode === 'add') {
        row(
          grid,
          'Home',
          `Adds home: ${home.name.trim()}, ${formatCurrency(parseMoney(home.value))}`
        );
      } else if (home.mode === 'pick') {
        const p = positions?.find((x) => x.id === home.positionId);
        row(grid, 'Home', `Links home: ${p ? p.name || p.ticker : 'selected home'}`);
      }
    }
    if (review.projected && !review.neverPaysOff) {
      const fmt = (v: number | null): string => formatCurrency(v ?? 0);
      row(
        grid,
        'Payoff date',
        formatDate(review.payoffDate, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })
      );
      row(grid, 'Payments left', String(review.paymentsLeft ?? 0));
      row(grid, 'Total interest left', fmt(review.totalInterestLeft));
      row(
        grid,
        'Rest of this year',
        `${formatCurrency(review.yearPrincipal)} principal, ${formatCurrency(review.yearInterest)} interest`
      );
    }
    wrap.appendChild(grid);
    if (review.neverPaysOff) {
      const warn = el(
        'p',
        'debt-review-warning',
        'At this payment the debt never pays off: the payment does not cover the interest. Go back and raise the payment or shorten the term.'
      );
      warn.setAttribute('role', 'alert');
      wrap.appendChild(warn);
    } else if (!review.projected) {
      wrap.appendChild(
        el(
          'p',
          'debt-field-hint',
          'Add a payment and a term to see a payoff estimate. This debt still counts against your net worth.'
        )
      );
    }
    if (review.balances.length >= 2) {
      const spark = el('div', 'debt-review-spark');
      spark.appendChild(sparkline(review.balances));
      wrap.appendChild(spark);
    }
    const cashHost = el('fieldset', 'debt-wizard-home debt-wizard-cashflow');
    wrap.appendChild(cashHost);
    body.appendChild(wrap);
    renderCash(cashHost, review);
    if (expenses === null) {
      void loadExpenses().then(() => {
        if (cashHost.isConnected) renderCash(cashHost, review);
      });
    }
    h.focus();
  }

  // ---- step 3 to 4: save ----------------------------------------------

  const parseMoney = (raw: string): number => Number(raw.replace(/[$,\s]/g, ''));

  function buildInput(): CreateLiabilityInput | null {
    if (blocked) return null;
    const draft = { ...state.draft };
    const { payment } = effectivePayment(draft);
    if (payment !== null && draft.paymentAmount.trim() === '')
      draft.paymentAmount = String(payment);
    const base = toCreateInput(draft);
    if (!base) return null;
    const input: CreateLiabilityInput = { ...base, source: 'wizard' };
    if (draft.liabilityType === 'mortgage') {
      const home = state.home;
      if (home.mode === 'pick' && home.positionId) {
        input.property = { mode: 'link', position_id: home.positionId };
      } else if (home.mode === 'add') {
        input.property = {
          mode: 'create',
          name: home.name.trim(),
          value: parseMoney(home.value),
          ...(home.purchasePrice.trim() ? { cost_basis: parseMoney(home.purchasePrice) } : {}),
          ...(home.purchaseDate ? { purchase_date: home.purchaseDate } : {}),
        };
      }
      // The property block links the home itself.
      if (input.property) delete input.linked_position_id;
    }
    const noFlow = draft.liabilityType === 'credit_card' && paidInFull;
    if (noFlow || cash.mode === 'none') input.cash_flow = { mode: 'none' };
    else if (cash.mode === 'link' && cash.expenseId) {
      input.cash_flow = { mode: 'link', expense_id: cash.expenseId };
    } else if (cash.mode === 'create') input.cash_flow = { mode: 'create' };
    else input.cash_flow = { mode: 'none' };
    return input;
  }

  async function save(btn: HTMLButtonElement): Promise<void> {
    if (blocked || saved) return;
    const input = buildInput();
    if (!input) return;
    try {
      const result = await withSubmitGuard(btn, 'Saving...', () =>
        apiCall<LiabilityResponse>('/api/liabilities', { method: 'POST', body: input })
      );
      saved = true;
      emit({ type: 'liabilities:changed', reason: 'added' });
      try {
        await options.onSaved?.(result);
      } catch (error) {
        // The debt is saved; a failing callback must not read as a failed save.
        console.error('Debt saved callback failed:', error instanceof Error ? error.name : 'error');
      }
      renderSuccess(result);
    } catch (error) {
      console.error('Debt save failed:', error instanceof Error ? error.name : 'error');
      if (error instanceof ApiError && error.status === 409) {
        // Someone linked that expense since we looked: start the list again.
        expenses = null;
        expensesLoad = null;
        takenExpenseIds = new Set();
        cashTouched = false;
        renderReviewStep();
      }
      showFormError(body, debtErrorMessage(error));
    }
  }

  // ---- step 4: success ------------------------------------------------

  function renderSuccess(result: LiabilityResponse): void {
    const h = setStep(4, 'Debt added');
    const text = el('p', 'debt-wizard-success');
    text.textContent = `${result.name || 'Your debt'} is saved and now counts against your net worth.`;
    body.appendChild(text);
    h.focus();
  }

  renderTypeStep();
  return {
    modal,
    close: (): void => {
      detach();
      closeDynamicModal();
    },
  };
}
