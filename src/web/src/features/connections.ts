/**
 * Settings > Connected accounts: the connections of this profile with a status
 * chip, last sync, accounts and quota, the providers offered here, the Disconnect
 * dialog with its two variants, and the Connect dialog (provider, credential,
 * first-sync range, account mapping) that also serves Reconnect and Edit
 * accounts, and Sync now (design 9.2): the plan's windows are synced oldest
 * first, one request each, and what came back opens in the import wizard at
 * Accounts, 12 statements per turn. Nothing is written before Apply except the
 * connection's own sync record; the debt links and kinds changed in the wizard
 * are written back with PUT only after Apply succeeded.
 *
 * Credentials: the inputs are password fields with autocomplete and spellcheck
 * off. Their values are read once on submit, the fields are emptied before the
 * request goes out, and nothing keeps them: not the dialog state, not the DOM,
 * not a log line. Errors map to fixed copy and never repeat what was typed.
 *
 * Connection labels are user data: everything goes into the DOM with textContent
 * or element properties. Errors map to fixed copy (connectionErrorText); server
 * and browser error text is never shown. Lazy `feature-*` chunk, loaded by the
 * Settings page when the tab opens.
 */

import { apiCall } from '@/api/client';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { showToast } from '@/ui/toast';
import { emit } from '@/state/events';
import { store } from '@/state/store';
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import { openSmartImportLazy } from '@/utils/smart-import-launcher';
import { KIND_CHOICES } from '@/utils/smart-import-render';
import {
  accountsText,
  connectionErrorText,
  disconnectResultLines,
  isConnectionGone,
  lastSyncedText,
  offeredProviders,
  providerLabel,
  quotaText,
  removalPreview,
  revokeHint,
  statusChip,
  statusNote,
  syncGate,
} from '@/utils/connections-render';
import { noteNode, whileBusy } from '@/utils/connections-note';
import {
  accountCodeText,
  accountsErrorText,
  buildUpdateRequest,
  connectErrorText,
  createBody,
  credentialBody,
  CREDENTIAL_HELP,
  credentialFields,
  disclosureLines,
  editsFrom,
  FIRST_SYNC_CHOICES,
  fittingDebts,
  initialState,
  isMappingDirty,
  labelError,
  mappingErrors,
  MAX_LABEL_CHARS,
  PROVIDER_LINE,
  ROLE_CHOICES,
  sameAsChoices,
  setEdit,
} from '@/utils/connections-state';
import type { ConnectState, FirstSyncDays } from '@/utils/connections-state';
import {
  NOTHING_TO_SYNC,
  REST_NOT_OPENED,
  accountErrorLines,
  mappingFor,
  noNewText,
  previewRequest,
  reviewable,
  splitTurns,
  TURN_STATEMENTS,
  withMappedKinds,
  stoppedText,
  syncingText,
  withSomethingNew,
  writeBackRequest,
} from '@/utils/connections-sync';
import type { WizardState } from '@/utils/smart-import-state';
import type {
  ConnectionAccountError,
  ConnectionDetail,
  ConnectionListingResponse,
  ConnectionProvider,
  ConnectionSummary,
  ConnectorSyncResponse,
  DisconnectResponse,
  LiabilityResponse,
  NormalizedStatement,
  PreviewResponse,
  SmartImportAccountKind,
  SmartImportContext,
  SmartImportSummary,
} from '@/types/api';

const byId = (id: string): HTMLElement | null => document.getElementById(id);

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

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function setStatus(lines: readonly string[], hostId = 'connections-status'): void {
  const status = byId(hostId);
  if (!status) return;
  status.replaceChildren(...lines.map((line) => el('span', 'connections-status-line', line)));
}

// -------------------------------------------------------------------- list

function connectionRow(c: ConnectionSummary, onChanged: () => Promise<void>): HTMLElement {
  const row = el('li', 'connection-row');
  const info = el('div', 'connection-info');
  const title = el('div', 'connection-title');
  title.appendChild(el('strong', 'connection-label', c.label));
  title.appendChild(el('span', 'connection-provider', providerLabel(c.provider)));
  const chip = statusChip(c);
  title.appendChild(el('span', `connection-chip badge badge-${chip.tone}`, chip.text));
  info.appendChild(title);
  info.appendChild(
    el('p', 'connection-meta', [lastSyncedText(c), accountsText(c), quotaText(c)].join(' · '))
  );
  const note = statusNote(c);
  if (note) info.appendChild(noteNode(note));
  const actions = el('div', 'connection-actions');
  const sync = button('Sync now', 'btn btn-primary btn-sm', () => {
    void whileBusy(sync, !syncGate(c).blocked, () => syncNow(c.id, onChanged));
  });
  sync.dataset.action = 'sync';
  sync.setAttribute('aria-label', `Sync ${c.label} now`);
  sync.disabled = syncGate(c).blocked;
  actions.appendChild(sync);
  if (c.status === 'reconnect_needed') {
    const reconnect = button('Reconnect', 'btn btn-primary btn-sm', () => {
      void openConnectDialog({ reconnect: c, onChanged });
    });
    reconnect.dataset.action = 'reconnect';
    reconnect.setAttribute('aria-label', `Reconnect ${c.label}`);
    actions.appendChild(reconnect);
  }
  const edit = button('Edit accounts', 'btn btn-secondary btn-sm', () => {
    void openMappingDialog(c, onChanged);
  });
  edit.dataset.action = 'edit-accounts';
  edit.setAttribute('aria-label', `Edit accounts of ${c.label}`);
  actions.appendChild(edit);
  const disconnect = button('Disconnect', 'btn btn-secondary btn-sm', () => {
    void openDisconnectDialog(c, onChanged);
  });
  disconnect.dataset.action = 'disconnect';
  disconnect.setAttribute('aria-label', `Disconnect ${c.label}`);
  actions.appendChild(disconnect);
  row.append(info, actions);
  return row;
}

function renderProviders(enabled: readonly string[] | null): void {
  const host = byId('connections-providers');
  if (!host) return;
  host.replaceChildren(
    ...offeredProviders(enabled).map((p) => el('li', 'connections-provider', providerLabel(p)))
  );
  // The Connect button sits under the providers it offers; built here so the
  // section markup stays the same.
  let connect = host.parentElement?.querySelector<HTMLButtonElement>('[data-action="connect"]');
  if (!connect) {
    connect = button('Connect a bank', 'btn btn-primary connections-connect', () => {
      void openConnectDialog({ onChanged: loadConnectionsSettings });
    });
    connect.dataset.action = 'connect';
    host.after(connect);
  }
}

function hideConnect(): void {
  document.querySelector('#settings-connected-accounts [data-action="connect"]')?.remove();
}

/** The v2 status's enabled providers, or null when it cannot be read. */
async function loadEnabled(): Promise<string[] | null> {
  try {
    const status = await apiCall<{ enabled?: unknown }>('/api/v2/connectors/status');
    const enabled = status?.enabled;
    return Array.isArray(enabled)
      ? enabled.filter((x): x is string => typeof x === 'string')
      : null;
  } catch {
    return null;
  }
}

/** Fill the Connected accounts section. Safe to call again after any change. */
export async function loadConnectionsSettings(): Promise<void> {
  const list = byId('connections-list');
  if (!list) return;
  const providers = byId('connections-providers');
  const subheading = document.querySelector<HTMLElement>('.connections-subheading');
  const [listed, enabled] = await Promise.all([
    apiCall<ConnectionSummary[]>('/api/connections').then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    ),
    loadEnabled(),
  ]);
  if (!listed.ok) {
    // Fixed copy only; the offered providers are meaningless when the list is unavailable.
    list.replaceChildren(el('li', 'connections-empty', connectionErrorText(listed.error)));
    providers?.replaceChildren();
    subheading?.classList.add('hidden');
    hideConnect();
    return;
  }
  subheading?.classList.remove('hidden');
  const connections = listed.value ?? [];
  if (connections.length === 0) {
    list.replaceChildren(el('li', 'connections-empty', 'No connected accounts yet.'));
  } else {
    list.replaceChildren(...connections.map((c) => connectionRow(c, loadConnectionsSettings)));
  }
  renderProviders(enabled);
}

// -------------------------------------------------------------- disconnect

/** All imports, for the counts; null when they cannot be read. */
async function loadImports(): Promise<SmartImportSummary[] | null> {
  try {
    return (await apiCall<SmartImportSummary[]>('/api/smart-import/imports')) ?? [];
  } catch {
    return null;
  }
}

async function openDisconnectDialog(
  c: ConnectionSummary,
  onChanged: () => Promise<void>
): Promise<void> {
  const imports = await loadImports();
  const preview = imports ? removalPreview(imports, c.id) : null;
  const hint = revokeHint(c.provider);

  const body = el('div', 'connection-dialog');
  body.appendChild(el('p', 'connection-dialog-name', c.label));
  body.appendChild(
    el(
      'p',
      'connection-dialog-text',
      'Disconnect stops syncing and forgets the saved credentials. Imported transactions ' +
        'stay unless you remove them too.'
    )
  );
  body.appendChild(
    el(
      'p',
      'connection-dialog-preview',
      preview ? preview.text : 'Could not count the imported data.'
    )
  );
  const revoke = el('p', 'connection-dialog-revoke', hint.text);
  if (hint.href && hint.linkText) {
    const link = el('a', 'connection-dialog-link', hint.linkText);
    link.href = hint.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    revoke.append(' ', link);
  }
  body.appendChild(revoke);
  const error = el('p', 'connection-dialog-error');
  error.setAttribute('role', 'alert');
  body.appendChild(error);

  let busy = false;
  const buttons: HTMLButtonElement[] = [];
  const setBusy = (value: boolean): void => {
    busy = value;
    buttons.forEach((b) => {
      b.disabled = value;
    });
  };

  const run = async (removeData: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    error.textContent = '';
    try {
      const result = await apiCall<DisconnectResponse>(
        `/api/connections/${encodeURIComponent(c.id)}?remove_data=${removeData}`,
        { method: 'DELETE' }
      );
      busy = false;
      closeDynamicModal();
      setStatus(disconnectResultLines(result));
      // Closing gave focus back to this row's Disconnect button, which the refresh
      // removes; the result line is the next useful place.
      byId('connections-status')?.focus();
      showToast('Disconnected', 'success');
      if (removeData && result.imports_undone > 0) {
        emit({ type: 'liabilities:changed', reason: 'balance' });
      }
      await onChanged();
    } catch (e) {
      setBusy(false);
      error.textContent = connectionErrorText(e);
      if (isConnectionGone(e)) void onChanged();
    }
  };

  const actions = el('div', 'connection-dialog-actions');
  const cancel = button('Cancel', 'btn btn-secondary', () => {
    if (!busy) closeDynamicModal();
  });
  const plain = button('Disconnect', 'btn btn-primary', () => void run(false));
  buttons.push(cancel, plain);
  actions.append(cancel, plain);
  if (!preview || preview.syncs > 0) {
    const remove = button(
      'Disconnect and remove imported data',
      'btn btn-danger',
      () => void run(true)
    );
    buttons.push(remove);
    actions.appendChild(remove);
  }
  body.appendChild(actions);

  createDynamicModal({
    title: `Disconnect ${providerLabel(c.provider)}`,
    content: body,
    showFooter: false,
    canClose: () => !busy,
  });
  // A destructive choice is never the default.
  cancel.focus();
}

// ----------------------------------------------------------------- connect

export interface ConnectDialogOptions {
  /** Reconnect this connection: same id and mapping, a new credential. */
  reconnect?: ConnectionSummary;
  /** Called once the dialog closes after anything was saved. */
  onChanged?: () => Promise<void>;
}

/** The open dialog's state, for tests. It never holds a credential. */
let liveState: ConnectState | null = null;

export function connectDialogState(): ConnectState | null {
  return liveState;
}

type Detail = ConnectionDetail | ConnectionListingResponse;

/** Settle a promise into a value, or a fallback on any failure. */
function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.then(
    (v) => v ?? fallback,
    () => fallback
  );
}

function dataMode(): 'server' | 'local' {
  return store.get('dataMode') === 'local' ? 'local' : 'server';
}

function secretInput(name: string): HTMLInputElement {
  const input = el('input', 'form-input connect-secret');
  input.type = 'password';
  input.autocomplete = 'off';
  input.setAttribute('autocomplete', 'off');
  input.spellcheck = false;
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocapitalize', 'off');
  input.dataset.credential = name;
  return input;
}

let fieldCounter = 0;
function labelled(text: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'form-group connect-field');
  control.id ||= `connect-field-${++fieldCounter}`;
  const label = el('label', undefined, text);
  label.htmlFor = control.id;
  wrap.append(label, control);
  if (hint) {
    const p = el('p', 'connect-hint', hint);
    p.id = `${control.id}-hint`;
    control.setAttribute('aria-describedby', p.id);
    wrap.appendChild(p);
  }
  return wrap;
}

function choiceSelect(
  options: readonly { value: string; label: string }[],
  value: string
): HTMLSelectElement {
  const s = el('select', 'form-select');
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    s.appendChild(opt);
  }
  s.value = value;
  return s;
}

function failureText(error: unknown): string {
  return connectErrorText(error) ?? connectionErrorText(error);
}

/** Open the Connect dialog (or Reconnect, with options.reconnect). */
export async function openConnectDialog(options: ConnectDialogOptions = {}): Promise<void> {
  const offered = options.reconnect ? [] : offeredProviders(await loadEnabled());
  const flow = new ConnectFlow(options);
  if (options.reconnect) flow.startReconnect(options.reconnect);
  else flow.start(offered);
}

/** Open the mapping step for an existing connection ("Edit accounts"). */
export async function openMappingDialog(
  c: ConnectionSummary,
  onChanged?: () => Promise<void>
): Promise<void> {
  let detail: ConnectionDetail;
  try {
    detail = await apiCall<ConnectionDetail>(`/api/connections/${encodeURIComponent(c.id)}`);
  } catch (e) {
    setStatus([connectionErrorText(e)]);
    if (isConnectionGone(e)) void onChanged?.();
    return;
  }
  const flow = new ConnectFlow(onChanged ? { onChanged } : {});
  await flow.startMapping(detail);
}

class ConnectFlow {
  private state: ConnectState = initialState();
  private offered: ConnectionProvider[] = [];
  private detail: Detail | null = null;
  private accountErrors: ConnectionAccountError[] = [];
  private liabilities: LiabilityResponse[] = [];
  /** The debts list could not be loaded: stored links are kept and shown as such. */
  private debtsFailed = false;
  /** Create flow only: the server's debt suggestions are labelled as such. */
  private creating = false;
  private known: SmartImportContext['accounts'] = [];
  private busy = false;
  private changed = false;
  private confirming = false;
  private modal: HTMLElement | null = null;
  private body!: HTMLElement;
  private title = 'Connect a bank';

  constructor(private readonly options: ConnectDialogOptions) {}

  // ---- state and shell ---------------------------------------------------

  private set(next: Partial<ConnectState>): void {
    this.state = { ...this.state, ...next };
    liveState = this.state;
  }

  private mount(): void {
    this.body = el('div', 'connect-dialog');
    this.modal = createDynamicModal({
      title: this.title,
      content: this.body,
      showFooter: false,
      modalClass: 'connect-modal modal-sheet',
      canClose: () => this.canClose(),
      onClose: () => this.finished(),
    });
    liveState = this.state;
  }

  private canClose(): boolean {
    if (this.busy || this.confirming) return false;
    if (
      this.state.step === 'accounts' &&
      this.detail &&
      isMappingDirty(this.detail, this.state.edits)
    ) {
      this.showDiscard();
      return false;
    }
    return true;
  }

  private finished(): void {
    this.modal = null;
    liveState = null;
    if (this.changed) void this.options.onChanged?.();
  }

  private close(): void {
    closeDynamicModal();
    this.finished();
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.body
      .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
        'button, input, select'
      )
      .forEach((c) => {
        c.disabled = value;
      });
  }

  private step(heading: string): HTMLElement {
    this.confirming = false;
    this.body.replaceChildren();
    const h = el('h3', 'connect-heading', heading);
    h.tabIndex = -1;
    this.body.appendChild(h);
    return h;
  }

  private errorLine(): HTMLElement {
    const p = el('p', 'connect-error');
    p.setAttribute('role', 'alert');
    // Focus lands here when the control that was used is gone or disabled.
    p.tabIndex = -1;
    return p;
  }

  private actions(...buttons: HTMLButtonElement[]): HTMLElement {
    const row = el('div', 'connect-actions');
    row.append(...buttons);
    return row;
  }

  // ---- entry points ------------------------------------------------------

  start(offered: ConnectionProvider[]): void {
    this.offered = offered;
    this.creating = true;
    this.mount();
    this.renderProvider();
  }

  startReconnect(c: ConnectionSummary): void {
    this.title = `Reconnect ${c.label}`;
    this.set({ provider: c.provider, connectionId: c.id, label: c.label, step: 'credentials' });
    this.mount();
    this.renderCredentials();
  }

  async startMapping(detail: ConnectionDetail): Promise<void> {
    this.title = `Accounts of ${detail.label}`;
    this.set({ provider: detail.provider, connectionId: detail.id, label: detail.label });
    this.mount();
    await this.showAccounts(detail, null);
  }

  // ---- 1. provider -------------------------------------------------------

  private renderProvider(): void {
    this.set({ step: 'provider' });
    const h = this.step('Choose where to connect');
    const list = el('div', 'connect-providers');
    for (const p of this.offered) {
      const choice = el('button', 'connect-provider');
      choice.type = 'button';
      choice.dataset.provider = p;
      choice.append(
        el('strong', 'connect-provider-name', providerLabel(p)),
        el('span', 'connect-provider-line', PROVIDER_LINE[p])
      );
      choice.addEventListener('click', () => {
        this.set({ provider: p, step: 'credentials' });
        this.renderCredentials();
      });
      list.appendChild(choice);
    }
    this.body.appendChild(list);
    this.body.appendChild(
      el(
        'p',
        'connect-hint',
        'Every sync opens the import review first, so nothing is added until you apply it.'
      )
    );
    h.focus();
  }

  // ---- 2. credential and first-sync range ---------------------------------

  private renderCredentials(): void {
    const provider = this.state.provider!;
    const reconnect = this.state.connectionId !== null;
    this.set({ step: 'credentials' });
    const h = this.step(reconnect ? 'Enter new credentials' : providerLabel(provider));
    const form = el('form', 'connect-form');
    form.noValidate = true;
    form.appendChild(el('p', 'connect-help', CREDENTIAL_HELP[provider]));

    const inputs = credentialFields(provider).map((f) => {
      const input = secretInput(f.name);
      form.appendChild(labelled(f.label, input));
      return input;
    });

    let labelInput: HTMLInputElement | null = null;
    if (!reconnect) {
      labelInput = el('input', 'form-input');
      labelInput.type = 'text';
      labelInput.maxLength = MAX_LABEL_CHARS;
      labelInput.dataset.field = 'label';
      labelInput.placeholder = providerLabel(provider);
      labelInput.value = this.state.label;
      labelInput.addEventListener('input', () => this.set({ label: labelInput!.value }));
      form.appendChild(labelled('Name (optional)', labelInput));

      const range = choiceSelect(
        FIRST_SYNC_CHOICES.map((c) => ({ value: String(c.value), label: c.label })),
        String(this.state.firstSyncDays)
      );
      range.dataset.field = 'first-sync';
      range.addEventListener('change', () => {
        this.set({ firstSyncDays: Number(range.value) as FirstSyncDays });
      });
      form.appendChild(
        labelled(
          'First sync',
          range,
          'How far back the first sync reaches. Later syncs pick up where the last one ended.'
        )
      );
    }

    const disclosure = el('details', 'connect-disclosure');
    disclosure.appendChild(el('summary', undefined, 'What Finlity does with this'));
    for (const line of disclosureLines(provider, dataMode())) {
      if (line) disclosure.appendChild(el('p', undefined, line));
    }
    form.appendChild(disclosure);

    const error = this.errorLine();
    form.appendChild(error);
    const submit = el('button', 'btn btn-primary', reconnect ? 'Reconnect' : 'Connect');
    submit.type = 'submit';
    const buttons: HTMLButtonElement[] = [];
    if (!reconnect) {
      buttons.push(
        button('Back', 'btn btn-secondary', () => {
          // The fields are rebuilt empty next time; nothing typed is kept.
          inputs.forEach((i) => (i.value = ''));
          this.renderProvider();
        })
      );
    }
    buttons.push(submit);
    form.appendChild(this.actions(...buttons));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitCredentials(inputs, labelInput, error);
    });
    this.body.appendChild(form);
    (inputs[0] ?? labelInput ?? h).focus();
  }

  private async submitCredentials(
    inputs: HTMLInputElement[],
    labelInput: HTMLInputElement | null,
    error: HTMLElement
  ): Promise<void> {
    if (this.busy) return;
    const provider = this.state.provider!;
    error.textContent = '';
    const problem = labelInput ? labelError(labelInput.value) : null;
    if (problem) {
      error.textContent = problem;
      labelInput?.focus();
      return;
    }
    const missing = inputs.find((i) => !i.value.trim());
    if (missing) {
      error.textContent =
        provider === 'akahu' ? 'Paste both tokens.' : 'Paste the setup token or Access URL.';
      missing.focus();
      return;
    }
    // Read once, then empty the fields before anything else can happen.
    const values: Record<string, string> = {};
    for (const i of inputs) values[i.dataset.credential!] = i.value;
    inputs.forEach((i) => (i.value = ''));
    const id = this.state.connectionId;
    const request = id
      ? {
          url: `/api/connections/${encodeURIComponent(id)}/credentials`,
          body: credentialBody(provider, values),
        }
      : {
          url: '/api/connections',
          body: createBody(provider, this.state.label, this.state.firstSyncDays, values),
        };
    for (const k of Object.keys(values)) delete values[k];
    if (!request.body) return;
    // A pasted Access URL or Akahu tokens is checked before it replaces the stored
    // one; a setup token is spent by the claim, so its connection waits for Retry.
    const pasted = !('setup_token' in request.body) && provider !== 'demo';
    this.setBusy(true);
    let result: ConnectionListingResponse;
    try {
      result = await apiCall<ConnectionListingResponse>(request.url, {
        method: 'POST',
        body: request.body,
      });
    } catch (e) {
      request.body = null;
      this.setBusy(false);
      error.textContent = failureText(e);
      (inputs[0] ?? error).focus();
      if (id && isConnectionGone(e)) this.changed = true;
      return;
    }
    request.body = null;
    this.changed = true;
    if (id && pasted && result.accounts_error) {
      // A pasted credential the provider refused was not saved: the old one and
      // its status stay, so ask again rather than offering a Retry with it.
      this.setBusy(false);
      error.textContent = accountsErrorText(result.accounts_error);
      (inputs[0] ?? error).focus();
      return;
    }
    this.busy = false;
    this.set({ connectionId: result.id });
    await this.showAccounts(result, result.accounts_error ?? null);
  }

  // ---- accounts pending --------------------------------------------------

  private renderPending(code: string): void {
    this.set({ step: 'accounts', accountsError: code });
    const h = this.step('Accounts not loaded yet.');
    this.body.appendChild(
      el(
        'p',
        'connect-help',
        `${accountsErrorText(code)} The connection is saved, so nothing needs to be entered again.`
      )
    );
    const error = this.errorLine();
    this.body.appendChild(error);
    const retry: HTMLButtonElement = button(
      'Retry',
      'btn btn-primary',
      () => void this.retryAccounts(error, retry)
    );
    this.body.appendChild(
      this.actions(
        button('Close', 'btn btn-secondary', () => this.close()),
        retry
      )
    );
    h.focus();
  }

  private async retryAccounts(error: HTMLElement, retry: HTMLButtonElement): Promise<void> {
    if (this.busy || !this.state.connectionId) return;
    this.setBusy(true);
    error.textContent = '';
    try {
      const result = await apiCall<ConnectionListingResponse>(
        `/api/connections/${encodeURIComponent(this.state.connectionId)}/accounts`,
        { method: 'POST' }
      );
      this.busy = false;
      this.changed = true;
      await this.showAccounts(result, null);
    } catch (e) {
      this.setBusy(false);
      error.textContent = failureText(e);
      (retry.isConnected ? retry : error).focus();
    }
  }

  // ---- 4. mapping --------------------------------------------------------

  private async showAccounts(detail: Detail, accountsError: string | null): Promise<void> {
    this.detail = detail;
    this.accountErrors = 'account_errors' in detail ? detail.account_errors : [];
    if (accountsError || detail.accounts.length === 0) {
      this.renderPending(accountsError ?? 'accounts_pending');
      return;
    }
    this.set({ edits: editsFrom(detail), debtTouched: [], accountsError: null });
    await this.loadChoices();
    this.renderMapping();
  }

  private async loadChoices(): Promise<void> {
    const [liabilities, context] = await Promise.all([
      settle(apiCall<LiabilityResponse[]>('/api/liabilities'), null),
      settle(apiCall<SmartImportContext | null>('/api/smart-import/context'), null),
    ]);
    this.debtsFailed = !Array.isArray(liabilities);
    this.liabilities = Array.isArray(liabilities) ? liabilities : [];
    this.known = Array.isArray(context?.accounts) ? context.accounts : [];
  }

  private renderMapping(focus?: { pid: string; field: string }): void {
    if (!this.modal?.isConnected) return;
    this.set({ step: 'accounts' });
    const h = this.step('Choose what each account is');
    this.body.appendChild(
      el(
        'p',
        'connect-help',
        'Spending accounts bring in transactions. Debt accounts also record the balance on ' +
          'a debt. You can change this later in Settings.'
      )
    );
    const list = el('div', 'connect-accounts');
    for (const a of this.detail!.accounts)
      list.appendChild(this.accountCard(a.provider_account_id));
    this.body.appendChild(list);
    const error = this.errorLine();
    this.body.appendChild(error);
    const save = button('Save', 'btn btn-primary', () => void this.save(error));
    this.body.appendChild(this.actions(save));
    const target = focus
      ? this.body.querySelector<HTMLElement>(
          `[data-account="${CSS.escape(focus.pid)}"] [data-map="${focus.field}"]`
        )
      : null;
    (target ?? h).focus();
  }

  private accountCard(pid: string): HTMLElement {
    const a = this.detail!.accounts.find((x) => x.provider_account_id === pid)!;
    const edit = this.state.edits[pid]!;
    const card = el('section', 'connect-account');
    card.dataset.account = pid;
    const head = el('div', 'connect-account-head');
    head.appendChild(el('strong', 'connect-account-name', a.name || edit.label));
    const meta = [a.institution, a.currency].filter((x): x is string => !!x).join(' · ');
    if (meta) head.appendChild(el('span', 'connect-account-meta', meta));
    card.appendChild(head);
    for (const e of this.accountErrors) {
      if (e.provider_account_id === pid) {
        card.appendChild(el('p', 'connect-account-problem', accountCodeText(e.code)));
      }
    }

    const grid = el('div', 'connect-account-grid');
    const role = choiceSelect(ROLE_CHOICES, edit.role);
    role.dataset.map = 'role';
    role.addEventListener('change', () => {
      this.set({ edits: setEdit(this.state.edits, pid, { role: role.value as typeof edit.role }) });
      this.renderMapping({ pid, field: 'role' });
    });
    grid.appendChild(labelled('Use as', role));

    const kind = choiceSelect(KIND_CHOICES, edit.kind);
    kind.dataset.map = 'kind';
    kind.addEventListener('change', () => {
      this.set({
        edits: setEdit(this.state.edits, pid, { kind: kind.value as SmartImportAccountKind }),
      });
      this.renderMapping({ pid, field: 'kind' });
    });
    grid.appendChild(labelled('Type', kind));

    const label = el('input', 'form-input');
    label.type = 'text';
    label.maxLength = MAX_LABEL_CHARS;
    label.value = edit.label;
    label.dataset.map = 'label';
    label.addEventListener('input', () => {
      this.set({ edits: setEdit(this.state.edits, pid, { label: label.value }) });
    });
    grid.appendChild(labelled('Name in Finlity', label));
    card.appendChild(grid);

    if (edit.role === 'debt') card.appendChild(this.debtSection(pid));

    const sameAs = choiceSelect(sameAsChoices(this.known, a), edit.same_as_key ?? '');
    sameAs.dataset.map = 'same-as';
    sameAs.addEventListener('change', () => {
      this.set({ edits: setEdit(this.state.edits, pid, { same_as_key: sameAs.value || null }) });
      this.renderMapping({ pid, field: 'same-as' });
    });
    card.appendChild(
      labelled(
        'Same as an imported account',
        sameAs,
        edit.same_as_key
          ? 'Syncs start after the newest transaction already stored for that account.'
          : 'Choose one when you already import this account from files.'
      )
    );
    const problem = el('p', 'connect-error');
    problem.dataset.problem = pid;
    card.appendChild(problem);
    return card;
  }

  private debtSection(pid: string): HTMLElement {
    const edit = this.state.edits[pid]!;
    const group = el('div', 'connect-debt');
    const options = [
      { value: '', label: 'Do not link a debt' },
      ...fittingDebts(this.liabilities, edit.kind, edit.liability_id).map((l) => ({
        value: l.id,
        label: l.name,
      })),
    ];
    // A stored link to a debt that is not listed (the list failed, or the debt is
    // gone) stays selected as it is, so Save never changes it unless chosen.
    const unlisted =
      edit.liability_id !== null && !options.some((o) => o.value === edit.liability_id);
    if (unlisted)
      options.push({ value: edit.liability_id!, label: 'Linked debt (not in the list)' });
    const debt = choiceSelect(options, edit.liability_id ?? '');
    debt.dataset.map = 'debt';
    debt.addEventListener('change', () => {
      this.set({
        edits: setEdit(this.state.edits, pid, { liability_id: debt.value || null }),
        debtTouched: [...this.state.debtTouched, pid],
      });
      this.renderMapping({ pid, field: 'debt' });
    });
    const suggested =
      this.creating &&
      !unlisted &&
      !this.state.debtTouched.includes(pid) &&
      edit.liability_id !== null &&
      debt.value !== '';
    group.appendChild(
      labelled(
        'Link to a debt',
        debt,
        suggested
          ? 'Suggested match. Each sync records this account’s balance on the debt.'
          : 'Each sync records this account’s balance on the linked debt.'
      )
    );
    if (this.debtsFailed) {
      group.appendChild(
        el(
          'p',
          'connect-hint',
          'Debts could not be loaded. The current link is kept unless you change it.'
        )
      );
    }
    const add = button(
      'Add as a new debt',
      'btn btn-secondary btn-sm',
      () => void this.addDebt(pid)
    );
    add.dataset.map = 'debt-new';
    group.appendChild(add);
    return group;
  }

  /**
   * The debt wizard replaces this dialog (there is one dynamic modal), so the
   * mapping steps aside with its edits intact and comes back when the wizard
   * goes away, saved or not.
   */
  private async addDebt(pid: string): Promise<void> {
    if (this.busy) return;
    const a = this.detail!.accounts.find((x) => x.provider_account_id === pid)!;
    const edit = this.state.edits[pid]!;
    let savedId: string | null = null;
    closeDynamicModal();
    this.modal = null;
    const handle = await openDebtWizardLazy({
      prefill: {
        liabilityType: edit.kind === 'credit_card' ? 'credit_card' : 'personal_loan',
        ...(a.institution ? { lender: a.institution } : {}),
        ...(edit.label.trim() ? { name: edit.label.trim() } : {}),
      },
      onSaved: (saved) => {
        savedId = saved.id;
      },
    });
    const resume = (): void => void this.comeBack(pid, savedId);
    if (!handle || !handle.modal.isConnected) {
      resume();
      return;
    }
    const waiter = new MutationObserver(() => {
      if (!handle.modal.isConnected) {
        waiter.disconnect();
        resume();
      }
    });
    waiter.observe(document.body, { childList: true, subtree: true });
  }

  private async comeBack(pid: string, savedId: string | null): Promise<void> {
    this.mount();
    await this.loadChoices();
    if (savedId) {
      this.set({
        edits: setEdit(this.state.edits, pid, { liability_id: savedId }),
        debtTouched: [...this.state.debtTouched, pid],
      });
    }
    this.renderMapping({ pid, field: 'debt' });
  }

  private async save(error: HTMLElement): Promise<void> {
    if (this.busy || !this.detail) return;
    error.textContent = '';
    this.body.querySelectorAll<HTMLElement>('[data-problem]').forEach((p) => (p.textContent = ''));
    const problems = mappingErrors(this.state.edits);
    const first = Object.keys(problems)[0];
    if (first) {
      for (const [pid, text] of Object.entries(problems)) {
        const p = this.body.querySelector<HTMLElement>(`[data-problem="${CSS.escape(pid)}"]`);
        if (p) p.textContent = text;
      }
      this.body
        .querySelector<HTMLElement>(`[data-account="${CSS.escape(first)}"] [data-map="label"]`)
        ?.focus();
      return;
    }
    const update = buildUpdateRequest(this.detail, this.state.edits);
    if (!update) {
      this.renderDone(this.detail);
      return;
    }
    this.setBusy(true);
    try {
      const saved = await apiCall<ConnectionDetail>(
        `/api/connections/${encodeURIComponent(this.detail.id)}`,
        { method: 'PUT', body: update }
      );
      this.busy = false;
      this.changed = true;
      this.detail = saved;
      this.renderDone(saved);
    } catch (e) {
      this.setBusy(false);
      error.textContent = failureText(e);
      error.focus();
      if (isConnectionGone(e)) this.changed = true;
    }
  }

  private showDiscard(): void {
    const row = this.body.querySelector<HTMLElement>('.connect-actions');
    if (!row) return;
    this.confirming = true;
    const previous = Array.from(row.childNodes);
    const text = el(
      'p',
      'connect-confirm-text',
      'Discard these changes? The connection stays as it was.'
    );
    text.setAttribute('role', 'alert');
    const keep = button('Keep editing', 'btn btn-secondary', () => {
      this.confirming = false;
      row.classList.remove('connect-confirm');
      row.replaceChildren(...previous);
      (previous[previous.length - 1] as HTMLElement | undefined)?.focus();
    });
    const discard = button('Discard', 'btn btn-primary', () => {
      this.confirming = false;
      this.close();
    });
    row.classList.add('connect-confirm');
    row.replaceChildren(text, keep, discard);
    keep.focus();
  }

  // ---- 5. done -----------------------------------------------------------

  private renderDone(detail: Detail): void {
    this.set({ step: 'done' });
    const h = this.step('Connected');
    const syncing = detail.accounts.filter((a) => a.role !== 'ignore').length;
    this.body.appendChild(
      el(
        'p',
        'connect-help',
        `${detail.label}: ${syncing} of ${detail.accounts.length} accounts will sync. Each sync ` +
          'opens the import review first, so nothing is added until you apply it.'
      )
    );
    const id = detail.id;
    const sync = button('Sync now', 'btn btn-secondary', () => {
      this.close();
      void syncNow(id, this.options.onChanged);
    });
    sync.dataset.action = 'sync';
    this.body.appendChild(
      this.actions(
        sync,
        button('Done', 'btn btn-primary', () => this.close())
      )
    );
    h.focus();
  }
}

// --------------------------------------------------------------- sync now

const syncing = new Set<string>();

function syncFailureText(error: unknown): string {
  return connectErrorText(error) ?? connectionErrorText(error);
}

/**
 * Sync now (design 9.2): walk the plan's windows oldest first, one request
 * each; a failure stops the walk and the windows that completed still open.
 * Then open the wizard on what is left to review, or say there is nothing new.
 */
export async function syncNow(
  id: string,
  onChanged?: () => Promise<void>,
  statusId = 'connections-status'
): Promise<void> {
  if (syncing.has(id)) return;
  syncing.add(id);
  try {
    await runSync(id, onChanged, statusId);
  } finally {
    syncing.delete(id);
  }
}

async function runSync(
  id: string,
  onChanged: (() => Promise<void>) | undefined,
  statusId: string
): Promise<void> {
  const say = (lines: readonly string[]): void => setStatus(lines, statusId);
  const path = `/api/connections/${encodeURIComponent(id)}`;
  let detail: ConnectionDetail;
  try {
    detail = await apiCall<ConnectionDetail>(path);
  } catch (e) {
    say([connectionErrorText(e)]);
    if (isConnectionGone(e)) void onChanged?.();
    return;
  }
  const total = detail.windows.length;
  if (total === 0) {
    say([NOTHING_TO_SYNC]);
    return;
  }
  const answers: ConnectorSyncResponse[] = [];
  let failure: unknown = null;
  for (let i = 0; i < total; i++) {
    say([syncingText(detail.label, i + 1, total)]);
    try {
      answers.push(
        await apiCall<ConnectorSyncResponse>(`${path}/sync`, {
          method: 'POST',
          body: { window_index: i },
        })
      );
    } catch (e) {
      failure = e;
      break;
    }
  }
  // The sync is recorded (last synced, quota) whether or not anything is applied.
  void onChanged?.();
  if (isConnectionGone(failure)) {
    say([connectionErrorText(failure)]);
    return;
  }

  let statements = reviewable(
    answers.flatMap((a) => a.statements),
    detail
  );
  if (statements.length > 0) {
    try {
      statements = withSomethingNew(statements, detail, await previewInBatches(statements));
    } catch {
      // The wizard's own preview marks duplicates; open everything.
    }
  }
  const accountLines = accountErrorLines(
    answers.flatMap((a) => a.account_errors),
    detail,
    accountCodeText
  );
  if (statements.length === 0) {
    if (failure !== null) {
      say([syncFailureText(failure), ...accountLines]);
      return;
    }
    const text = noNewText(detail.windows[0]!.start);
    say([text, ...accountLines]);
    showToast(text, 'info');
    return;
  }

  const notices: string[] = [];
  if (failure !== null) notices.push(stoppedText(answers.length, total, syncFailureText(failure)));
  notices.push(...accountLines);
  say([]);
  openTurns(detail, splitTurns(statements), notices, onChanged);
}

/**
 * Which synced rows are already stored. The preview takes at most one turn of
 * statements per request, so it goes in batches and the answers are merged.
 */
async function previewInBatches(
  statements: NormalizedStatement[]
): Promise<Pick<PreviewResponse, 'existing_dedupe_keys' | 'prior_files'>> {
  const merged: Pick<PreviewResponse, 'existing_dedupe_keys' | 'prior_files'> = {
    existing_dedupe_keys: [],
    prior_files: [],
  };
  for (const batch of splitTurns(statements, TURN_STATEMENTS)) {
    const preview = await apiCall<PreviewResponse>('/api/smart-import/preview', {
      method: 'POST',
      body: previewRequest(batch),
    });
    merged.existing_dedupe_keys.push(...(preview.existing_dedupe_keys ?? []));
    merged.prior_files.push(...(preview.prior_files ?? []));
  }
  return merged;
}

/** Open one wizard per turn of at most 12 statements; the next opens once a turn is applied. */
function openTurns(
  start: ConnectionDetail,
  turns: NormalizedStatement[][],
  notices: string[],
  onChanged?: () => Promise<void>
): void {
  let detail = start;
  const path = `/api/connections/${encodeURIComponent(detail.id)}`;
  // The last write-back; the next turn never opens before it settles, however the
  // wizard was closed. Undo of an import leaves the mapping as written back.
  let writing: Promise<unknown> = Promise.resolve();
  const onApplied = async (state: WizardState): Promise<void> => {
    const update = writeBackRequest(detail, state.statements);
    if (!update) return;
    const run = apiCall<ConnectionDetail>(path, { method: 'PUT', body: update });
    writing = run.catch(() => undefined);
    detail = await run;
    void onChanged?.();
  };
  const open = (index: number): void => {
    void openSmartImportLazy({
      connection: {
        connection_id: detail.id,
        provider_label: providerLabel(detail.provider),
        // A later turn starts from the mapping as the earlier turns' write-back left it.
        statements: index === 0 ? turns[0]! : withMappedKinds(turns[index]!, detail),
        accounts: mappingFor(detail),
        notices: index === 0 ? notices : [],
        turn: { index: index + 1, total: turns.length },
        onApplied,
      },
      onClose: ({ applied, undone }) => {
        const more = index + 1 < turns.length;
        if (more && applied && !undone) void writing.then(() => open(index + 1));
        else if (more) showToast(REST_NOT_OPENED, 'info');
      },
    });
  };
  open(0);
}
