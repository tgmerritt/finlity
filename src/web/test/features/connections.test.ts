/**
 * The Connect dialog and account mapping (plan C2, design 10 and 12): provider
 * step, credential step (password fields, cleared after submit, never
 * prefilled, nothing kept), the mode-dependent disclosure, error copy, the
 * first-sync range, the mapping step and Save.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
vi.mock('@/utils/debt-wizard-launcher', () => ({ openDebtWizardLazy: vi.fn() }));
vi.mock('@/pages/budget', () => ({ showBudgetTab: vi.fn(), loadBudgetTab: vi.fn() }));

import { apiCall, ApiError } from '@/api/client';
import { showToast } from '@/ui/toast';
import { closeDynamicModal } from '@/ui/modal';
import { store } from '@/state/store';
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import {
  connectDialogState,
  loadConnectionsSettings,
  openConnectDialog,
  syncNow,
} from '@/features/connections';
import type {
  ApplyRequest,
  ConnectionAccount,
  ConnectionListingResponse,
  ConnectorSyncResponse,
  NormalizedStatement,
  ConnectionSummary,
  LiabilityResponse,
  SmartImportContext,
} from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const EM_DASH = String.fromCharCode(0x2014);
const PLANTED = 'PLANTED-k3y-9f2e1d';
const PLANTED_URL = `https://u:${PLANTED}@bridge.simplefin.org/simplefin`;

function account(over: Partial<ConnectionAccount> = {}): ConnectionAccount {
  return {
    provider_account_id: 'demo-card',
    name: 'Demo Rewards Card',
    institution: 'Demo bank',
    currency: 'USD',
    kind: 'credit_card',
    role: 'debt',
    label: 'Demo Rewards Card',
    account_key: 'acct:card',
    liability_id: 'debt-visa',
    flip_balance: false,
    same_as_key: null,
    next_since: '2026-07-08',
    ...over,
  };
}

function listing(over: Partial<ConnectionListingResponse> = {}): ConnectionListingResponse {
  return {
    id: 'new-1',
    provider: 'demo',
    label: 'Demo bank',
    status: 'ok',
    status_at: '2026-10-06T10:00:00',
    created_at: '2026-10-06T10:00:00',
    last_synced_at: null,
    first_sync_days: 90,
    accounts_count: 2,
    accounts_enabled: 2,
    quota_budget: null,
    quota_left: null,
    quota_resets_at: null,
    windows: [],
    accounts: [
      account(),
      account({
        provider_account_id: 'demo-chk',
        name: 'Demo Everyday',
        kind: 'checking',
        role: 'cash_flow',
        label: 'Demo Everyday',
        account_key: 'acct:chk',
        liability_id: null,
      }),
    ],
    account_errors: [],
    accounts_error: null,
    ...over,
  };
}

const visa = {
  id: 'debt-visa',
  name: 'Visa card',
  liability_type: 'credit_card',
  lender: 'Demo bank',
  is_active: true,
} as LiabilityResponse;
const loan = {
  id: 'debt-car',
  name: 'Car loan',
  liability_type: 'auto_loan',
  lender: null,
  is_active: true,
} as LiabilityResponse;

const context: SmartImportContext = {
  rules: [],
  categories: [],
  accounts: [
    {
      account_key: 'acct:file-visa',
      label: 'Visa from files',
      last4: '4242',
      kind: 'credit_card',
      institution: null,
      liability_id: null,
    },
  ],
  csv_layouts: [] as unknown as SmartImportContext['csv_layouts'],
  settings: {} as SmartImportContext['settings'],
};

let enabled: string[];
let createResult: ConnectionListingResponse | Error;
let refreshResult: ConnectionListingResponse | Error;
let connections: ConnectionSummary[];
let liabilities: LiabilityResponse[];

function route(): void {
  apiCallMock.mockImplementation(
    async (endpoint: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET';
      if (endpoint === '/api/connections' && method === 'GET') return connections;
      if (endpoint === '/api/v2/connectors/status') return { enabled, providers: [] };
      if (endpoint === '/api/smart-import/imports') return [];
      if (endpoint === '/api/smart-import/context') return context;
      if (endpoint === '/api/liabilities') return liabilities;
      if (endpoint === '/api/connections' && method === 'POST') {
        if (createResult instanceof Error) throw createResult;
        return createResult;
      }
      if (/^\/api\/connections\/[^/]+\/credentials$/.test(endpoint)) {
        if (createResult instanceof Error) throw createResult;
        return createResult;
      }
      if (/^\/api\/connections\/[^/]+\/accounts$/.test(endpoint)) {
        if (refreshResult instanceof Error) throw refreshResult;
        return refreshResult;
      }
      if (/^\/api\/connections\/[^/]+$/.test(endpoint) && method === 'GET') return listing();
      if (/^\/api\/connections\/[^/]+$/.test(endpoint) && method === 'PUT') return listing();
      throw new Error(`unexpected ${method} ${endpoint}`);
    }
  );
}

const modal = (): HTMLElement | null => document.getElementById('dynamic-modal');
const button = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
const calls = (method: string, prefix: string) =>
  apiCallMock.mock.calls.filter(
    ([e, o]) => e.startsWith(prefix) && ((o as { method?: string })?.method ?? 'GET') === method
  );
const input = (name: string): HTMLInputElement =>
  modal()!.querySelector(`[data-credential="${name}"]`) as HTMLInputElement;
/** The whole document as markup, attributes included. */
const markup = (): string => new XMLSerializer().serializeToString(document.body);

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function pick(provider: string): Promise<HTMLElement> {
  await openConnectDialog();
  await flush();
  (modal()!.querySelector(`[data-provider="${provider}"]`) as HTMLButtonElement).click();
  await flush();
  return modal()!;
}

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(): Promise<void> {
  button(modal()!, 'Connect')!.click();
  await flush();
}

beforeEach(() => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(...Array.from(parsed.body.childNodes));
  apiCallMock.mockReset();
  vi.mocked(openDebtWizardLazy).mockReset();
  enabled = ['simplefin', 'akahu', 'demo'];
  createResult = listing();
  refreshResult = listing();
  connections = [];
  liabilities = [visa, loan];
  route();
  store.set('dataMode', 'server');
});

afterEach(() => {
  modal()?.remove();
});

describe('entry', () => {
  it('adds a Connect button to Settings > Connected accounts', async () => {
    await loadConnectionsSettings();
    const connect = document.querySelector<HTMLButtonElement>(
      '#settings-connected-accounts [data-action="connect"]'
    )!;
    expect(connect.textContent).toBe('Connect a bank');
    connect.click();
    await flush();
    expect(modal()!.querySelector('[data-provider="demo"]')).not.toBeNull();
  });
});

describe('provider step', () => {
  it('shows the SimpleFIN price line and the Akahu personal app line', async () => {
    await openConnectDialog();
    await flush();
    const dialog = modal()!;
    const simplefin = dialog.querySelector('[data-provider="simplefin"]')!;
    expect(simplefin.textContent).toContain(
      'Your SimpleFIN Bridge subscription costs $1.50 a month or $15 a year, paid to SimpleFIN.'
    );
    expect(dialog.querySelector('[data-provider="akahu"]')!.textContent).toContain(
      'Create a free personal app at my.akahu.nz and paste its two tokens.'
    );
    expect(dialog.querySelector('[data-provider="demo"]')!.textContent).toContain(
      'Try a demo bank (synthetic data)'
    );
    expect(dialog.textContent).not.toContain(EM_DASH);
  });

  it('offers only the demo when the status does not enable real providers', async () => {
    enabled = ['demo'];
    await openConnectDialog();
    await flush();
    expect(modal()!.querySelector('[data-provider="simplefin"]')).toBeNull();
    expect(modal()!.querySelector('[data-provider="akahu"]')).toBeNull();
    expect(modal()!.querySelector('[data-provider="demo"]')).not.toBeNull();
  });
});

describe('credential step', () => {
  it('uses password inputs with autocomplete and spellcheck off, empty', async () => {
    let dialog = await pick('simplefin');
    const secret = input('secret');
    expect(secret.type).toBe('password');
    expect(secret.getAttribute('autocomplete')).toBe('off');
    expect(secret.getAttribute('spellcheck')).toBe('false');
    expect(secret.value).toBe('');
    button(dialog, 'Back')!.click();
    await flush();
    (modal()!.querySelector('[data-provider="akahu"]') as HTMLButtonElement).click();
    await flush();
    dialog = modal()!;
    for (const name of ['user_token', 'app_token']) {
      const el = input(name);
      expect(el.type).toBe('password');
      expect(el.getAttribute('autocomplete')).toBe('off');
      expect(el.getAttribute('spellcheck')).toBe('false');
      expect(el.value).toBe('');
    }
    expect(dialog.querySelector('[data-credential="secret"]')).toBeNull();
  });

  it('demo connect needs no input and sends the chosen range', async () => {
    const dialog = await pick('demo');
    expect(dialog.querySelectorAll('[data-credential]')).toHaveLength(0);
    const range = dialog.querySelector<HTMLSelectElement>('select[data-field="first-sync"]')!;
    expect(Array.from(range.options).map((o) => o.value)).toEqual(['30', '60', '90']);
    expect(range.value).toBe('90');
    range.value = '30';
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await submit();
    const posts = calls('POST', '/api/connections');
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]).toMatchObject({ body: { provider: 'demo', first_sync_days: 30 } });
  });

  it('sends a setup token, or an Access URL when it starts with https://', async () => {
    await pick('simplefin');
    type(input('secret'), ' c2V0dXA= ');
    await submit();
    expect(calls('POST', '/api/connections')[0]![1]).toMatchObject({
      body: { provider: 'simplefin', setup_token: 'c2V0dXA=' },
    });
    modal()!.remove();
    await pick('simplefin');
    type(input('secret'), PLANTED_URL);
    await submit();
    expect(calls('POST', '/api/connections')[1]![1]).toMatchObject({
      body: { provider: 'simplefin', access_url: PLANTED_URL },
    });
  });

  it('asks for the credential instead of sending an empty one', async () => {
    const dialog = await pick('akahu');
    type(input('user_token'), 'u');
    await submit();
    expect(calls('POST', '/api/connections')).toHaveLength(0);
    expect(dialog.querySelector('.connect-error')!.textContent).toContain('Paste');
  });

  it('clears the inputs right after submit, before the answer arrives', async () => {
    let release: (v: ConnectionListingResponse) => void = () => undefined;
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (e: string, o?: { method?: string }) => {
      if (e === '/api/connections' && o?.method === 'POST') {
        return new Promise<ConnectionListingResponse>((r) => (release = r));
      }
      return base(e, o as never);
    });
    await pick('akahu');
    type(input('user_token'), PLANTED);
    type(input('app_token'), `${PLANTED}-app`);
    button(modal()!, 'Connect')!.click();
    await flush();
    expect(input('user_token').value).toBe('');
    expect(input('app_token').value).toBe('');
    // In flight: the dialog cannot be dismissed and Connect cannot be pressed twice.
    (modal()!.querySelector('.modal-close') as HTMLButtonElement).click();
    expect(modal()).not.toBeNull();
    expect(button(modal()!, 'Connect')!.disabled).toBe(true);
    release(listing({ provider: 'akahu' }));
    await flush();
    expect(modal()!.querySelector('[data-account="demo-card"]')).not.toBeNull();
  });

  it('leaves no trace of a planted credential in state, DOM or console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    // A server that echoes the credential in its message and detail.
    createResult = new ApiError(422, `bad ${PLANTED}`, {
      error_type: 'host_not_allowed',
      detail: PLANTED_URL,
    });
    try {
      await pick('simplefin');
      type(input('secret'), PLANTED_URL);
      await submit();
      const dialog = modal()!;
      expect(dialog.querySelector('.connect-error')!.textContent).toBe(
        'That Access URL does not point to SimpleFIN Bridge, so it was not used.'
      );
      for (const el of Array.from(document.querySelectorAll('input'))) {
        expect(el.value).not.toContain(PLANTED);
        expect(el.getAttribute('value') ?? '').not.toContain(PLANTED);
      }
      expect(markup()).not.toContain(PLANTED);
      expect(document.body.textContent).not.toContain(PLANTED);
      expect(JSON.stringify(connectDialogState())).not.toContain(PLANTED);
      expect(JSON.stringify(store.getState())).not.toContain(PLANTED);
      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(PLANTED);
      }
      // Back and forward again: the field is never refilled.
      button(dialog, 'Back')!.click();
      await flush();
      (modal()!.querySelector('[data-provider="simplefin"]') as HTMLButtonElement).click();
      await flush();
      expect(input('secret').value).toBe('');
      // A success also leaves nothing behind.
      createResult = listing({ provider: 'simplefin' });
      type(input('secret'), PLANTED);
      await submit();
      expect(markup()).not.toContain(PLANTED);
      expect(JSON.stringify(connectDialogState())).not.toContain(PLANTED);
      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(PLANTED);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('shows the compromised-token advice for claim_refused', async () => {
    createResult = new ApiError(422, 'x', { error_type: 'claim_refused', detail: 'x' });
    await pick('simplefin');
    type(input('secret'), 'dG9rZW4=');
    await submit();
    const text = modal()!.querySelector('.connect-error')!.textContent!;
    expect(text).toContain('may be compromised');
    expect(text).toContain('disable it at SimpleFIN Bridge');
  });

  it.each(['claim_not_saved', 'claim_timeout'])(
    'asks for a new setup token after %s',
    async (code) => {
      createResult = new ApiError(502, 'x', { error_type: code, detail: 'x' });
      await pick('simplefin');
      type(input('secret'), 'dG9rZW4=');
      await submit();
      expect(modal()!.querySelector('.connect-error')!.textContent).toContain(
        'Create a new setup token at SimpleFIN Bridge'
      );
      expect(input('secret').value).toBe('');
    }
  );

  it('says where the credential goes in server mode', async () => {
    const dialog = await pick('simplefin');
    const details = dialog.querySelector('details.connect-disclosure')!;
    expect(details.querySelector('summary')!.textContent).toBe('What Finlity does with this');
    expect(details.textContent).toContain('encrypted and stored in this server’s database');
    expect(details.textContent).not.toContain('sealed in this browser');
  });

  it('says where the credential goes in hosted mode', async () => {
    store.set('dataMode', 'local');
    const dialog = await pick('akahu');
    const text = dialog.querySelector('details.connect-disclosure')!.textContent!;
    expect(text).toContain('sealed in this browser');
    expect(text).toContain('Your tokens are sealed in this browser');
    expect(text).toContain('passes them through Finlity’s server');
    expect(text).toContain('does not store them or log them');
    expect(text).toContain('not against a script running inside this page');
    expect(text).not.toContain('this server’s database');
  });
});

describe('reconnect', () => {
  const broken: ConnectionSummary = {
    id: 'c-old',
    provider: 'simplefin',
    label: 'Everyday bank',
    status: 'reconnect_needed',
    status_at: '2026-10-06T10:00:00',
    created_at: '2026-10-01T10:00:00',
    last_synced_at: null,
    first_sync_days: 90,
    accounts_count: 1,
    accounts_enabled: 1,
    quota_budget: 20,
    quota_left: 20,
    quota_resets_at: null,
  };

  it('opens on the credential step with empty fields and posts to /credentials', async () => {
    await openConnectDialog({ reconnect: broken });
    await flush();
    expect(input('secret').value).toBe('');
    expect(modal()!.querySelector('[data-field="first-sync"]')).toBeNull();
    type(input('secret'), 'bmV3');
    button(modal()!, 'Reconnect')!.click();
    await flush();
    const posts = calls('POST', '/api/connections/c-old/credentials');
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]).toMatchObject({ body: { setup_token: 'bmV3' } });
    expect(modal()!.querySelector('[data-credential]')).toBeNull();
  });

  it('keeps the connection id and its mapping: no new connection, no mapping write', async () => {
    await openConnectDialog({ reconnect: broken });
    await flush();
    type(input('secret'), 'bmV3');
    button(modal()!, 'Reconnect')!.click();
    await flush();
    const writes = apiCallMock.mock.calls.filter(([e, o]) => {
      const method = (o as { method?: string } | undefined)?.method ?? 'GET';
      return method !== 'GET' && e.startsWith('/api/connections');
    });
    expect(writes.map(([e, o]) => `${(o as { method: string }).method} ${e}`)).toEqual([
      'POST /api/connections/c-old/credentials',
    ]);
  });

  it('stays on the credential step when the provider refuses a pasted credential', async () => {
    createResult = listing({
      id: 'c-old',
      provider: 'simplefin',
      status: 'reconnect_needed',
      accounts_error: 'reconnect_needed',
    });
    await openConnectDialog({ reconnect: broken });
    await flush();
    type(input('secret'), PLANTED_URL);
    button(modal()!, 'Reconnect')!.click();
    await flush();
    expect(input('secret')).not.toBeNull();
    expect(input('secret').value).toBe('');
    expect(modal()!.querySelector('.connect-error')!.textContent).toBe(
      'The provider did not accept these credentials. Check them and try again.'
    );
    expect(modal()!.textContent).not.toContain('Accounts not loaded yet.');
    expect(markup()).not.toContain(PLANTED);
  });

  it('offers Reconnect on a row that needs it', async () => {
    connections = [broken];
    await loadConnectionsSettings();
    const btn = document.querySelector<HTMLButtonElement>('[data-action="reconnect"]')!;
    btn.click();
    await flush();
    expect(input('secret').value).toBe('');
  });
});

describe('mapping step', () => {
  async function connectDemo(): Promise<HTMLElement> {
    await pick('demo');
    await submit();
    return modal()!;
  }

  it('lists each account with role, kind, label, debt and same as', async () => {
    const dialog = await connectDemo();
    const card = dialog.querySelector('[data-account="demo-card"]')!;
    expect(card.textContent).toContain('Demo Rewards Card');
    expect((card.querySelector('[data-map="role"]') as HTMLSelectElement).value).toBe('debt');
    expect((card.querySelector('[data-map="kind"]') as HTMLSelectElement).value).toBe(
      'credit_card'
    );
    expect((card.querySelector('[data-map="label"]') as HTMLInputElement).value).toBe(
      'Demo Rewards Card'
    );
    const debt = card.querySelector('[data-map="debt"]') as HTMLSelectElement;
    expect(debt.value).toBe('debt-visa');
    expect(Array.from(debt.options).map((o) => o.value)).toEqual(['', 'debt-visa']);
    expect(card.textContent).toContain('Suggested match');
    const sameAs = card.querySelector('[data-map="same-as"]') as HTMLSelectElement;
    expect(Array.from(sameAs.options).map((o) => o.textContent)).toEqual([
      'Keep separate',
      'Visa from files (ending 4242)',
    ]);
    // A spending account has no debt picker.
    const chk = dialog.querySelector('[data-account="demo-chk"]')!;
    expect(chk.querySelector('[data-map="debt"]')).toBeNull();
  });

  it('Save sends only the changes with PUT and shows Done', async () => {
    const dialog = await connectDemo();
    const chk = dialog.querySelector('[data-account="demo-chk"]')!;
    const label = chk.querySelector('[data-map="label"]') as HTMLInputElement;
    label.value = 'Bills';
    label.dispatchEvent(new Event('input', { bubbles: true }));
    const role = dialog.querySelector(
      '[data-account="demo-card"] [data-map="role"]'
    ) as HTMLSelectElement;
    role.value = 'ignore';
    role.dispatchEvent(new Event('change', { bubbles: true }));
    button(modal()!, 'Save')!.click();
    await flush();
    const puts = calls('PUT', '/api/connections/new-1');
    expect(puts).toHaveLength(1);
    expect(puts[0]![1]).toEqual({
      method: 'PUT',
      body: {
        accounts: {
          'demo-chk': { label: 'Bills' },
          'demo-card': { role: 'ignore', liability_id: null },
        },
      },
    });
    expect(modal()!.textContent).toContain('Connected');
    expect(button(modal()!, 'Done')).toBeDefined();
  });

  it('Save with no changes skips the PUT', async () => {
    const dialog = await connectDemo();
    button(dialog, 'Save')!.click();
    await flush();
    expect(calls('PUT', '/api/connections')).toHaveLength(0);
    expect(button(modal()!, 'Done')).toBeDefined();
  });

  it('links a chosen debt and a "same as" account', async () => {
    const dialog = await connectDemo();
    const card = dialog.querySelector('[data-account="demo-card"]')!;
    const sameAs = card.querySelector('[data-map="same-as"]') as HTMLSelectElement;
    sameAs.value = 'acct:file-visa';
    sameAs.dispatchEvent(new Event('change', { bubbles: true }));
    const debt = modal()!.querySelector(
      '[data-account="demo-card"] [data-map="debt"]'
    ) as HTMLSelectElement;
    debt.value = '';
    debt.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modal()!.querySelector('[data-account="demo-card"]')!.textContent).not.toContain(
      'Suggested match'
    );
    button(modal()!, 'Save')!.click();
    await flush();
    expect(calls('PUT', '/api/connections/new-1')[0]![1]).toMatchObject({
      body: {
        accounts: { 'demo-card': { same_as_key: 'acct:file-visa', liability_id: null } },
      },
    });
  });

  it('"Add as a new debt" opens the debt wizard and comes back with it linked', async () => {
    const wizardModal = document.createElement('div');
    vi.mocked(openDebtWizardLazy).mockImplementation(async (opts) => {
      document.body.appendChild(wizardModal);
      setTimeout(() => {
        void opts?.onSaved?.({ id: 'debt-new' } as LiabilityResponse);
        wizardModal.remove();
      }, 0);
      return { modal: wizardModal, close: () => wizardModal.remove() };
    });
    liabilities = [visa, loan, { ...visa, id: 'debt-new', name: 'New card' }];
    const dialog = await connectDemo();
    const label = dialog.querySelector(
      '[data-account="demo-chk"] [data-map="label"]'
    ) as HTMLInputElement;
    label.value = 'Kept edit';
    label.dispatchEvent(new Event('input', { bubbles: true }));
    (
      dialog.querySelector('[data-account="demo-card"] [data-map="debt-new"]') as HTMLButtonElement
    ).click();
    await flush();
    await flush();
    expect(vi.mocked(openDebtWizardLazy)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openDebtWizardLazy).mock.calls[0]![0]).toMatchObject({
      prefill: { liabilityType: 'credit_card', lender: 'Demo bank' },
    });
    const back = modal()!;
    expect(
      (back.querySelector('[data-account="demo-card"] [data-map="debt"]') as HTMLSelectElement)
        .value
    ).toBe('debt-new');
    expect(
      (back.querySelector('[data-account="demo-chk"] [data-map="label"]') as HTMLInputElement).value
    ).toBe('Kept edit');
  });

  it('keeps the connection and offers Retry when the accounts did not load', async () => {
    createResult = listing({
      accounts: [],
      accounts_error: 'provider_timeout',
      status: 'accounts_pending',
    });
    const dialog = await connectDemo();
    expect(dialog.textContent).toContain('Accounts not loaded yet.');
    expect(dialog.querySelector('[data-credential]')).toBeNull();
    button(dialog, 'Retry')!.click();
    await flush();
    expect(calls('POST', '/api/connections/new-1/accounts')).toHaveLength(1);
    expect(modal()!.querySelector('[data-account="demo-card"]')).not.toBeNull();
  });

  it('flags an account the provider reported a problem with', async () => {
    createResult = listing({
      account_errors: [{ provider_account_id: 'demo-chk', code: 'connector_account_error' }],
    });
    const dialog = await connectDemo();
    expect(dialog.querySelector('[data-account="demo-chk"]')!.textContent).toContain(
      'The provider reported a problem with this account, so some transactions may be missing.'
    );
  });

  it('puts provider text in as text, never markup', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    createResult = listing({
      accounts: [account({ name: evil, label: evil, institution: evil })],
    });
    const dialog = await connectDemo();
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.textContent).toContain(evil);
  });

  it('opens from "Edit accounts" on a row with the stored mapping', async () => {
    connections = [listing()];
    await loadConnectionsSettings();
    document.querySelector<HTMLButtonElement>('[data-action="edit-accounts"]')!.click();
    await flush();
    expect(calls('GET', '/api/connections/new-1')).toHaveLength(1);
    expect(modal()!.querySelector('[data-account="demo-card"]')).not.toBeNull();
  });
});

describe('review fixes (C2)', () => {
  async function connectDemo(): Promise<HTMLElement> {
    await pick('demo');
    await submit();
    return modal()!;
  }
  const active = (): Element | null => document.activeElement;
  const escape = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };

  it('keeps a stored debt link that is not in the list, and Save leaves it alone', async () => {
    connections = [listing({ accounts: [account({ liability_id: 'debt-gone' })] })];
    route();
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) =>
      /^\/api\/connections\/[^/]+$/.test(endpoint) && (options?.method ?? 'GET') === 'GET'
        ? listing({ accounts: [account({ liability_id: 'debt-gone' })] })
        : base(endpoint, options)
    );
    await loadConnectionsSettings();
    document.querySelector<HTMLButtonElement>('[data-action="edit-accounts"]')!.click();
    await flush();
    const debt = modal()!.querySelector('[data-map="debt"]') as HTMLSelectElement;
    expect(debt.value).toBe('debt-gone');
    expect(debt.selectedOptions[0]!.textContent).toBe('Linked debt (not in the list)');
    button(modal()!, 'Save')!.click();
    await flush();
    expect(calls('PUT', '/api/connections')).toHaveLength(0);
  });

  it('says when debts could not be loaded and keeps the stored link', async () => {
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
      if (endpoint === '/api/liabilities') throw new ApiError(500, 'x');
      return base(endpoint, options);
    });
    connections = [listing()];
    await loadConnectionsSettings();
    document.querySelector<HTMLButtonElement>('[data-action="edit-accounts"]')!.click();
    await flush();
    const card = modal()!.querySelector('[data-account="demo-card"]')!;
    const debt = card.querySelector('[data-map="debt"]') as HTMLSelectElement;
    expect(debt.value).toBe('debt-visa');
    expect(card.textContent).toContain('Debts could not be loaded.');
    button(modal()!, 'Save')!.click();
    await flush();
    expect(calls('PUT', '/api/connections')).toHaveLength(0);
  });

  it('shows "Suggested match" when connecting, never in Edit accounts', async () => {
    const dialog = await connectDemo();
    expect(dialog.querySelector('[data-account="demo-card"]')!.textContent).toContain(
      'Suggested match'
    );
    modal()?.remove();
    connections = [listing()];
    await loadConnectionsSettings();
    document.querySelector<HTMLButtonElement>('[data-action="edit-accounts"]')!.click();
    await flush();
    expect(modal()!.querySelector('[data-account="demo-card"]')!.textContent).not.toContain(
      'Suggested match'
    );
  });

  it('focuses the error when a demo connect fails, never the page body', async () => {
    createResult = new ApiError(503, 'x', { error_type: 'provider_unavailable' });
    const dialog = await pick('demo');
    await submit();
    const error = dialog.querySelector<HTMLElement>('.connect-error')!;
    expect(error.textContent).not.toBe('');
    expect(active()).toBe(error);
  });

  it('puts focus back on Retry when the retry fails', async () => {
    createResult = listing({
      accounts: [],
      accounts_error: 'provider_timeout',
      status: 'accounts_pending',
    });
    refreshResult = new ApiError(504, 'x', { error_type: 'provider_timeout' });
    const dialog = await connectDemo();
    const retry = button(dialog, 'Retry')!;
    retry.click();
    await flush();
    expect(active()).toBe(button(modal()!, 'Retry'));
    expect(modal()!.querySelector('.connect-error')!.textContent).not.toBe('');
  });

  it('focuses the error when Save fails', async () => {
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
      if (options?.method === 'PUT') throw new ApiError(500, 'x');
      return base(endpoint, options);
    });
    const dialog = await connectDemo();
    const role = dialog.querySelector(
      '[data-account="demo-card"] [data-map="role"]'
    ) as HTMLSelectElement;
    role.value = 'ignore';
    role.dispatchEvent(new Event('change', { bubbles: true }));
    button(modal()!, 'Save')!.click();
    await flush();
    expect(active()).toBe(modal()!.querySelector('.connect-error[role="alert"]'));
  });

  it('moves focus at each step: provider, credential, mapping, done', async () => {
    await openConnectDialog();
    await flush();
    expect(active()?.textContent).toBe('Choose where to connect');
    (modal()!.querySelector('[data-provider="simplefin"]') as HTMLButtonElement).click();
    await flush();
    expect(active()).toBe(input('secret'));
    button(modal()!, 'Back')!.click();
    await flush();
    (modal()!.querySelector('[data-provider="demo"]') as HTMLButtonElement).click();
    await flush();
    expect(active()).toBe(modal()!.querySelector('[data-field="label"]'));
    await submit();
    expect(active()?.textContent).toBe('Choose what each account is');
    button(modal()!, 'Save')!.click();
    await flush();
    expect(active()?.textContent).toBe('Connected');
  });

  it('blocks Escape while a request is in flight', async () => {
    let release: (v: ConnectionListingResponse) => void = () => undefined;
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
      if (endpoint === '/api/connections' && options?.method === 'POST') {
        return new Promise<ConnectionListingResponse>((r) => (release = r));
      }
      return base(endpoint, options);
    });
    await pick('demo');
    button(modal()!, 'Connect')!.click();
    await flush();
    escape();
    await flush();
    expect(modal()).not.toBeNull();
    release(listing());
    await flush();
    expect(modal()!.querySelector('[data-account="demo-card"]')).not.toBeNull();
  });

  it('asks before discarding mapping changes, and keeps them on Keep editing', async () => {
    const dialog = await connectDemo();
    const label = dialog.querySelector(
      '[data-account="demo-chk"] [data-map="label"]'
    ) as HTMLInputElement;
    type(label, 'Changed');
    escape();
    await flush();
    expect(modal()!.textContent).toContain('Discard these changes?');
    expect(active()).toBe(button(modal()!, 'Keep editing'));
    button(modal()!, 'Keep editing')!.click();
    expect(modal()!.textContent).not.toContain('Discard these changes?');
    expect(
      (modal()!.querySelector('[data-account="demo-chk"] [data-map="label"]') as HTMLInputElement)
        .value
    ).toBe('Changed');
    escape();
    await flush();
    button(modal()!, 'Discard')!.click();
    await flush();
    expect(modal()).toBeNull();
    expect(calls('PUT', '/api/connections')).toHaveLength(0);
  });

  it('decides a reconnect refusal from what was sent, not from the status', async () => {
    const broken = {
      ...listing({ id: 'c-old', provider: 'simplefin' }),
      status: 'reconnect_needed' as const,
    };
    // A setup token is spent by the claim: even with status ok, the saved
    // connection goes on to Retry rather than asking again.
    createResult = listing({
      id: 'c-old',
      provider: 'simplefin',
      status: 'ok',
      accounts: [],
      accounts_error: 'provider_timeout',
    });
    await openConnectDialog({ reconnect: broken });
    await flush();
    type(input('secret'), 'bmV3');
    button(modal()!, 'Reconnect')!.click();
    await flush();
    expect(modal()!.textContent).toContain('Accounts not loaded yet.');
    modal()?.remove();
    // A pasted Access URL that was refused asks again, whatever the status says.
    createResult = listing({
      id: 'c-old',
      provider: 'simplefin',
      status: 'accounts_pending',
      accounts_error: 'reconnect_needed',
    });
    await openConnectDialog({ reconnect: broken });
    await flush();
    type(input('secret'), PLANTED_URL);
    button(modal()!, 'Reconnect')!.click();
    await flush();
    expect(input('secret')).not.toBeNull();
    expect(modal()!.textContent).not.toContain('Accounts not loaded yet.');
  });
});

let connectionsList: ConnectionListingResponse[] = [];

describe('Sync now (C3)', () => {
  type Txn = NormalizedStatement['transactions'][number];
  const txn = (key: string, n: number, over: Partial<Txn> = {}): Txn => ({
    row: n,
    posted_date: '2026-09-20',
    amount: -12.5,
    description: `DEMO SHOP ${n}`,
    merchant_key: `DEMO SHOP ${n}`,
    kind: 'expense',
    category_id: null,
    category_source: 'none',
    external_id: `demo:${key}:${n}`,
    dedupe_base: `${key}-${n}`,
    ...over,
  });
  const stmtFor = (
    key: 'card' | 'chk',
    window: number,
    over: Partial<NormalizedStatement> = {}
  ): NormalizedStatement => ({
    file_hash: `${key}-w${window}`.padEnd(64, '0'),
    file_name: `Demo bank sync w${window}`,
    origin: 'connector',
    format: 'connector',
    parser: 'connector:demo',
    account:
      key === 'card'
        ? { kind: 'credit_card', key: 'acct:card', last4: null, institution: 'Demo Bank' }
        : { kind: 'checking', key: 'acct:chk', last4: null, institution: 'Demo Bank' },
    period: { start: '2026-07-01', end: '2026-10-04' },
    closing_balance:
      key === 'card'
        ? { amount: 400 + window, as_of: '2026-10-04' }
        : { amount: 1500, as_of: '2026-10-04' },
    extras: null,
    warnings: [],
    transactions: [txn(`${key}-w${window}`, 0), txn(`${key}-w${window}`, 1)],
    ...over,
  });

  let windows: { start: string; end: string }[];
  let syncAnswers: (ConnectorSyncResponse | Error)[];
  let existing: string[];
  let applied: ApplyRequest[];
  let order: string[];
  let undone: string[];
  let previewSizes: number[];
  let putGate: Promise<void> | null;
  let putDetail: ConnectionListingResponse | null;

  const detail = (): ConnectionListingResponse => listing({ windows });

  function syncRoute(): void {
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(
      async (endpoint: string, options?: { method?: string; body?: unknown }) => {
        const method = options?.method ?? 'GET';
        if (method !== 'GET') order.push(`${method} ${endpoint}`);
        if (endpoint === '/api/connections/new-1' && method === 'GET') return detail();
        if (endpoint === '/api/connections/new-1/sync') {
          const i = (options!.body as { window_index: number }).window_index;
          const answer = syncAnswers[i];
          if (answer === undefined) throw new Error(`no window ${i}`);
          if (answer instanceof Error) throw answer;
          return answer;
        }
        if (endpoint === '/api/smart-import/preview') {
          const sent = (options!.body as { statements: unknown[] }).statements.length;
          previewSizes.push(sent);
          // Both validators refuse more than one turn of statements.
          if (sent > 12) throw new ApiError(422, 'too many statements');
          return {
            existing_dedupe_keys: existing,
            prior_files: [],
            liability_suggestions: [],
            history: [],
          };
        }
        if (/^\/api\/connections\/new-1$/.test(endpoint) && method === 'PUT') {
          if (putGate) await putGate;
          return putDetail ?? listing();
        }
        if (endpoint === '/api/smart-import/ai-status') return { ai_available: false };
        if (endpoint === '/api/v2/smart-import/recurring') return { candidates: [] };
        if (endpoint === '/api/budget/expenses') return [];
        if (endpoint === '/api/smart-import/settings') return {};
        if (endpoint === '/api/smart-import/apply') {
          const body = options!.body as ApplyRequest;
          applied.push(body);
          for (const st of body.statements) {
            for (const t of st.transactions) existing.push(t.dedupe_key);
          }
          return {
            imports: body.statements.map((st, i) => ({
              import_id: `imp-${applied.length}-${i}`,
              file_hash: st.file_hash,
              txn_new: st.transactions.length,
              txn_duplicate: 0,
              txn_excluded: 0,
              balance: 'none',
            })),
            skipped_files: [],
            rules_saved: 0,
            expenses_created: 0,
            expenses_linked: 0,
            pruned: 0,
          };
        }
        if (endpoint.startsWith('/api/smart-import/imports/') && method === 'DELETE') {
          undone.push(endpoint);
          // Undo removes what the apply stored, so the next sync offers it again.
          existing = [];
          return {
            deleted: { transactions: 2, expenses: 0, snapshots: 0 },
            reassigned: { transactions: 0 },
            kept: [],
          };
        }
        return base(endpoint, options);
      }
    );
  }

  const sync = (window: number, ...keys: ('card' | 'chk')[]): ConnectorSyncResponse => ({
    statements: keys.map((k) => stmtFor(k, window)),
    account_errors: [],
    window: windows[window]!,
  });
  const wizard = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('#dynamic-modal.smart-import-modal');
  const q = (sel: string): HTMLElement => wizard()!.querySelector<HTMLElement>(sel)!;
  const nextStep = async (): Promise<void> => {
    q('[data-si="next"]').click();
    await flush();
    await flush();
  };
  const toReview = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await nextStep();
    expect(q('.smart-import-heading').textContent).toBe('Review and apply');
  };
  const applyNow = async (): Promise<void> => {
    q('[data-si="apply"]').click();
    await flush();
    await flush();
  };
  async function runSync(): Promise<void> {
    await syncNow('new-1');
    await flush();
    await flush();
  }

  beforeAll(async () => {
    // The wizard is a lazy chunk; load it once so opening it takes no extra ticks.
    await import('@/features/smart-import');
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 4, 18, 0, 0));
    windows = [
      { start: '2026-04-07', end: '2026-07-05' },
      { start: '2026-07-06', end: '2026-10-04' },
    ];
    syncAnswers = [sync(0, 'card'), sync(1, 'card', 'chk')];
    existing = [];
    applied = [];
    order = [];
    undone = [];
    previewSizes = [];
    putGate = null;
    putDetail = null;
    vi.mocked(showToast).mockReset();
    syncRoute();
  });
  afterEach(() => {
    closeDynamicModal();
    vi.useRealTimers();
  });

  it('walks the windows oldest first, one request each, and opens the wizard at Accounts', async () => {
    await runSync();
    const syncs = calls('POST', '/api/connections/new-1/sync');
    expect(syncs.map(([, o]) => (o as { body: unknown }).body)).toEqual([
      { window_index: 0 },
      { window_index: 1 },
    ]);
    expect(wizard()).not.toBeNull();
    expect(q('.smart-import-heading').textContent).toBe('Check the accounts');
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(3);
  });

  it('stops at a failed window and still opens the windows that completed', async () => {
    windows = [...windows, { start: '2026-10-05', end: '2026-10-05' }];
    syncAnswers = [
      sync(0, 'card'),
      new ApiError(504, 'x', { error_type: 'provider_timeout' }),
      sync(0, 'chk'),
    ];
    await runSync();
    expect(calls('POST', '/api/connections/new-1/sync')).toHaveLength(2);
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(1);
    expect(q('[data-si="sync-notice"]').textContent).toContain(
      'The sync stopped after part 1 of 3.'
    );
    expect(q('[data-si="sync-notice"]').textContent).toContain('did not answer in time');
  });

  it('shows the error and opens nothing when the first window fails', async () => {
    syncAnswers = [new ApiError(409, 'x', { error_type: 'connection_busy' })];
    await runSync();
    expect(wizard()).toBeNull();
    expect(document.getElementById('connections-status')!.textContent).toBe(
      'Another action is running for this connection. Try again in a moment.'
    );
  });

  it('says "No new transactions since" when nothing is left to review', async () => {
    const empty = (w: number): ConnectorSyncResponse => ({
      statements: [
        stmtFor('chk', w, { transactions: [] }),
        stmtFor('card', w, { transactions: [], closing_balance: null }),
      ],
      account_errors: [],
      window: windows[w]!,
    });
    syncAnswers = [empty(0), empty(1)];
    await runSync();
    expect(wizard()).toBeNull();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      'No new transactions since Apr 7, 2026.',
      'info'
    );
  });

  it('says the same when every synced row is already stored', async () => {
    windows = [windows[1]!];
    syncAnswers = [sync(0, 'chk')];
    existing = ['acct:chk|chk-w0-0', 'acct:chk|chk-w0-1'];
    await runSync();
    expect(wizard()).toBeNull();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      'No new transactions since Jul 6, 2026.',
      'info'
    );
  });

  it('prefills kinds and the mapped debt link', async () => {
    await runSync();
    const card = wizard()!.querySelector('[data-statement="c1:0"]')!;
    expect(card.querySelector<HTMLSelectElement>('[data-si="kind"]')!.value).toBe('credit_card');
    expect(card.querySelector<HTMLSelectElement>('[data-si="debt"]')!.value).toBe('debt-visa');
    expect(card.querySelector('.smart-import-card-title')!.textContent).toBe('Demo Rewards Card');
  });

  it('writes nothing before Apply, then applies with connection_id and writes changed links back after', async () => {
    await runSync();
    // Change the debt link on the newest card statement in the wizard.
    const debt = wizard()!.querySelector<HTMLSelectElement>(
      '[data-statement="c2:0"] [data-si="debt"]'
    )!;
    debt.value = '';
    debt.dispatchEvent(new Event('change', { bubbles: true }));
    await toReview();
    expect(
      order.every((w) =>
        /^POST \/api\/(connections\/new-1\/sync|smart-import\/preview|v2\/smart-import\/recurring)$/.test(
          w
        )
      )
    ).toBe(true);
    await applyNow();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.statements.map((st) => [st.origin, st.connection_id])).toEqual([
      ['connector', 'new-1'],
      ['connector', 'new-1'],
      ['connector', 'new-1'],
    ]);
    const puts = order.filter((w) => w.startsWith('PUT /api/connections'));
    expect(puts).toEqual(['PUT /api/connections/new-1']);
    expect(order.indexOf('POST /api/smart-import/apply')).toBeLessThan(
      order.indexOf('PUT /api/connections/new-1')
    );
    expect(calls('PUT', '/api/connections/new-1')[0]![1]).toEqual({
      method: 'PUT',
      body: { accounts: { 'demo-card': { liability_id: null } } },
    });
  });

  it('sends no PUT when the wizard kept the mapping', async () => {
    await runSync();
    await toReview();
    await applyNow();
    expect(applied).toHaveLength(1);
    expect(calls('PUT', '/api/connections')).toHaveLength(0);
  });

  it('reviews more than 12 statements in turns', async () => {
    const many = (w: number, n: number): ConnectorSyncResponse => ({
      statements: Array.from({ length: n }, (_, i) =>
        stmtFor('chk', w * 100 + i, {
          transactions: [txn(`chk-${w}-${i}`, 0)],
        })
      ),
      account_errors: [],
      window: windows[w]!,
    });
    syncAnswers = [many(0, 8), many(1, 7)];
    await runSync();
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(12);
    expect(wizard()!.textContent).toContain('Part 1 of 2 of this sync.');
    await toReview();
    await applyNow();
    expect(applied[0]!.statements).toHaveLength(12);
    q('[data-si="close"]').click();
    await flush();
    await flush();
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(3);
    expect(wizard()!.textContent).toContain('Part 2 of 2 of this sync.');
    await toReview();
    await applyNow();
    expect(applied[1]!.statements).toHaveLength(3);
  });

  it('does not open the next turn when a turn is discarded', async () => {
    const many = (n: number): ConnectorSyncResponse => ({
      statements: Array.from({ length: n }, (_, i) =>
        stmtFor('chk', i, { transactions: [txn(`chk-${i}`, 0)] })
      ),
      account_errors: [],
      window: windows[0]!,
    });
    windows = [windows[0]!];
    syncAnswers = [many(13)];
    await runSync();
    q('[data-si="cancel"]').click();
    q('[data-si="discard"]').click();
    await flush();
    expect(wizard()).toBeNull();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      'The rest of this sync was not opened. Sync now offers it again.',
      'info'
    );
  });

  it('undoes from Done, and the next Sync now offers the rows again', async () => {
    windows = [windows[1]!];
    syncAnswers = [sync(0, 'chk')];
    await runSync();
    await toReview();
    await applyNow();
    q('[data-si="undo"]').click();
    q('[data-si="undo-confirm"]').click();
    await flush();
    expect(undone).toHaveLength(1);
    q('[data-si="close"]').click();
    await flush();
    await runSync();
    expect(wizard()).not.toBeNull();
    await toReview();
    expect(q('[data-count="new"]').textContent).toBe('2');
    expect(q('[data-count="duplicates"]').textContent).toBe('0');
  });

  it('previews at most 12 statements per request, merges the answers and drops stored ones', async () => {
    const many = (w: number, n: number): ConnectorSyncResponse => ({
      statements: Array.from({ length: n }, (_, i) =>
        stmtFor('chk', w * 100 + i, { transactions: [txn(`chk-${w}-${i}`, 0)] })
      ),
      account_errors: [],
      window: windows[w]!,
    });
    syncAnswers = [many(0, 8), many(1, 7)];
    // Window 1's last statement sits in the second batch and is already stored.
    existing = ['acct:chk|chk-1-6-0'];
    await runSync();
    // The wizard's own preview comes after these two.
    expect(previewSizes.slice(0, 2)).toEqual([12, 3]);
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(12);
    expect(wizard()!.textContent).toContain('Part 1 of 2 of this sync.');
    await toReview();
    await applyNow();
    q('[data-si="close"]').click();
    await flush();
    await flush();
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(2);
  });

  it('keeps the account error lines when nothing new came back', async () => {
    const empty = (w: number): ConnectorSyncResponse => ({
      statements: [stmtFor('chk', w, { transactions: [] })],
      account_errors: [{ provider_account_id: 'demo-chk', code: 'connector_account_error' }],
      window: windows[w]!,
    });
    syncAnswers = [empty(0), empty(1)];
    await runSync();
    expect(wizard()).toBeNull();
    const status = document.getElementById('connections-status')!;
    expect(status.textContent).toContain('No new transactions since Apr 7, 2026.');
    expect(status.textContent).toContain('Demo Everyday: The provider reported a problem');
  });

  it('keeps a balance-only statement of a debt-role account that has no stored link', async () => {
    const unlinked = listing({
      windows,
      accounts: [
        { ...listing().accounts[0]!, role: 'debt', liability_id: null },
        listing().accounts[1]!,
      ],
    });
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
      if (endpoint === '/api/connections/new-1' && (options?.method ?? 'GET') === 'GET') {
        return unlinked;
      }
      return base(endpoint, options);
    });
    windows = [windows[1]!];
    syncAnswers = [
      {
        statements: [stmtFor('card', 1, { transactions: [] })],
        account_errors: [],
        window: windows[0]!,
      },
    ];
    await runSync();
    expect(wizard()).not.toBeNull();
    expect(wizard()!.querySelectorAll('[data-statement]')).toHaveLength(1);
  });

  it('says "this account\u2019s balance" for a synced account', async () => {
    await runSync();
    const card = wizard()!.querySelector('[data-statement="c1:0"]')!;
    expect(card.textContent).toContain('Linking records this account\u2019s balance on the debt');
  });

  it('waits for the write-back before Next part, and the next part starts from it', async () => {
    const stmts = (w: number, n: number, cardFirst: boolean): NormalizedStatement[] => [
      ...(cardFirst ? [stmtFor('card', w)] : []),
      ...Array.from({ length: n }, (_, i) =>
        stmtFor('chk', w * 100 + i, { transactions: [txn(`chk-${w}-${i}`, 0)] })
      ),
    ];
    syncAnswers = [
      { statements: stmts(0, 11, true), account_errors: [], window: windows[0]! },
      {
        statements: [stmtFor('card', 1), ...stmts(1, 1, false)],
        account_errors: [],
        window: windows[1]!,
      },
    ];
    const moved = listing();
    moved.accounts[0] = { ...moved.accounts[0]!, kind: 'checking', liability_id: null };
    putDetail = moved;
    let release!: () => void;
    putGate = new Promise<void>((r) => {
      release = r;
    });
    await runSync();
    // Turn 1: the card's kind is changed to checking in the wizard.
    const kind = wizard()!.querySelector<HTMLSelectElement>(
      '[data-statement="c1:0"] [data-si="kind"]'
    )!;
    kind.value = 'checking';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 5 && q('.smart-import-heading').textContent !== 'Review and apply'; i++) {
      await nextStep();
    }
    await applyNow();
    expect(calls('PUT', '/api/connections/new-1')).toHaveLength(1);
    const next = q('[data-si="close"]') as HTMLButtonElement;
    expect(next.textContent).toBe('Next part (2 of 2)');
    expect(next.disabled).toBe(true);
    release();
    await flush();
    await flush();
    expect((q('[data-si="close"]') as HTMLButtonElement).disabled).toBe(false);
    q('[data-si="close"]').click();
    await flush();
    await flush();
    expect(wizard()!.textContent).toContain('Part 2 of 2 of this sync.');
    const card = wizard()!.querySelector('[data-statement="c1:0"]')!;
    expect(card.querySelector<HTMLSelectElement>('[data-si="kind"]')!.value).toBe('checking');
  });

  it('disables a row Sync button while the walk runs', async () => {
    connectionsList = [listing({ id: 'new-1', windows })];
    document.body.innerHTML = '<ul id="connections-list"></ul><div id="connections-status"></div>';
    let go!: () => void;
    const hold = new Promise<void>((r) => {
      go = r;
    });
    const base = apiCallMock.getMockImplementation()!;
    apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
      if (endpoint === '/api/connections' && (options?.method ?? 'GET') === 'GET')
        return connectionsList;
      if (endpoint === '/api/connections/new-1/sync') await hold;
      return base(endpoint, options);
    });
    await loadConnectionsSettings();
    const btn = document.querySelector<HTMLButtonElement>('[data-action="sync"]')!;
    btn.click();
    await flush();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    go();
    await flush();
    await flush();
    const after = document.querySelector<HTMLButtonElement>('[data-action="sync"]')!;
    expect(after.disabled).toBe(false);
    expect(after.hasAttribute('aria-busy')).toBe(false);
  });

  it('offers Sync now on a row and on the Done step of Connect', async () => {
    connections = [listing()];
    await loadConnectionsSettings();
    const btn = document.querySelector<HTMLButtonElement>('[data-action="sync"]')!;
    expect(btn.textContent).toBe('Sync now');
    btn.click();
    await flush();
    await flush();
    expect(calls('POST', '/api/connections/new-1/sync').length).toBeGreaterThan(0);
    closeDynamicModal();
    await pick('demo');
    await submit();
    button(modal()!, 'Save')!.click();
    await flush();
    expect(button(modal()!, 'Sync now')).toBeDefined();
  });
});
