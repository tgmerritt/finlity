/**
 * Pure helpers for Settings > Connected accounts: provider names, status chips,
 * summary lines, the Disconnect preview and result text, revoke hints and fixed
 * error copy. Connection labels are user data; callers put them in the DOM with
 * textContent only. Nothing here touches the DOM or the network.
 */

import { formatDate } from '@/utils/format';
import { countText, keptLines } from '@/utils/smart-import-render';
import type {
  ConnectionProvider,
  ConnectionSummary,
  DisconnectResponse,
  SmartImportSummary,
} from '@/types/api';

const PROVIDER_ORDER: readonly ConnectionProvider[] = ['simplefin', 'akahu', 'demo'];

const PROVIDER_LABEL: Record<ConnectionProvider, string> = {
  simplefin: 'SimpleFIN Bridge',
  akahu: 'Akahu',
  demo: 'Demo bank',
};

export function providerLabel(provider: ConnectionProvider): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/** Providers to offer: the demo always, real ones only when the status enables them. */
export function offeredProviders(enabled: readonly string[] | null): ConnectionProvider[] {
  const on = new Set(enabled ?? []);
  return PROVIDER_ORDER.filter((p) => p === 'demo' || on.has(p));
}

// ------------------------------------------------------------------ status

export type ChipTone = 'success' | 'warning' | 'danger' | 'default';

/** The chip text and tone for a connection's status. */
export function statusChip(
  c: ConnectionSummary,
  now: Date = new Date()
): { text: string; tone: ChipTone } {
  switch (c.status) {
    case 'ok':
      return { text: 'Connected', tone: 'success' };
    case 'accounts_pending':
      return { text: 'Accounts not loaded', tone: 'warning' };
    case 'reconnect_needed':
      return { text: 'Needs reconnect', tone: 'danger' };
    case 'payment_required':
      return { text: 'Subscription issue', tone: 'danger' };
    case 'rate_limited': {
      // The provider asked for fewer requests: sync is off until the gate opens.
      // Once it has, the connection reads like any other connected one.
      const { until } = syncGate(c, now);
      if (!until) return { text: 'Connected', tone: 'success' };
      return { text: `Rate limited until ${formatDate(until.toISOString())}`, tone: 'warning' };
    }
    default:
      return { text: 'Sync problem', tone: 'warning' };
  }
}

export function lastSyncedText(c: ConnectionSummary): string {
  return c.last_synced_at ? `Last synced ${formatDate(c.last_synced_at)}` : 'Never synced';
}

export function accountsText(c: ConnectionSummary): string {
  if (c.accounts_count === 0) return 'No accounts yet';
  return `${c.accounts_enabled} of ${countText(c.accounts_count, 'account')} syncing`;
}

export function quotaText(c: ConnectionSummary): string {
  if (c.quota_budget === null || c.quota_left === null) return 'No sync limit';
  if (c.quota_left === 0 && c.quota_resets_at) {
    const at = new Date(c.quota_resets_at).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `No syncs left until ${at}`;
  }
  return `${c.quota_left} of ${c.quota_budget} syncs left today`;
}

// ----------------------------------------------------------- status handling

export const BRIDGE_URL = 'https://beta-bridge.simplefin.org/';

const DAY_MS = 24 * 60 * 60 * 1000;
const DISMISSED_KEY = 'finlity.syncDueDismissed';

export interface SyncGate {
  blocked: boolean;
  /** reconnect: needs new credentials; time: wait until `until`. */
  reason: 'reconnect' | 'time' | null;
  until: Date | null;
}

/**
 * Whether Sync is offered now. reconnect_needed never is; rate_limited waits
 * for the next local midnight after it was set (design 11); a spent quota
 * waits for its reset time. A time in the past no longer blocks.
 */
export function syncGate(c: ConnectionSummary, now: Date = new Date()): SyncGate {
  if (c.status === 'reconnect_needed') return { blocked: true, reason: 'reconnect', until: null };
  let until: Date | null = null;
  if (c.status === 'rate_limited') {
    const set = new Date(c.status_at);
    if (!Number.isNaN(set.getTime())) {
      until = new Date(set.getFullYear(), set.getMonth(), set.getDate() + 1, 0, 0, 0);
    }
  } else if (c.quota_left === 0 && c.quota_resets_at) {
    const at = new Date(c.quota_resets_at);
    if (!Number.isNaN(at.getTime())) until = at;
  }
  if (until && until.getTime() > now.getTime()) return { blocked: true, reason: 'time', until };
  return { blocked: false, reason: null, until: null };
}

/** "at 3:15 PM" today, "Oct 7 at 12:00 AM" on another local day. */
function whenText(until: Date, now: Date): string {
  const time = until.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (until.toDateString() === now.toDateString()) return `at ${time}`;
  return `${formatDate(until.toISOString(), { month: 'short', day: 'numeric' })} at ${time}`;
}

export interface StatusNote {
  text: string;
  href: string | null;
  linkText: string | null;
}

/** The line under a connection that explains why Sync is off or needs care. */
export function statusNote(c: ConnectionSummary, now: Date = new Date()): StatusNote | null {
  if (c.status === 'reconnect_needed') {
    return {
      text:
        'Finlity cannot read this connection any more. Reconnect to sync again. ' +
        'Your account choices are kept.',
      href: null,
      linkText: null,
    };
  }
  if (c.status === 'payment_required') {
    const bridge = c.provider === 'simplefin';
    return {
      text: 'Your SimpleFIN Bridge subscription needs attention before syncing works.',
      href: bridge ? BRIDGE_URL : null,
      linkText: bridge ? 'Open SimpleFIN Bridge' : null,
    };
  }
  const gate = syncGate(c, now);
  if (gate.reason === 'time' && gate.until) {
    const prefix =
      c.status === 'rate_limited'
        ? ''
        : 'This connection\u2019s syncs for the last 24 hours are used up. ';
    return {
      text: `${prefix}Sync is available again ${whenText(gate.until, now)}.`,
      href: null,
      linkText: null,
    };
  }
  return null;
}

// "Sync due": an ok connection last synced over 24 hours ago. Dismissals last
// for the session (sessionStorage), with an in-memory fallback when it is blocked.
const dismissedMemory = new Set<string>();

function storedDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    // Storage blocked or unreadable: the in-memory set still works.
  }
  return new Set();
}

export function isSyncDue(c: ConnectionSummary, now: Date = new Date()): boolean {
  if (c.status !== 'ok' || !c.last_synced_at) return false;
  const last = new Date(c.last_synced_at).getTime();
  if (Number.isNaN(last) || now.getTime() - last <= DAY_MS) return false;
  return !dismissedMemory.has(c.id) && !storedDismissed().has(c.id);
}

export function dismissSyncDue(id: string): void {
  dismissedMemory.add(id);
  try {
    const all = storedDismissed();
    all.add(id);
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...all]));
  } catch {
    // Kept in memory for this page load.
  }
}

/** Forget the in-memory dismissals (tests). */
export function resetSyncDue(): void {
  dismissedMemory.clear();
}

/** The history title of a connector import, or null for a file import. */
export function historyLabel(
  i: SmartImportSummary,
  connections: readonly ConnectionSummary[] | null
): { title: string; removed: boolean } | null {
  if (i.origin !== 'connector' && !i.connection_id) return null;
  const known = connections?.find((c) => c.id === i.connection_id);
  const name = known ? providerLabel(known.provider) : 'Bank';
  const day = formatDate(i.imported_at, { month: 'short', day: 'numeric' });
  return {
    title: `${name} sync, ${day}`,
    removed: connections !== null && !known,
  };
}

// -------------------------------------------------------------- disconnect

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** What "Disconnect and remove imported data" would undo, from the imports list. */
export function removalPreview(
  imports: readonly SmartImportSummary[],
  connectionId: string
): { syncs: number; transactions: number; balances: number; text: string } {
  const mine = imports.filter((i) => i.connection_id === connectionId);
  const transactions = mine.reduce((n, i) => n + i.txn_new, 0);
  const balances = mine.filter((i) => i.liability_id !== null && i.closing_balance !== null).length;
  if (mine.length === 0) {
    return {
      syncs: 0,
      transactions: 0,
      balances: 0,
      text: 'Nothing has been imported from this connection yet.',
    };
  }
  const parts = [countText(mine.length, 'sync'), countText(transactions, 'transaction')];
  if (balances > 0) parts.push(countText(balances, 'debt balance'));
  return {
    syncs: mine.length,
    transactions,
    balances,
    text:
      `Removes ${list(parts)}, plus any expenses those syncs added. ` +
      'Remembered merchants stay.',
  };
}

/** Disconnecting here cannot revoke access at the provider; say where to do that. */
export function revokeHint(provider: ConnectionProvider): {
  text: string;
  linkText: string | null;
  href: string | null;
} {
  switch (provider) {
    case 'simplefin':
      return {
        text:
          'Finlity cannot revoke access at SimpleFIN. To end it there, disable this app in ' +
          'your SimpleFIN Bridge account.',
        linkText: 'Open SimpleFIN Bridge',
        href: 'https://beta-bridge.simplefin.org/',
      };
    case 'akahu':
      return {
        text:
          'The tokens stay valid at Akahu until you act. To end access, delete the personal ' +
          'app at my.akahu.nz.',
        linkText: 'Open my.akahu.nz',
        href: 'https://my.akahu.nz/',
      };
    default:
      return { text: 'The demo bank holds no real credentials.', linkText: null, href: null };
  }
}

/** The status lines after a Disconnect: what was removed and what was kept. */
export function disconnectResultLines(r: DisconnectResponse): string[] {
  if (!r.remove_data) {
    return [
      r.imports_kept > 0
        ? `Disconnected. The ${countText(r.imports_kept, 'imported sync')} ${
            r.imports_kept === 1 ? 'stays' : 'stay'
          }.`
        : 'Disconnected.',
    ];
  }
  const parts: string[] = [];
  if (r.imports_undone > 0) parts.push(countText(r.imports_undone, 'sync'));
  if (r.deleted.transactions > 0) parts.push(countText(r.deleted.transactions, 'transaction'));
  if (r.deleted.expenses > 0) parts.push(countText(r.deleted.expenses, 'expense'));
  if (r.deleted.snapshots > 0) parts.push(countText(r.deleted.snapshots, 'debt balance'));
  const lines = [parts.length > 0 ? `Disconnected. Removed ${list(parts)}.` : 'Disconnected.'];
  if (r.imports_kept > 0) {
    lines.push(
      `${countText(r.imports_kept, 'sync')} could not be removed and ${
        r.imports_kept === 1 ? 'stays' : 'stay'
      }.`
    );
  }
  return [...lines, ...keptLines(r.kept)];
}

// ------------------------------------------------------------------ errors

/** Fixed copy per error code; server and browser text is never shown. */
const ERROR_COPY: Record<string, string> = {
  connection_busy: 'Another action is running for this connection. Try again in a moment.',
  storage_unavailable:
    'This browser could not open its saved connection details. Try again in a moment.',
  connection_not_found: 'This connection was already removed.',
  connections_unavailable: 'Connected accounts are not available on this deployment.',
};

const GENERIC_ERROR = 'Something went wrong. Check the list and try again.';

function errorFields(error: unknown): { status: number; type: string | null } {
  if (!error || typeof error !== 'object') return { status: 0, type: null };
  const e = error as { status?: unknown; data?: unknown };
  const data = e.data;
  const type =
    data &&
    typeof data === 'object' &&
    typeof (data as { error_type?: unknown }).error_type === 'string'
      ? (data as { error_type: string }).error_type
      : null;
  return { status: typeof e.status === 'number' ? e.status : 0, type };
}

/** The fixed sentence for a failed connections call. */
export function connectionErrorText(error: unknown): string {
  const { status, type } = errorFields(error);
  const copy = type ? ERROR_COPY[type] : undefined;
  if (copy) return copy;
  if (status === 403) return 'Saving is turned off on this site, so nothing was changed.';
  if (status === 429) return 'Too many requests. Try again in a moment.';
  return GENERIC_ERROR;
}

/** True when the connection no longer exists, so the list should refresh. */
export function isConnectionGone(error: unknown): boolean {
  return errorFields(error).type === 'connection_not_found';
}
