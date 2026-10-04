/**
 * Settings > Connected accounts: the list, provider availability, and the
 * Disconnect dialog with its two variants.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/api/client', async () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return { apiCall: vi.fn(), ApiError };
});
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/ui/tabs', () => ({ onTabChange: vi.fn(), showTab: vi.fn(), getCurrentTab: vi.fn() }));

import { apiCall, ApiError } from '@/api/client';
import { showToast } from '@/ui/toast';
import { store } from '@/state/store';
import { loadConnectionsSettings } from '@/features/connections';
import type { ConnectionSummary, DisconnectResponse, SmartImportSummary } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const EM_DASH = String.fromCharCode(0x2014);
const DEMO_ID = 'demo-1';
const PLANTED = '<img src=x onerror="window.__pwned=1">';

function conn(over: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'c1',
    provider: 'simplefin',
    label: 'Everyday bank',
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

let connections: ConnectionSummary[];
let imports: SmartImportSummary[];
let enabled: string[];
let deleteResult: DisconnectResponse;
let failWith: Error | null;
let failList: Error | null;

function route(): void {
  apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (endpoint === '/api/connections' && method === 'GET') {
      if (failList) throw failList;
      return connections;
    }
    if (endpoint === '/api/v2/connectors/status') return { enabled, providers: [] };
    if (endpoint === '/api/smart-import/imports') return imports;
    if (endpoint.startsWith('/api/connections/') && method === 'DELETE') {
      if (failWith) throw failWith;
      const id = decodeURIComponent(endpoint.split('/')[3]!.split('?')[0]!);
      connections = connections.filter((c) => c.id !== id);
      return deleteResult;
    }
    throw new Error(`unexpected ${method} ${endpoint}`);
  });
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const calls = (method: string, prefix: string) =>
  apiCallMock.mock.calls.filter(
    ([e, o]) => e.startsWith(prefix) && ((o as { method?: string })?.method ?? 'GET') === method
  );
const modal = (): HTMLElement | null => document.getElementById('dynamic-modal');
const button = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function openDisconnect(label: string): Promise<HTMLElement> {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.connection-row')).find(
    (r) => r.querySelector('.connection-label')!.textContent === label
  )!;
  (row.querySelector('[data-action="disconnect"]') as HTMLButtonElement).click();
  await flush();
  return modal()!;
}

beforeEach(() => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  apiCallMock.mockReset();
  vi.mocked(showToast).mockReset();
  connections = [
    conn(),
    conn({ id: DEMO_ID, provider: 'demo', label: 'Demo', quota_budget: null, quota_left: null }),
  ];
  imports = [];
  enabled = ['simplefin', 'akahu', 'demo'];
  deleteResult = {
    connection_id: 'c1',
    remove_data: false,
    imports_undone: 0,
    imports_kept: 0,
    deleted: { transactions: 0, recurring_candidates: 0, expenses: 0, snapshots: 0 },
    reassigned: { transactions: 0 },
    kept: [],
  };
  failWith = null;
  failList = null;
  route();
  store.set('dataMode', 'server');
  delete (window as unknown as { __pwned?: number }).__pwned;
});

describe('markup', () => {
  it('adds the section with an index link, ahead of Imported transactions', () => {
    const section = $('settings-connected-accounts');
    expect(section.querySelector('.settings-section-header')!.textContent).toBe(
      'Connected accounts'
    );
    expect(
      document.querySelector('#settings-index [data-section="settings-connected-accounts"]')
    ).not.toBeNull();
    const order = Array.from(document.querySelectorAll('#tab-settings .settings-section')).map(
      (s) => s.id
    );
    expect(order.indexOf('settings-connected-accounts')).toBeLessThan(
      order.indexOf('settings-imported-transactions')
    );
    expect(section.textContent).not.toContain(EM_DASH);
  });

  it('is loaded by the settings page lazily, never imported statically', () => {
    const src = readFileSync(resolve(__dirname, '../../src/pages/settings.ts'), 'utf8');
    expect(src).toMatch(/import\(\s*'@\/features\/connections'\s*\)/);
    expect(src).not.toMatch(/^import .*@\/features\/connections/m);
  });
});

describe('list', () => {
  it('shows provider, label, status chip, last synced, accounts and quota left', async () => {
    await loadConnectionsSettings();
    const rows = document.querySelectorAll('.connection-row');
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.querySelector('.connection-label')!.textContent).toBe('Everyday bank');
    expect(first.querySelector('.connection-provider')!.textContent).toBe('SimpleFIN Bridge');
    const chip = first.querySelector('.connection-chip')!;
    expect(chip.textContent).toBe('Connected');
    expect(chip.className).toContain('badge-success');
    const meta = first.querySelector('.connection-meta')!.textContent!;
    expect(meta).toContain('Last synced Oct 5, 2026');
    expect(meta).toContain('2 of 3 accounts syncing');
    expect(meta).toContain('18 of 20 syncs left today');
    expect(rows[1]!.querySelector('.connection-meta')!.textContent).toContain('No sync limit');
  });

  it('shows the needs-reconnect and subscription chips', async () => {
    connections = [
      conn({ id: 'a', label: 'A', status: 'reconnect_needed' }),
      conn({ id: 'b', label: 'B', status: 'payment_required' }),
    ];
    await loadConnectionsSettings();
    const chips = Array.from(document.querySelectorAll('.connection-chip')).map(
      (c) => c.textContent
    );
    expect(chips).toEqual(['Needs reconnect', 'Subscription issue']);
  });

  it('shows an empty state', async () => {
    connections = [];
    await loadConnectionsSettings();
    expect(document.querySelectorAll('.connection-row')).toHaveLength(0);
    expect($('connections-list').textContent).toContain('No connected accounts yet.');
  });

  it('renders user data as text, never as markup', async () => {
    connections = [conn({ label: PLANTED })];
    await loadConnectionsSettings();
    const label = document.querySelector('.connection-label')!;
    expect(label.textContent).toBe(PLANTED);
    expect(label.children).toHaveLength(0);
    expect(document.querySelector('#connections-list img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('says when connected accounts are not available on a shared deployment', async () => {
    failList = new ApiError(403, 'Forbidden', { error_type: 'connections_unavailable' });
    await loadConnectionsSettings();
    expect($('connections-list').textContent).toBe(
      'Connected accounts are not available on this deployment.'
    );
  });

  it('shows fixed copy, not server text, when the list cannot load', async () => {
    failList = new ApiError(500, 'stack trace here', { error_type: 'server_error' });
    await loadConnectionsSettings();
    expect($('connections-list').textContent).toBe(
      'Something went wrong. Check the list and try again.'
    );
  });
});

describe('providers offered', () => {
  const offered = (): string[] =>
    Array.from(document.querySelectorAll('#connections-providers li')).map((l) => l.textContent!);

  it('lists every provider the status enables', async () => {
    await loadConnectionsSettings();
    expect(offered()).toEqual(['SimpleFIN Bridge', 'Akahu', 'Demo bank']);
  });

  it('hides real providers the status does not list, but always offers the demo', async () => {
    enabled = [];
    await loadConnectionsSettings();
    expect(offered()).toEqual(['Demo bank']);
  });

  it('offers only the demo when the status cannot be read', async () => {
    apiCallMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/api/connections') return [];
      throw new ApiError(500, 'down');
    });
    await loadConnectionsSettings();
    expect(offered()).toEqual(['Demo bank']);
  });
});

describe('Disconnect dialog', () => {
  it('opens a dialog with both variants and the counts for this connection only', async () => {
    imports = [
      imp({ import_id: 'a', txn_new: 100 }),
      imp({ import_id: 'b', txn_new: 212, liability_id: 'l1', closing_balance: 40 }),
      imp({ import_id: 'c', connection_id: 'other', txn_new: 999 }),
    ];
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain(
      'Removes 2 syncs, 312 transactions and 1 debt balance, plus any expenses those syncs ' +
        'added. Remembered merchants stay.'
    );
    expect(button(dialog, 'Disconnect')).toBeDefined();
    expect(button(dialog, 'Disconnect and remove imported data')).toBeDefined();
    expect(dialog.textContent).toContain('cannot revoke');
    const link = dialog.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://beta-bridge.simplefin.org/');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    // Nothing is deleted just by opening the dialog.
    expect(calls('DELETE', '/api/connections')).toHaveLength(0);
  });

  it('confirms before deleting: Cancel changes nothing', async () => {
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    button(dialog, 'Cancel')!.click();
    await flush();
    expect(modal()).toBeNull();
    expect(calls('DELETE', '/api/connections')).toHaveLength(0);
  });

  it('Disconnect calls DELETE with remove_data=false and refreshes the list', async () => {
    imports = [imp({})];
    deleteResult = { ...deleteResult, imports_kept: 1 };
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    button(dialog, 'Disconnect')!.click();
    await flush();
    const dels = calls('DELETE', '/api/connections');
    expect(dels).toHaveLength(1);
    expect(dels[0]![0]).toBe('/api/connections/c1?remove_data=false');
    expect(modal()).toBeNull();
    expect(document.querySelectorAll('.connection-row')).toHaveLength(1);
    expect($('connections-status').textContent).toContain(
      'Disconnected. The 1 imported sync stays.'
    );
  });

  it('Disconnect and remove imported data sends remove_data=true and lists kept items', async () => {
    imports = [imp({ txn_new: 5 })];
    deleteResult = {
      ...deleteResult,
      remove_data: true,
      imports_undone: 1,
      deleted: { transactions: 5, recurring_candidates: 0, expenses: 0, snapshots: 0 },
      kept: [{ table: 'budget_expenses', id: 'e1', reason: 'edited' }],
    };
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    button(dialog, 'Disconnect and remove imported data')!.click();
    await flush();
    expect(calls('DELETE', '/api/connections')[0]![0]).toBe('/api/connections/c1?remove_data=true');
    const status = $('connections-status').textContent!;
    expect(status).toContain('Disconnected. Removed 1 sync and 5 transactions.');
    expect(status).toContain('Kept 1 expense: it was changed after the import.');
  });

  it('offers only a plain disconnect when nothing was imported', async () => {
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    expect(dialog.textContent).toContain('Nothing has been imported from this connection yet.');
    expect(button(dialog, 'Disconnect and remove imported data')).toBeUndefined();
  });

  it('still allows a plain disconnect when the imports cannot be counted', async () => {
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (e: string, o?: { method?: string }) => {
      if (e === '/api/smart-import/imports') throw new ApiError(500, 'x');
      return base(e, o as never);
    });
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    expect(dialog.textContent).toContain('Could not count the imported data.');
    expect(button(dialog, 'Disconnect')).toBeDefined();
  });

  it('shows the Akahu revoke hint and no link for the demo', async () => {
    connections = [
      conn({ id: 'k', provider: 'akahu', label: 'Kiwi' }),
      conn({ id: DEMO_ID, provider: 'demo', label: 'Demo' }),
    ];
    await loadConnectionsSettings();
    let dialog = await openDisconnect('Kiwi');
    expect(dialog.textContent).toContain('personal app');
    expect(dialog.querySelector('a')!.getAttribute('href')).toBe('https://my.akahu.nz/');
    button(dialog, 'Cancel')!.click();
    await flush();
    dialog = await openDisconnect('Demo');
    expect(dialog.querySelector('a')).toBeNull();
  });

  it.each([
    [
      'connection_busy',
      409,
      'Another action is running for this connection. Try again in a moment.',
    ],
    [
      'storage_unavailable',
      503,
      'This browser could not open its saved connection details. Try again in a moment.',
    ],
    ['connection_not_found', 404, 'This connection was already removed.'],
  ])('maps %s to fixed copy and leaves the dialog open', async (code, status, copy) => {
    failWith = new ApiError(status, 'raw server text', { error_type: code, detail: 'raw' });
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    button(dialog, 'Disconnect')!.click();
    await flush();
    expect(dialog.querySelector('.connection-dialog-error')!.textContent).toBe(copy);
    expect(document.body.textContent).not.toContain('raw server text');
    // Buttons come back so the person can retry.
    expect(button(dialog, 'Disconnect')!.disabled).toBe(false);
  });

  it('does not send a second DELETE while one is running', async () => {
    let release: (v: DisconnectResponse) => void = () => undefined;
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (e: string, o?: { method?: string }) => {
      if (o?.method === 'DELETE') return new Promise<DisconnectResponse>((r) => (release = r));
      return base(e, o as never);
    });
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    const btn = button(dialog, 'Disconnect')!;
    btn.click();
    btn.click();
    await flush();
    expect(calls('DELETE', '/api/connections')).toHaveLength(1);
    expect(btn.disabled).toBe(true);
    release(deleteResult);
    await flush();
  });

  it('focuses the result line after a successful Disconnect', async () => {
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    button(dialog, 'Disconnect')!.click();
    await flush();
    expect(modal()).toBeNull();
    expect(document.activeElement).toBe($('connections-status'));
  });

  it('starts on Cancel, never on a destructive button', async () => {
    imports = [imp({})];
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    expect(document.activeElement).toBe(button(dialog, 'Cancel'));
  });

  it('cannot be dismissed by X, backdrop or Escape while a DELETE runs', async () => {
    let release: (v: DisconnectResponse) => void = () => undefined;
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (e: string, o?: { method?: string }) => {
      if (o?.method === 'DELETE') return new Promise<DisconnectResponse>((r) => (release = r));
      return base(e, o as never);
    });
    await loadConnectionsSettings();
    const dialog = await openDisconnect('Everyday bank');
    button(dialog, 'Disconnect')!.click();
    await flush();
    (dialog.querySelector('.modal-close') as HTMLButtonElement).click();
    (dialog.querySelector('.modal-backdrop') as HTMLElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal()).toBe(dialog);
    release(deleteResult);
    await flush();
    expect(modal()).toBeNull();
  });

  it('can be dismissed by Escape when idle', async () => {
    await loadConnectionsSettings();
    await openDisconnect('Everyday bank');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal()).toBeNull();
  });

  it('puts connection names in the dialog as text', async () => {
    connections = [conn({ label: PLANTED })];
    await loadConnectionsSettings();
    const dialog = await openDisconnect(PLANTED);
    expect(dialog.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('status handling', () => {
  const rowOf = (label: string): HTMLElement =>
    Array.from(document.querySelectorAll<HTMLElement>('.connection-row')).find(
      (r) => r.querySelector('.connection-label')!.textContent === label
    )!;
  const sync = (row: HTMLElement): HTMLButtonElement =>
    row.querySelector<HTMLButtonElement>('[data-action="sync"]')!;
  const noteOf = (row: HTMLElement): HTMLElement | null =>
    row.querySelector<HTMLElement>('.connection-note');

  it('disables Sync on reconnect_needed and offers Reconnect with the reason', async () => {
    connections = [conn({ id: 'a', label: 'A', status: 'reconnect_needed' })];
    await loadConnectionsSettings();
    const row = rowOf('A');
    expect(sync(row).disabled).toBe(true);
    expect(row.querySelector('[data-action="reconnect"]')).not.toBeNull();
    expect(noteOf(row)!.textContent).toContain('Reconnect to sync again');
    sync(row).click();
    await flush();
    expect(calls('POST', '/api/connections/a/sync')).toHaveLength(0);
  });

  it('links payment_required to the bridge and keeps Sync available', async () => {
    connections = [conn({ id: 'b', label: 'B', status: 'payment_required' })];
    await loadConnectionsSettings();
    const row = rowOf('B');
    const link = noteOf(row)!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://beta-bridge.simplefin.org/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toBe('Open SimpleFIN Bridge');
    expect(sync(row).disabled).toBe(false);
  });

  it('disables Sync while rate limited and shows when it is available again', async () => {
    connections = [
      conn({ id: 'r', label: 'R', status: 'rate_limited', status_at: new Date().toISOString() }),
    ];
    await loadConnectionsSettings();
    const row = rowOf('R');
    expect(sync(row).disabled).toBe(true);
    expect(noteOf(row)!.textContent).toMatch(/^Sync is available again .* at \d{1,2}:\d{2}/);
    expect(row.querySelector('[data-action="reconnect"]')).toBeNull();
  });

  it('disables Sync when the quota is spent and shows the reset time', async () => {
    connections = [
      conn({
        id: 'q',
        label: 'Q',
        quota_left: 0,
        quota_resets_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
      }),
    ];
    await loadConnectionsSettings();
    const row = rowOf('Q');
    expect(sync(row).disabled).toBe(true);
    expect(noteOf(row)!.textContent).toContain('Sync is available again');
  });

  it('shows no note and an enabled Sync on a healthy connection', async () => {
    await loadConnectionsSettings();
    const row = rowOf('Everyday bank');
    expect(noteOf(row)).toBeNull();
    expect(sync(row).disabled).toBe(false);
  });

  it('keeps a hostile label as text next to a note', async () => {
    connections = [conn({ id: 'x', label: PLANTED, status: 'reconnect_needed' })];
    await loadConnectionsSettings();
    expect(document.querySelector('.connection-label')!.textContent).toBe(PLANTED);
    expect(document.querySelector('.connection-row img')).toBeNull();
  });
});
