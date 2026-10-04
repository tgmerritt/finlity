/**
 * Smart import wizard: Upload (1), Accounts (2), Categorize (3), Recurring
 * bills (4) and Review (5), then Done. Nothing is written to the data layer
 * before Apply: the POSTs besides the analyze uploads are the read-only preview,
 * the stateless recurring check and the AI calls, and the one earlier write is
 * the server-mode AI consent (`ai_enabled`), saved only when the person agrees.
 * Apply is one POST, then the settings PUT (labels and CSV layouts); Undo is one
 * DELETE per import id.
 *
 * Statement text, file names and account labels are user data: everything goes
 * into the DOM with textContent or element properties.
 *
 * The bundled sample statement is imported here (not in a util) so it ships in
 * this lazy `feature-*` chunk and never in the main bundle.
 */

import { apiCall, uploadFileWithContext, ApiError } from '@/api/client';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { showToast } from '@/ui/toast';
import { store } from '@/state/store';
import { emit } from '@/state/events';
import { getCurrentTab, showTab } from '@/ui/tabs';
import { loadBudgetTab, showBudgetTab } from '@/pages/budget';
import { today } from '@/utils/clock';
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import { formatCurrency, formatDate } from '@/utils/format';
import {
  ACCEPT,
  KIND_CHOICES,
  KIND_LABEL,
  MAPPING_FIELDS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_LABEL_CHARS,
  PAGE_ROWS,
  PRIVACY_LINE,
  STEP_LABELS,
  TXN_KIND_CHOICES,
  WARNING_COPY,
  analyzeErrorText,
  analyzeErrorType,
  balanceText,
  button,
  categorizeErrorText,
  countText,
  FREQUENCY_CHOICES,
  applyErrorText,
  keptLines,
  tooLargeText,
  el,
  errorTypeOf,
  extractErrorText,
  field,
  guessMapping,
  isDebtKind,
  isSpendingKind,
  mappingComplete,
  periodText,
  select,
  sourceChipText,
  whatGetsSentPanel,
} from '@/utils/smart-import-render';
import {
  ApplyTooLargeError,
  acceptAllSuggestions,
  addFile,
  applyCategorizeResponse,
  applyPreview,
  buildCategorizeRequest,
  buildAnalyzeContext,
  buildApplyRequest,
  buildPreviewRequest,
  buildSettingsPatch,
  accountKey,
  createWizardState,
  filterRows,
  layoutFor,
  markFileError,
  mergeAnalyze,
  needsReview,
  recurringRequest,
  reviewCounts,
  setAiProvider,
  setCategory,
  setExcluded,
  setFileMapping,
  setFileOptions,
  setKind,
  setRecurring,
  setStatement,
  updateRecurring,
  type RecurringChoice,
  type ReviewCounts,
  type RowFilter,
  type WizardFile,
  type WizardRow,
  type WizardState,
  type WizardStatement,
} from '@/utils/smart-import-state';
import type {
  AnalyzeResponse,
  ApplyRequest,
  ApplyResponse,
  CategorizeResponse,
  Expense,
  LiabilityResponse,
  PreviewResponse,
  RecurringCandidateSuggestion,
  SmartImportAccountKind,
  SmartImportAiStatus,
  SmartImportContext,
  SmartImportFrequency,
  SmartImportSettings,
  SmartImportTxnKind,
  SmartImportUndoResponse,
} from '@/types/api';
import sampleCsv from '@/samples/sample-checking.csv?raw';
import sampleOfx from '@/samples/sample-card.ofx?raw';

export interface OpenSmartImportOptions {
  /** Files to analyze right away (the Expenses drop zone hands its drop over). */
  files?: File[];
  /** Account kind hint for every file (the Debts toolbar passes 'credit_card'). */
  preset?: SmartImportAccountKind;
}

export interface SmartImportHandle {
  readonly modal: HTMLElement | null;
  /** Close the wizard without the discard prompt. */
  close: () => void;
  /** The current wizard state (read only; for tests and later steps). */
  getState: () => WizardState;
}

const SAMPLE_CHECKING_NAME = 'sample-checking.csv';
const SAMPLE_CHECKING_LABEL = 'Sample checking';
const ALLOWED_EXT = /\.(csv|ofx|qfx|pdf)$/i;
/** Per categorize chunk: the provider call is bounded server side, well under this. */
const AI_TIMEOUT_MS = 60_000;
/** Apply writes a whole batch in one transaction; give a large one time. */
const APPLY_TIMEOUT_MS = 120_000;
/** Columns of the categorize grid: select, date, description, amount, category, kind, source. */
const GRID_COLS = 7;

/** "a", "a and b", "a, b and c". */
function joinParts(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const FALLBACK_AI: SmartImportAiStatus = {
  ai_available: false,
  pdf_ai_available: false,
  ai_enabled: false,
  pdf_ai_enabled: false,
  provider: null,
  model: null,
  limits: {},
};

function newBatchId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Open the wizard on the Upload step. */
export function openSmartImportWizard(options: OpenSmartImportOptions = {}): SmartImportHandle {
  let ctx: SmartImportContext | null = null;
  let ctxFailed = false;
  let ai: SmartImportAiStatus = FALLBACK_AI;
  let state: WizardState | null = null;
  let step = 1;
  let busy = false;
  let liabilities: LiabilityResponse[] | null = null;
  let liabilitiesLoad: Promise<void> | null = null;

  const fileObjs = new Map<string, File>();
  const mappingDrafts = new Map<string, Record<string, string>>();
  const mappingErrors = new Set<string>();
  const sampleLabels = new Map<string, string>();
  const sending = new Set<string>();
  const sendFailed = new Map<string, string>();
  /** Statements whose debt choice the person made (or committed with Next). */
  const debtTouched = new Set<string>();
  let fileSeq = 0;
  let queue: Promise<void> = Promise.resolve();

  let modal: HTMLElement | null = null;
  let body: HTMLElement;
  let footer: HTMLElement;
  let progress: HTMLElement;
  let confirming = false;
  let closed = false;

  // ---- small state helpers ---------------------------------------------

  const st = (): WizardState => state!;
  const fileOf = (id: string): WizardFile | undefined => state?.files.find((f) => f.id === id);
  const statementsOf = (fileId: string): WizardStatement[] =>
    st().statements.filter((s) => s.file_id === fileId);

  function patchFile(id: string, patch: Partial<WizardFile>): void {
    state = { ...st(), files: st().files.map((f) => (f.id === id ? { ...f, ...patch } : f)) };
  }

  function removeFile(id: string): void {
    const s = st();
    state = {
      ...s,
      files: s.files.filter((f) => f.id !== id),
      statements: s.statements.filter((x) => x.file_id !== id),
      rows: s.rows.filter((r) => !r.statement_id.startsWith(`${id}:`)),
    };
    fileObjs.delete(id);
    mappingDrafts.delete(id);
  }

  // ---- data loading ----------------------------------------------------

  const load = async (): Promise<void> => {
    try {
      const [loaded, status] = await Promise.all([
        apiCall<SmartImportContext>('/api/smart-import/context'),
        apiCall<SmartImportAiStatus>('/api/smart-import/ai-status').catch(() => FALLBACK_AI),
      ]);
      ctx = loaded;
      ai = { ...FALLBACK_AI, ...status };
      state = createWizardState(loaded, newBatchId(), store.get('currentEntityId') ?? null);
      ctxFailed = false;
    } catch (error) {
      console.error('Import setup failed:', error instanceof Error ? error.name : 'error');
      ctxFailed = true;
    }
  };
  let ready: Promise<void> = load();

  function loadLiabilities(): Promise<void> {
    liabilitiesLoad ??= apiCall<LiabilityResponse[]>('/api/liabilities')
      .then((list) => {
        liabilities = Array.isArray(list) ? list : [];
      })
      .catch((error: unknown) => {
        console.error('Debts load failed:', error instanceof Error ? error.name : 'error');
        liabilities = [];
      });
    return liabilitiesLoad;
  }

  /** Mark duplicates and prior files, and look for a debt to link. Read only. */
  async function refreshPreview(): Promise<void> {
    if (!state) return;
    const request = buildPreviewRequest(st());
    if (request.statements.length === 0) return;
    try {
      const preview = await apiCall<PreviewResponse>('/api/smart-import/preview', {
        method: 'POST',
        body: request,
      });
      state = applyPreview(st(), preview);
    } catch (error) {
      console.error('Preview failed:', error instanceof Error ? error.name : 'error');
    }
  }

  // ---- analyze ---------------------------------------------------------

  const enqueue = (job: () => Promise<void>): Promise<void> => {
    queue = queue.then(job, job);
    return queue;
  };

  async function analyze(fileId: string): Promise<void> {
    const file = fileObjs.get(fileId);
    const wf = fileOf(fileId);
    if (!file || !wf || !ctx || !state) return;
    patchFile(fileId, { status: 'pending', error_type: null });
    refreshUi();
    try {
      const overrides = {
        ...wf.options,
        origin: wf.origin,
        ...(wf.headers.length ? { headers: wf.headers } : {}),
      };
      const answer = await uploadFileWithContext<AnalyzeResponse>(
        '/api/v2/smart-import/analyze',
        file,
        buildAnalyzeContext(ctx, overrides)
      );
      if (!fileOf(fileId)) return;
      state = mergeAnalyze(st(), fileId, answer);
      const presetLabel = sampleLabels.get(fileId);
      if (presetLabel) {
        for (const x of statementsOf(fileId)) {
          if (!x.account_key && !x.account_label) {
            state = setStatement(st(), x.id, { account_label: presetLabel });
          }
        }
      }
      if (answer.status === 'needs_mapping' && !wf.options.mapping) {
        const remembered = layoutFor(ctx, answer.headers);
        if (remembered) {
          state = setFileMapping(st(), fileId, remembered);
          return analyze(fileId);
        }
      }
    } catch (error) {
      if (!fileOf(fileId)) return;
      const status = error instanceof ApiError ? error.status : 0;
      console.error('Analyze failed:', error instanceof Error ? error.name : 'error');
      state = markFileError(
        st(),
        fileId,
        analyzeErrorType(status, error instanceof ApiError ? error.data : undefined)
      );
    }
    refreshUi();
  }

  async function addFiles(list: File[], origin: 'file' | 'sample' = 'file'): Promise<void> {
    await ready;
    if (!state || closed) return;
    let badType = false;
    let tooBig = false;
    let tooMany = false;
    for (const f of list) {
      if (origin === 'file' && !ALLOWED_EXT.test(f.name)) {
        badType = true;
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        tooBig = true;
        continue;
      }
      if (st().files.length >= MAX_FILES) {
        tooMany = true;
        break;
      }
      const id = `f${++fileSeq}`;
      fileObjs.set(id, f);
      state = addFile(st(), { id, file_name: f.name, origin });
      if (options.preset) state = setFileOptions(st(), id, { account_kind: options.preset });
      if (origin === 'sample' && f.name === SAMPLE_CHECKING_NAME) {
        // The sample checking file has no account id: name it so a visitor can click through.
        state = setFileOptions(st(), id, { account_kind: 'checking' });
        sampleLabels.set(id, SAMPLE_CHECKING_LABEL);
      }
      void enqueue(() => analyze(id));
    }
    if (badType) showToast('Only CSV, OFX, QFX and PDF files can be imported.', 'error');
    if (tooBig) showToast('A file larger than 10 MB was left out.', 'error');
    if (tooMany) showToast(`You can import up to ${MAX_FILES} files at a time.`, 'error');
    refreshUi();
  }

  function addSamples(): void {
    if (!state || st().files.some((f) => f.origin === 'sample')) return;
    void addFiles(
      [
        new File([sampleCsv], SAMPLE_CHECKING_NAME, { type: 'text/csv' }),
        new File([sampleOfx], 'sample-card.ofx', { type: 'application/x-ofx' }),
      ],
      'sample'
    );
  }

  // ---- rules for moving on ---------------------------------------------

  const hasPending = (): boolean => st().files.some((f) => f.status === 'pending');
  const unresolved = (): boolean =>
    st().files.some((f) => f.status === 'needs_mapping' || f.status === 'needs_ai_layout');

  function canLeaveUpload(): boolean {
    if (!state || busy || hasPending()) return false;
    return st().files.some((f) => f.status !== 'error');
  }

  function canLeaveAccounts(): boolean {
    if (!state || busy || hasPending() || unresolved()) return false;
    const stmts = st().statements.filter((s) => !s.skipped);
    return stmts.length > 0 && stmts.every((s) => accountKey(s) !== null);
  }

  // ---- discard prompt, listeners ----------------------------------------

  const isDirty = (): boolean => !!state && st().files.length > 0;

  function requestClose(): void {
    if (applyResult) finish();
    else if (isDirty()) showConfirm();
    else finish();
  }

  function finish(): void {
    closed = true;
    detach();
    closeDynamicModal();
  }

  let resumeFocus: HTMLElement | null = null;
  function showConfirm(): void {
    confirming = true;
    resumeFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    footer.textContent = '';
    footer.classList.add('smart-import-confirm');
    const text = el(
      'p',
      'smart-import-confirm-text',
      'Discard this import? Nothing has been saved yet.'
    );
    text.setAttribute('role', 'alert');
    const keep = button('Keep editing', 'btn btn-secondary', 'keep');
    const discard = button('Discard', 'btn btn-primary', 'discard');
    keep.addEventListener('click', () => {
      confirming = false;
      footer.classList.remove('smart-import-confirm');
      renderFooter();
      (resumeFocus?.isConnected ? resumeFocus : headingEl())?.focus();
    });
    discard.addEventListener('click', finish);
    footer.append(text, keep, discard);
    keep.focus();
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!modal || !modal.isConnected) {
      detach();
      return;
    }
    if (event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (!confirming) requestClose();
  };
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.modal-close') && !target.classList.contains('modal-backdrop')) return;
    event.stopPropagation();
    if (!confirming) requestClose();
  };
  const watcher = new MutationObserver(() => {
    if (modal && !modal.isConnected) detach();
  });
  function detach(): void {
    window.removeEventListener('keydown', onKey, true);
    watcher.disconnect();
    modal?.removeEventListener('click', onClick, true);
  }

  // ---- focus across re-renders -----------------------------------------

  const SCOPES = '[data-file],[data-statement]';
  const FOCUSABLE =
    'button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]';

  interface FocusKey {
    scope: string | null;
    si: string | null;
    field: string | null;
    index: number;
  }

  const scopeKey = (node: HTMLElement): string =>
    node.dataset.statement ? `s:${node.dataset.statement}` : `f:${node.dataset.file ?? ''}`;

  /** Where focus is inside the step, as a key that survives the DOM being rebuilt. */
  function captureFocus(): FocusKey | null {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement)) return null;
    if (footer?.contains(a)) {
      return { scope: 'footer', si: a.getAttribute('data-si'), field: null, index: -1 };
    }
    if (!body?.contains(a)) return null;
    const host = a.closest<HTMLElement>(SCOPES);
    const scopes = Array.from(body.querySelectorAll<HTMLElement>(SCOPES));
    return {
      scope: host ? scopeKey(host) : null,
      si: a.getAttribute('data-si'),
      field: a.getAttribute('data-field'),
      index: host ? scopes.indexOf(host) : -1,
    };
  }

  /**
   * Put focus back on the same control after a re-render. When its file or
   * statement is gone (Remove), the same control on the next one is used, then
   * that one's first control, then the drop zone or the heading.
   */
  function restoreFocus(key: FocusKey | null): void {
    if (!key) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body && a.isConnected) return;
    const sel = key.si
      ? `[data-si="${key.si}"]${key.field ? `[data-field="${key.field}"]` : ''}`
      : null;
    const pickIn = (host: HTMLElement): HTMLElement | null =>
      (sel ? host.querySelector<HTMLElement>(sel) : null) ??
      host.querySelector<HTMLElement>(FOCUSABLE);
    const scopes = Array.from(body.querySelectorAll<HTMLElement>(SCOPES));
    let target: HTMLElement | null = null;
    if (key.scope === 'footer') {
      target = sel ? footer.querySelector<HTMLElement>(`${sel}:not(:disabled)`) : null;
    } else if (key.scope) {
      const same = scopes.find((n) => scopeKey(n) === key.scope);
      const nextOne = same ?? scopes[Math.min(key.index, scopes.length - 1)];
      target = nextOne ? pickIn(nextOne) : null;
    } else if (sel) {
      target = body.querySelector<HTMLElement>(sel);
    }
    target ??= body.querySelector<HTMLElement>('[data-si="dropzone"]') ?? headingEl();
    target?.focus();
  }

  // ---- shell -----------------------------------------------------------

  const headingEl = (): HTMLElement | null => body.querySelector('.smart-import-heading');

  function mount(): void {
    const shell = el('div', 'smart-import');
    progress = el('div', 'smart-import-progress');
    body = el('div', 'smart-import-step');
    shell.append(progress, body);
    modal = createDynamicModal({
      title: 'Import statements',
      content: shell,
      showFooter: false,
      modalClass: 'smart-import-modal modal-sheet',
    });
    const content = modal.querySelector<HTMLElement>('.modal-content')!;
    footer = el('div', 'smart-import-footer');
    content.appendChild(footer);
    confirming = false;
    window.addEventListener('keydown', onKey, true);
    watcher.observe(document.body, { childList: true });
    modal.addEventListener('click', onClick, true);
  }

  function renderProgress(): void {
    progress.textContent = '';
    const list = el('ol', 'smart-import-steps');
    list.setAttribute('aria-label', 'Import steps');
    STEP_LABELS.forEach((label, i) => {
      const li = el(
        'li',
        i + 1 === step ? 'is-current' : i + 1 < step ? 'is-done' : undefined,
        label
      );
      if (i + 1 === step) li.setAttribute('aria-current', 'step');
      list.appendChild(li);
    });
    const done = step > STEP_LABELS.length;
    const short = el(
      'p',
      'smart-import-progress-short',
      done ? 'Done' : `${step} of ${STEP_LABELS.length}`
    );
    const name = el('span', 'smart-import-step-name', done ? '' : STEP_LABELS[step - 1]);
    progress.append(list, short, name);
  }

  function setStep(n: number, title: string): HTMLElement {
    step = n;
    renderProgress();
    body.textContent = '';
    const h = el('h3', 'smart-import-heading', title);
    h.tabIndex = -1;
    body.appendChild(h);
    renderFooter();
    return h;
  }

  function renderFooter(): void {
    if (confirming) return;
    footer.textContent = '';
    if (step === 6) {
      const close = button('Done', 'btn btn-primary', 'close');
      close.disabled = undoing;
      close.addEventListener('click', finish);
      footer.append(el('span'), close);
      return;
    }
    if (step === 5) {
      const backBtn = button('Back', 'btn btn-secondary', 'back');
      backBtn.disabled = applying;
      backBtn.addEventListener('click', () => void goTo(4));
      const apply = button(applying ? 'Applying...' : 'Apply import', 'btn btn-primary', 'apply');
      apply.disabled = applying || !hasSomethingToApply();
      apply.addEventListener('click', () => void applyNow());
      footer.append(backBtn, apply);
      return;
    }
    const left = button(
      step === 1 ? 'Cancel' : 'Back',
      'btn btn-secondary',
      step === 1 ? 'cancel' : 'back'
    );
    const right = button('Next', 'btn btn-primary', 'next');
    right.disabled =
      step === 1
        ? !canLeaveUpload()
        : step === 2
          ? !canLeaveAccounts()
          : step === 3
            ? aiBusy
            : step === 4
              ? !canLeaveRecurring()
              : true;
    left.addEventListener('click', () => {
      if (step === 1) requestClose();
      else void goTo(step - 1);
    });
    right.addEventListener('click', () => void goNext());
    footer.append(left, right);
  }

  /** Redraw whatever depends on file status. Cheap; safe from async callbacks. */
  function refreshUi(): void {
    if (!modal || !modal.isConnected) return;
    const focus = captureFocus();
    if (step === 1) renderFileList();
    if (step === 2) renderAccountCards();
    if (step === 3) renderCategorizeParts();
    renderFooter();
    if (step !== 3) restoreFocus(focus);
  }

  async function goTo(n: number): Promise<void> {
    if (n === 1) renderUpload();
    else if (n === 2) await renderAccounts();
    else if (n === 3) renderCategorize();
    else if (n === 4) await renderRecurring();
    else if (n === 5) await renderReview();
  }

  async function goNext(): Promise<void> {
    if (step === 1 && canLeaveUpload()) {
      busy = true;
      renderFooter();
      try {
        await renderAccounts();
      } finally {
        busy = false;
        renderFooter();
      }
      return;
    }
    if (step === 2 && canLeaveAccounts()) {
      // Commit the debt choices as shown, suggestions included.
      for (const s of st().statements) {
        if (!isDebtKind(s.account_kind) || s.skipped) continue;
        const value = debtValue(s);
        state = setStatement(st(), s.id, { liability_id: value || null });
        debtTouched.add(s.id);
      }
      renderCategorize();
      return;
    }
    if (step === 3 && !aiBusy) await renderRecurring();
    else if (step === 4 && canLeaveRecurring()) await renderReview();
  }

  // ---- step 1: upload --------------------------------------------------

  let fileList: HTMLElement | null = null;

  function renderUpload(): void {
    const h = setStep(1, 'Add your statements');
    if (!state) {
      if (!ctxFailed) {
        body.appendChild(el('p', 'smart-import-lead', 'Loading...'));
        h.focus();
        return;
      }
      const note = el('p', 'smart-import-error', 'Could not load your import settings.');
      note.setAttribute('role', 'alert');
      const retry = button('Retry', 'btn btn-secondary', 'retry');
      retry.addEventListener('click', () => {
        ctxFailed = false;
        ready = load();
        renderUpload();
        void ready.then(() => {
          if (!closed && modal?.isConnected && step === 1) renderUpload();
        });
      });
      body.append(note, retry);
      h.focus();
      return;
    }

    const input = el('input', 'smart-import-file-input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = true;
    input.setAttribute('data-si', 'file-input');
    // The drop zone (a button) is the keyboard target; the input stays out of the tab order.
    input.tabIndex = -1;
    input.setAttribute('aria-label', 'Choose statement files');
    input.addEventListener('change', () => {
      const picked = Array.from(input.files ?? []);
      input.value = '';
      void addFiles(picked);
    });

    const zone = el('div', 'drop-zone smart-import-dropzone');
    zone.setAttribute('data-si', 'dropzone');
    zone.setAttribute('role', 'button');
    zone.tabIndex = 0;
    zone.appendChild(
      el(
        'p',
        undefined,
        'Drop CSV, OFX, QFX or PDF statements here, or choose files. Up to 12 files.'
      )
    );
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('drag-active');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-active'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-active');
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      void addFiles(dropped);
    });

    const sample = button('Try a sample statement', 'btn btn-secondary', 'sample');
    sample.addEventListener('click', addSamples);
    const actions = el('div', 'smart-import-actions');
    actions.appendChild(sample);

    fileList = el('ul', 'smart-import-files');
    fileList.setAttribute('aria-live', 'polite');

    body.append(zone, input, actions, el('p', 'smart-import-privacy', PRIVACY_LINE), fileList);
    renderFileList();
    h.focus();
  }

  function fileStatusText(f: WizardFile): string {
    switch (f.status) {
      case 'pending':
        return 'Reading...';
      case 'ok':
        return `${countText(statementsOf(f.id).length, 'statement')} found`;
      case 'needs_mapping':
        return 'Needs a column match';
      case 'needs_ai_layout':
        return 'Needs help reading the layout';
      default:
        return analyzeErrorText(f.error_type);
    }
  }

  function renderFileList(): void {
    if (!fileList || !state) return;
    fileList.textContent = '';
    for (const f of st().files) {
      const li = el('li', `smart-import-file is-${f.status}`);
      li.dataset.file = f.id;
      const name = el('span', 'smart-import-file-name', f.file_name);
      const status = el('span', 'smart-import-file-status', fileStatusText(f));
      const remove = button('Remove', 'btn btn-secondary btn-sm', 'remove-file');
      remove.setAttribute('aria-label', `Remove ${f.file_name}`);
      remove.addEventListener('click', () => {
        removeFile(f.id);
        refreshUi();
      });
      li.append(name, status, remove);
      fileList.appendChild(li);
    }
  }

  // ---- step 2: accounts --------------------------------------------------

  let cards: HTMLElement | null = null;

  async function renderAccounts(focus?: string): Promise<void> {
    if (!state) return;
    const needsDebts = st().statements.some((s) => isDebtKind(s.account_kind));
    // Debts may have been added elsewhere since the last visit: always fetch afresh.
    if (needsDebts) {
      liabilities = null;
      liabilitiesLoad = null;
    }
    await Promise.all([refreshPreview(), needsDebts ? loadLiabilities() : Promise.resolve()]);
    if (!modal || !modal.isConnected) return;
    const h = setStep(2, 'Check the accounts');
    body.appendChild(
      el(
        'p',
        'smart-import-lead',
        'Confirm what each statement is. Nothing is saved until you apply the import.'
      )
    );
    cards = el('div', 'smart-import-cards');
    body.appendChild(cards);
    renderAccountCards();
    const target = focus ? body.querySelector<HTMLElement>(focus) : null;
    (target ?? h).focus();
  }

  function renderAccountCards(): void {
    if (!cards || !state) return;
    const focus = captureFocus();
    cards.textContent = '';
    let failed = 0;
    for (const f of st().files) {
      if (f.status === 'error') failed++;
      else if (f.status === 'pending') cards.appendChild(pendingCard(f));
      else if (f.status === 'needs_mapping') cards.appendChild(mappingCard(f));
      else if (f.status === 'needs_ai_layout') cards.appendChild(aiCard(f));
      else for (const s of statementsOf(f.id)) cards.appendChild(statementCard(s, f));
    }
    if (failed > 0) {
      cards.appendChild(
        el(
          'p',
          'smart-import-hint',
          `${countText(failed, 'file')} could not be read and will be left out.`
        )
      );
    }
    renderFooter();
    restoreFocus(focus);
  }

  /** Card title with the "Leave this file out" text button at the top right. */
  function cardHead(title: string, fileId: string): HTMLElement {
    const head = el('div', 'smart-import-card-head');
    head.appendChild(el('h4', 'smart-import-card-title', title));
    const leave = button('Leave this file out', 'smart-import-leave', 'remove-file');
    leave.addEventListener('click', () => {
      removeFile(fileId);
      refreshUi();
    });
    head.appendChild(leave);
    return head;
  }

  function pendingCard(f: WizardFile): HTMLElement {
    const card = el('section', 'smart-import-card is-pending');
    card.dataset.file = f.id;
    card.append(el('h4', 'smart-import-card-title', f.file_name), el('p', undefined, 'Reading...'));
    return card;
  }

  function knownLabels(): string[] {
    if (!ctx) return [];
    const labels = [
      ...ctx.accounts.map((a) => a.label ?? ''),
      ...Object.values(ctx.settings.accounts ?? {}),
    ].filter((l) => l.trim().length > 0);
    return [...new Set(labels)];
  }

  function accountTitle(s: WizardStatement): string {
    const known = ctx?.accounts.find((a) => a.account_key === s.account_key)?.label;
    const named = s.account_label?.trim() || known;
    if (named) return named;
    if (s.account_kind === 'unknown')
      return s.institution ? `${s.institution} statement` : 'Statement';
    return s.institution
      ? `${s.institution} ${KIND_LABEL[s.account_kind]}`
      : KIND_LABEL[s.account_kind];
  }

  function statementCard(s: WizardStatement, f: WizardFile): HTMLElement {
    const card = el('section', 'smart-import-card');
    card.setAttribute('data-statement', s.id);
    card.appendChild(cardHead(accountTitle(s), f.id));

    const facts = el('dl', 'smart-import-facts');
    const fact = (label: string, value: string): void => {
      const dt = el('dt', undefined, label);
      const dd = el('dd', undefined, value);
      facts.append(dt, dd);
    };
    fact('Type', s.account_kind === 'unknown' ? 'Not detected' : KIND_LABEL[s.account_kind]);
    if (s.last4) fact('Account', `ending ${s.last4}`);
    if (s.institution) fact('Institution', s.institution);
    fact('Period', periodText(s.period));
    fact(
      'Transactions',
      countText(st().rows.filter((r) => r.statement_id === s.id).length, 'transaction')
    );
    const bal = balanceText(s);
    if (bal) fact('Balance', bal);
    fact('File', s.file_name || f.file_name);
    card.appendChild(facts);

    if (s.prior_import_at !== null) {
      card.appendChild(
        el('p', 'smart-import-note', 'This file was already imported, so it will be left out.')
      );
    }
    for (const w of s.warnings) {
      const text = WARNING_COPY[w];
      if (text) card.appendChild(el('p', 'smart-import-note', text));
    }

    // Which account is this?
    if (!s.account_key) {
      const input = el('input');
      input.type = 'text';
      input.maxLength = MAX_LABEL_CHARS;
      input.value = s.account_label ?? '';
      input.setAttribute('data-si', 'label');
      input.autocomplete = 'off';
      const list = el('datalist');
      list.id = `si-labels-${s.id.replace(/[^a-z0-9]/gi, '')}`;
      for (const label of knownLabels()) {
        const o = el('option');
        o.value = label;
        list.appendChild(o);
      }
      input.setAttribute('list', list.id);
      input.addEventListener('input', () => {
        state = setStatement(st(), s.id, { account_label: input.value });
        renderFooter();
      });
      input.addEventListener('change', () => {
        state = setStatement(st(), s.id, { account_label: input.value });
        void refreshPreview().then(() => {
          renderFooter();
          const host = card.querySelector<HTMLElement>('.smart-import-debt');
          if (host) renderDebtSection(host, s.id);
        });
      });
      card.append(
        field(
          'Which account is this?',
          input,
          'A name you will recognize, like Everyday checking.'
        ),
        list
      );
    }

    // Account type (a hint the parser uses to read signs and kinds).
    if (statementsOf(f.id).length === 1) {
      const kind = select(KIND_CHOICES, s.account_kind, { 'data-si': 'kind' });
      kind.addEventListener('change', () => {
        state = setFileOptions(st(), f.id, { account_kind: kind.value as SmartImportAccountKind });
        void reanalyze(f.id, '[data-si="kind"]');
      });
      card.appendChild(field('Account type', kind));
    }

    // Sign and date order controls (CSV files).
    if (s.format === 'csv') {
      const flipped = f.options.flip_sign ?? s.warnings.includes('sign_flipped');
      const row = el('div', 'smart-import-actions');
      if (flipped) row.appendChild(el('span', 'smart-import-note-inline', 'Amounts were flipped.'));
      const flip = button(
        flipped ? 'Undo the flip' : 'Amounts look reversed? Flip',
        'btn btn-secondary btn-sm',
        'flip'
      );
      flip.addEventListener('click', () => {
        state = setFileOptions(st(), f.id, { flip_sign: !flipped });
        void reanalyze(f.id, '[data-si="flip"]');
      });
      row.appendChild(flip);
      card.appendChild(row);

      const assumed = s.warnings.includes('date_order_assumed') && !f.options.date_order;
      if (assumed || f.options.date_order) {
        const order = select(
          [
            { value: 'mdy', label: 'Month first (12/31/2026)' },
            { value: 'dmy', label: 'Day first (31/12/2026)' },
          ],
          f.options.date_order ?? 'mdy',
          { 'data-si': 'date-order' }
        );
        order.addEventListener('change', () => {
          state = setFileOptions(st(), f.id, { date_order: order.value });
          void reanalyze(f.id, '[data-si="date-order"]');
        });
        card.appendChild(
          field(
            'Date order',
            order,
            assumed
              ? 'The dates in this file could be read either way. Month first was assumed.'
              : undefined
          )
        );
        if (assumed) {
          const confirmRow = el('div', 'smart-import-actions');
          const ok = button('Looks right', 'btn btn-secondary btn-sm', 'date-confirm');
          ok.setAttribute('aria-label', 'Month first looks right');
          ok.addEventListener('click', () => {
            state = setFileOptions(st(), f.id, { date_order: 'mdy' });
            void reanalyze(f.id, '[data-si="date-order"]');
          });
          confirmRow.appendChild(ok);
          card.appendChild(confirmRow);
        }
      }
    }

    if (isDebtKind(s.account_kind)) {
      const host = el('div', 'smart-import-debt');
      card.appendChild(host);
      renderDebtSection(host, s.id);
    }

    return card;
  }

  async function reanalyze(fileId: string, focus: string): Promise<void> {
    await enqueue(() => analyze(fileId));
    if (step !== 2 || !modal?.isConnected) return;
    await renderAccounts(focus);
  }

  // ---- debt link ---------------------------------------------------------

  /** What the select shows: the person's choice, else the preview's suggestion. */
  function debtValue(s: WizardStatement): string {
    if (debtTouched.has(s.id)) return s.liability_id ?? '';
    return suggestionFor(s);
  }

  /** Active debts whose type fits the statement: cards for a card, loan types for a loan. */
  function fittingDebts(s: WizardStatement): LiabilityResponse[] {
    return (liabilities ?? []).filter(
      (l) =>
        l.is_active !== false &&
        (s.account_kind === 'credit_card'
          ? l.liability_type === 'credit_card'
          : l.liability_type !== 'credit_card' && l.liability_type !== 'heloc')
    );
  }

  /** The preview's suggestion, else the only debt of a fitting type. */
  function suggestionFor(s: WizardStatement): string {
    if (s.suggested_liability_id) return s.suggested_liability_id;
    const fits = fittingDebts(s);
    return fits.length === 1 ? fits[0]!.id : '';
  }

  function debtChoices(s: WizardStatement): LiabilityResponse[] {
    const all = (liabilities ?? []).filter((l) => l.is_active !== false);
    const fits = fittingDebts(s);
    const chosen = debtValue(s);
    const extra = chosen ? all.find((l) => l.id === chosen && !fits.includes(l)) : undefined;
    return extra ? [...fits, extra] : fits;
  }

  function renderDebtSection(host: HTMLElement, statementId: string): void {
    const s = st().statements.find((x) => x.id === statementId);
    if (!s) return;
    host.textContent = '';
    const choices = debtChoices(s);
    const options = [
      { value: '', label: 'Do not link a debt' },
      ...choices.map((l) => ({ value: l.id, label: l.name })),
    ];
    const sel = select(options, debtValue(s), { 'data-si': 'debt' });
    if (sel.value !== debtValue(s)) sel.value = '';
    sel.addEventListener('change', () => {
      state = setStatement(st(), s.id, { liability_id: sel.value || null });
      debtTouched.add(s.id);
      renderDebtSection(host, s.id);
    });
    const group = el('div', 'smart-import-debt-group');
    group.appendChild(field('Link to a debt', sel));
    host.appendChild(group);
    const suggested = suggestionFor(s);
    if (!debtTouched.has(s.id) && suggested && sel.value === suggested) {
      group.appendChild(
        el(
          'p',
          'smart-import-hint',
          'Suggested match. Choose Skip to leave this statement unlinked.'
        )
      );
    }
    group.appendChild(
      el(
        'p',
        'smart-import-hint',
        'Linking records this statement’s balance on the debt when you apply the import.'
      )
    );
    group.appendChild(
      el(
        'p',
        'smart-import-hint',
        '"Add as a new debt" saves that debt right away. Everything else here waits until you apply the import.'
      )
    );
    const row = el('div', 'smart-import-actions');
    const skip = button('Skip', 'btn btn-secondary btn-sm', 'debt-skip');
    skip.addEventListener('click', () => {
      state = setStatement(st(), s.id, { liability_id: null });
      debtTouched.add(s.id);
      renderDebtSection(host, s.id);
    });
    const add = button('Add as a new debt', 'btn btn-secondary btn-sm', 'debt-new');
    add.addEventListener('click', () => void addDebtFor(s.id));
    row.append(skip, add);
    group.appendChild(row);
  }

  /**
   * The debt wizard replaces this dialog (there is one dynamic modal), so this
   * wizard steps aside with its state intact and comes back when the debt wizard
   * goes away, saved or not.
   */
  async function addDebtFor(statementId: string): Promise<void> {
    const s = st().statements.find((x) => x.id === statementId);
    if (!s) return;
    const balance = s.closing_balance ? Math.abs(s.closing_balance.amount).toFixed(2) : '';
    let savedId: string | null = null;
    detach();
    closeDynamicModal();
    modal = null;
    const handle = await openDebtWizardLazy({
      prefill: {
        liabilityType: s.account_kind === 'credit_card' ? 'credit_card' : 'personal_loan',
        ...(s.institution ? { lender: s.institution } : {}),
        ...(balance ? { currentBalance: balance } : {}),
      },
      onSaved: (saved) => {
        savedId = saved.id;
      },
    });
    const resume = (): void => {
      if (closed) return;
      void comeBack(statementId, savedId);
    };
    if (!handle) {
      resume();
      return;
    }
    const waiter = new MutationObserver(() => {
      if (!handle.modal.isConnected) {
        waiter.disconnect();
        resume();
      }
    });
    waiter.observe(document.body, { childList: true });
    if (!handle.modal.isConnected) {
      waiter.disconnect();
      resume();
    }
  }

  async function comeBack(statementId: string, savedId: string | null): Promise<void> {
    mount();
    liabilities = null;
    liabilitiesLoad = null;
    if (savedId) {
      state = setStatement(st(), statementId, { liability_id: savedId });
      debtTouched.add(statementId);
    }
    await renderAccounts('[data-si="debt"]');
  }

  // ---- needs_mapping and needs_ai_layout cards ---------------------------

  function mappingCard(f: WizardFile): HTMLElement {
    const card = el('section', 'smart-import-card smart-import-mapping');
    card.dataset.file = f.id;
    card.appendChild(cardHead('Match the columns', f.id));
    card.appendChild(el('p', 'smart-import-file-name', f.file_name));
    card.appendChild(
      el(
        'p',
        'smart-import-hint',
        'The columns in this file were not recognized. Choose which column holds each value.'
      )
    );
    if (f.sample_rows.length > 0) {
      const wrap = el('div', 'smart-import-sample');
      const table = el('table');
      const head = el('tr');
      for (const h of f.headers) head.appendChild(el('th', undefined, h));
      table.appendChild(el('thead')).appendChild(head);
      const tbody = el('tbody');
      for (const row of f.sample_rows) {
        const tr = el('tr');
        for (const cell of row) tr.appendChild(el('td', undefined, cell));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      card.appendChild(wrap);
    }
    if (!mappingDrafts.has(f.id)) mappingDrafts.set(f.id, guessMapping(f.headers));
    const draft = mappingDrafts.get(f.id)!;
    const grid = el('div', 'smart-import-mapping-grid');
    for (const m of MAPPING_FIELDS) {
      const sel = select(
        [{ value: '', label: 'Not used' }, ...f.headers.map((h) => ({ value: h, label: h }))],
        draft[m.key] ?? '',
        { 'data-si': 'map-field', 'data-field': m.key }
      );
      sel.addEventListener('change', () => {
        if (sel.value) draft[m.key] = sel.value;
        else delete draft[m.key];
      });
      grid.appendChild(field(m.label, sel));
    }
    card.appendChild(grid);
    if (mappingErrors.has(f.id)) {
      const alert = el(
        'p',
        'smart-import-error',
        'Choose the date, description and amount columns.'
      );
      alert.setAttribute('role', 'alert');
      card.appendChild(alert);
    }
    const row = el('div', 'smart-import-actions');
    const apply = button('Use these columns', 'btn btn-primary btn-sm', 'map-apply');
    apply.addEventListener('click', () => {
      if (!mappingComplete(draft)) {
        mappingErrors.add(f.id);
        renderAccountCards();
        return;
      }
      mappingErrors.delete(f.id);
      state = setFileMapping(st(), f.id, { ...draft });
      void reanalyze(f.id, '[data-si="kind"]');
    });
    row.append(apply);
    card.appendChild(row);
    return card;
  }

  function aiCard(f: WizardFile): HTMLElement {
    const card = el('section', 'smart-import-card smart-import-ai-card');
    card.dataset.file = f.id;
    card.appendChild(cardHead('This PDF needs help', f.id));
    card.appendChild(el('p', 'smart-import-file-name', f.file_name));
    card.appendChild(
      el(
        'p',
        undefined,
        `The layout of this PDF was not recognized (${countText(f.line_count, 'line')} found).`
      )
    );
    if (ai.pdf_ai_available) {
      const provider = ai.provider ?? 'the AI provider';
      card.appendChild(
        el(
          'p',
          'smart-import-hint',
          `These lines, with long numbers already hidden, would be sent to ${provider} to be read. Nothing is kept.`
        )
      );
      const lines = el('div', 'smart-import-lines', f.lines.join('\n'));
      lines.tabIndex = 0;
      lines.setAttribute('role', 'region');
      lines.setAttribute('aria-label', 'Lines that would be sent');
      card.appendChild(lines);
      const failure = sendFailed.get(f.id);
      if (failure) {
        const alert = el('p', 'smart-import-error', failure);
        alert.setAttribute('role', 'alert');
        card.appendChild(alert);
      }
      const send = button(
        sending.has(f.id) ? 'Sending...' : `Send these ${f.lines.length} lines`,
        'btn btn-primary btn-sm',
        'send-lines'
      );
      send.disabled = sending.has(f.id);
      send.addEventListener('click', () => void sendLines(f.id));
      card.appendChild(send);
    } else {
      card.appendChild(
        el('p', 'smart-import-hint', 'Try your bank’s CSV or OFX download instead.')
      );
    }
    return card;
  }

  async function sendLines(fileId: string): Promise<void> {
    const f = fileOf(fileId);
    if (!f || !ctx || sending.has(fileId)) return;
    // The button is disabled while sending, so focus is put back from this key afterwards.
    const focus = captureFocus();
    sending.add(fileId);
    sendFailed.delete(fileId);
    renderAccountCards();
    try {
      const answer = await apiCall<AnalyzeResponse>('/api/smart-import/extract', {
        method: 'POST',
        body: {
          lines: f.lines,
          categories: ctx.categories,
          rules: ctx.rules.map((r) => ({
            merchant_key: r.merchant_key,
            category_id: r.category_id,
            kind: r.kind,
          })),
          ...(f.options.account_kind ? { account_kind: f.options.account_kind } : {}),
        },
      });
      if (!fileOf(fileId)) return;
      if (answer.status !== 'ok' || answer.statements.length === 0) {
        sendFailed.set(fileId, extractErrorText(502));
      } else {
        state = mergeAnalyze(st(), fileId, answer);
        state = setAiProvider(st(), ai.provider);
        await refreshPreview();
      }
    } catch (error) {
      console.error('PDF AI failed:', error instanceof Error ? error.name : 'error');
      sendFailed.set(
        fileId,
        extractErrorText(
          error instanceof ApiError ? error.status : 0,
          error instanceof ApiError ? errorTypeOf(error.data) : undefined
        )
      );
    } finally {
      sending.delete(fileId);
    }
    if (step === 2 && modal?.isConnected) {
      renderAccountCards();
      restoreFocus(focus);
    }
  }

  // ---- step 3: categorize ------------------------------------------------

  /** Server mode keeps a per-profile AI consent; hosted mode has none to ask for. */
  const isHosted = (): boolean => store.get('dataMode') === 'local';

  let filter: RowFilter = 'all';
  /** The rows in view, fixed when the filter is chosen so an edit never makes a row jump away. */
  let viewIds: string[] = [];
  let shown = PAGE_ROWS;
  const selected = new Set<string>();
  /** The grid's single tab stop (roving tabindex): this row, this column. */
  let activeRow: string | null = null;
  let activeCol = 0;
  /**
   * The latest category or kind change. "Remember" is on by default; turning it
   * off replays the change on the state from before it, without remembering.
   * Another edit ends the offer; selection changes do not.
   */
  let lastEdit: {
    before: WizardState;
    redo: (s: WizardState, remember: boolean) => WizardState;
    label: string;
    remember: boolean;
  } | null = null;
  let aiOpen = false;
  let aiBusy = false;
  let aiNote: { text: string; error: boolean } | null = null;

  let catFilters: HTMLElement | null = null;
  let catAi: HTMLElement | null = null;
  let catBody: HTMLTableSectionElement | null = null;
  let catSelectAll: HTMLInputElement | null = null;
  let catSelectAllText: HTMLElement | null = null;
  let catMore: HTMLElement | null = null;
  let catBulk: HTMLElement | null = null;

  const rowById = (): Map<string, WizardRow> => new Map(st().rows.map((r) => [r.id, r]));

  function setFilter(next: RowFilter): void {
    filter = next;
    viewIds = filterRows(st(), next).map((r) => r.id);
    shown = PAGE_ROWS;
    selected.clear();
    activeRow = null;
    activeCol = 0;
  }

  function renderCategorize(): void {
    if (!state) return;
    const h = setStep(3, 'Categorize transactions');
    body.appendChild(
      el(
        'p',
        'smart-import-lead',
        'Check the category of each transaction. Nothing is saved until you apply the import.'
      )
    );
    setFilter(filterRows(st(), 'review').length > 0 ? 'review' : 'all');
    lastEdit = null;
    aiOpen = false;
    aiNote = null;

    catAi = el('div', 'smart-import-ai');
    catFilters = el('div', 'smart-import-filters');
    catFilters.setAttribute('role', 'group');
    catFilters.setAttribute('aria-label', 'Show');

    const tools = el('div', 'smart-import-grid-tools');
    const allLabel = el('label', 'smart-import-select-all');
    const all = el('input');
    all.type = 'checkbox';
    all.setAttribute('data-si', 'select-all');
    all.addEventListener('change', () => {
      if (all.checked) for (const id of viewIds) selected.add(id);
      else for (const id of viewIds) selected.delete(id);
      renderCategorizeParts();
    });
    catSelectAll = all;
    catSelectAllText = el('span');
    allLabel.append(all, catSelectAllText);
    tools.appendChild(allLabel);

    const wrap = el('div', 'smart-import-table-wrap');
    const table = el('table', 'smart-import-table');
    // A real grid: explicit roles survive the phone card layout's display changes.
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', 'Imported transactions');
    const head = el('tr');
    head.setAttribute('role', 'row');
    for (const [label, cls] of [
      ['', 'check'],
      ['Date', 'date'],
      ['Description', 'desc'],
      ['Amount', 'amount'],
      ['Category', 'category'],
      ['Kind', 'kind'],
      ['Source', 'source'],
    ] as const) {
      const th = el('th', `smart-import-col-${cls}`, label);
      th.scope = 'col';
      th.setAttribute('role', 'columnheader');
      if (!label) th.setAttribute('aria-label', 'Selected');
      head.appendChild(th);
    }
    table.appendChild(el('thead')).appendChild(head);
    catBody = el('tbody');
    catBody.addEventListener('change', onTableChange);
    catBody.addEventListener('keydown', onTableKey);
    catBody.addEventListener('focusin', onTableFocus);
    table.appendChild(catBody);
    wrap.appendChild(table);

    catMore = el('div', 'smart-import-more');
    catBulk = el('div', 'smart-import-bulk');
    catBulk.setAttribute('role', 'region');
    catBulk.setAttribute('aria-label', 'Change selected rows');

    body.append(catAi, catFilters, tools, wrap, catMore, catBulk);
    renderCategorizeParts();
    h.focus();
  }

  /** Redraw the step from state, keeping focus on the same control. */
  function renderCategorizeParts(): void {
    if (!catBody || !state || step !== 3) return;
    const active = document.activeElement;
    const inBody = active instanceof HTMLElement && body.contains(active);
    const inGrid = inBody && catBody.contains(active);
    const focusSi = inBody ? active.getAttribute('data-si') : null;
    const focusFilter = inBody ? active.getAttribute('data-filter') : null;

    renderCatFilters();
    renderCatAi();
    renderCatRows();
    renderCatBulk();
    renderFooter();

    if (inGrid) {
      focusActiveCell();
      return;
    }
    let target: HTMLElement | null = null;
    if (focusFilter) {
      target = catFilters?.querySelector<HTMLElement>(`[data-filter="${focusFilter}"]`) ?? null;
    } else if (focusSi) {
      target = body.querySelector<HTMLElement>(`[data-si="${focusSi}"]`);
    }
    if (target && target !== document.activeElement) target.focus();
  }

  function renderCatFilters(): void {
    if (!catFilters) return;
    catFilters.textContent = '';
    const filters: [RowFilter, string][] = [
      ['review', 'Needs review'],
      ['all', 'All'],
      ['duplicates', 'Duplicates'],
      ['excluded', 'Excluded'],
    ];
    for (const [value, label] of filters) {
      const b = button(
        `${label} (${filterRows(st(), value).length.toLocaleString('en-US')})`,
        'smart-import-filter',
        'filter'
      );
      b.setAttribute('data-filter', value);
      b.setAttribute('aria-pressed', String(filter === value));
      b.addEventListener('click', () => {
        setFilter(value);
        renderCategorizeParts();
      });
      catFilters.appendChild(b);
    }
  }

  function categoryOptions(): { value: string; label: string }[] {
    return [
      { value: '', label: 'Uncategorized' },
      ...st().categories.map((c) => ({ value: c.id, label: c.name })),
    ];
  }

  function renderCatRows(): void {
    if (!catBody || !catMore || !catSelectAll || !catSelectAllText) return;
    catBody.textContent = '';
    const rows = rowById();
    const view = viewIds.map((id) => rows.get(id)).filter((r): r is WizardRow => !!r);
    const page = view.slice(0, shown);
    if (activeRow === null || !page.some((r) => r.id === activeRow)) {
      activeRow = page[0]?.id ?? null;
      activeCol = 0;
    }
    const cats = categoryOptions();
    for (const r of page) catBody.appendChild(rowEl(r, cats));
    if (page.length === 0) {
      const tr = el('tr', 'smart-import-empty');
      tr.setAttribute('role', 'row');
      const td = el('td', undefined, 'No transactions in this list.');
      td.setAttribute('role', 'gridcell');
      td.colSpan = GRID_COLS;
      tr.appendChild(td);
      catBody.appendChild(tr);
    }
    applyRoving();

    const picked = view.filter((r) => selected.has(r.id)).length;
    catSelectAll.checked = view.length > 0 && picked === view.length;
    catSelectAll.indeterminate = picked > 0 && picked < view.length;
    catSelectAll.disabled = view.length === 0;
    catSelectAllText.textContent = `Select all ${countText(view.length, 'row')} in this list`;

    catMore.textContent = '';
    if (view.length > shown) {
      catMore.appendChild(
        el(
          'span',
          'smart-import-hint',
          `Showing ${shown.toLocaleString('en-US')} of ${view.length.toLocaleString('en-US')}`
        )
      );
      const more = button('Show more', 'btn btn-secondary btn-sm', 'show-more');
      more.addEventListener('click', () => {
        const firstNew = view[shown]?.id;
        shown += PAGE_ROWS;
        // The button goes away with the last page: continue in the first new row.
        const gone = view.length <= shown;
        if (gone && firstNew) {
          activeRow = firstNew;
          activeCol = 0;
        }
        renderCategorizeParts();
        if (gone && firstNew) focusActiveCell();
      });
      catMore.appendChild(more);
    }
  }

  function rowEl(r: WizardRow, cats: { value: string; label: string }[]): HTMLTableRowElement {
    const classes = ['smart-import-row'];
    if (r.excluded) classes.push('is-excluded');
    if (r.duplicate) classes.push('is-duplicate');
    const tr = el('tr', classes.join(' '));
    tr.dataset.row = r.id;
    tr.setAttribute('role', 'row');
    tr.setAttribute('aria-selected', String(selected.has(r.id)));

    const check = el('input');
    check.type = 'checkbox';
    check.checked = selected.has(r.id);
    check.setAttribute('data-si', 'row-select');
    check.setAttribute('aria-label', `Select ${r.description}`);
    const cCheck = el('td', 'smart-import-col-check');
    cCheck.appendChild(check);

    const cDate = el('td', 'smart-import-col-date', formatDate(r.posted_date));

    const cDesc = el('td', 'smart-import-col-desc');
    cDesc.appendChild(el('span', 'smart-import-desc-text', r.description));
    if (r.duplicate) cDesc.appendChild(el('span', 'smart-import-badge', 'Duplicate'));
    if (r.excluded) cDesc.appendChild(el('span', 'smart-import-badge is-muted', 'Excluded'));

    const cAmount = el(
      'td',
      `smart-import-col-amount${r.amount > 0 ? ' is-in' : ''}`,
      formatCurrency(r.amount)
    );

    const spending = isSpendingKind(r.kind);
    const cat = select(
      spending ? cats : [{ value: '', label: 'No category' }],
      spending ? (r.category_id ?? '') : '',
      { 'data-si': 'category', 'aria-label': `Category for ${r.description}` }
    );
    cat.disabled = !spending;
    const cCat = el('td', 'smart-import-col-category');
    cCat.appendChild(cat);

    const kind = select(TXN_KIND_CHOICES, r.kind, {
      'data-si': 'kind',
      'aria-label': `Kind for ${r.description}`,
    });
    const cKind = el('td', 'smart-import-col-kind');
    cKind.appendChild(kind);

    const cSource = el('td', 'smart-import-col-source');
    const chip = sourceChipText(r);
    if (chip) {
      const c = el('span', `smart-import-chip is-${r.category_source}`, chip);
      if (needsReview(r)) c.classList.add('is-review');
      cSource.appendChild(c);
    }

    for (const td of [cCheck, cDate, cDesc, cAmount, cCat, cKind, cSource]) {
      td.setAttribute('role', 'gridcell');
      tr.appendChild(td);
    }
    return tr;
  }

  // ---- grid keyboard model -------------------------------------------------

  const gridRows = (): HTMLTableRowElement[] =>
    catBody ? Array.from(catBody.rows).filter((r) => r.dataset.row) : [];

  /** A cell's focus target: its enabled control, else the cell itself. */
  function cellTarget(td: HTMLTableCellElement): HTMLElement {
    const control = td.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    return control && !control.disabled ? control : td;
  }

  /** Every cell and control is out of the tab order except the active cell's target. */
  function applyRoving(): void {
    for (const tr of gridRows()) {
      for (const td of Array.from(tr.cells)) {
        td.tabIndex = -1;
        for (const c of Array.from(td.querySelectorAll<HTMLElement>('input, select'))) {
          c.tabIndex = -1;
        }
      }
    }
    const td = activeCell();
    if (td) cellTarget(td).tabIndex = 0;
  }

  function activeCell(): HTMLTableCellElement | null {
    const tr = gridRows().find((r) => r.dataset.row === activeRow);
    return tr?.cells[Math.min(activeCol, tr.cells.length - 1)] ?? null;
  }

  function focusActiveCell(): void {
    const td = activeCell();
    if (td) cellTarget(td).focus();
  }

  function moveTo(tr: HTMLTableRowElement | undefined, col: number): void {
    if (!tr?.dataset.row) return;
    activeRow = tr.dataset.row;
    activeCol = Math.max(0, Math.min(GRID_COLS - 1, col));
    applyRoving();
    focusActiveCell();
  }

  function toggleRow(id: string, on: boolean): void {
    if (on) selected.add(id);
    else selected.delete(id);
  }

  function onTableChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const rowId = target.closest('tr')?.dataset.row;
    const row = rowId ? rowById().get(rowId) : undefined;
    if (!row) return;
    const si = target.getAttribute('data-si');
    if (si === 'row-select' && target instanceof HTMLInputElement) {
      toggleRow(row.id, target.checked);
    } else if (si === 'category') {
      const value = target.value || null;
      edit((s, remember) => setCategory(s, [row.id], value, remember), row.merchant_key);
    } else if (si === 'kind') {
      const value = target.value as SmartImportTxnKind;
      edit((s, remember) => setKind(s, [row.id], value, remember), row.merchant_key);
    }
    renderCategorizeParts();
  }

  /** Apply a category or kind change, remembered by default, and offer to un-remember it. */
  function edit(redo: (s: WizardState, remember: boolean) => WizardState, label: string): void {
    const before = st();
    state = redo(before, true);
    lastEdit = { before, redo, label, remember: true };
  }

  /** A change that is not offered "Remember" (exclude, accept, AI) ends the offer. */
  function plainEdit(next: WizardState): void {
    state = next;
    lastEdit = null;
  }

  function onTableFocus(event: FocusEvent): void {
    const td = event.target instanceof Element ? event.target.closest('td') : null;
    const id = td?.parentElement?.dataset.row;
    if (!td || !id) return;
    if (id === activeRow && td.cellIndex === activeCol) return;
    activeRow = id;
    activeCol = td.cellIndex;
    applyRoving();
  }

  /**
   * Arrow Up and Down, Home and End move between rows; Left and Right between
   * cells. The arrows are taken from a focused select too, so the grid stays
   * navigable (a select still opens with Space, Enter or Alt+Down). Space on a
   * cell without a control toggles the row's selection.
   */
  function onTableKey(event: KeyboardEvent): void {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;
    const td = t.closest('td');
    const tr = td?.parentElement;
    if (!td || !(tr instanceof HTMLTableRowElement) || !tr.dataset.row) return;
    const rows = gridRows();
    const i = rows.indexOf(tr);
    const col = td.cellIndex;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(rows[i + 1], col);
        break;
      case 'ArrowUp':
        moveTo(rows[i - 1], col);
        break;
      case 'Home':
        moveTo(rows[0], col);
        break;
      case 'End':
        moveTo(rows[rows.length - 1], col);
        break;
      case 'ArrowLeft':
        moveTo(tr, col - 1);
        break;
      case 'ArrowRight':
        moveTo(tr, col + 1);
        break;
      case ' ':
      case 'Spacebar': {
        if (t !== td) return; // a checkbox or select handles its own Space
        const id = tr.dataset.row;
        toggleRow(id, !selected.has(id));
        renderCategorizeParts();
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  function renderCatBulk(): void {
    if (!catBulk) return;
    catBulk.textContent = '';
    if (lastEdit) {
      const last = lastEdit;
      const label = el('label', 'smart-import-remember');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = last.remember;
      box.setAttribute('data-si', 'remember');
      box.addEventListener('change', () => {
        state = last.redo(last.before, box.checked);
        last.remember = box.checked;
        renderCategorizeParts();
      });
      label.append(box, el('span', undefined, `Remember for all ${last.label}`));
      catBulk.appendChild(label);
    }

    const rows = rowById();
    const ids = [...selected].filter((id) => rows.has(id));
    const none = ids.length === 0;
    catBulk.classList.toggle('is-empty', none);
    const controls = el('div', 'smart-import-bulk-controls');
    controls.appendChild(
      el(
        'span',
        'smart-import-bulk-count',
        none
          ? 'Select rows to change them together'
          : `${ids.length.toLocaleString('en-US')} selected`
      )
    );

    const bulkCat = select(
      [{ value: '', label: 'Set category' }, ...categoryOptions().slice(1)],
      '',
      {
        'data-si': 'bulk-category',
        'aria-label': 'Set the category of the selected rows',
      }
    );
    bulkCat.disabled = none;
    bulkCat.addEventListener('change', () => {
      if (!bulkCat.value) return;
      const value = bulkCat.value;
      const merchants = new Set(ids.map((id) => rows.get(id)!.merchant_key));
      edit(
        (s, remember) => setCategory(s, ids, value, remember),
        merchants.size === 1 ? [...merchants][0]! : `${merchants.size} merchants`
      );
      renderCategorizeParts();
    });

    const bulkKind = select([{ value: '', label: 'Set kind' }, ...TXN_KIND_CHOICES], '', {
      'data-si': 'bulk-kind',
      'aria-label': 'Set the kind of the selected rows',
    });
    bulkKind.disabled = none;
    bulkKind.addEventListener('change', () => {
      if (!bulkKind.value) return;
      const value = bulkKind.value as SmartImportTxnKind;
      const merchants = new Set(ids.map((id) => rows.get(id)!.merchant_key));
      edit(
        (s, remember) => setKind(s, ids, value, remember),
        merchants.size === 1 ? [...merchants][0]! : `${merchants.size} merchants`
      );
      renderCategorizeParts();
    });

    const allExcluded = !none && ids.every((id) => rows.get(id)!.excluded);
    const exclude = button(
      allExcluded ? 'Include' : 'Exclude',
      'btn btn-secondary btn-sm',
      'bulk-exclude'
    );
    exclude.disabled = none;
    exclude.addEventListener('click', () => {
      plainEdit(setExcluded(st(), ids, !allExcluded));
      renderCategorizeParts();
    });

    const clear = button('Clear', 'btn btn-secondary btn-sm', 'bulk-clear');
    clear.disabled = none;
    clear.addEventListener('click', () => {
      selected.clear();
      renderCategorizeParts();
    });

    const pending = st().rows.some((r) => r.category_source === 'ai' && !r.reviewed);
    const accept = button('Accept all suggestions', 'btn btn-secondary btn-sm', 'bulk-accept');
    accept.disabled = !pending;
    accept.addEventListener('click', () => {
      plainEdit(acceptAllSuggestions(st()));
      renderCategorizeParts();
    });

    controls.append(bulkCat, bulkKind, exclude, clear, accept);
    catBulk.appendChild(controls);
  }

  // ---- AI suggestions ------------------------------------------------------

  /** Server mode asks once; the answer is the profile's `ai_enabled` from ai-status. */
  const needsConsent = (): boolean => !isHosted() && !ai.ai_enabled;

  function renderCatAi(): void {
    if (!catAi) return;
    catAi.textContent = '';
    if (!ai.ai_available) {
      // Hosted: the operator decides; there is nothing the person can turn on.
      if (!isHosted()) {
        catAi.appendChild(
          el(
            'p',
            'smart-import-hint',
            'AI suggestions are off. An AI provider can be set up in Settings; until then, use the bulk tools below.'
          )
        );
      }
      return;
    }
    const { request, chunks } = buildCategorizeRequest(st(), st().categories);
    const row = el('div', 'smart-import-actions');
    const suggest = button(
      aiBusy ? 'Asking for suggestions...' : 'Suggest with AI',
      'btn btn-secondary btn-sm',
      'ai-suggest'
    );
    suggest.disabled = aiBusy || chunks.length === 0;
    suggest.setAttribute('aria-expanded', String(aiOpen));
    suggest.addEventListener('click', () => {
      aiOpen = !aiOpen;
      aiNote = null;
      renderCategorizeParts();
    });
    row.appendChild(suggest);
    if (chunks.length === 0) {
      row.appendChild(
        el(
          'span',
          'smart-import-note-inline',
          request.items.length === 0
            ? 'Every merchant that could be sent already has a category.'
            : 'Add a budget category first.'
        )
      );
    }
    catAi.appendChild(row);

    if (aiNote) {
      const note = el('p', aiNote.error ? 'smart-import-error' : 'smart-import-hint', aiNote.text);
      note.setAttribute('role', aiNote.error ? 'alert' : 'status');
      catAi.appendChild(note);
    }
    if (!aiOpen || chunks.length === 0) return;

    const panel = whatGetsSentPanel(
      request,
      ai.provider ?? 'the AI provider',
      ai.model ?? 'default',
      chunks.length
    );
    const actions = el('div', 'smart-import-actions');
    const merchants = countText(request.items.length, 'merchant');
    if (needsConsent()) {
      panel.appendChild(el('h4', 'smart-import-subtitle', 'Turn on AI suggestions?'));
      panel.appendChild(
        el(
          'p',
          'smart-import-hint',
          `Each time you ask, the lines above are sent to ${ai.provider ?? 'the AI provider'}. This can be turned off again in Settings.`
        )
      );
      const agree = button(`Turn on and send ${merchants}`, 'btn btn-primary btn-sm', 'ai-consent');
      agree.disabled = aiBusy;
      agree.addEventListener('click', () => void suggestWithAi(true));
      const no = button('Not now', 'btn btn-secondary btn-sm', 'ai-cancel');
      no.addEventListener('click', closeAiPanel);
      actions.append(agree, no);
    } else {
      const send = button(`Send ${merchants}`, 'btn btn-primary btn-sm', 'ai-send');
      send.disabled = aiBusy;
      send.addEventListener('click', () => void suggestWithAi(false));
      const cancel = button('Cancel', 'btn btn-secondary btn-sm', 'ai-cancel');
      cancel.addEventListener('click', closeAiPanel);
      actions.append(send, cancel);
    }
    panel.appendChild(actions);
    catAi.appendChild(panel);
  }

  function closeAiPanel(): void {
    aiOpen = false;
    renderCategorizeParts();
    body.querySelector<HTMLElement>('[data-si="ai-suggest"]')?.focus();
  }

  /**
   * Save consent first when asked (and send nothing if that fails), then post
   * every chunk. Suggestions are applied only when all chunks answered, so a
   * failure leaves every row as it was.
   */
  async function suggestWithAi(consent: boolean): Promise<void> {
    if (aiBusy || !state) return;
    aiBusy = true;
    aiNote = null;
    renderCategorizeParts();
    try {
      if (consent) {
        try {
          await apiCall('/api/smart-import/settings', {
            method: 'PUT',
            body: { ai_enabled: true },
          });
          ai = { ...ai, ai_enabled: true };
        } catch (error) {
          console.error('AI consent save failed:', error instanceof Error ? error.name : 'error');
          aiNote = { text: 'The setting could not be saved, so nothing was sent.', error: true };
          return;
        }
      }
      const { chunks } = buildCategorizeRequest(st(), st().categories);
      const suggestions: CategorizeResponse['suggestions'] = [];
      let provider = ai.provider ?? '';
      let model = ai.model ?? '';
      for (const chunk of chunks) {
        const answer = await apiCall<CategorizeResponse>('/api/smart-import/categorize', {
          method: 'POST',
          body: chunk,
          timeout: AI_TIMEOUT_MS,
        });
        suggestions.push(...(Array.isArray(answer.suggestions) ? answer.suggestions : []));
        provider = answer.provider;
        model = answer.model;
      }
      const sent = chunks.reduce((n, c) => n + c.items.length, 0);
      const before = new Set(
        st()
          .rows.filter((r) => r.category_source === 'ai')
          .map((r) => r.merchant_key)
      );
      plainEdit(applyCategorizeResponse(st(), { suggestions, provider, model }));
      const got = new Set(
        st()
          .rows.filter((r) => r.category_source === 'ai' && !before.has(r.merchant_key))
          .map((r) => r.merchant_key)
      ).size;
      aiOpen = false;
      aiNote = {
        text: `Suggestions came back for ${got.toLocaleString('en-US')} of ${countText(sent, 'merchant')}. Rows below 80% confidence stay in Needs review.`,
        error: false,
      };
      setFilter(filter);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const type = error instanceof ApiError ? errorTypeOf(error.data) : undefined;
      console.error('AI suggestions failed:', error instanceof Error ? error.name : 'error');
      if (!isHosted() && (status === 403 || type === 'ai_not_enabled')) {
        // Consent was withdrawn elsewhere: ask again next time.
        ai = { ...ai, ai_enabled: false };
      }
      aiNote = { text: categorizeErrorText(status, type), error: true };
    } finally {
      aiBusy = false;
      if (step === 3 && modal?.isConnected) renderCategorizeParts();
    }
  }

  // ---- step 4: recurring bills -------------------------------------------

  /** The rows the current candidates were detected from; new rows ask again. */
  let recurringFor: WizardState['rows'] | null = null;
  let recurringStatus: 'idle' | 'loading' | 'ok' | 'failed' = 'idle';
  let recHost: HTMLElement | null = null;

  /** Why a ticked candidate cannot be saved yet, or null. */
  function recurringProblem(c: RecurringChoice): string | null {
    if (!c.checked) return null;
    if (!c.name.trim()) return 'Add a name to keep this bill.';
    if (!(c.amount > 0)) return 'Enter an amount above zero.';
    if (c.category_id === null) return 'Pick a category to add this bill.';
    return null;
  }

  function canLeaveRecurring(): boolean {
    return recurringStatus !== 'loading' && st().recurring.every((c) => !recurringProblem(c));
  }

  /** One expenses read and one recurring call; edits survive a repeat ask by merchant. */
  async function loadRecurring(): Promise<void> {
    const rows = st().rows;
    recurringStatus = 'loading';
    renderFooter();
    try {
      const list = await apiCall<Expense[]>('/api/budget/expenses');
      const expenses = (Array.isArray(list) ? list : [])
        .filter((e) => e.is_active !== false)
        .map((e) => ({
          id: e.id,
          name: e.name,
          amount: e.amount,
          frequency: e.frequency,
          category_id: e.category_id ?? null,
          is_active: true,
        }));
      const res = await apiCall<{ candidates?: RecurringCandidateSuggestion[] }>(
        '/api/v2/smart-import/recurring',
        {
          method: 'POST',
          body: recurringRequest(st(), { expenses, categories: st().categories }),
        }
      );
      const before = new Map(st().recurring.map((c) => [c.merchant_key, c]));
      state = setRecurring(st(), Array.isArray(res?.candidates) ? res.candidates : []);
      for (const c of st().recurring) {
        const old = before.get(c.merchant_key);
        if (!old) continue;
        const { name, amount, frequency, category_id, checked } = old;
        state = updateRecurring(st(), c.merchant_key, {
          name,
          amount,
          frequency,
          category_id,
          checked,
        });
      }
      recurringFor = rows;
      recurringStatus = 'ok';
    } catch (error) {
      console.error('Recurring check failed:', error instanceof Error ? error.name : 'error');
      state = setRecurring(st(), []);
      recurringFor = null;
      recurringStatus = 'failed';
    }
  }

  async function renderRecurring(): Promise<void> {
    const h = setStep(4, 'Recurring bills');
    body.appendChild(
      el(
        'p',
        'smart-import-lead',
        'These look like regular bills. Ticked ones go into your budget as expenses; unticked ones are left out.'
      )
    );
    recHost = el('div', 'smart-import-cards');
    body.appendChild(recHost);
    h.focus();
    if (recurringFor !== st().rows || recurringStatus === 'failed') {
      recHost.appendChild(el('p', 'smart-import-lead', 'Looking for recurring bills...'));
      await loadRecurring();
      if (step !== 4 || !modal?.isConnected) return;
    }
    renderRecurringCards();
    renderFooter();
  }

  function renderRecurringCards(): void {
    if (!recHost) return;
    recHost.textContent = '';
    if (recurringStatus === 'failed') {
      const p = el(
        'p',
        'smart-import-error',
        'Recurring bills could not be checked. You can go on without them, or go Back and try again.'
      );
      p.setAttribute('data-si', 'rec-failed');
      recHost.appendChild(p);
      return;
    }
    if (st().recurring.length === 0) {
      const p = el('p', 'smart-import-lead', 'No recurring bills found in these statements.');
      p.setAttribute('data-si', 'rec-empty');
      recHost.appendChild(p);
      return;
    }
    for (const c of st().recurring) recHost.appendChild(recurringCard(c));
  }

  function recurringCard(c: RecurringChoice): HTMLElement {
    const card = el('div', 'smart-import-card smart-import-rec');
    card.setAttribute('data-candidate', c.merchant_key);
    const key = c.merchant_key;

    const tick = el('label', 'smart-import-rec-tick');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = c.checked;
    box.setAttribute('data-si', 'rec-check');
    tick.append(
      box,
      el(
        'span',
        undefined,
        c.matched_expense_id ? 'Link to the expense already in your budget' : 'Add to budget'
      )
    );
    const seenText = `Seen ${countText(c.occurrences, 'time')}, last on ${formatDate(c.last_date)}`;
    card.append(tick, el('p', 'smart-import-hint', seenText));

    if (c.already_budgeted) {
      const note = el(
        'p',
        'smart-import-note',
        c.matched_expense_id
          ? 'Already in your budget, so it starts unticked. Tick it to link this bill to that expense instead of adding a new one.'
          : 'Looks like it is already in your budget, so it starts unticked.'
      );
      note.setAttribute('data-si', 'rec-note');
      card.appendChild(note);
    }

    const name = el('input');
    name.type = 'text';
    name.maxLength = 120;
    name.value = c.name;
    name.setAttribute('data-si', 'rec-name');
    const amount = el('input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = '0.01';
    amount.inputMode = 'decimal';
    amount.value = String(c.amount);
    amount.setAttribute('data-si', 'rec-amount');
    const frequency = select(FREQUENCY_CHOICES, c.frequency, { 'data-si': 'rec-frequency' });
    const category = select(
      [{ value: '', label: 'Choose a category' }, ...categoryOptions()],
      c.category_id ?? '',
      { 'data-si': 'rec-category' }
    );
    const grid = el('div', 'smart-import-rec-grid');
    grid.append(
      field('Name', name),
      field('Amount', amount),
      field('How often', frequency),
      field('Category', category)
    );
    card.appendChild(grid);

    const update = (patch: Parameters<typeof updateRecurring>[2]): void => {
      state = updateRecurring(st(), key, patch);
      refreshRecurringCard(card, key);
      renderFooter();
    };
    box.addEventListener('change', () => update({ checked: box.checked }));
    name.addEventListener('input', () => update({ name: name.value }));
    amount.addEventListener('input', () => {
      const n = Number(amount.value);
      update({ amount: amount.value.trim() && Number.isFinite(n) ? n : 0 });
    });
    frequency.addEventListener('change', () =>
      update({ frequency: frequency.value as SmartImportFrequency })
    );
    category.addEventListener('change', () => update({ category_id: category.value || null }));
    refreshRecurringCard(card, key);
    return card;
  }

  /** Update one card in place (no rebuild, so typing keeps focus and caret). */
  function refreshRecurringCard(card: HTMLElement, key: string): void {
    const c = st().recurring.find((x) => x.merchant_key === key);
    if (!c) return;
    card.classList.toggle('is-off', !c.checked);
    card.querySelector('[data-si="rec-error"]')?.remove();
    const problem = recurringProblem(c);
    if (!problem) return;
    const p = el('p', 'smart-import-error', problem);
    p.setAttribute('data-si', 'rec-error');
    p.setAttribute('role', 'status');
    card.appendChild(p);
  }

  // ---- step 5: review and apply ----------------------------------------

  let applying = false;
  let applyResult: ApplyResponse | null = null;
  let applyError: string | null = null;
  let settingsWarning = false;
  let reviewError: HTMLElement | null = null;

  /** True when the batch has at least one statement to save (a too-large batch counts). */
  function hasSomethingToApply(): boolean {
    try {
      return buildApplyRequest(st()).statements.length > 0;
    } catch {
      return true;
    }
  }

  const liabilityById = (id: string): LiabilityResponse | undefined =>
    liabilities?.find((l) => l.id === id);

  /** The debt line on Review: balance now, balance after Apply, and why when they match. */
  function debtAfter(debt: ReviewCounts['debts'][number]): {
    before: number | null;
    after: number | null;
    note: string;
  } {
    const l = liabilityById(debt.liability_id);
    const before = l ? l.current_balance : null;
    const when = formatDate(debt.as_of);
    if (debt.closing_balance < 0) {
      return { before, after: before, note: 'A credit balance is not recorded on a debt.' };
    }
    if (debt.as_of > today()) {
      return {
        before,
        after: before,
        note: `The statement date ${when} is in the future, so this balance is not recorded.`,
      };
    }
    if (l?.balance_as_of && debt.as_of < l.balance_as_of) {
      return {
        before,
        after: before,
        note: `This statement (${when}) is older than the current balance, so it goes into the history and the current balance stays.`,
      };
    }
    if (l?.balance_as_of && debt.as_of === l.balance_as_of) {
      return {
        before,
        after: before,
        note: `A balance for ${when} is already recorded and is kept.`,
      };
    }
    return { before, after: debt.closing_balance, note: `Statement balance on ${when}.` };
  }

  async function renderReview(): Promise<void> {
    const h = setStep(5, 'Review and apply');
    body.appendChild(
      el('p', 'smart-import-lead', 'Check what will be saved. Nothing is written until Apply.')
    );
    const counts = reviewCounts(st());
    if (counts.debts.length) {
      liabilitiesLoad = null;
      await loadLiabilities();
      if (step !== 5 || !modal?.isConnected) return;
    }

    const facts = el('dl', 'smart-import-facts smart-import-review');
    facts.setAttribute('data-si', 'review');
    const fact = (label: string, key: keyof ReviewCounts, value: number): void => {
      const dd = el('dd', undefined, String(value));
      dd.setAttribute('data-count', key);
      facts.append(el('dt', undefined, label), dd);
    };
    fact('New transactions to save', 'new', counts.new);
    fact('Duplicates skipped', 'duplicates', counts.duplicates);
    fact('Excluded by you', 'excluded', counts.excluded);
    fact('Saved without a final category', 'needs_review', counts.needs_review);
    fact('Merchants to remember', 'merchants_to_remember', counts.merchants_to_remember);
    fact('Bills to add to the budget', 'expenses_to_add', counts.expenses_to_add);
    fact('Bills to link to existing expenses', 'expenses_to_link', counts.expenses_to_link);
    if (counts.files_skipped) fact('Statements left out', 'files_skipped', counts.files_skipped);
    body.appendChild(facts);
    if (counts.needs_review) {
      body.appendChild(
        el(
          'p',
          'smart-import-hint',
          'Rows still waiting for review are saved as they are; their category can be changed later.'
        )
      );
    }

    if (counts.debts.length) {
      body.appendChild(el('h4', 'smart-import-subtitle', 'Debt balances'));
      const list = el('div', 'smart-import-debts');
      for (const d of counts.debts) {
        const row = el('div', 'smart-import-debt-line');
        row.setAttribute('data-debt', d.liability_id);
        const { before, after, note } = debtAfter(d);
        const name = liabilityById(d.liability_id)?.name ?? d.label;
        const money = (n: number | null): string => (n === null ? 'Not known' : formatCurrency(n));
        const dl = el('dl', 'smart-import-facts');
        const b = el('dd', undefined, money(before));
        b.setAttribute('data-si', 'debt-before');
        const a = el('dd', undefined, money(after));
        a.setAttribute('data-si', 'debt-after');
        dl.append(el('dt', undefined, 'Now'), b, el('dt', undefined, 'After import'), a);
        row.append(
          el('p', 'smart-import-card-title', name),
          dl,
          el('p', 'smart-import-hint', note)
        );
        list.appendChild(row);
      }
      body.appendChild(list);
    }

    if (!hasSomethingToApply()) {
      body.appendChild(
        el(
          'p',
          'smart-import-note',
          'Every statement here was already imported or left out, so there is nothing new to save.'
        )
      );
    }
    reviewError = el('p', 'smart-import-error');
    reviewError.setAttribute('data-si', 'apply-error');
    reviewError.setAttribute('role', 'alert');
    reviewError.hidden = !applyError;
    reviewError.textContent = applyError ?? '';
    body.appendChild(reviewError);
    renderFooter();
    h.focus();
  }

  function showApplyError(text: string): void {
    applyError = text;
    if (reviewError) {
      reviewError.textContent = text;
      reviewError.hidden = false;
    }
  }

  async function applyNow(): Promise<void> {
    if (applying || applyResult || step !== 5) return;
    let request: ApplyRequest;
    try {
      request = buildApplyRequest(st());
    } catch (error) {
      if (error instanceof ApplyTooLargeError) {
        showApplyError(tooLargeText(error));
        return;
      }
      throw error;
    }
    applying = true;
    applyError = null;
    if (reviewError) reviewError.hidden = true;
    renderFooter();
    let result: ApplyResponse;
    try {
      result = await apiCall<ApplyResponse>('/api/smart-import/apply', {
        method: 'POST',
        body: request,
        timeout: APPLY_TIMEOUT_MS,
      });
    } catch (error) {
      console.error('Import apply failed:', error instanceof Error ? error.name : 'error');
      applying = false;
      showApplyError(applyErrorText(error));
      renderFooter();
      return;
    }
    applyResult = result;
    try {
      await apiCall<SmartImportSettings>('/api/smart-import/settings', {
        method: 'PUT',
        body: buildSettingsPatch(st(), ctx?.settings ?? { csv_layouts: {}, accounts: {} }),
      });
    } catch (error) {
      console.error('Import settings save failed:', error instanceof Error ? error.name : 'error');
      settingsWarning = true;
    }
    applying = false;
    refreshViews();
    if (modal?.isConnected) renderDone();
  }

  // ---- done and undo -----------------------------------------------------

  /**
   * Debts and the dashboard listen for liabilities:changed. The Budget page has
   * no event; it reloads on tab change, so reload it here only while it shows
   * (the pattern features/bank-statements.ts uses).
   */
  function refreshViews(): void {
    emit({ type: 'liabilities:changed', reason: 'balance' });
    if (getCurrentTab() === 'budget') void loadBudgetTab();
  }

  const undoneIds = new Set<string>();
  const undoTotals = { transactions: 0, expenses: 0, snapshots: 0, reassigned: 0 };
  const undoKept: SmartImportUndoResponse['kept'] = [];
  let undoing = false;
  let undoFailed = 0;

  const pendingUndo = (): string[] =>
    (applyResult?.imports ?? []).map((i) => i.import_id).filter((id) => !undoneIds.has(id));

  const statementFor = (fileHash: string): WizardStatement | undefined =>
    st().statements.find((s) => s.file_hash === fileHash);

  function balanceLine(imp: ApplyResponse['imports'][number]): string | null {
    const s = statementFor(imp.file_hash);
    if (!s?.liability_id || !s.closing_balance) return null;
    const name = liabilityById(s.liability_id)?.name ?? 'the debt';
    const when = formatDate(s.closing_balance.as_of);
    switch (imp.balance) {
      case 'recorded':
        return `Balance of ${formatCurrency(s.closing_balance.amount)} on ${when} recorded for ${name}.`;
      case 'skipped_existing':
        return `A balance for ${when} was already recorded for ${name}, so this one was not added.`;
      case 'skipped_future':
        return `The statement date ${when} is in the future, so the balance for ${name} was not recorded.`;
      default:
        return `A credit balance cannot be recorded on ${name}, so none was added.`;
    }
  }

  function renderDone(focusResult = false): void {
    const result = applyResult!;
    const allUndone = pendingUndo().length === 0;
    const h = setStep(6, allUndone ? 'Import undone' : 'Import saved');
    const sum = (k: 'txn_new' | 'txn_duplicate' | 'txn_excluded'): number =>
      result.imports.reduce((n, i) => n + i[k], 0);

    const summary = el('ul', 'smart-import-summary');
    summary.setAttribute('data-si', 'done-summary');
    const line = (text: string): void => {
      summary.appendChild(el('li', undefined, text));
    };
    line(`${countText(sum('txn_new'), 'transaction')} saved`);
    if (sum('txn_duplicate')) line(`${countText(sum('txn_duplicate'), 'duplicate')} skipped`);
    if (sum('txn_excluded')) line(`${countText(sum('txn_excluded'), 'excluded row')} not stored`);
    if (result.rules_saved) line(`${countText(result.rules_saved, 'merchant')} remembered`);
    if (result.expenses_created)
      line(`${countText(result.expenses_created, 'bill')} added to the budget`);
    if (result.expenses_linked)
      line(`${countText(result.expenses_linked, 'bill')} linked to existing expenses`);
    if (result.pruned)
      line(`${countText(result.pruned, 'older transaction')} removed under the keep-for setting`);
    for (const hash of result.skipped_files) {
      const name = statementFor(hash)?.file_name || 'A file';
      line(`${name}: already imported, so it was skipped`);
    }
    for (const imp of result.imports) {
      const text = balanceLine(imp);
      if (text) line(text);
    }
    // Once everything is undone the saved summary no longer holds; the undo result replaces it.
    if (!allUndone) body.appendChild(summary);

    if (settingsWarning && !allUndone) {
      const warn = el(
        'p',
        'smart-import-note',
        'The import is saved, but account names and column layouts could not be remembered for next time.'
      );
      warn.setAttribute('data-si', 'settings-warning');
      body.appendChild(warn);
    }

    const actions = el('div', 'smart-import-actions');
    const planned = button('See planned vs actual', 'btn btn-secondary', 'planned');
    planned.addEventListener('click', () => {
      finish();
      showTab('budget');
      showBudgetTab('expenses');
    });
    actions.appendChild(planned);
    if (!allUndone) {
      const undo = button('Undo this import', 'btn btn-secondary', 'undo');
      undo.disabled = undoing;
      undo.addEventListener('click', showUndoConfirm);
      actions.appendChild(undo);
    }
    body.appendChild(actions);

    let target: HTMLElement = h;
    if (undoFailed) {
      const total = (applyResult?.imports ?? []).length;
      const err = el(
        'p',
        'smart-import-error',
        `Undid ${total - pendingUndo().length} of ${total} statements. The rest could not be undone; try again.`
      );
      err.setAttribute('data-si', 'undo-error');
      err.setAttribute('role', 'alert');
      body.appendChild(err);
    }
    if (undoneIds.size) {
      const box = el('div', 'smart-import-card smart-import-undo-result');
      box.setAttribute('data-si', 'undo-result');
      box.tabIndex = -1;
      box.appendChild(el('p', undefined, removedText()));
      for (const text of keptLines(undoKept)) box.appendChild(el('p', undefined, text));
      if (undoTotals.reassigned) {
        box.appendChild(
          el(
            'p',
            undefined,
            `${countText(undoTotals.reassigned, 'transaction')} also in another import now belong to that import.`
          )
        );
      }
      box.appendChild(el('p', 'smart-import-hint', 'Remembered merchants stay.'));
      body.appendChild(box);
      if (focusResult) target = box;
    }
    renderFooter();
    target.focus();
  }

  function removedText(): string {
    const parts = [countText(undoTotals.transactions, 'transaction')];
    if (undoTotals.expenses) parts.push(countText(undoTotals.expenses, 'expense'));
    if (undoTotals.snapshots) parts.push(countText(undoTotals.snapshots, 'debt balance'));
    return `Removed ${joinParts(parts)}.`;
  }

  function undoConfirmText(): string {
    const pending = new Set(pendingUndo());
    const imports = (applyResult?.imports ?? []).filter((i) => pending.has(i.import_id));
    const parts = [
      countText(
        imports.reduce((n, i) => n + i.txn_new, 0),
        'transaction'
      ),
    ];
    if (!undoneIds.size && applyResult?.expenses_created) {
      parts.push(`${countText(applyResult.expenses_created, 'expense')} it added`);
    }
    const balances = imports.filter((i) => i.balance === 'recorded').length;
    if (balances) parts.push(countText(balances, 'debt balance'));
    return `Undo this import? Removes ${joinParts(parts)}. Remembered merchants stay.`;
  }

  function showUndoConfirm(): void {
    if (undoing || !pendingUndo().length) return;
    confirming = true;
    footer.textContent = '';
    footer.classList.add('smart-import-confirm');
    const text = el('p', 'smart-import-confirm-text', undoConfirmText());
    text.setAttribute('role', 'alert');
    const keep = button('Keep it', 'btn btn-secondary', 'undo-cancel');
    const go = button('Undo import', 'btn btn-danger', 'undo-confirm');
    keep.addEventListener('click', () => {
      confirming = false;
      footer.classList.remove('smart-import-confirm');
      renderFooter();
      body.querySelector<HTMLElement>('[data-si="undo"]')?.focus();
    });
    go.addEventListener('click', () => void runUndo(keep, go));
    footer.append(text, keep, go);
    keep.focus();
  }

  async function runUndo(keep: HTMLButtonElement, go: HTMLButtonElement): Promise<void> {
    if (undoing) return;
    undoing = true;
    keep.disabled = true;
    go.disabled = true;
    go.textContent = 'Undoing...';
    let changed = false;
    undoFailed = 0;
    for (const id of pendingUndo()) {
      try {
        const r = await apiCall<SmartImportUndoResponse>(
          `/api/smart-import/imports/${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        );
        undoTotals.transactions += r.deleted?.transactions ?? 0;
        undoTotals.expenses += r.deleted?.expenses ?? 0;
        undoTotals.snapshots += r.deleted?.snapshots ?? 0;
        undoTotals.reassigned += r.reassigned?.transactions ?? 0;
        undoKept.push(...(r.kept ?? []));
        undoneIds.add(id);
        changed = true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          undoneIds.add(id); // already gone (undone from the history list)
          continue;
        }
        console.error('Import undo failed:', error instanceof Error ? error.name : 'error');
        undoFailed += 1;
        break;
      }
    }
    undoing = false;
    confirming = false;
    footer.classList.remove('smart-import-confirm');
    if (changed) {
      refreshViews();
    }
    if (modal?.isConnected) renderDone(true);
  }

  // ---- open ----------------------------------------------------------------

  mount();
  renderUpload();
  void ready.then(() => {
    if (closed || !modal?.isConnected) return;
    if (step === 1) renderUpload();
    if (options.files?.length) void addFiles(options.files);
  });

  return {
    get modal(): HTMLElement | null {
      return modal;
    },
    close: finish,
    getState: (): WizardState => st(),
  };
}
