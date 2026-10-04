/**
 * Settings > Imported transactions: retention, AI consent toggles (server mode
 * only), remembered merchants with delete, and "Delete all imported transactions".
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

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { store } from '@/state/store';
import { loadSmartImportSettings } from '@/pages/settings';
import type { MerchantRuleResponse, SmartImportSettings } from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const EM_DASH = String.fromCharCode(0x2014);

const SETTINGS: SmartImportSettings = {
  retention_months: 24,
  ai_enabled: false,
  pdf_ai_enabled: true,
  csv_layouts: {},
  accounts: {},
};

function rule(over: Partial<MerchantRuleResponse>): MerchantRuleResponse {
  return {
    id: 'r1',
    merchant_key: 'TRADER JOES',
    category_id: 'c1',
    category_name: 'Groceries',
    category_deleted: false,
    kind: 'expense',
    hits: 3,
    source: 'user',
    updated_at: null,
    ...over,
  };
}

let rules: MerchantRuleResponse[];

function route(): void {
  apiCallMock.mockImplementation(async (endpoint: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (endpoint === '/api/smart-import/settings' && method === 'GET') return { ...SETTINGS };
    if (endpoint === '/api/smart-import/settings' && method === 'PUT') return { ...SETTINGS };
    if (endpoint === '/api/smart-import/rules' && method === 'GET') return rules;
    if (endpoint.startsWith('/api/smart-import/rules/') && method === 'DELETE') return { deleted: true };
    if (endpoint === '/api/smart-import/transactions' && method === 'DELETE') return { deleted: 142 };
    throw new Error(`unexpected ${method} ${endpoint}`);
  });
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const calls = (method: string, endpoint: string) =>
  apiCallMock.mock.calls.filter(([e, o]) => e === endpoint && ((o as { method?: string })?.method ?? 'GET') === method);

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  apiCallMock.mockReset();
  vi.mocked(showToast).mockReset();
  rules = [rule({})];
  route();
  store.set('dataMode', 'server');
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('markup', () => {
  it('adds the Imported transactions section with an index link', () => {
    const section = $('settings-imported-transactions');
    expect(section.querySelector('.settings-section-header')!.textContent).toBe('Imported transactions');
    expect(document.querySelector('#settings-index [data-section="settings-imported-transactions"]')).not.toBeNull();
  });

  it('has no em-dash in the section copy', () => {
    expect($('settings-imported-transactions').textContent).not.toContain(EM_DASH);
  });
});

describe('retention', () => {
  it('shows the saved retention and saves a change through PUT settings', async () => {
    await loadSmartImportSettings();
    const select = $<HTMLSelectElement>('si-retention');
    expect(select.value).toBe('24');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['12', '24', '36', '0']);
    select.value = '36';
    select.dispatchEvent(new Event('change'));
    await flush();
    const puts = calls('PUT', '/api/smart-import/settings');
    expect(puts).toHaveLength(1);
    // apiCall serializes the body itself, so the page must pass the object.
    expect((puts[0][1] as { body: unknown }).body).toEqual({ retention_months: 36 });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('puts the previous value back when the save fails', async () => {
    await loadSmartImportSettings();
    apiCallMock.mockImplementation(async (_e: string, o?: { method?: string }) => {
      if (o?.method === 'PUT') throw new Error('boom');
      return {};
    });
    const select = $<HTMLSelectElement>('si-retention');
    select.value = '12';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(select.value).toBe('24');
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

describe('AI toggles', () => {
  it('shows both toggles in server mode, reflecting the saved values', async () => {
    await loadSmartImportSettings();
    expect($('si-ai-group').classList.contains('hidden')).toBe(false);
    expect($<HTMLInputElement>('si-ai-enabled').checked).toBe(false);
    expect($<HTMLInputElement>('si-pdf-ai-enabled').checked).toBe(true);
  });

  it('saves a toggle through PUT settings', async () => {
    await loadSmartImportSettings();
    const box = $<HTMLInputElement>('si-ai-enabled');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await flush();
    const puts = calls('PUT', '/api/smart-import/settings');
    expect((puts[0][1] as { body: unknown }).body).toEqual({ ai_enabled: true });
  });

  it('hides both toggles in hosted mode', async () => {
    store.set('dataMode', 'local');
    await loadSmartImportSettings();
    expect($('si-ai-group').classList.contains('hidden')).toBe(true);
    // The retention select is still there.
    expect($('si-retention').closest('.hidden')).toBeNull();
  });
});

describe('remembered merchants', () => {
  it('lists each merchant with its category via textContent only', async () => {
    rules = [rule({ merchant_key: '<img src=x onerror=alert(1)>' })];
    await loadSmartImportSettings();
    const list = $('si-rules-list');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(list.textContent).toContain('Groceries');
  });

  it('shows an empty note when there are none', async () => {
    rules = [];
    await loadSmartImportSettings();
    expect($('si-rules-list').textContent).toContain('No remembered merchants yet');
  });

  it('notes a rule whose category was deleted', async () => {
    rules = [rule({ category_deleted: true, category_name: null })];
    await loadSmartImportSettings();
    expect($('si-rules-list').textContent).toContain('category deleted');
  });

  it('asks before deleting and deletes by id, then refreshes the list', async () => {
    await loadSmartImportSettings();
    const btn = $('si-rules-list').querySelector('button') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toContain('TRADER JOES');
    rules = [];
    btn.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls('DELETE', '/api/smart-import/rules/r1')).toHaveLength(1);
    expect($('si-rules-list').textContent).toContain('No remembered merchants yet');
  });

  it('does nothing when the confirm is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    await loadSmartImportSettings();
    ($('si-rules-list').querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(calls('DELETE', '/api/smart-import/rules/r1')).toHaveLength(0);
  });
});

describe('delete all imported transactions', () => {
  it('asks first and does not delete when declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    await loadSmartImportSettings();
    $('si-delete-all').click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls('DELETE', '/api/smart-import/transactions')).toHaveLength(0);
  });

  it('deletes and reports the count', async () => {
    await loadSmartImportSettings();
    $('si-delete-all').click();
    await flush();
    expect(calls('DELETE', '/api/smart-import/transactions')).toHaveLength(1);
    expect($('si-delete-status').textContent).toContain('142');
    expect(String(vi.mocked(showToast).mock.calls[0][0])).toContain('142');
  });

  it('says so when the delete fails', async () => {
    await loadSmartImportSettings();
    apiCallMock.mockRejectedValue(new Error('boom'));
    $('si-delete-all').click();
    await flush();
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect($('si-delete-status').textContent).not.toContain('142');
  });
});
