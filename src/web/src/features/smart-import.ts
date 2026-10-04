/**
 * Smart import wizard: Upload (1), Accounts (2), then Categorize, Recurring
 * bills and Review (added by later tasks). Nothing is written to the data layer
 * here; the only POST besides the analyze uploads is the read-only preview.
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
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import {
  ACCEPT,
  KIND_CHOICES,
  KIND_LABEL,
  MAPPING_FIELDS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_LABEL_CHARS,
  PRIVACY_LINE,
  STEP_LABELS,
  WARNING_COPY,
  analyzeErrorText,
  analyzeErrorType,
  balanceText,
  button,
  countText,
  el,
  extractErrorText,
  field,
  guessMapping,
  isDebtKind,
  mappingComplete,
  periodText,
  select,
} from '@/utils/smart-import-render';
import {
  addFile,
  applyPreview,
  buildAnalyzeContext,
  buildPreviewRequest,
  accountKey,
  createWizardState,
  layoutFor,
  markFileError,
  mergeAnalyze,
  setAiProvider,
  setFileMapping,
  setFileOptions,
  setStatement,
  type WizardFile,
  type WizardState,
  type WizardStatement,
} from '@/utils/smart-import-state';
import type {
  AnalyzeResponse,
  LiabilityResponse,
  PreviewResponse,
  SmartImportAccountKind,
  SmartImportAiStatus,
  SmartImportContext,
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

const ALLOWED_EXT = /\.(csv|ofx|qfx|pdf)$/i;

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
      const detail = error instanceof ApiError ? error.message : '';
      console.error('Analyze failed:', error instanceof Error ? error.name : 'error');
      state = markFileError(st(), fileId, analyzeErrorType(status, detail));
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
        new File([sampleCsv], 'sample-checking.csv', { type: 'text/csv' }),
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
    if (isDirty()) showConfirm();
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
    const short = el('p', 'smart-import-progress-short', `${step} of ${STEP_LABELS.length}`);
    const name = el('span', 'smart-import-step-name', STEP_LABELS[step - 1]);
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
    const left = button(
      step === 1 ? 'Cancel' : 'Back',
      'btn btn-secondary',
      step === 1 ? 'cancel' : 'back'
    );
    const right = button('Next', 'btn btn-primary', 'next');
    right.disabled = step === 1 ? !canLeaveUpload() : step === 2 ? !canLeaveAccounts() : true;
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
    if (step === 1) renderFileList();
    if (step === 2) renderAccountCards();
    renderFooter();
  }

  async function goTo(n: number): Promise<void> {
    if (n === 1) renderUpload();
    else if (n === 2) await renderAccounts();
    else renderComingNext(n);
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
      renderComingNext(3);
    }
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
  }

  function pendingCard(f: WizardFile): HTMLElement {
    const card = el('section', 'smart-import-card is-pending');
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
    card.appendChild(el('h4', 'smart-import-card-title', accountTitle(s)));

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

      if (s.warnings.includes('date_order_assumed') || f.options.date_order) {
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
          field('Date order', order, 'The dates in this file could be read either way.')
        );
      }
    }

    if (isDebtKind(s.account_kind)) {
      const host = el('div', 'smart-import-debt');
      card.appendChild(host);
      renderDebtSection(host, s.id);
    }

    const remove = button('Leave this file out', 'btn btn-secondary btn-sm', 'remove-file');
    remove.addEventListener('click', () => {
      removeFile(f.id);
      refreshUi();
    });
    card.appendChild(remove);
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
    return s.suggested_liability_id ?? '';
  }

  function debtChoices(s: WizardStatement): LiabilityResponse[] {
    const all = (liabilities ?? []).filter((l) => l.is_active !== false);
    const fits = all.filter((l) =>
      s.account_kind === 'credit_card'
        ? l.liability_type === 'credit_card'
        : l.liability_type !== 'credit_card'
    );
    const chosen = debtValue(s);
    const extra = chosen ? all.find((l) => l.id === chosen && !fits.includes(l)) : undefined;
    return extra ? [...fits, extra] : fits;
  }

  function renderDebtSection(host: HTMLElement, statementId: string): void {
    const s = st().statements.find((x) => x.id === statementId);
    if (!s) return;
    host.textContent = '';
    host.appendChild(el('h5', 'smart-import-subtitle', 'Link to a debt'));
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
    host.appendChild(field('Debt', sel));
    if (
      !debtTouched.has(s.id) &&
      s.suggested_liability_id &&
      sel.value === s.suggested_liability_id
    ) {
      host.appendChild(
        el(
          'p',
          'smart-import-hint',
          'Suggested match. Choose Skip to leave this statement unlinked.'
        )
      );
    }
    host.appendChild(
      el(
        'p',
        'smart-import-hint',
        'Linking records this statement’s balance on the debt when you apply the import.'
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
    host.appendChild(row);
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
    card.appendChild(el('h4', 'smart-import-card-title', 'Match the columns'));
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
    const remove = button('Leave this file out', 'btn btn-secondary btn-sm', 'remove-file');
    remove.addEventListener('click', () => {
      removeFile(f.id);
      refreshUi();
    });
    row.append(apply, remove);
    card.appendChild(row);
    return card;
  }

  function aiCard(f: WizardFile): HTMLElement {
    const card = el('section', 'smart-import-card smart-import-ai-card');
    card.appendChild(el('h4', 'smart-import-card-title', 'This PDF needs help'));
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
    const remove = button('Leave this file out', 'btn btn-secondary btn-sm', 'remove-file');
    remove.addEventListener('click', () => {
      removeFile(f.id);
      refreshUi();
    });
    card.appendChild(remove);
    return card;
  }

  async function sendLines(fileId: string): Promise<void> {
    const f = fileOf(fileId);
    if (!f || !ctx || sending.has(fileId)) return;
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
      sendFailed.set(fileId, extractErrorText(error instanceof ApiError ? error.status : 0));
    } finally {
      sending.delete(fileId);
    }
    if (step === 2 && modal?.isConnected) renderAccountCards();
  }

  // ---- later steps -------------------------------------------------------

  function renderComingNext(n: number): void {
    const h = setStep(n, STEP_LABELS[n - 1] ?? '');
    body.appendChild(el('p', 'smart-import-lead', 'This step opens here once it is ready.'));
    h.focus();
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
