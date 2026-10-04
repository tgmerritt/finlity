/**
 * Guided "Add a debt" wizard: pick a type (step 1), then answer that type's
 * questions (step 2). Review and save (steps 3 and 4) hook in through
 * `onDetails`. Field rendering, defaults and validation come from the shared
 * debt modules; this file owns the steps, footer and discard prompt.
 *
 * All values go into the DOM with textContent or element properties.
 */

import { apiCall } from '@/api/client';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { applyFieldErrors, buildDebtFields, type DebtFieldsHandle } from '@/features/debt-form';
import {
  DEBT_TYPES,
  defaultsFor,
  switchType,
  validateDraft,
  type DebtDraft,
} from '@/utils/debt-fields';
import { LIABILITY_TYPE_LABELS } from '@/utils/liabilities';
import type { Entity, LiabilityType, PositionResponse } from '@/types/api';

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
    if (chosen === null) return false;
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
    const left =
      state.step === 1
        ? button('Cancel', 'btn btn-secondary', 'cancel')
        : button('Back', 'btn btn-secondary', 'back');
    const right = button('Next', 'btn btn-primary', 'next');
    right.disabled = state.step === 1 && chosen === null;
    left.addEventListener('click', () => {
      if (state.step === 1) requestClose();
      else goBack();
    });
    right.addEventListener('click', goNext);
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
    }
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
  }

  renderTypeStep();
  return {
    modal,
    close: () => {
      detach();
      closeDynamicModal();
    },
  };
}
