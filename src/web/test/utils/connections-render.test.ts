/**
 * Pure helpers for Settings > Connected accounts: status chips, summary lines,
 * the Disconnect preview, revoke hints and fixed error copy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  connectionErrorText,
  dismissSyncDue,
  historyLabel,
  isSyncDue,
  resetSyncDue,
  statusNote,
  syncGate,
  BRIDGE_URL,
  disconnectResultLines,
  lastSyncedText,
  offeredProviders,
  providerLabel,
  quotaText,
  removalPreview,
  revokeHint,
  statusChip,
} from '@/utils/connections-render';
import type { ConnectionSummary, DisconnectResponse, SmartImportSummary } from '@/types/api';

const EM_DASH = String.fromCharCode(0x2014);

function conn(over: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'c1',
    provider: 'simplefin',
    label: 'My bank',
    status: 'ok',
    status_at: '2026-10-06T10:00:00',
    created_at: '2026-10-01T10:00:00',
    last_synced_at: '2026-10-05T09:00:00',
    first_sync_days: 30,
    accounts_count: 3,
    accounts_enabled: 2,
    quota_budget: 20,
    quota_left: 18,
    quota_resets_at: null,
    ...over,
  };
}

function imp(over: Partial<SmartImportSummary>): SmartImportSummary {
  return {
    import_id: 'i1',
    batch_id: 'b1',
    file_name: 'sync',
    origin: 'connector',
    format: 'connector',
    parser: 'connector',
    account_kind: 'checking',
    account_key: 'acct:1',
    account_label: 'Checking',
    account_last4: null,
    institution: null,
    period_start: null,
    period_end: null,
    closing_balance: null,
    closing_balance_date: null,
    liability_id: null,
    txn_new: 10,
    txn_duplicate: 0,
    txn_excluded: 0,
    ai_used: 0,
    ai_provider: null,
    connection_id: 'c1',
    imported_at: '2026-10-05T09:00:00',
    ...over,
  };
}

describe('providerLabel', () => {
  it('names each provider', () => {
    expect(providerLabel('simplefin')).toBe('SimpleFIN Bridge');
    expect(providerLabel('akahu')).toBe('Akahu');
    expect(providerLabel('demo')).toBe('Demo bank');
  });
});

describe('statusChip', () => {
  it.each([
    ['ok', 'Connected', 'success'],
    ['accounts_pending', 'Accounts not loaded', 'warning'],
    ['reconnect_needed', 'Needs reconnect', 'danger'],
    ['payment_required', 'Subscription issue', 'danger'],
    ['error', 'Sync problem', 'warning'],
  ] as const)('%s reads %s', (status, text, tone) => {
    expect(statusChip(conn({ status }))).toEqual({ text, tone });
  });

  it('says when a rate limited connection can sync again', () => {
    const chip = statusChip(
      conn({ status: 'rate_limited', status_at: '2026-10-06T10:00:00' }),
      NOW
    );
    expect(chip.tone).toBe('warning');
    expect(chip.text).toMatch(/^Rate limited until Oct 7/);
  });

  it('drops the rate limited chip once the gate has opened', () => {
    const chip = statusChip(
      conn({ status: 'rate_limited', status_at: '2026-10-04T10:00:00' }),
      NOW
    );
    expect(chip.text).not.toContain('Rate limited');
    expect(chip).toEqual(statusChip(conn({ status: 'ok' }), NOW));
  });
});

describe('summary lines', () => {
  it('says never synced, or the last sync day', () => {
    expect(lastSyncedText(conn({ last_synced_at: null }))).toBe('Never synced');
    expect(lastSyncedText(conn())).toBe('Last synced Oct 5, 2026');
  });

  it('shows the accounts that are on', () => {
    expect(quotaText(conn())).toBe('18 of 20 syncs left today');
    expect(quotaText(conn({ quota_left: 1, quota_budget: 20 }))).toBe('1 of 20 syncs left today');
  });

  it('says the demo is unlimited and when a spent quota resets', () => {
    expect(quotaText(conn({ provider: 'demo', quota_budget: null, quota_left: null }))).toBe(
      'No sync limit'
    );
    expect(quotaText(conn({ quota_left: 0, quota_resets_at: '2026-10-06T22:30:00' }))).toMatch(
      /^No syncs left until /
    );
  });
});

describe('offeredProviders', () => {
  it('always offers the demo and real providers only when the status lists them', () => {
    expect(offeredProviders(null)).toEqual(['demo']);
    expect(offeredProviders([])).toEqual(['demo']);
    expect(offeredProviders(['simplefin'])).toEqual(['simplefin', 'demo']);
    expect(offeredProviders(['demo', 'akahu', 'simplefin', 'bogus'])).toEqual([
      'simplefin',
      'akahu',
      'demo',
    ]);
  });
});

describe('removalPreview', () => {
  it('counts only this connection: syncs, transactions and debt balances', () => {
    const list = [
      imp({ import_id: 'a', txn_new: 100 }),
      imp({ import_id: 'b', txn_new: 212, liability_id: 'l1', closing_balance: 500 }),
      imp({ import_id: 'c', connection_id: 'other', txn_new: 999 }),
      imp({ import_id: 'd', connection_id: null, txn_new: 999 }),
      imp({ import_id: 'e', txn_new: 0, liability_id: 'l1', closing_balance: 1 }),
    ];
    const p = removalPreview(list, 'c1');
    expect(p).toMatchObject({ syncs: 3, transactions: 312, balances: 2 });
    expect(p.text).toBe(
      'Removes 3 syncs, 312 transactions and 2 debt balances, plus any expenses those syncs ' +
        'added. Remembered merchants stay.'
    );
  });

  it('uses singular nouns and omits a zero balance count', () => {
    const p = removalPreview([imp({ txn_new: 1 })], 'c1');
    expect(p.text).toBe(
      'Removes 1 sync and 1 transaction, plus any expenses those syncs added. ' +
        'Remembered merchants stay.'
    );
  });

  it('has nothing to remove when no import came from the connection', () => {
    const p = removalPreview([imp({ connection_id: 'x' })], 'c1');
    expect(p.syncs).toBe(0);
    expect(p.text).toBe('Nothing has been imported from this connection yet.');
  });
});

describe('revokeHint', () => {
  it('tells SimpleFIN users where to revoke', () => {
    const h = revokeHint('simplefin');
    expect(h.text).toContain('cannot revoke');
    expect(h.href).toBe('https://beta-bridge.simplefin.org/');
  });

  it('tells Akahu users to delete the personal app', () => {
    const h = revokeHint('akahu');
    expect(h.text).toContain('personal app');
    expect(h.href).toBe('https://my.akahu.nz/');
  });

  it('has no link for the demo', () => {
    expect(revokeHint('demo').href).toBeNull();
  });
});

describe('disconnectResultLines', () => {
  const base: DisconnectResponse = {
    connection_id: 'c1',
    remove_data: true,
    imports_undone: 3,
    imports_kept: 0,
    deleted: { transactions: 312, recurring_candidates: 2, expenses: 1, snapshots: 2 },
    reassigned: { transactions: 0 },
    kept: [],
  };

  it('summarizes what was removed and lists what was kept', () => {
    const lines = disconnectResultLines({
      ...base,
      kept: [{ table: 'budget_expenses', id: 'e1', reason: 'edited' }],
    });
    expect(lines[0]).toBe(
      'Disconnected. Removed 3 syncs, 312 transactions, 1 expense and 2 debt balances.'
    );
    expect(lines).toContain('Kept 1 expense: it was changed after the import.');
  });

  it('says a plain disconnect kept the imported data', () => {
    expect(
      disconnectResultLines({
        ...base,
        remove_data: false,
        imports_undone: 0,
        imports_kept: 4,
        deleted: { transactions: 0, recurring_candidates: 0, expenses: 0, snapshots: 0 },
      })
    ).toEqual(['Disconnected. The 4 imported syncs stay.']);
    expect(
      disconnectResultLines({
        ...base,
        remove_data: false,
        imports_undone: 0,
        imports_kept: 0,
        deleted: { transactions: 0, recurring_candidates: 0, expenses: 0, snapshots: 0 },
      })
    ).toEqual(['Disconnected.']);
  });
});

describe('connectionErrorText', () => {
  const err = (status: number, error_type?: string): Error =>
    Object.assign(new Error('raw server text'), {
      status,
      data: error_type ? { error_type, detail: 'raw detail' } : undefined,
    });

  it('maps error codes to fixed copy', () => {
    expect(connectionErrorText(err(409, 'connection_busy'))).toBe(
      'Another action is running for this connection. Try again in a moment.'
    );
    expect(connectionErrorText(err(503, 'storage_unavailable'))).toBe(
      'This browser could not open its saved connection details. Try again in a moment.'
    );
    expect(connectionErrorText(err(404, 'connection_not_found'))).toBe(
      'This connection was already removed.'
    );
    expect(connectionErrorText(err(403, 'connections_unavailable'))).toBe(
      'Connected accounts are not available on this deployment.'
    );
  });

  it('never shows the server text for an unknown failure', () => {
    for (const e of [err(500, 'weird_new_code'), err(422), new Error('Network error')]) {
      const text = connectionErrorText(e);
      expect(text).not.toContain('raw');
      expect(text).toBe('Something went wrong. Check the list and try again.');
    }
  });

  it('uses the protected-site wording for a plain 403', () => {
    expect(connectionErrorText(err(403))).toBe(
      'Saving is turned off on this site, so nothing was changed.'
    );
  });
});

describe('copy', () => {
  it('has no em-dash', () => {
    const all = [
      removalPreview([imp({})], 'c1').text,
      revokeHint('simplefin').text,
      revokeHint('akahu').text,
      statusChip(conn({ status: 'rate_limited', status_at: '2026-10-06T10:00:00' }), NOW).text,
      quotaText(conn({ quota_left: 0, quota_resets_at: '2026-10-06T22:30:00' })),
    ].join(' ');
    expect(all).not.toContain(EM_DASH);
  });
});

// ------------------------------------------------------- status handling (C4)

const NOW = new Date(2026, 9, 6, 10, 0, 0);
const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min, 0).toISOString();
const squash = (t: string): string => t.replace(/\s/g, ' ');

describe('syncGate', () => {
  it('lets an ok connection sync', () => {
    expect(syncGate(conn(), NOW)).toEqual({ blocked: false, reason: null, until: null });
  });

  it('blocks reconnect_needed with no time', () => {
    expect(syncGate(conn({ status: 'reconnect_needed' }), NOW)).toEqual({
      blocked: true,
      reason: 'reconnect',
      until: null,
    });
  });

  it('blocks rate_limited until the next local midnight after status_at', () => {
    const g = syncGate(conn({ status: 'rate_limited', status_at: iso(2026, 10, 6, 9, 0) }), NOW);
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe('time');
    expect(g.until!.getTime()).toBe(new Date(2026, 9, 7, 0, 0, 0).getTime());
  });

  it('lets a rate_limited connection sync once that time has passed', () => {
    const g = syncGate(conn({ status: 'rate_limited', status_at: iso(2026, 10, 4, 9, 0) }), NOW);
    expect(g.blocked).toBe(false);
  });

  it('blocks a spent quota until quota_resets_at, and not after it', () => {
    const spent = { quota_left: 0, quota_resets_at: iso(2026, 10, 6, 15, 15) };
    const g = syncGate(conn(spent), NOW);
    expect(g).toMatchObject({ blocked: true, reason: 'time' });
    expect(g.until!.getTime()).toBe(new Date(2026, 9, 6, 15, 15).getTime());
    expect(syncGate(conn({ ...spent, quota_resets_at: iso(2026, 10, 6, 9, 0) }), NOW).blocked).toBe(
      false
    );
  });

  it('does not block payment_required (a retry clears it)', () => {
    expect(syncGate(conn({ status: 'payment_required' }), NOW).blocked).toBe(false);
  });
});

describe('statusNote', () => {
  it('is null for a healthy connection', () => {
    expect(statusNote(conn(), NOW)).toBeNull();
  });

  it('asks for a reconnect and says the accounts are kept', () => {
    const n = statusNote(conn({ status: 'reconnect_needed' }), NOW)!;
    expect(n.text).toBe(
      'Finlity cannot read this connection any more. Reconnect to sync again. Your account choices are kept.'
    );
    expect(n.href).toBeNull();
  });

  it('links a subscription issue to the bridge', () => {
    const n = statusNote(conn({ status: 'payment_required' }), NOW)!;
    expect(n.href).toBe(BRIDGE_URL);
    expect(n.linkText).toBe('Open SimpleFIN Bridge');
    expect(n.text).toContain('subscription');
  });

  it('has no bridge link for a provider other than SimpleFIN', () => {
    expect(
      statusNote(conn({ provider: 'akahu', status: 'payment_required' }), NOW)!.href
    ).toBeNull();
  });

  it('shows the local time rate limiting ends, with the date when it is another day', () => {
    const n = statusNote(conn({ status: 'rate_limited', status_at: iso(2026, 10, 6, 9, 0) }), NOW)!;
    expect(squash(n.text)).toBe('Sync is available again Oct 7 at 12:00 AM.');
  });

  it('shows only the time for a quota that resets today', () => {
    const n = statusNote(conn({ quota_left: 0, quota_resets_at: iso(2026, 10, 6, 15, 15) }), NOW)!;
    expect(squash(n.text)).toBe(
      'This connection\u2019s syncs for the last 24 hours are used up. ' +
        'Sync is available again at 3:15 PM.'
    );
  });

  it('uses no em-dash', () => {
    for (const c of [
      conn({ status: 'reconnect_needed' }),
      conn({ status: 'payment_required' }),
      conn({ quota_left: 0, quota_resets_at: iso(2026, 10, 7, 1, 0) }),
    ]) {
      expect(statusNote(c, NOW)!.text).not.toContain(EM_DASH);
    }
  });
});

describe('isSyncDue', () => {
  beforeEach(() => {
    resetSyncDue();
    sessionStorage.clear();
  });
  const at = (h: number): string => new Date(NOW.getTime() - h * 3600_000).toISOString();

  it('is due for an ok connection last synced more than 24 hours ago', () => {
    expect(isSyncDue(conn({ last_synced_at: at(25) }), NOW)).toBe(true);
  });

  it('is not due at 24 hours or less', () => {
    expect(isSyncDue(conn({ last_synced_at: at(24) }), NOW)).toBe(false);
    expect(isSyncDue(conn({ last_synced_at: at(3) }), NOW)).toBe(false);
  });

  it('is not due for other statuses, or when never synced', () => {
    expect(isSyncDue(conn({ status: 'reconnect_needed', last_synced_at: at(72) }), NOW)).toBe(
      false
    );
    expect(isSyncDue(conn({ status: 'rate_limited', last_synced_at: at(72) }), NOW)).toBe(false);
    expect(isSyncDue(conn({ last_synced_at: null }), NOW)).toBe(false);
  });

  it('stays dismissed for the session, per connection, in sessionStorage', () => {
    const c = conn({ last_synced_at: at(30) });
    dismissSyncDue('c1');
    expect(isSyncDue(c, NOW)).toBe(false);
    expect(isSyncDue({ ...c, id: 'c2' }, NOW)).toBe(true);
    expect(sessionStorage.getItem('finlity.syncDueDismissed')).toBe('["c1"]');
  });

  it('falls back to memory when sessionStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const c = conn({ last_synced_at: at(30) });
    expect(isSyncDue(c, NOW)).toBe(true);
    dismissSyncDue('c1');
    expect(isSyncDue(c, NOW)).toBe(false);
    spy.mockRestore();
    set.mockRestore();
  });
});

describe('historyLabel', () => {
  const connections = [conn()];
  const imp = (over: Partial<SmartImportSummary>): SmartImportSummary =>
    ({
      origin: 'connector',
      connection_id: 'c1',
      imported_at: '2026-10-06T15:00:00',
      file_name: 'sync.json',
      ...over,
    }) as SmartImportSummary;

  it('is null for a file import', () => {
    expect(historyLabel(imp({ origin: 'upload', connection_id: null }), connections)).toBeNull();
  });

  it('names the provider and the date', () => {
    expect(historyLabel(imp({}), connections)).toEqual({
      title: 'SimpleFIN Bridge sync, Oct 6',
      removed: false,
    });
  });

  it('marks an import whose connection was removed', () => {
    expect(historyLabel(imp({ connection_id: 'gone' }), connections)).toEqual({
      title: 'Bank sync, Oct 6',
      removed: true,
    });
  });

  it('does not claim removal when the connections are unknown', () => {
    expect(historyLabel(imp({}), null)).toEqual({ title: 'Bank sync, Oct 6', removed: false });
  });
});
