/**
 * Pure helpers for the Connect dialog and the account mapping (design 10 and 12):
 * provider copy, credential fields and request bodies, the "What Finlity does
 * with this" text per mode, the first-sync range, and the mapping edits with the
 * PUT body they produce.
 *
 * Credentials: credentialBody and createBody take the typed strings and return a
 * request body for one call; nothing here keeps them. The dialog state
 * (ConnectState) has no field that can hold a credential. Nothing here touches
 * the DOM or the network.
 */

import { WARNING_COPY } from '@/utils/smart-import-render';
import type {
  ConnectionAccount,
  ConnectionAccountRole,
  ConnectionAccountUpdate,
  ConnectionDetail,
  ConnectionProvider,
  CreateConnectionRequest,
  LiabilityResponse,
  ReplaceCredentialsRequest,
  SmartImportAccountKind,
  SmartImportContext,
  UpdateConnectionRequest,
} from '@/types/api';

export type ConnectStep = 'provider' | 'credentials' | 'accounts' | 'done';
export type ConnectMode = 'server' | 'local';
export type FirstSyncDays = 30 | 60 | 90;

export const MAX_LABEL_CHARS = 120;
export const DEFAULT_FIRST_SYNC_DAYS: FirstSyncDays = 90;
export const FIRST_SYNC_CHOICES: readonly { value: FirstSyncDays; label: string }[] = [
  { value: 30, label: 'The last 30 days' },
  { value: 60, label: 'The last 60 days' },
  { value: 90, label: 'The last 90 days' },
];

/** The line under each provider on the first step. */
export const PROVIDER_LINE: Record<ConnectionProvider, string> = {
  simplefin:
    'Your SimpleFIN Bridge subscription costs $1.50 a month or $15 a year, paid to SimpleFIN.',
  akahu: 'New Zealand. Create a free personal app at my.akahu.nz and paste its two tokens.',
  demo: 'Try a demo bank (synthetic data). No account or token needed.',
};

/** Where to get the credential, shown above the fields. */
export const CREDENTIAL_HELP: Record<ConnectionProvider, string> = {
  simplefin:
    'Create a setup token at SimpleFIN Bridge and paste it here. An Access URL ' +
    '(starting with https://) also works.',
  akahu: 'Paste the User token and the App token of your Akahu personal app.',
  demo: 'The demo bank needs no credentials. It makes up transactions for two accounts.',
};

export interface CredentialField {
  name: 'secret' | 'user_token' | 'app_token';
  label: string;
}

export function credentialFields(provider: ConnectionProvider): CredentialField[] {
  switch (provider) {
    case 'simplefin':
      return [{ name: 'secret', label: 'Setup token or Access URL' }];
    case 'akahu':
      return [
        { name: 'user_token', label: 'User token' },
        { name: 'app_token', label: 'App token' },
      ];
    default:
      return [];
  }
}

/**
 * The credential part of a create or reconnect body, or null when a field is
 * empty. SimpleFIN: a value starting with https:// is an Access URL, anything
 * else a setup token (design 8.3).
 */
export function credentialBody(
  provider: ConnectionProvider,
  values: Readonly<Record<string, string>>
): ReplaceCredentialsRequest | null {
  const get = (name: string): string => (values[name] ?? '').trim();
  if (provider === 'simplefin') {
    const secret = get('secret');
    if (!secret) return null;
    return /^https:\/\//i.test(secret) ? { access_url: secret } : { setup_token: secret };
  }
  if (provider === 'akahu') {
    const user = get('user_token');
    const app = get('app_token');
    if (!user || !app) return null;
    return { user_token: user, app_token: app };
  }
  return {};
}

/** POST /api/connections, or null when a credential field is empty. */
export function createBody(
  provider: ConnectionProvider,
  label: string,
  firstSyncDays: FirstSyncDays,
  values: Readonly<Record<string, string>>
): CreateConnectionRequest | null {
  const creds = credentialBody(provider, values);
  if (creds === null) return null;
  const body: CreateConnectionRequest = { provider, first_sync_days: firstSyncDays, ...creds };
  const name = label.trim();
  if (name) body.label = name;
  return body;
}

/** Fixed problem with the label field, or null. */
export function labelError(label: string): string | null {
  const name = label.trim();
  if (Array.from(name).length > MAX_LABEL_CHARS) {
    return `Use ${MAX_LABEL_CHARS} characters or fewer.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return 'Use letters, numbers and punctuation only.';
  return null;
}

const REVOKE: Record<ConnectionProvider, string> = {
  simplefin: 'To end access, disable this app in your SimpleFIN Bridge account.',
  akahu: 'To end access, delete the personal app at my.akahu.nz.',
  demo: '',
};

/** "What Finlity does with this": where the credential lives in this mode. */
export function disclosureLines(provider: ConnectionProvider, mode: ConnectMode): string[] {
  if (provider === 'demo') {
    return ['The demo bank has no credentials. Its data is made up and never leaves Finlity.'];
  }
  // Akahu takes two tokens; SimpleFIN one (a setup token, or the Access URL it becomes).
  const two = provider === 'akahu';
  const yours = two ? 'Your tokens are' : 'Your token is';
  const it = two ? 'them' : 'it';
  const where =
    mode === 'local'
      ? `${yours} sealed in this browser with a key that cannot leave it. A saved or ` +
        'downloaded copy of your data holds only the sealed form. This protects that ' +
        'saved copy, not against a script running inside this page.'
      : `${yours} encrypted and stored in this server’s database and never shown again.`;
  const passes =
    mode === 'local'
      ? `Each sync passes ${it} through Finlity’s server to the provider over HTTPS. ` +
        `The server does not store ${it} or log ${it}.`
      : `Each sync sends ${it} from this server to the provider over HTTPS. ` +
        `${two ? 'They are' : 'It is'} never logged.`;
  return [where, passes, 'Finlity can only read transactions and balances.', REVOKE[provider]];
}

// ------------------------------------------------------------------ errors

/** Fixed copy for the Connect dialog's failures; null falls back to connectionErrorText. */
const CONNECT_ERROR: Record<string, string> = {
  bad_setup_token:
    'That does not look like a SimpleFIN setup token or Access URL. Copy it again from ' +
    'SimpleFIN Bridge.',
  claim_refused:
    'This setup token was already used or is not valid. If you did not use it, it may be ' +
    'compromised: disable it at SimpleFIN Bridge, then create a new setup token.',
  claim_not_saved:
    'The setup token was used but the connection could not be saved. Create a new setup ' +
    'token at SimpleFIN Bridge and try again.',
  claim_timeout:
    'SimpleFIN did not answer in time, and the setup token may already be used. Create a new ' +
    'setup token at SimpleFIN Bridge and try again.',
  host_not_allowed: 'That Access URL does not point to SimpleFIN Bridge, so it was not used.',
  connection_limit: 'You have 10 connections, the most allowed. Disconnect one first.',
  connector_disabled: 'This provider is not available on this site.',
  reconnect_needed: 'The provider did not accept these credentials. Check them and try again.',
  payment_required: 'Your SimpleFIN Bridge subscription needs attention before syncing works.',
  provider_rate_limited: 'The provider asked for fewer requests. Try again tomorrow.',
  quota_reached: 'This connection used all of today’s requests. Try again later.',
  provider_timeout: 'The provider did not answer in time. Try again in a moment.',
  provider_unavailable: 'The provider could not be reached. Try again in a moment.',
  provider_bad_response: 'The provider sent an answer Finlity could not read.',
  response_too_large: 'The provider sent more data than Finlity accepts.',
  liability_not_found: 'That debt no longer exists. Choose another one.',
  bad_request: 'Some of these details were not accepted. Check them and try again.',
};

function errorType(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const type = (data as { error_type?: unknown }).error_type;
  return typeof type === 'string' ? type : null;
}

export function connectErrorText(error: unknown): string | null {
  const type = errorType(error);
  return type ? (CONNECT_ERROR[type] ?? null) : null;
}

/** "Accounts not loaded yet" reasons, from a create or reconnect's accounts_error. */
export function accountsErrorText(code: string): string {
  return CONNECT_ERROR[code] ?? 'The account list could not be loaded.';
}

/** A per-account code from a listing (design 8.3). */
export function accountCodeText(code: string): string {
  switch (code) {
    case 'connector_account_error':
      return WARNING_COPY.connector_account_error as string;
    case 'currency_unsupported':
      return 'This account’s currency is not supported, so it is skipped.';
    default:
      return 'The provider reported a problem with this account.';
  }
}

// ----------------------------------------------------------------- mapping

export interface AccountEdit {
  kind: SmartImportAccountKind;
  role: ConnectionAccountRole;
  label: string;
  liability_id: string | null;
  same_as_key: string | null;
}

export type MappingEdits = Readonly<Record<string, AccountEdit>>;

/** The dialog's state: the step, the provider and the mapping. Never a credential. */
export interface ConnectState {
  step: ConnectStep;
  provider: ConnectionProvider | null;
  label: string;
  firstSyncDays: FirstSyncDays;
  connectionId: string | null;
  /** Set when the connection exists but its account list failed to load. */
  accountsError: string | null;
  edits: MappingEdits;
  /** Accounts whose debt choice was made by the person (the suggestion hint hides). */
  debtTouched: readonly string[];
}

export function initialState(): ConnectState {
  return {
    step: 'provider',
    provider: null,
    label: '',
    firstSyncDays: DEFAULT_FIRST_SYNC_DAYS,
    connectionId: null,
    accountsError: null,
    edits: {},
    debtTouched: [],
  };
}

export const ROLE_CHOICES: readonly { value: ConnectionAccountRole; label: string }[] = [
  { value: 'cash_flow', label: 'Spending' },
  { value: 'debt', label: 'Debt' },
  { value: 'ignore', label: 'Do not sync' },
];

export function editsFrom(detail: Pick<ConnectionDetail, 'accounts'>): Record<string, AccountEdit> {
  const out: Record<string, AccountEdit> = {};
  for (const a of detail.accounts) {
    out[a.provider_account_id] = {
      kind: a.kind,
      role: a.role,
      label: a.label,
      liability_id: a.liability_id,
      same_as_key: a.same_as_key,
    };
  }
  return out;
}

export function setEdit(
  edits: MappingEdits,
  pid: string,
  patch: Partial<AccountEdit>
): Record<string, AccountEdit> {
  const current = edits[pid];
  if (!current) return { ...edits };
  return { ...edits, [pid]: { ...current, ...patch } };
}

/** The debt link that will be saved: only a debt-role account keeps one. */
function savedLiability(edit: AccountEdit): string | null {
  return edit.role === 'debt' ? edit.liability_id : null;
}

/** Problems that block Save, per provider account id. */
export function mappingErrors(edits: MappingEdits): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pid, edit] of Object.entries(edits)) {
    if (!edit.label.trim()) out[pid] = 'Enter a name for this account.';
    else {
      const problem = labelError(edit.label);
      if (problem) out[pid] = problem;
    }
  }
  return out;
}

/** PUT /api/connections/{id} with only what changed, or null when nothing did. */
export function buildUpdateRequest(
  detail: Pick<ConnectionDetail, 'accounts'>,
  edits: MappingEdits
): UpdateConnectionRequest | null {
  const accounts: Record<string, ConnectionAccountUpdate> = {};
  for (const a of detail.accounts) {
    const edit = edits[a.provider_account_id];
    if (!edit) continue;
    const change: ConnectionAccountUpdate = {};
    if (edit.kind !== a.kind) change.kind = edit.kind;
    if (edit.role !== a.role) change.role = edit.role;
    const label = edit.label.trim();
    if (label && label !== a.label) change.label = label;
    const liability = savedLiability(edit);
    if (liability !== a.liability_id) change.liability_id = liability;
    if (edit.same_as_key !== a.same_as_key) change.same_as_key = edit.same_as_key;
    if (Object.keys(change).length > 0) accounts[a.provider_account_id] = change;
  }
  return Object.keys(accounts).length > 0 ? { accounts } : null;
}

export function isMappingDirty(
  detail: Pick<ConnectionDetail, 'accounts'>,
  edits: MappingEdits
): boolean {
  return buildUpdateRequest(detail, edits) !== null;
}

/** Active debts that fit the kind: cards for a card, loan types otherwise. */
export function fittingDebts(
  liabilities: readonly LiabilityResponse[],
  kind: SmartImportAccountKind,
  chosen: string | null
): LiabilityResponse[] {
  const active = liabilities.filter((l) => l.is_active !== false);
  const fits = active.filter((l) =>
    kind === 'credit_card'
      ? l.liability_type === 'credit_card'
      : l.liability_type !== 'credit_card' && l.liability_type !== 'heloc'
  );
  const extra = chosen ? liabilities.find((l) => l.id === chosen && !fits.includes(l)) : undefined;
  return extra ? [...fits, extra] : fits;
}

/** "Same as" choices: accounts already imported, never this account itself. */
export function sameAsChoices(
  known: SmartImportContext['accounts'],
  account: Pick<ConnectionAccount, 'account_key' | 'same_as_key'>
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [{ value: '', label: 'Keep separate' }];
  const seen = new Set<string>([account.account_key]);
  for (const k of known) {
    if (seen.has(k.account_key)) continue;
    seen.add(k.account_key);
    const name = k.label || k.institution || 'Imported account';
    out.push({ value: k.account_key, label: k.last4 ? `${name} (ending ${k.last4})` : name });
  }
  if (account.same_as_key && !seen.has(account.same_as_key)) {
    out.push({ value: account.same_as_key, label: 'The account chosen before' });
  }
  return out;
}
