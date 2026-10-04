/**
 * Tests for the smart import wizard shell and its Upload and Accounts steps
 * (src/features/smart-import.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  return { apiCall: vi.fn(), uploadFileWithContext: vi.fn(), ApiError };
});
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/utils/debt-wizard-launcher', () => ({ openDebtWizardLazy: vi.fn() }));
vi.mock('@/ui/tabs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/tabs')>()),
  showTab: vi.fn(),
  getCurrentTab: vi.fn(() => 'dashboard'),
}));
vi.mock('@/pages/budget', () => ({ showBudgetTab: vi.fn(), loadBudgetTab: vi.fn() }));

import { apiCall, uploadFileWithContext, ApiError } from '@/api/client';
import { showToast } from '@/ui/toast';
import { closeDynamicModal } from '@/ui/modal';
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import { openSmartImportWizard } from '@/features/smart-import';
import { store } from '@/state/store';
import {
  buildApplyRequest,
  buildCategorizeRequest,
  buildSettingsPatch,
  recurringRequest,
  reviewCounts,
} from '@/utils/smart-import-state';
import { on } from '@/state/events';
import { getCurrentTab, showTab } from '@/ui/tabs';
import { loadBudgetTab, showBudgetTab } from '@/pages/budget';
import type {
  AnalyzeResponse,
  ApplyRequest,
  ApplyResponse,
  CategorizeRequest,
  CategorizeResponse,
  NormalizedStatement,
  PreviewResponse,
  RecurringCandidateSuggestion,
  SmartImportAiStatus,
  SmartImportContext,
  SmartImportUndoResponse,
} from '@/types/api';

const apiCallMock = vi.mocked(apiCall);
const uploadMock = vi.mocked(uploadFileWithContext);
const toastMock = vi.mocked(showToast);
const debtLauncherMock = vi.mocked(openDebtWizardLazy);

const modal = (): HTMLElement => document.getElementById('dynamic-modal')!;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const q = <T extends HTMLElement = HTMLElement>(sel: string): T => modal().querySelector<T>(sel)!;
const qa = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
  Array.from(modal().querySelectorAll<T>(sel));
const next = (): HTMLButtonElement => q<HTMLButtonElement>('[data-si="next"]');
const back = (): HTMLButtonElement => q<HTMLButtonElement>('[data-si="back"]');

function context(over: Partial<SmartImportContext> = {}): SmartImportContext {
  return {
    rules: [{ id: 'r1', merchant_key: 'netflix', category_id: 'c1', kind: null }],
    categories: [
      { id: 'c1', name: 'Entertainment' },
      { id: 'c2', name: 'Groceries' },
    ],
    accounts: [
      {
        account_key: 'acct:old',
        label: 'Joint checking',
        last4: '9999',
        kind: 'checking',
        institution: null,
        liability_id: null,
      },
    ],
    csv_layouts: {},
    settings: {
      retention_months: 24,
      ai_enabled: false,
      pdf_ai_enabled: false,
      csv_layouts: {},
      accounts: { 'label:old': 'Old savings' },
    },
    ...over,
  };
}

function statement(over: Partial<NormalizedStatement> = {}): NormalizedStatement {
  return {
    file_hash: 'hash-a',
    file_name: 'stmt.csv',
    origin: 'file',
    format: 'csv',
    parser: 'csv',
    account: { kind: 'checking', key: 'acct:abc', last4: '1234', institution: 'Sample Bank' },
    period: { start: '2026-07-01', end: '2026-09-30' },
    closing_balance: { amount: 2500.5, as_of: '2026-09-30' },
    extras: null,
    warnings: [],
    transactions: [
      {
        row: 0,
        posted_date: '2026-07-03',
        amount: -15.49,
        description: 'NETFLIX.COM',
        merchant_key: 'netflix',
        kind: 'expense',
        category_id: 'c1',
        category_source: 'rule',
        external_id: null,
        dedupe_base: 'd0',
      },
      {
        row: 1,
        posted_date: '2026-07-05',
        amount: -62.18,
        description: 'SAFEWAY',
        merchant_key: 'safeway',
        kind: 'expense',
        category_id: null,
        category_source: 'none',
        external_id: null,
        dedupe_base: 'd1',
      },
    ],
    ...over,
  };
}

const okAnswer = (...s: NormalizedStatement[]): AnalyzeResponse => ({
  status: 'ok',
  statements: s,
});

const emptyPreview: PreviewResponse = {
  existing_dedupe_keys: [],
  prior_files: [],
  liability_suggestions: [],
  history: [],
};

interface Setup {
  ctx?: SmartImportContext;
  ai?: Partial<SmartImportAiStatus> | 'fail';
  preview?: PreviewResponse;
  liabilities?: unknown[];
  analyze?: (
    file: File,
    ctx: Record<string, unknown>
  ) => AnalyzeResponse | Promise<AnalyzeResponse>;
  categorize?: (body: CategorizeRequest) => CategorizeResponse | Promise<CategorizeResponse>;
  settingsPut?: (body: unknown) => unknown;
  expenses?: unknown[];
  recurring?: (body: unknown) => unknown;
  apply?: (body: unknown) => unknown;
  undo?: (id: string) => unknown;
}

let calls: { url: string; options?: { method?: string; body?: unknown } }[] = [];

function setup(s: Setup = {}): void {
  calls = [];
  apiCallMock.mockReset();
  uploadMock.mockReset();
  apiCallMock.mockImplementation(async (url: string, options?: never) => {
    calls.push({ url, options });
    if (url === '/api/smart-import/context') return s.ctx ?? context();
    if (url === '/api/smart-import/ai-status') {
      if (s.ai === 'fail') throw new ApiError(503, 'x');
      return {
        ai_available: false,
        pdf_ai_available: false,
        ai_enabled: false,
        pdf_ai_enabled: false,
        provider: null,
        model: null,
        limits: {},
        ...(s.ai ?? {}),
      };
    }
    if (url === '/api/smart-import/preview') return s.preview ?? emptyPreview;
    if (url === '/api/liabilities') return s.liabilities ?? [];
    if (url === '/api/smart-import/categorize') {
      const body = (options as { body?: unknown } | undefined)?.body as CategorizeRequest;
      if (s.categorize) return s.categorize(body);
      throw new ApiError(503, 'x', { error_type: 'ai_unavailable' });
    }
    if (url === '/api/smart-import/settings') {
      const body = (options as { body?: unknown } | undefined)?.body;
      return s.settingsPut ? s.settingsPut(body) : { ...context().settings, ...(body as object) };
    }
    if (url === '/api/budget/expenses') return s.expenses ?? [];
    if (url === '/api/v2/smart-import/recurring') {
      const body = (options as { body?: unknown } | undefined)?.body;
      return s.recurring ? s.recurring(body) : { candidates: [] };
    }
    if (url === '/api/smart-import/apply') {
      const body = (options as { body?: unknown } | undefined)?.body;
      if (s.apply) return s.apply(body);
      throw new ApiError(500, 'x');
    }
    if (url.startsWith('/api/smart-import/imports/')) {
      const id = decodeURIComponent(url.slice('/api/smart-import/imports/'.length));
      if (s.undo) return s.undo(id);
      throw new ApiError(500, 'x');
    }
    return {};
  });
  uploadMock.mockImplementation(async (_url: string, file: File, ctx: unknown) => {
    const answer = s.analyze
      ? await s.analyze(file, ctx as Record<string, unknown>)
      : okAnswer(statement({ file_name: file.name }));
    return answer as never;
  });
}

function pick(files: File[]): void {
  const input = q<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
const csvFile = (name = 'stmt.csv'): File =>
  new File(['Date,Amount\n'], name, { type: 'text/csv' });

async function open(options: Parameters<typeof openSmartImportWizard>[0] = {}) {
  const handle = openSmartImportWizard(options);
  await flush();
  return handle;
}

async function toAccounts(files: File[] = [csvFile()]): Promise<void> {
  pick(files);
  await flush();
  next().click();
  await flush();
}

function liability(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'l1',
    name: 'Sample Card',
    liability_type: 'credit_card',
    lender: 'Sample Bank',
    current_balance: 1200,
    is_active: true,
    ...over,
  };
}

describe('smart import wizard', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    toastMock.mockReset();
    debtLauncherMock.mockReset();
    setup();
  });
  afterEach(() => {
    closeDynamicModal();
  });

  describe('shell', () => {
    it('shows five steps, the first current, and the short "1 of 5" label', async () => {
      await open();
      const steps = qa('.smart-import-steps li');
      expect(steps).toHaveLength(5);
      expect(steps.map((s) => s.textContent)).toEqual([
        'Upload',
        'Accounts',
        'Categorize',
        'Recurring bills',
        'Review',
      ]);
      expect(steps[0]!.getAttribute('aria-current')).toBe('step');
      expect(q('.smart-import-progress-short').textContent).toBe('1 of 5');
    });

    it('reads "2 of 5" on the Accounts step', async () => {
      await open();
      await toAccounts();
      expect(q('.smart-import-progress-short').textContent).toBe('2 of 5');
      expect(qa('.smart-import-steps li')[1]!.getAttribute('aria-current')).toBe('step');
    });

    it('is a dialog sheet with the wizard classes', async () => {
      await open();
      expect(modal().classList.contains('smart-import-modal')).toBe(true);
      expect(modal().classList.contains('modal-sheet')).toBe(true);
    });

    it('asks before discarding once a file was added, and keeps editing on request', async () => {
      await open();
      pick([csvFile()]);
      await flush();
      q('[data-si="cancel"]').click();
      expect(modal().textContent).toContain('Discard this import?');
      q('[data-si="keep"]').click();
      expect(document.getElementById('dynamic-modal')).not.toBeNull();
      q('[data-si="cancel"]').click();
      q('[data-si="discard"]').click();
      expect(document.getElementById('dynamic-modal')).toBeNull();
    });

    it('closes without a prompt when nothing was added', async () => {
      await open();
      q('[data-si="cancel"]').click();
      expect(document.getElementById('dynamic-modal')).toBeNull();
    });

    it('Escape asks first when dirty', async () => {
      await open();
      pick([csvFile()]);
      await flush();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.getElementById('dynamic-modal')).not.toBeNull();
      expect(modal().textContent).toContain('Discard this import?');
    });
  });

  describe('Upload', () => {
    it('accepts the four extensions and shows the privacy line', async () => {
      await open();
      const input = q<HTMLInputElement>('input[type="file"]');
      expect(input.accept).toBe('.csv,.ofx,.qfx,.pdf');
      expect(input.multiple).toBe(true);
      expect(q('.smart-import-privacy').textContent).toBe(
        'Files are read once and never kept. Only masked transactions are saved, in your own database.'
      );
    });

    it('rejects other extensions with a toast and analyzes nothing', async () => {
      await open();
      pick([new File(['x'], 'notes.docx')]);
      await flush();
      expect(toastMock).toHaveBeenCalledWith(
        'Only CSV, OFX, QFX and PDF files can be imported.',
        'error'
      );
      expect(uploadMock).not.toHaveBeenCalled();
      expect(next().disabled).toBe(true);
    });

    it('keeps the good files from a mixed drop', async () => {
      await open();
      pick([new File(['x'], 'notes.docx'), csvFile('a.csv'), new File(['x'], 'b.QFX')]);
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(2);
      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    it('enforces 12 files across drops', async () => {
      await open();
      pick(Array.from({ length: 10 }, (_, i) => csvFile(`a${i}.csv`)));
      await flush();
      pick(Array.from({ length: 3 }, (_, i) => csvFile(`b${i}.csv`)));
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(12);
      expect(toastMock).toHaveBeenCalledWith('You can import up to 12 files at a time.', 'error');
    });

    it('sends each file to analyze with the rules, categories and its origin', async () => {
      await open();
      pick([csvFile()]);
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(1);
      const [url, file, ctx] = uploadMock.mock.calls[0]!;
      expect(url).toBe('/api/v2/smart-import/analyze');
      expect((file as File).name).toBe('stmt.csv');
      expect(ctx).toMatchObject({
        origin: 'file',
        rules: [{ merchant_key: 'netflix' }],
        categories: [
          { id: 'c1', name: 'Entertainment' },
          { id: 'c2', name: 'Groceries' },
        ],
      });
    });

    it('lists files with a status, shows a failed file with fixed copy, and removes it', async () => {
      setup({
        analyze: () => {
          throw new ApiError(422, 'The PDF is password protected.', {
            error_type: 'encrypted_pdf',
          });
        },
      });
      await open();
      pick([csvFile('secret.pdf')]);
      await flush();
      const row = q('.smart-import-file');
      expect(row.textContent).toContain('secret.pdf');
      expect(row.textContent).toContain('This PDF is password protected.');
      expect(next().disabled).toBe(true);
      q('[data-si="remove-file"]').click();
      expect(qa('.smart-import-file')).toHaveLength(0);
    });

    it('does not render server detail text for unknown errors', async () => {
      setup({
        analyze: () => {
          throw new ApiError(422, 'SELECT secret FROM something', {
            error_type: 'not_in_catalog',
            detail: 'SELECT secret FROM something',
          });
        },
      });
      await open();
      pick([csvFile()]);
      await flush();
      expect(modal().textContent).not.toContain('SELECT');
      expect(modal().textContent).toContain('could not be read');
    });

    it('falls back to the status when there is no error_type', async () => {
      setup({
        analyze: () => {
          throw new ApiError(413, 'whatever the server said');
        },
      });
      await open();
      pick([csvFile()]);
      await flush();
      expect(q('.smart-import-file').textContent).toContain('larger than the 10 MB limit');
      expect(modal().textContent).not.toContain('whatever');
    });

    it('puts file names in the DOM as text, never as markup', async () => {
      await open();
      pick([csvFile('<img src=x onerror=alert(1)>.csv')]);
      await flush();
      expect(modal().querySelector('img')).toBeNull();
      expect(q('.smart-import-file').textContent).toContain('<img src=x');
    });

    it('enables Next once every file has an answer', async () => {
      let release: (a: AnalyzeResponse) => void = () => undefined;
      setup({ analyze: () => new Promise<AnalyzeResponse>((r) => (release = r)) });
      await open();
      pick([csvFile()]);
      await flush();
      expect(next().disabled).toBe(true);
      expect(q('.smart-import-file').textContent).toContain('Reading');
      release(okAnswer(statement()));
      await flush();
      expect(next().disabled).toBe(false);
    });

    it('accepts a drop on the drop zone', async () => {
      await open();
      const zone = q('[data-si="dropzone"]');
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { files: [csvFile('d.csv')] } });
      zone.dispatchEvent(drop);
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(1);
    });

    it('takes files passed in by an entry point', async () => {
      await open({ files: [csvFile('given.csv')] });
      expect(uploadMock).toHaveBeenCalledTimes(1);
    });

    it('"Try a sample statement" analyzes both bundled files as origin sample', async () => {
      await open();
      q('[data-si="sample"]').click();
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(2);
      const names = uploadMock.mock.calls.map((c) => (c[1] as File).name).sort();
      expect(names).toEqual(['sample-card.ofx', 'sample-checking.csv']);
      for (const call of uploadMock.mock.calls) {
        expect((call[2] as Record<string, unknown>).origin).toBe('sample');
      }
      const here = resolve(import.meta.dirname, '../../src/samples');
      const csv = uploadMock.mock.calls.find((c) => (c[1] as File).name.endsWith('.csv'))![1];
      expect(await (csv as File).text()).toBe(
        readFileSync(resolve(here, 'sample-checking.csv'), 'utf8')
      );
    });

    it('presets the sample checking file as Checking named "Sample checking", so Next works untouched', async () => {
      setup({
        analyze: (file) =>
          okAnswer(
            file.name.endsWith('.csv')
              ? statement({
                  file_name: file.name,
                  origin: 'sample',
                  account: { kind: 'checking', key: null, last4: null, institution: null },
                })
              : statement({ file_name: file.name, file_hash: 'hash-ofx', origin: 'sample' })
          ),
      });
      await open();
      q('[data-si="sample"]').click();
      await flush();
      const csvCall = uploadMock.mock.calls.find((c) => (c[1] as File).name.endsWith('.csv'))!;
      expect((csvCall[2] as Record<string, unknown>).account_kind).toBe('checking');
      const ofxCall = uploadMock.mock.calls.find((c) => (c[1] as File).name.endsWith('.ofx'))!;
      expect((ofxCall[2] as Record<string, unknown>).account_kind).toBeUndefined();
      next().click();
      await flush();
      expect(q<HTMLInputElement>('[data-si="label"]').value).toBe('Sample checking');
      expect(next().disabled).toBe(false);
    });

    it('presets the account kind hint for a preset entry point', async () => {
      await open({ preset: 'credit_card' });
      pick([csvFile()]);
      await flush();
      expect((uploadMock.mock.calls[0]![2] as Record<string, unknown>).account_kind).toBe(
        'credit_card'
      );
    });

    it('writes nothing: only reads and the preview call are made', async () => {
      await open();
      await toAccounts();
      for (const c of calls) {
        const method = c.options?.method ?? 'GET';
        if (method !== 'GET') expect(c.url).toBe('/api/smart-import/preview');
      }
      expect(calls.some((c) => c.url === '/api/smart-import/settings')).toBe(false);
    });
  });

  describe('Accounts', () => {
    it('renders one card per statement with kind, last4, period, count and balance', async () => {
      setup({
        analyze: (file) =>
          okAnswer(
            statement({ file_name: file.name }),
            statement({
              file_hash: 'hash-b',
              account: { kind: 'savings', key: 'acct:def', last4: '5678', institution: null },
              closing_balance: null,
            })
          ),
      });
      await open();
      await toAccounts();
      const cards = qa('.smart-import-card');
      expect(cards).toHaveLength(2);
      const first = cards[0]!.textContent!;
      expect(first).toContain('Checking');
      expect(first).toContain('1234');
      expect(first).toContain('Sample Bank');
      expect(first).toContain('Jul 1, 2026 to Sep 30, 2026');
      expect(first).toContain('2 transactions');
      expect(first).toContain('$2,500.50');
      expect(cards[1]!.textContent).toContain('Savings');
      expect(cards[1]!.textContent).not.toContain('Closing balance');
    });

    it('labels a card balance as owed', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({
              account: {
                kind: 'credit_card',
                key: 'acct:cc',
                last4: '4321',
                institution: 'Sample Bank',
              },
              closing_balance: { amount: 1200, as_of: '2026-09-30' },
            })
          ),
      });
      await open();
      await toAccounts();
      expect(q('.smart-import-card').textContent).toContain('Balance owed');
      expect(q('.smart-import-card').textContent).toContain('$1,200.00');
    });

    it('asks for a label when the account is unknown, offers known labels, and gates Next', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({
              account: { kind: 'checking', key: null, last4: null, institution: null },
            })
          ),
      });
      await open();
      await toAccounts();
      expect(modal().textContent).toContain('Which account is this?');
      const input = q<HTMLInputElement>('[data-si="label"]');
      expect(input.maxLength).toBe(190);
      const listId = input.getAttribute('list')!;
      const options = Array.from(document.getElementById(listId)!.querySelectorAll('option')).map(
        (o) => o.value
      );
      expect(options).toEqual(['Joint checking', 'Old savings']);
      expect(next().disabled).toBe(true);
      input.value = 'Everyday checking';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(next().disabled).toBe(false);
    });

    it('re-runs the preview with the label once it is typed', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({ account: { kind: 'checking', key: null, last4: null, institution: null } })
          ),
      });
      await open();
      await toAccounts();
      const input = q<HTMLInputElement>('[data-si="label"]');
      input.value = 'Everyday';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      const previews = calls.filter((c) => c.url === '/api/smart-import/preview');
      const last = previews[previews.length - 1]!.options!.body as {
        statements: { account_key: string }[];
      };
      expect(last.statements[0]!.account_key).toBe('label:everyday');
    });

    it('re-analyzes with the account type chosen for an unknown type', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({
              account: { kind: 'unknown', key: 'acct:x', last4: null, institution: null },
            })
          ),
      });
      await open();
      await toAccounts();
      const kind = q<HTMLSelectElement>('[data-si="kind"]');
      kind.value = 'credit_card';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(2);
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).account_kind).toBe(
        'credit_card'
      );
    });

    it('"Amounts look reversed? Flip" re-analyzes with flip_sign, and flips back', async () => {
      await open();
      await toAccounts();
      q('[data-si="flip"]').click();
      await flush();
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).flip_sign).toBe(true);
      q('[data-si="flip"]').click();
      await flush();
      expect((uploadMock.mock.calls[2]![2] as Record<string, unknown>).flip_sign).toBe(false);
    });

    it('treats a parser flip as already on, so Flip turns it off', async () => {
      setup({ analyze: () => okAnswer(statement({ warnings: ['sign_flipped'] })) });
      await open();
      await toAccounts();
      expect(q('.smart-import-card').textContent).toContain('Amounts were flipped');
      q('[data-si="flip"]').click();
      await flush();
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).flip_sign).toBe(false);
    });

    it('offers the date order switch only when the order was assumed', async () => {
      await open();
      await toAccounts();
      expect(modal().querySelector('[data-si="date-order"]')).toBeNull();
      closeDynamicModal();

      setup({ analyze: () => okAnswer(statement({ warnings: ['date_order_assumed'] })) });
      await open();
      await toAccounts();
      const sel = q<HTMLSelectElement>('[data-si="date-order"]');
      expect(sel.value).toBe('mdy');
      sel.value = 'dmy';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).date_order).toBe('dmy');
      // The server stops flagging the order once it is told; the switch stays.
      expect(q<HTMLSelectElement>('[data-si="date-order"]').value).toBe('dmy');
    });

    it('shows a note for a file imported before', async () => {
      setup({
        preview: {
          ...emptyPreview,
          prior_files: [
            { file_hash: 'hash-a', import_id: 'i1', imported_at: '2026-09-01T10:00:00' },
          ],
        },
      });
      await open();
      await toAccounts();
      expect(q('.smart-import-card').textContent).toContain('already imported');
    });

    it('Back returns to Upload with the files still listed', async () => {
      await open();
      await toAccounts();
      back().click();
      await flush();
      expect(qa('.smart-import-file')).toHaveLength(1);
      expect(q('.smart-import-progress-short').textContent).toBe('1 of 5');
    });

    it('renders every string as text', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({
              account: {
                kind: 'checking',
                key: 'acct:abc',
                last4: '1234',
                institution: '<b>Bad</b> Bank',
              },
            })
          ),
      });
      await open();
      await toAccounts();
      expect(modal().querySelector('.smart-import-card b')).toBeNull();
      expect(q('.smart-import-card').textContent).toContain('<b>Bad</b> Bank');
    });
  });

  describe('column mapping', () => {
    const needsMapping: AnalyzeResponse = {
      status: 'needs_mapping',
      headers: ['When', 'Payee', 'Out', 'In'],
      sample_rows: [['2026-07-01', 'Rent', '1850.00', '']],
    };

    function mappingThenOk(): Setup['analyze'] {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return needsMapping;
        }
        return okAnswer(statement());
      };
    }

    it('shows a picker with the sample rows, then re-analyzes with the mapping', async () => {
      setup({ analyze: mappingThenOk() });
      await open();
      pick([csvFile()]);
      await flush();
      next().click();
      await flush();
      expect(q('.smart-import-mapping').textContent).toContain('Rent');
      const set = (field: string, value: string): void => {
        const s = q<HTMLSelectElement>(`[data-si="map-field"][data-field="${field}"]`);
        s.value = value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      };
      expect(next().disabled).toBe(true);
      // Incomplete: an error, no request.
      q('[data-si="map-apply"]').click();
      expect(q('.smart-import-mapping [role="alert"]').textContent).toContain(
        'Choose the date, description and amount columns.'
      );
      expect(uploadMock).toHaveBeenCalledTimes(1);
      set('date', 'When');
      set('description', 'Payee');
      set('debit', 'Out');
      set('credit', 'In');
      q('[data-si="map-apply"]').click();
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(2);
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).mapping).toEqual({
        date: 'When',
        description: 'Payee',
        debit: 'Out',
        credit: 'In',
      });
      expect(modal().querySelector('.smart-import-mapping')).toBeNull();
      expect(q('.smart-import-card').textContent).toContain('2 transactions');
    });

    it('keeps the mapping and header signature in state for Apply, and writes no settings', async () => {
      setup({ analyze: mappingThenOk() });
      const handle = await open();
      pick([csvFile()]);
      await flush();
      next().click();
      await flush();
      for (const [f, v] of [
        ['date', 'When'],
        ['description', 'Payee'],
        ['amount', 'Out'],
      ] as const) {
        const s = q<HTMLSelectElement>(`[data-si="map-field"][data-field="${f}"]`);
        s.value = v;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }
      q('[data-si="map-apply"]').click();
      await flush();
      const file = handle.getState().files[0]!;
      expect(file.options.mapping).toEqual({ date: 'When', description: 'Payee', amount: 'Out' });
      expect(file.layout_signature).toMatch(/^[0-9a-f]{64}$/);
      expect(calls.some((c) => c.url === '/api/smart-import/settings')).toBe(false);
    });

    it('applies a remembered layout without asking', async () => {
      const { csvHeaderSignature } = await import('@/utils/smart-import-state');
      const sig = csvHeaderSignature(['When', 'Payee', 'Out', 'In']);
      setup({
        ctx: context({
          csv_layouts: { [sig]: { date: 'When', description: 'Payee', amount: 'Out' } },
        }),
        analyze: mappingThenOk(),
      });
      await open();
      pick([csvFile()]);
      await flush();
      expect(uploadMock).toHaveBeenCalledTimes(2);
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).mapping).toEqual({
        date: 'When',
        description: 'Payee',
        amount: 'Out',
      });
    });
  });

  describe('debt link', () => {
    const cardStatement = (): NormalizedStatement =>
      statement({
        file_hash: 'hash-card',
        format: 'ofx',
        account: { kind: 'credit_card', key: 'acct:cc', last4: '4321', institution: 'Sample Bank' },
        closing_balance: { amount: 1200, as_of: '2026-09-30' },
      });

    const suggestion: PreviewResponse = {
      ...emptyPreview,
      liability_suggestions: [
        {
          file_hash: 'hash-card',
          account_key: 'acct:cc',
          liability_id: 'l2',
          reason: 'lender_match',
        },
      ],
    };

    it('is not shown for a checking account', async () => {
      await open();
      await toAccounts();
      expect(modal().querySelector('[data-si="debt"]')).toBeNull();
    });

    it('preselects the suggestion without applying it, and commits on Next', async () => {
      setup({
        analyze: () => okAnswer(cardStatement()),
        preview: suggestion,
        liabilities: [liability(), liability({ id: 'l2', name: 'Other Card' })],
      });
      const handle = await open();
      await toAccounts();
      const sel = q<HTMLSelectElement>('[data-si="debt"]');
      expect(sel.value).toBe('l2');
      expect(handle.getState().statements[0]!.liability_id).toBeNull();
      expect(handle.getState().statements[0]!.suggested_liability_id).toBe('l2');
      expect(Array.from(sel.options).map((o) => o.textContent)).toContain('Other Card');
      next().click();
      await flush();
      expect(handle.getState().statements[0]!.liability_id).toBe('l2');
    });

    it('suggests the only debt of a fitting type when the preview has no suggestion', async () => {
      setup({
        analyze: () => okAnswer(cardStatement()),
        liabilities: [
          liability({ id: 'only', name: 'Only Card' }),
          liability({ id: 'm1', name: 'Home', liability_type: 'mortgage' }),
        ],
      });
      const handle = await open();
      await toAccounts();
      expect(q<HTMLSelectElement>('[data-si="debt"]').value).toBe('only');
      expect(modal().textContent).toContain('Suggested match');
      expect(handle.getState().statements[0]!.liability_id).toBeNull();
      next().click();
      await flush();
      expect(handle.getState().statements[0]!.liability_id).toBe('only');
    });

    it('does not guess when two debts fit', async () => {
      setup({
        analyze: () => okAnswer(cardStatement()),
        liabilities: [liability(), liability({ id: 'l9', name: 'Second' })],
      });
      await open();
      await toAccounts();
      expect(q<HTMLSelectElement>('[data-si="debt"]').value).toBe('');
    });

    it('has one "Link to a debt" label, with Skip and Add grouped with the select', async () => {
      setup({ analyze: () => okAnswer(cardStatement()), liabilities: [] });
      await open();
      await toAccounts();
      const group = q('.smart-import-debt-group');
      expect(modal().textContent!.split('Link to a debt').length - 1).toBe(1);
      expect(group.querySelector('label')!.textContent).toBe('Link to a debt');
      expect(group.querySelector('[data-si="debt-skip"]')).not.toBeNull();
      expect(group.querySelector('[data-si="debt-new"]')).not.toBeNull();
    });

    it('puts "Leave this file out" in the card header', async () => {
      await open();
      await toAccounts();
      expect(q('.smart-import-card-head [data-si="remove-file"]').textContent).toBe(
        'Leave this file out'
      );
      expect(qa('.smart-import-card [data-si="remove-file"]')).toHaveLength(1);
    });

    it('Skip clears the choice and the suggestion is not committed', async () => {
      setup({
        analyze: () => okAnswer(cardStatement()),
        preview: suggestion,
        liabilities: [liability({ id: 'l2', name: 'Other Card' })],
      });
      const handle = await open();
      await toAccounts();
      q('[data-si="debt-skip"]').click();
      expect(q<HTMLSelectElement>('[data-si="debt"]').value).toBe('');
      next().click();
      await flush();
      expect(handle.getState().statements[0]!.liability_id).toBeNull();
    });

    it('lets the person pick another debt', async () => {
      setup({
        analyze: () => okAnswer(cardStatement()),
        liabilities: [liability(), liability({ id: 'l3', name: 'Third' })],
      });
      const handle = await open();
      await toAccounts();
      const sel = q<HTMLSelectElement>('[data-si="debt"]');
      sel.value = 'l3';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      expect(handle.getState().statements[0]!.liability_id).toBe('l3');
    });

    function fakeDebtWizard(): void {
      debtLauncherMock.mockImplementation(async (options) => {
        const fake = document.createElement('div');
        fake.id = 'dynamic-modal';
        document.body.appendChild(fake);
        savedCallback = options?.onSaved as typeof savedCallback;
        return { modal: fake, close: () => fake.remove() } as never;
      });
    }
    let savedCallback: ((r: { id: string }) => void) | undefined;

    it('"Add as a new debt" opens the debt wizard prefilled, then returns and refreshes', async () => {
      setup({ analyze: () => okAnswer(cardStatement()), liabilities: [] });
      const handle = await open();
      await toAccounts();
      fakeDebtWizard();
      // The debt wizard replaces our modal: ours is removed first.
      q('[data-si="debt-new"]').click();
      await flush();
      expect(debtLauncherMock).toHaveBeenCalledTimes(1);
      expect(debtLauncherMock.mock.calls[0]![0]).toMatchObject({
        prefill: {
          liabilityType: 'credit_card',
          lender: 'Sample Bank',
          currentBalance: '1200.00',
        },
      });
      expect(handle.getState().statements).toHaveLength(1);
      apiCallMock.mockImplementation(async (url: string) => {
        if (url === '/api/liabilities') return [liability({ id: 'new1', name: 'Sample Card' })];
        if (url === '/api/smart-import/preview') return emptyPreview;
        return {};
      });
      savedCallback!({ id: 'new1' });
      document.getElementById('dynamic-modal')!.remove();
      await flush();
      expect(q('.smart-import-progress-short').textContent).toBe('2 of 5');
      const sel = q<HTMLSelectElement>('[data-si="debt"]');
      expect(sel.value).toBe('new1');
      expect(Array.from(sel.options).map((o) => o.value)).toContain('new1');
    });

    it('returns to the Accounts step when the debt wizard is closed without saving', async () => {
      setup({ analyze: () => okAnswer(cardStatement()), liabilities: [] });
      await open();
      await toAccounts();
      fakeDebtWizard();
      q('[data-si="debt-new"]').click();
      await flush();
      document.getElementById('dynamic-modal')!.remove();
      await flush();
      expect(q('.smart-import-progress-short').textContent).toBe('2 of 5');
      expect(q<HTMLSelectElement>('[data-si="debt"]').value).toBe('');
    });
  });

  describe('PDF without a readable layout', () => {
    const layout: AnalyzeResponse = {
      status: 'needs_ai_layout',
      file_hash: 'hash-pdf',
      line_count: 2,
      lines: ['07/01 RENT ***', '07/03 NETFLIX 15.49'],
    };
    const aiOn = { pdf_ai_available: true, provider: 'Anthropic Claude', model: 'm' };

    it('shows the masked lines and "Send these 2 lines" when PDF AI is available', async () => {
      setup({ analyze: () => layout, ai: aiOn });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      expect(q('.smart-import-lines').textContent).toBe('07/01 RENT ***\n07/03 NETFLIX 15.49');
      expect(q('[data-si="send-lines"]').textContent).toBe('Send these 2 lines');
      expect(q('.smart-import-ai-card').textContent).toContain('Anthropic Claude');
      expect(next().disabled).toBe(true);
    });

    it('posts exactly the lines, categories and rules, then folds the answer in', async () => {
      let n = 0;
      setup({ analyze: () => (n++ === 0 ? layout : okAnswer(statement())), ai: aiOn });
      const handle = await open();
      await toAccounts([csvFile('a.pdf')]);
      apiCallMock.mockImplementation(async (url: string) => {
        if (url === '/api/smart-import/extract') return okAnswer(statement({ parser: 'pdf:ai' }));
        if (url === '/api/smart-import/preview') return emptyPreview;
        return {};
      });
      q('[data-si="send-lines"]').click();
      await flush();
      const extract = apiCallMock.mock.calls.find((c) => c[0] === '/api/smart-import/extract')!;
      expect(extract[1]).toMatchObject({ method: 'POST' });
      expect((extract[1] as { body: unknown }).body).toEqual({
        lines: ['07/01 RENT ***', '07/03 NETFLIX 15.49'],
        categories: [
          { id: 'c1', name: 'Entertainment' },
          { id: 'c2', name: 'Groceries' },
        ],
        rules: [{ merchant_key: 'netflix', category_id: 'c1', kind: null }],
      });
      expect(handle.getState().statements).toHaveLength(1);
      expect(handle.getState().ai_provider).toBe('Anthropic Claude');
      expect(modal().querySelector('.smart-import-ai-card')).toBeNull();
    });

    it('shows a fixed message and keeps the lines when the AI call fails', async () => {
      setup({ analyze: () => layout, ai: aiOn });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      apiCallMock.mockImplementation(async (url: string) => {
        if (url === '/api/smart-import/extract')
          throw new ApiError(502, 'raw upstream text', { error_type: 'ai_bad_response' });
        return {};
      });
      q('[data-si="send-lines"]').click();
      await flush();
      expect(modal().textContent).not.toContain('raw upstream');
      expect(modal().textContent).toContain('could not read these lines');
      expect(q('.smart-import-lines')).not.toBeNull();
    });

    it('reads ai_not_enabled from the error body', async () => {
      setup({ analyze: () => layout, ai: aiOn });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      apiCallMock.mockImplementation(async (url: string) => {
        if (url === '/api/smart-import/extract')
          throw new ApiError(400, 'x', { error_type: 'ai_not_enabled' });
        return {};
      });
      q('[data-si="send-lines"]').click();
      await flush();
      expect(modal().textContent).toContain('turned off');
    });

    it('hides the send button and shows the CSV or OFX hint when PDF AI is off', async () => {
      setup({ analyze: () => layout, ai: { pdf_ai_available: false } });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      expect(modal().querySelector('[data-si="send-lines"]')).toBeNull();
      expect(modal().textContent).toContain('Try your bank’s CSV or OFX download');
    });

    it('gates on ai-status, not on the profile consent setting', async () => {
      setup({
        analyze: () => layout,
        ctx: context({ settings: { ...context().settings, pdf_ai_enabled: true } }),
        ai: { pdf_ai_available: false, pdf_ai_enabled: true },
      });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      expect(modal().querySelector('[data-si="send-lines"]')).toBeNull();
    });

    it('treats a failed ai-status call as unavailable', async () => {
      setup({ analyze: () => layout, ai: 'fail' });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      expect(modal().querySelector('[data-si="send-lines"]')).toBeNull();
    });
  });

  describe('focus, touch targets and review fixes', () => {
    const active = (): HTMLElement => document.activeElement as HTMLElement;

    it('keeps the hidden file input out of the tab order', async () => {
      await open();
      expect(q<HTMLInputElement>('input[type="file"]').tabIndex).toBe(-1);
    });

    it('moves focus to the next Remove button after a file is removed', async () => {
      await open();
      pick([csvFile('a.csv'), csvFile('b.csv')]);
      await flush();
      const removes = qa<HTMLButtonElement>('.smart-import-files [data-si="remove-file"]');
      expect(removes).toHaveLength(2);
      removes[0]!.focus();
      removes[0]!.click();
      await flush();
      expect(active().getAttribute('data-si')).toBe('remove-file');
      expect(active().isConnected).toBe(true);
      expect(active().closest('li')!.textContent).toContain('b.csv');
    });

    it('focuses the drop zone after the last file is removed', async () => {
      await open();
      pick([csvFile('a.csv')]);
      await flush();
      const remove = q<HTMLButtonElement>('.smart-import-files [data-si="remove-file"]');
      remove.focus();
      remove.click();
      await flush();
      expect(active().getAttribute('data-si')).toBe('dropzone');
    });

    it('keeps focus on the same control when an analyze finishes in the background', async () => {
      let release: () => void = () => {};
      setup({
        analyze: (file) =>
          file.name === 'b.csv'
            ? new Promise((r) => {
                release = () => r(okAnswer(statement({ file_name: 'b.csv' })));
              })
            : okAnswer(statement({ file_name: file.name })),
      });
      await open();
      pick([csvFile('a.csv')]);
      await flush();
      pick([csvFile('b.csv')]);
      await flush();
      const first = q<HTMLButtonElement>('.smart-import-files [data-si="remove-file"]');
      first.focus();
      release();
      await flush();
      expect(active().getAttribute('data-si')).toBe('remove-file');
      expect(active().isConnected).toBe(true);
      expect(active().closest('li')!.textContent).toContain('a.csv');
    });

    it('puts focus back on "Send these N lines" after a failed send', async () => {
      setup({
        analyze: () => ({
          status: 'needs_ai_layout',
          file_hash: 'hash-pdf',
          line_count: 1,
          lines: ['07/01 RENT ***'],
        }),
        ai: { pdf_ai_available: true, provider: 'P', model: 'm' },
      });
      await open();
      await toAccounts([csvFile('a.pdf')]);
      const send = q<HTMLButtonElement>('[data-si="send-lines"]');
      send.focus();
      send.click();
      await flush();
      expect(active().getAttribute('data-si')).toBe('send-lines');
      expect(active().isConnected).toBe(true);
    });

    it('reloads debts each time the Accounts step opens', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({
              account: {
                kind: 'credit_card',
                key: 'acct:card',
                last4: '1',
                institution: 'Sample Bank',
              },
            })
          ),
      });
      await open();
      await toAccounts();
      back().click();
      await flush();
      next().click();
      await flush();
      expect(calls.filter((c) => c.url === '/api/liabilities')).toHaveLength(2);
    });

    it('says that "Add as a new debt" saves right away', async () => {
      setup({
        analyze: () =>
          okAnswer(
            statement({
              account: {
                kind: 'credit_card',
                key: 'acct:card',
                last4: '1',
                institution: 'Sample Bank',
              },
            })
          ),
      });
      await open();
      await toAccounts();
      expect(q('.smart-import-debt').textContent).toContain(
        '"Add as a new debt" saves that debt right away'
      );
    });

    it('lets the person confirm an assumed month-first date order', async () => {
      setup({
        analyze: (_f, ctx) =>
          okAnswer(statement({ warnings: ctx.date_order ? [] : ['date_order_assumed'] })),
      });
      await open();
      await toAccounts();
      expect(q('[data-statement]').textContent).toContain('could be read either way');
      const confirm = q<HTMLButtonElement>('[data-si="date-confirm"]');
      expect(confirm.textContent).toBe('Looks right');
      confirm.click();
      await flush();
      expect((uploadMock.mock.calls[1]![2] as Record<string, unknown>).date_order).toBe('mdy');
      expect(modal().querySelector('[data-si="date-confirm"]')).toBeNull();
      expect(q('[data-statement]').textContent).not.toContain('could be read either way');
      expect(q<HTMLSelectElement>('[data-si="date-order"]').value).toBe('mdy');
    });

    it('gives every wizard button a 44px target on phones', () => {
      const css = readFileSync(resolve(import.meta.dirname, '../../style.css'), 'utf8');
      const start = css.indexOf('/* Smart import wizard: shell, Upload and Accounts steps */');
      const phone = css.slice(css.indexOf('@media (max-width: 768px)', start));
      const block = phone.slice(0, phone.indexOf('\n}\n'));
      expect(block).toMatch(/\.smart-import-step \.btn[^{]*\{[^}]*min-height:\s*44px/);
    });
  });

  describe('categorize step', () => {
    type Txn = NormalizedStatement['transactions'][number];
    const txn = (row: number, over: Partial<Txn> = {}): Txn => ({
      row,
      posted_date: '2026-07-10',
      amount: -10,
      description: `ROW ${row}`,
      merchant_key: `merchant ${row}`,
      kind: 'expense',
      category_id: null,
      category_source: 'none',
      external_id: null,
      dedupe_base: `d${row}`,
      ...over,
    });

    /** Rule row, two uncategorized SAFEWAY rows, income, a seed row, a duplicate. */
    const mixed = (): Txn[] => [
      txn(0, {
        description: 'NETFLIX.COM',
        merchant_key: 'netflix',
        amount: -15.49,
        category_id: 'c1',
        category_source: 'rule',
      }),
      txn(1, { description: 'SAFEWAY #1', merchant_key: 'safeway', amount: -62.18 }),
      txn(2, { description: 'SAFEWAY #2', merchant_key: 'safeway', amount: -40 }),
      txn(3, {
        description: 'PAYROLL',
        merchant_key: 'payroll',
        amount: 2400,
        kind: 'income',
      }),
      txn(4, {
        description: 'TRADER JOES',
        merchant_key: 'trader joes',
        amount: -47.3,
        category_id: 'c2',
        category_source: 'seed',
      }),
      txn(5, {
        description: 'OLD CHARGE',
        merchant_key: 'old charge',
        amount: -9,
        dedupe_base: 'dup',
      }),
    ];

    const aiOn: Partial<SmartImportAiStatus> = {
      ai_available: true,
      ai_enabled: true,
      provider: 'Fake AI',
      model: 'fake-model-1',
    };

    async function toCategorize(
      transactions: Txn[] = mixed(),
      s: Setup = {}
    ): Promise<ReturnType<typeof openSmartImportWizard>> {
      setup({
        preview: { ...emptyPreview, existing_dedupe_keys: ['acct:abc|dup'] },
        analyze: (file) => okAnswer(statement({ file_name: file.name, transactions })),
        ...s,
      });
      const handle = await open();
      await toAccounts();
      next().click();
      await flush();
      return handle;
    }

    const rowEls = (): HTMLElement[] => qa('tbody .smart-import-row');
    const rowFor = (desc: string): HTMLElement =>
      rowEls().find((r) => r.querySelector('.smart-import-desc-text')?.textContent === desc)!;
    const filterBtn = (f: string): HTMLButtonElement =>
      q<HTMLButtonElement>(`[data-si="filter"][data-filter="${f}"]`);
    const change = (
      target: HTMLSelectElement | HTMLInputElement,
      value: string | boolean
    ): void => {
      if (typeof value === 'boolean') (target as HTMLInputElement).checked = value;
      else target.value = value;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const writes = (): string[] =>
      calls
        .filter((c) => (c.options?.method ?? 'GET') !== 'GET')
        .map((c) => `${c.options!.method} ${c.url}`);

    afterEach(() => {
      store.set('dataMode', 'server');
    });

    it('opens on Next from Accounts as "3 of 5" with the table columns', async () => {
      await toCategorize();
      expect(q('.smart-import-progress-short').textContent).toBe('3 of 5');
      expect(q('.smart-import-heading').textContent).toBe('Categorize transactions');
      const heads = qa('.smart-import-table thead th').map((th) => th.textContent);
      expect(heads.slice(1)).toEqual([
        'Date',
        'Description',
        'Amount',
        'Category',
        'Kind',
        'Source',
      ]);
    });

    it('is a grid with explicit row, cell and column header roles', async () => {
      await toCategorize();
      expect(q('.smart-import-table').getAttribute('role')).toBe('grid');
      expect(
        qa('.smart-import-table thead th').every((th) => th.getAttribute('role') === 'columnheader')
      ).toBe(true);
      for (const tr of rowEls()) {
        expect(tr.getAttribute('role')).toBe('row');
        expect(tr.getAttribute('aria-selected')).toBe('false');
        expect(Array.from(tr.children).every((td) => td.getAttribute('role') === 'gridcell')).toBe(
          true
        );
      }
    });

    it('defaults to "Needs review" when any row needs it, and counts each filter', async () => {
      await toCategorize();
      expect(filterBtn('review').getAttribute('aria-pressed')).toBe('true');
      expect(filterBtn('review').textContent).toBe('Needs review (2)');
      expect(filterBtn('all').textContent).toBe('All (6)');
      expect(filterBtn('duplicates').textContent).toBe('Duplicates (1)');
      expect(filterBtn('excluded').textContent).toBe('Excluded (0)');
      expect(rowEls().map((r) => r.querySelector('.smart-import-desc-text')!.textContent)).toEqual([
        'SAFEWAY #1',
        'SAFEWAY #2',
      ]);
    });

    it('defaults to "All" when nothing needs review', async () => {
      await toCategorize([mixed()[0]!, mixed()[3]!]);
      expect(filterBtn('all').getAttribute('aria-pressed')).toBe('true');
      expect(rowEls()).toHaveLength(2);
    });

    it('shows source chips (Rule, Built-in) and the duplicate badge', async () => {
      await toCategorize();
      filterBtn('all').click();
      await flush();
      expect(rowFor('NETFLIX.COM').querySelector('.smart-import-chip')!.textContent).toBe('Rule');
      expect(rowFor('TRADER JOES').querySelector('.smart-import-chip')!.textContent).toBe(
        'Built-in'
      );
      expect(rowFor('OLD CHARGE').querySelector('.smart-import-badge')!.textContent).toBe(
        'Duplicate'
      );
      expect(rowFor('NETFLIX.COM').querySelector('.smart-import-badge')).toBeNull();
      filterBtn('duplicates').click();
      await flush();
      expect(rowEls()).toHaveLength(1);
    });

    it('has no category for income rows', async () => {
      await toCategorize();
      filterBtn('all').click();
      await flush();
      const sel = rowFor('PAYROLL').querySelector<HTMLSelectElement>('[data-si="category"]')!;
      expect(sel.disabled).toBe(true);
    });

    it('changing a category offers "Remember for all <merchant>", checked, and updates the other rows', async () => {
      const handle = await toCategorize();
      const sel = rowFor('SAFEWAY #1').querySelector<HTMLSelectElement>('[data-si="category"]')!;
      change(sel, 'c2');
      await flush();
      const rows = handle.getState().rows;
      expect(rows.find((r) => r.description === 'SAFEWAY #2')!.category_id).toBe('c2');
      expect(rows.find((r) => r.description === 'SAFEWAY #1')!.category_source).toBe('user');
      const remember = q<HTMLInputElement>('[data-si="remember"]');
      expect(remember.checked).toBe(true);
      expect(remember.closest('label')!.textContent).toContain('Remember for all safeway');
      expect(handle.getState().remembered.safeway).toEqual({ category_id: 'c2' });
      // Both rows stay in view (no jump) and show "You".
      expect(rowEls()).toHaveLength(2);
      expect(rowFor('SAFEWAY #2').querySelector('.smart-import-chip')!.textContent).toBe('You');
      expect(
        rowFor('SAFEWAY #2').querySelector<HTMLSelectElement>('[data-si="category"]')!.value
      ).toBe('c2');
    });

    it('unticking "Remember" keeps the change on that row only and forgets the merchant', async () => {
      const handle = await toCategorize();
      change(rowFor('SAFEWAY #1').querySelector<HTMLSelectElement>('[data-si="category"]')!, 'c2');
      await flush();
      change(q<HTMLInputElement>('[data-si="remember"]'), false);
      await flush();
      const rows = handle.getState().rows;
      expect(rows.find((r) => r.description === 'SAFEWAY #1')!.category_id).toBe('c2');
      expect(rows.find((r) => r.description === 'SAFEWAY #2')!.category_id).toBeNull();
      expect(handle.getState().remembered).toEqual({});
      expect(q<HTMLInputElement>('[data-si="remember"]').checked).toBe(false);
    });

    it('changing a kind offers "Remember" too', async () => {
      const handle = await toCategorize();
      change(
        rowFor('SAFEWAY #1').querySelector<HTMLSelectElement>('[data-si="kind"]')!,
        'transfer'
      );
      await flush();
      expect(handle.getState().rows.find((r) => r.description === 'SAFEWAY #2')!.kind).toBe(
        'transfer'
      );
      expect(q<HTMLInputElement>('[data-si="remember"]').checked).toBe(true);
    });

    describe('selection and the bulk bar', () => {
      const tick = (desc: string): void =>
        change(rowFor(desc).querySelector<HTMLInputElement>('[data-si="row-select"]')!, true);

      it('is sticky and disabled until rows are selected', async () => {
        await toCategorize();
        const bar = q('.smart-import-bulk');
        expect(bar).not.toBeNull();
        expect(q<HTMLSelectElement>('[data-si="bulk-category"]').disabled).toBe(true);
        expect(q<HTMLSelectElement>('[data-si="bulk-kind"]').disabled).toBe(true);
        expect(q<HTMLButtonElement>('[data-si="bulk-exclude"]').disabled).toBe(true);
        tick('SAFEWAY #1');
        await flush();
        expect(q('.smart-import-bulk-count').textContent).toBe('1 selected');
        expect(q<HTMLSelectElement>('[data-si="bulk-category"]').disabled).toBe(false);
      });

      it('sets a category on the selected rows', async () => {
        const handle = await toCategorize();
        filterBtn('all').click();
        await flush();
        tick('SAFEWAY #1');
        tick('PAYROLL');
        await flush();
        change(q<HTMLSelectElement>('[data-si="bulk-category"]'), 'c1');
        await flush();
        const rows = handle.getState().rows;
        expect(rows.find((r) => r.description === 'SAFEWAY #1')!.category_id).toBe('c1');
        // Income takes no category.
        expect(rows.find((r) => r.description === 'PAYROLL')!.category_id).toBeNull();
      });

      it('sets a kind on the selected rows', async () => {
        const handle = await toCategorize();
        tick('SAFEWAY #1');
        await flush();
        change(q<HTMLSelectElement>('[data-si="bulk-kind"]'), 'fee');
        await flush();
        expect(handle.getState().rows.find((r) => r.description === 'SAFEWAY #1')!.kind).toBe(
          'fee'
        );
      });

      it('excludes the selected rows, then includes them again', async () => {
        const handle = await toCategorize();
        tick('SAFEWAY #1');
        await flush();
        q<HTMLButtonElement>('[data-si="bulk-exclude"]').click();
        await flush();
        expect(handle.getState().rows.find((r) => r.description === 'SAFEWAY #1')!.excluded).toBe(
          true
        );
        expect(filterBtn('excluded').textContent).toBe('Excluded (1)');
        expect(rowFor('SAFEWAY #1').classList.contains('is-excluded')).toBe(true);
        expect(q('[data-si="bulk-exclude"]').textContent).toBe('Include');
        q<HTMLButtonElement>('[data-si="bulk-exclude"]').click();
        await flush();
        expect(handle.getState().rows.find((r) => r.description === 'SAFEWAY #1')!.excluded).toBe(
          false
        );
      });

      it('"Select all N rows in this list" selects the list and matches the selection', async () => {
        await toCategorize();
        const all = q<HTMLInputElement>('[data-si="select-all"]');
        expect(all.closest('label')!.textContent).toBe('Select all 2 rows in this list');
        change(all, true);
        await flush();
        expect(q('.smart-import-bulk-count').textContent).toBe('2 selected');
        expect(rowEls().every((r) => r.getAttribute('aria-selected') === 'true')).toBe(true);
        change(rowEls()[0]!.querySelector<HTMLInputElement>('[data-si="row-select"]')!, false);
        await flush();
        const again = q<HTMLInputElement>('[data-si="select-all"]');
        expect(again.checked).toBe(false);
        expect(again.indeterminate).toBe(true);
        expect(q('.smart-import-bulk-count').textContent).toBe('1 selected');
      });

      it('keeps the Remember offer through selection changes', async () => {
        await toCategorize();
        change(
          rowFor('SAFEWAY #1').querySelector<HTMLSelectElement>('[data-si="category"]')!,
          'c2'
        );
        await flush();
        change(q<HTMLInputElement>('[data-si="select-all"]'), true);
        await flush();
        expect(modal().querySelector('[data-si="remember"]')).not.toBeNull();
        const date = rowEls()[0]!.children[1] as HTMLElement;
        date.focus();
        date.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
        );
        await flush();
        expect(modal().querySelector('[data-si="remember"]')).not.toBeNull();
      });

      it('"Accept all suggestions" confirms low-confidence AI rows', async () => {
        const handle = await toCategorize(mixed(), {
          ai: aiOn,
          categorize: (body) => ({
            suggestions: body.items.map((i) => ({
              id: i.id,
              category: 'Groceries',
              kind: null,
              confidence: 0.5,
            })),
            provider: 'Fake AI',
            model: 'fake-model-1',
          }),
        });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="ai-send"]').click();
        await flush();
        expect(filterBtn('review').textContent).toBe('Needs review (2)');
        const accept = q<HTMLButtonElement>('[data-si="bulk-accept"]');
        expect(accept.disabled).toBe(false);
        accept.click();
        await flush();
        expect(filterBtn('review').textContent).toBe('Needs review (0)');
        expect(handle.getState().rows.filter((r) => r.category_source === 'ai')).toHaveLength(2);
      });
    });

    describe('AI suggestions', () => {
      it('hides "Suggest with AI" when ai-status says it is unavailable, even with consent saved', async () => {
        await toCategorize(mixed(), {
          ctx: context({ settings: { ...context().settings, ai_enabled: true } }),
          ai: { ai_available: false, ai_enabled: true },
        });
        expect(modal().querySelector('[data-si="ai-suggest"]')).toBeNull();
        expect(modal().textContent).toContain('AI suggestions are off');
      });

      it('shows nothing about AI in hosted mode when it is unavailable', async () => {
        store.set('dataMode', 'local');
        await toCategorize();
        expect(modal().querySelector('[data-si="ai-suggest"]')).toBeNull();
        expect(modal().textContent).not.toContain('AI suggestions are off');
      });

      it('"What gets sent" renders exactly the request, plus provider and model', async () => {
        const handle = await toCategorize(mixed(), { ai: aiOn });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        const state = handle.getState();
        const { request } = buildCategorizeRequest(state, state.categories);
        expect(request.items.length).toBeGreaterThan(0);
        const panel = q('[data-si="ai-panel"]');
        expect(JSON.parse(panel.querySelector('.smart-import-sent-json')!.textContent!)).toEqual(
          request
        );
        const shown = Array.from(panel.querySelectorAll('.smart-import-sent-items tbody tr')).map(
          (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)
        );
        expect(shown).toEqual(
          request.items.map((i) => [
            i.merchant,
            `$${i.typical_amount.toLocaleString('en-US')}`,
            i.direction === 'in' ? 'Money in' : 'Money out',
            String(i.count),
          ])
        );
        expect(
          Array.from(panel.querySelectorAll('.smart-import-sent-categories li')).map(
            (li) => li.textContent
          )
        ).toEqual(request.categories);
        expect(panel.querySelector('[data-si="ai-provider"]')!.textContent).toBe('Fake AI');
        expect(panel.querySelector('[data-si="ai-model"]')!.textContent).toBe('fake-model-1');
        expect(panel.textContent).toContain('does not store or log');
      });

      it('sends one request per 60 merchants and applies the suggestions', async () => {
        const many = Array.from({ length: 70 }, (_, i) =>
          txn(i, { description: `SHOP ${i}`, merchant_key: `shop number ${i}` })
        );
        const bodies: CategorizeRequest[] = [];
        const handle = await toCategorize(many, {
          ai: aiOn,
          categorize: (body) => {
            bodies.push(body);
            return {
              suggestions: body.items.map((i) => ({
                id: i.id,
                category: 'Groceries',
                kind: null,
                confidence: 0.92,
              })),
              provider: 'Fake AI',
              model: 'fake-model-1',
            };
          },
        });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        expect(q('[data-si="ai-panel"]').textContent).toContain('Sent in 2 batches');
        q<HTMLButtonElement>('[data-si="ai-send"]').click();
        await flush();
        const state0 = handle.getState();
        expect(bodies.map((b) => b.items.length)).toEqual([60, 10]);
        expect(state0.rows.every((r) => r.category_id === 'c2' && r.category_source === 'ai')).toBe(
          true
        );
        filterBtn('all').click();
        await flush();
        expect(rowEls()[0]!.querySelector('.smart-import-chip')!.textContent).toBe('AI 92%');
        expect(writes()).toEqual([
          'POST /api/smart-import/preview',
          'POST /api/smart-import/categorize',
          'POST /api/smart-import/categorize',
        ]);
      });

      it('asks for consent on first use in server mode, then saves ai_enabled and sends', async () => {
        const puts: unknown[] = [];
        await toCategorize(mixed(), {
          ai: { ...aiOn, ai_enabled: false },
          settingsPut: (body) => {
            puts.push(body);
            return { ...context().settings, ai_enabled: true };
          },
          categorize: (body) => ({
            suggestions: body.items.map((i) => ({
              id: i.id,
              category: 'Groceries',
              kind: null,
              confidence: 0.9,
            })),
            provider: 'Fake AI',
            model: 'fake-model-1',
          }),
        });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        expect(modal().querySelector('[data-si="ai-send"]')).toBeNull();
        expect(q('[data-si="ai-panel"]').textContent).toContain('Turn on AI suggestions?');
        q<HTMLButtonElement>('[data-si="ai-consent"]').click();
        await flush();
        expect(puts).toEqual([{ ai_enabled: true }]);
        expect(writes()).toEqual([
          'POST /api/smart-import/preview',
          'PUT /api/smart-import/settings',
          'POST /api/smart-import/categorize',
        ]);
      });

      it('writes nothing when consent is declined', async () => {
        await toCategorize(mixed(), { ai: { ...aiOn, ai_enabled: false } });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="ai-cancel"]').click();
        await flush();
        expect(modal().querySelector('[data-si="ai-panel"]')).toBeNull();
        expect(writes()).toEqual(['POST /api/smart-import/preview']);
      });

      it('does not send when saving consent fails', async () => {
        await toCategorize(mixed(), {
          ai: { ...aiOn, ai_enabled: false },
          settingsPut: () => {
            throw new ApiError(500, 'secret detail');
          },
        });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="ai-consent"]').click();
        await flush();
        expect(writes()).toEqual([
          'POST /api/smart-import/preview',
          'PUT /api/smart-import/settings',
        ]);
        expect(modal().textContent).not.toContain('secret detail');
        expect(q('.smart-import-ai .smart-import-error').textContent).toContain('nothing was sent');
      });

      it('never asks for consent or writes settings in hosted mode', async () => {
        store.set('dataMode', 'local');
        await toCategorize(mixed(), {
          ai: { ...aiOn, ai_enabled: false },
          categorize: (body) => ({
            suggestions: body.items.map((i) => ({
              id: i.id,
              category: null,
              kind: null,
              confidence: 0,
            })),
            provider: 'Fake AI',
            model: 'fake-model-1',
          }),
        });
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        expect(modal().querySelector('[data-si="ai-consent"]')).toBeNull();
        q<HTMLButtonElement>('[data-si="ai-send"]').click();
        await flush();
        expect(writes()).toEqual([
          'POST /api/smart-import/preview',
          'POST /api/smart-import/categorize',
        ]);
      });

      for (const [status, errorType] of [
        [503, 'ai_unavailable'],
        [502, 'ai_bad_response'],
      ] as const) {
        it(`shows a fixed message on ${status} and leaves the rows untouched`, async () => {
          const handle = await toCategorize(mixed(), {
            ai: aiOn,
            categorize: () => {
              throw new ApiError(status, 'server detail text', {
                error_type: errorType,
                detail: 'server detail text',
              });
            },
          });
          const before = structuredClone(handle.getState().rows);
          q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
          await flush();
          q<HTMLButtonElement>('[data-si="ai-send"]').click();
          await flush();
          expect(handle.getState().rows).toEqual(before);
          const alert = q('.smart-import-ai .smart-import-error');
          expect(alert.getAttribute('role')).toBe('alert');
          expect(alert.textContent).toContain('Your rows are unchanged.');
          expect(modal().textContent).not.toContain('server detail text');
        });
      }

      it('leaves rows untouched when a later chunk fails', async () => {
        const many = Array.from({ length: 70 }, (_, i) =>
          txn(i, { description: `SHOP ${i}`, merchant_key: `shop number ${i}` })
        );
        let n = 0;
        const handle = await toCategorize(many, {
          ai: aiOn,
          categorize: (body) => {
            if (++n === 2) throw new ApiError(502, 'x', { error_type: 'ai_provider_error' });
            return {
              suggestions: body.items.map((i) => ({
                id: i.id,
                category: 'Groceries',
                kind: null,
                confidence: 0.9,
              })),
              provider: 'Fake AI',
              model: 'fake-model-1',
            };
          },
        });
        const before = structuredClone(handle.getState().rows);
        q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="ai-send"]').click();
        await flush();
        expect(handle.getState().rows).toEqual(before);
      });

      it('disables Suggest when no merchant is left to send', async () => {
        await toCategorize([mixed()[0]!, mixed()[3]!], { ai: aiOn });
        expect(q<HTMLButtonElement>('[data-si="ai-suggest"]').disabled).toBe(true);
      });
    });

    it('renders 200 rows at a time with "Show more"', async () => {
      const many = Array.from({ length: 450 }, (_, i) =>
        txn(i, { description: `SHOP ${i}`, merchant_key: `shop number ${i}` })
      );
      await toCategorize(many);
      expect(rowEls()).toHaveLength(200);
      const more = q<HTMLButtonElement>('[data-si="show-more"]');
      expect(q('.smart-import-more').textContent).toContain('Showing 200 of 450');
      more.click();
      await flush();
      expect(rowEls()).toHaveLength(400);
      q<HTMLButtonElement>('[data-si="show-more"]').click();
      await flush();
      expect(rowEls()).toHaveLength(450);
      expect(modal().querySelector('[data-si="show-more"]')).toBeNull();
    });

    describe('keyboard grid', () => {
      const key = (target: Element, k: string): KeyboardEvent => {
        const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev;
      };
      const active = (): HTMLElement => document.activeElement as HTMLElement;
      const cellOf = (node: Element): [number, number] => {
        const td = node.closest('td')!;
        return [rowEls().indexOf(td.parentElement as HTMLElement), td.cellIndex];
      };
      /** Elements a Tab press would visit, in DOM order (jsdom has no real Tab). */
      const tabbables = (): HTMLElement[] =>
        qa<HTMLElement>('button, input, select, [tabindex]').filter(
          (n) => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled
        );

      it('is one tab stop: Tab enters on the active cell and the next Tab leaves the grid', async () => {
        await toCategorize();
        const table = q('.smart-import-table');
        const order = tabbables();
        const inGrid = order.filter((n) => table.contains(n));
        expect(inGrid).toHaveLength(1);
        expect(inGrid[0]!.getAttribute('data-si')).toBe('row-select');
        expect(cellOf(inGrid[0]!)).toEqual([0, 0]);
        const after = order[order.indexOf(inGrid[0]!) + 1];
        expect(after).toBeDefined();
        expect(table.contains(after!)).toBe(false);
      });

      it('moves between rows with Up and Down and between cells with Left and Right', async () => {
        await toCategorize();
        const start = rowEls()[0]!.querySelector<HTMLElement>('[data-si="row-select"]')!;
        start.focus();
        expect(key(start, 'ArrowDown').defaultPrevented).toBe(true);
        expect(cellOf(active())).toEqual([1, 0]);
        key(active(), 'ArrowRight');
        expect(cellOf(active())).toEqual([1, 1]);
        expect(active().tagName).toBe('TD');
        key(active(), 'ArrowRight');
        key(active(), 'ArrowRight');
        key(active(), 'ArrowRight');
        expect(active().getAttribute('data-si')).toBe('category');
        // The arrows navigate from a select too.
        key(active(), 'ArrowUp');
        expect(cellOf(active())).toEqual([0, 4]);
        expect(active().getAttribute('data-si')).toBe('category');
        key(active(), 'ArrowLeft');
        expect(cellOf(active())).toEqual([0, 3]);
        // Only the active cell is tabbable.
        const table = q('.smart-import-table');
        expect(tabbables().filter((n) => table.contains(n))).toEqual([active()]);
      });

      it('jumps to the first and last row with Home and End', async () => {
        const many = Array.from({ length: 5 }, (_, i) =>
          txn(i, { description: `SHOP ${i}`, merchant_key: `shop number ${i}` })
        );
        await toCategorize(many);
        const start = rowEls()[2]!.children[1] as HTMLElement;
        start.focus();
        key(start, 'End');
        expect(cellOf(active())).toEqual([4, 1]);
        key(active(), 'Home');
        expect(cellOf(active())).toEqual([0, 1]);
      });

      it('toggles selection with Space on a cell and keeps focus there', async () => {
        await toCategorize();
        const date = rowEls()[1]!.children[1] as HTMLElement;
        date.focus();
        expect(key(date, ' ').defaultPrevented).toBe(true);
        await flush();
        expect(rowEls()[1]!.getAttribute('aria-selected')).toBe('true');
        expect(
          rowEls()[1]!.querySelector<HTMLInputElement>('[data-si="row-select"]')!.checked
        ).toBe(true);
        expect(cellOf(active())).toEqual([1, 1]);
        expect(active().isConnected).toBe(true);
      });

      it('leaves Space to a select', async () => {
        await toCategorize();
        const sel = rowEls()[0]!.querySelector<HTMLSelectElement>('[data-si="category"]')!;
        sel.focus();
        expect(key(sel, ' ').defaultPrevented).toBe(false);
      });
    });

    it('keeps focus on the filter that was clicked', async () => {
      await toCategorize();
      filterBtn('all').focus();
      filterBtn('all').click();
      await flush();
      expect(document.activeElement).toBe(filterBtn('all'));
      expect(filterBtn('all').getAttribute('aria-pressed')).toBe('true');
    });

    it('moves focus to the first new row when "Show more" goes away', async () => {
      const many = Array.from({ length: 250 }, (_, i) =>
        txn(i, { description: `SHOP ${i}`, merchant_key: `shop number ${i}` })
      );
      await toCategorize(many);
      const more = q<HTMLButtonElement>('[data-si="show-more"]');
      more.focus();
      more.click();
      await flush();
      expect(modal().querySelector('[data-si="show-more"]')).toBeNull();
      const tr = (document.activeElement as HTMLElement).closest('tr')!;
      expect(rowEls().indexOf(tr)).toBe(200);
    });

    it('turns the table into a card list on phones', () => {
      const css = readFileSync(resolve(import.meta.dirname, '../../style.css'), 'utf8');
      const start = css.indexOf('/* Smart import wizard: Categorize step */');
      expect(start).toBeGreaterThan(-1);
      const phone = css.slice(css.indexOf('@media (max-width: 768px)', start));
      const block = phone.slice(0, phone.indexOf('\n}\n'));
      expect(block).toMatch(/\.smart-import-table thead\s*\{[^}]*display:\s*none/);
      expect(block).toMatch(/\.smart-import-table \.smart-import-row\s*\{[^}]*display:\s*grid/);
    });

    it('writes nothing to the data layer while editing', async () => {
      await toCategorize();
      change(rowFor('SAFEWAY #1').querySelector<HTMLSelectElement>('[data-si="category"]')!, 'c2');
      await flush();
      change(rowFor('SAFEWAY #1').querySelector<HTMLInputElement>('[data-si="row-select"]')!, true);
      await flush();
      q<HTMLButtonElement>('[data-si="bulk-exclude"]').click();
      filterBtn('all').click();
      await flush();
      expect(writes()).toEqual(['POST /api/smart-import/preview']);
    });

    it('renders descriptions and merchants as text', async () => {
      const evil = '<img src=x onerror=alert(1)>';
      await toCategorize([txn(0, { description: evil, merchant_key: 'evil <b>shop</b>' })], {
        ai: aiOn,
      });
      expect(modal().querySelector('img, b')).toBeNull();
      expect(rowFor(evil)).toBeDefined();
      q<HTMLButtonElement>('[data-si="ai-suggest"]').click();
      await flush();
      expect(modal().querySelector('img, b')).toBeNull();
      expect(q('[data-si="ai-panel"]').textContent).toContain('evil <b>shop</b>');
    });

    it('Back returns to Accounts and Next moves on to step 4', async () => {
      await toCategorize();
      back().click();
      await flush();
      expect(q('.smart-import-progress-short').textContent).toBe('2 of 5');
      next().click();
      await flush();
      expect(q('.smart-import-progress-short').textContent).toBe('3 of 5');
      expect(next().disabled).toBe(false);
      next().click();
      await flush();
      expect(q('.smart-import-progress-short').textContent).toBe('4 of 5');
    });
  });

  describe('recurring, review, apply and done', () => {
    type Txn = NormalizedStatement['transactions'][number];
    const txn = (row: number, over: Partial<Txn> = {}): Txn => ({
      row,
      posted_date: '2026-07-10',
      amount: -10,
      description: `ROW ${row}`,
      merchant_key: `merchant ${row}`,
      kind: 'expense',
      category_id: null,
      category_source: 'none',
      external_id: null,
      dedupe_base: `d${row}`,
      ...over,
    });

    const checking = (): NormalizedStatement =>
      statement({
        file_hash: 'hash-chk',
        file_name: 'checking.csv',
        transactions: [
          txn(0, {
            description: 'NETFLIX.COM',
            merchant_key: 'netflix',
            amount: -15.49,
            category_id: 'c1',
            category_source: 'rule',
          }),
          txn(1, { description: 'SAFEWAY', merchant_key: 'safeway', amount: -62.18 }),
          txn(2, {
            description: 'GYM CLUB',
            merchant_key: 'gym club',
            amount: -40,
            category_id: 'c2',
            category_source: 'seed',
          }),
          txn(3, { description: 'OLD CHARGE', merchant_key: 'old charge', dedupe_base: 'dup' }),
        ],
      });

    const card = (over: Partial<NormalizedStatement> = {}): NormalizedStatement =>
      statement({
        file_hash: 'hash-card',
        file_name: 'card.ofx',
        format: 'ofx',
        parser: 'ofx',
        account: { kind: 'credit_card', key: 'acct:cc', last4: '4321', institution: 'Sample Bank' },
        closing_balance: { amount: 1200, as_of: '2026-09-30' },
        transactions: [txn(0, { description: 'CAFE', merchant_key: 'cafe', amount: -5 })],
        ...over,
      });

    const candidate = (
      merchant_key: string,
      over: Partial<RecurringCandidateSuggestion> = {}
    ): RecurringCandidateSuggestion => ({
      merchant_key,
      name: merchant_key.toUpperCase(),
      amount: 20,
      frequency: 'monthly',
      occurrences: 3,
      last_date: '2026-09-10',
      category_id: 'c2',
      already_budgeted: false,
      matched_expense_id: null,
      ...over,
    });

    const candidates = (): RecurringCandidateSuggestion[] => [
      candidate('netflix', {
        name: 'Netflix',
        amount: 15.49,
        category_id: 'c1',
        already_budgeted: true,
        matched_expense_id: 'e1',
      }),
      candidate('gym club', { name: 'Gym Club', amount: 40 }),
      candidate('safeway', { name: 'Safeway', amount: 62.18, category_id: null }),
    ];

    const expenses = [
      {
        id: 'e1',
        name: 'Netflix',
        amount: 15.49,
        monthly_amount: 15.49,
        frequency: 'monthly',
        category_id: 'c1',
        is_active: true,
      },
      {
        id: 'e9',
        name: 'Old gym',
        amount: 30,
        monthly_amount: 30,
        frequency: 'monthly',
        is_active: false,
      },
    ];

    const applied = (over: Partial<ApplyResponse> = {}): ApplyResponse => ({
      imports: [
        {
          import_id: 'imp-1',
          file_hash: 'hash-chk',
          txn_new: 3,
          txn_duplicate: 1,
          txn_excluded: 0,
          balance: 'none',
        },
        {
          import_id: 'imp-2',
          file_hash: 'hash-card',
          txn_new: 1,
          txn_duplicate: 0,
          txn_excluded: 0,
          balance: 'recorded',
        },
      ],
      skipped_files: [],
      rules_saved: 1,
      expenses_created: 1,
      expenses_linked: 0,
      pruned: 0,
      ...over,
    });

    const undone = (over: Partial<SmartImportUndoResponse> = {}): SmartImportUndoResponse => ({
      undone: true,
      deleted: { transactions: 2, recurring_candidates: 1, expenses: 1, snapshots: 0 },
      reassigned: { transactions: 0 },
      kept: [],
      ...over,
    });

    const writes = (): string[] =>
      calls
        .filter((c) => (c.options?.method ?? 'GET') !== 'GET')
        .map((c) => `${c.options!.method} ${c.url}`);
    const callsTo = (url: string) => calls.filter((c) => c.url === url);
    const change = (
      target: HTMLSelectElement | HTMLInputElement,
      value: string | boolean
    ): void => {
      if (typeof value === 'boolean') (target as HTMLInputElement).checked = value;
      else target.value = value;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const typeInto = (target: HTMLInputElement, value: string): void => {
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const cardFor = (key: string): HTMLElement => q(`[data-candidate="${key}"]`);
    const ctl = <T extends HTMLElement>(key: string, si: string): T =>
      cardFor(key).querySelector<T>(`[data-si="${si}"]`)!;
    const shortLabel = (): string => q('.smart-import-progress-short').textContent ?? '';

    function base(s: Setup = {}): Setup {
      return {
        preview: { ...emptyPreview, existing_dedupe_keys: ['acct:abc|dup'] },
        analyze: (file) => okAnswer(file.name.endsWith('.ofx') ? card() : checking()),
        liabilities: [liability({ current_balance: 900, balance_as_of: '2026-08-31' })],
        expenses,
        recurring: () => ({ candidates: candidates() }),
        apply: () => applied(),
        undo: () => undone(),
        ...s,
      };
    }

    const twoFiles = (): File[] => [
      csvFile('checking.csv'),
      new File(['OFXHEADER'], 'card.ofx', { type: 'application/x-ofx' }),
    ];

    async function toRecurring(
      s: Setup = {},
      files: File[] = twoFiles()
    ): Promise<ReturnType<typeof openSmartImportWizard>> {
      setup(base(s));
      const handle = await open();
      await toAccounts(files);
      next().click(); // to Categorize
      await flush();
      next().click(); // to Recurring
      await flush();
      return handle;
    }

    async function toReview(s: Setup = {}): Promise<ReturnType<typeof openSmartImportWizard>> {
      const handle = await toRecurring(s);
      change(ctl('safeway', 'rec-check'), false);
      await flush();
      next().click();
      await flush();
      return handle;
    }

    async function toDone(s: Setup = {}): Promise<ReturnType<typeof openSmartImportWizard>> {
      const handle = await toReview(s);
      q<HTMLButtonElement>('[data-si="apply"]').click();
      await flush();
      return handle;
    }

    let seen: string[] = [];
    let offs: (() => void)[] = [];
    beforeEach(() => {
      seen = [];
      offs = [on('liabilities:changed', (e) => seen.push(`liabilities:${e.reason}`))];
      vi.mocked(showTab).mockReset();
      vi.mocked(showBudgetTab).mockReset();
      vi.mocked(loadBudgetTab).mockReset();
      vi.mocked(loadBudgetTab).mockImplementation(async () => {
        seen.push('budget:reload');
      });
      vi.mocked(getCurrentTab).mockReturnValue('budget');
    });
    afterEach(() => {
      offs.forEach((off) => off());
    });

    describe('Recurring bills', () => {
      it('asks for candidates with one recurring call built from the rows and active expenses', async () => {
        const handle = await toRecurring();
        expect(shortLabel()).toBe('4 of 5');
        const rec = callsTo('/api/v2/smart-import/recurring');
        expect(rec).toHaveLength(1);
        expect(rec[0]!.options?.method).toBe('POST');
        const active = [
          {
            id: 'e1',
            name: 'Netflix',
            amount: 15.49,
            frequency: 'monthly',
            category_id: 'c1',
            is_active: true,
          },
        ];
        expect(rec[0]!.options?.body).toEqual(
          recurringRequest(handle.getState(), {
            expenses: active,
            categories: handle.getState().categories,
          })
        );
      });

      it('does not ask again on Back from Review or after an unchanged Categorize', async () => {
        await toRecurring();
        change(ctl('safeway', 'rec-check'), false);
        await flush();
        next().click();
        await flush();
        expect(shortLabel()).toBe('5 of 5');
        back().click();
        await flush();
        expect(shortLabel()).toBe('4 of 5');
        back().click();
        await flush();
        next().click();
        await flush();
        expect(shortLabel()).toBe('4 of 5');
        expect(callsTo('/api/v2/smart-import/recurring')).toHaveLength(1);
      });

      it('keeps edits when coming back from Review', async () => {
        const handle = await toRecurring();
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-name'), 'Gym membership');
        await flush();
        change(ctl('safeway', 'rec-check'), false);
        next().click();
        await flush();
        back().click();
        await flush();
        expect(ctl<HTMLInputElement>('gym club', 'rec-name').value).toBe('Gym membership');
        expect(handle.getState().recurring.find((c) => c.merchant_key === 'gym club')!.name).toBe(
          'Gym membership'
        );
      });

      it('starts an already budgeted bill unticked with its note', async () => {
        await toRecurring();
        expect(ctl<HTMLInputElement>('netflix', 'rec-check').checked).toBe(false);
        expect(ctl<HTMLInputElement>('gym club', 'rec-check').checked).toBe(true);
        expect(cardFor('netflix').querySelector('[data-si="rec-note"]')!.textContent).toMatch(
          /already in your budget/i
        );
        expect(cardFor('gym club').querySelector('[data-si="rec-note"]')).toBeNull();
      });

      it('edits name, amount, frequency and category', async () => {
        const handle = await toRecurring();
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-name'), 'Gym membership');
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-amount'), '42.5');
        change(ctl('gym club', 'rec-frequency'), 'biweekly');
        change(ctl('gym club', 'rec-category'), 'c1');
        await flush();
        const c = handle.getState().recurring.find((x) => x.merchant_key === 'gym club')!;
        expect(c).toMatchObject({
          name: 'Gym membership',
          amount: 42.5,
          frequency: 'biweekly',
          category_id: 'c1',
        });
      });

      it('needs a category on every ticked bill before Next', async () => {
        await toRecurring();
        expect(next().disabled).toBe(true);
        expect(cardFor('safeway').querySelector('[data-si="rec-error"]')!.textContent).toMatch(
          /category/i
        );
        change(ctl('safeway', 'rec-category'), 'c2');
        await flush();
        expect(next().disabled).toBe(false);
        expect(cardFor('safeway').querySelector('[data-si="rec-error"]')).toBeNull();
        change(ctl('safeway', 'rec-category'), '');
        await flush();
        expect(next().disabled).toBe(true);
        change(ctl('safeway', 'rec-check'), false);
        await flush();
        expect(next().disabled).toBe(false);
      });

      it('needs a name and an amount above zero on a ticked bill', async () => {
        await toRecurring();
        change(ctl('safeway', 'rec-check'), false);
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-amount'), '0');
        await flush();
        expect(next().disabled).toBe(true);
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-amount'), '40');
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-name'), '   ');
        await flush();
        expect(next().disabled).toBe(true);
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-name'), 'Gym');
        await flush();
        expect(next().disabled).toBe(false);
      });

      it('maps ticks to create, link and reject in the apply body', async () => {
        await toRecurring();
        change(ctl('netflix', 'rec-check'), true);
        change(ctl('safeway', 'rec-category'), 'c2');
        change(ctl('safeway', 'rec-check'), false);
        await flush();
        next().click();
        await flush();
        q<HTMLButtonElement>('[data-si="apply"]').click();
        await flush();
        const body = callsTo('/api/smart-import/apply')[0]!.options!.body as ApplyRequest;
        const byKey = Object.fromEntries((body.recurring ?? []).map((r) => [r.merchant_key, r]));
        expect(byKey['netflix']).toMatchObject({ decision: 'link', expense_id: 'e1' });
        expect(byKey['gym club']).toMatchObject({ decision: 'create', category_id: 'c2' });
        expect(byKey['safeway']).toMatchObject({ decision: 'reject' });
      });

      it('says so when nothing recurring was found, and lets the person go on', async () => {
        await toRecurring({ recurring: () => ({ candidates: [] }) });
        expect(q('[data-si="rec-empty"]').textContent).toMatch(/no recurring bills/i);
        expect(next().disabled).toBe(false);
      });

      it('shows a fixed message when the check fails, and lets the person go on', async () => {
        await toRecurring({
          recurring: () => {
            throw new ApiError(500, 'secret detail', { detail: 'secret detail' });
          },
        });
        const msg = q('[data-si="rec-failed"]').textContent ?? '';
        expect(msg).toMatch(/could not/i);
        expect(modal().textContent).not.toContain('secret detail');
        expect(next().disabled).toBe(false);
      });

      it('renders candidate names as text', async () => {
        await toRecurring({
          recurring: () => ({
            candidates: [candidate('evil', { name: '<img src=x onerror=alert(1)>' })],
          }),
        });
        expect(modal().querySelector('img')).toBeNull();
        expect(ctl<HTMLInputElement>('evil', 'rec-name').value).toBe(
          '<img src=x onerror=alert(1)>'
        );
      });
    });

    describe('Review', () => {
      it('shows the counts from reviewCounts', async () => {
        const handle = await toReview();
        expect(shortLabel()).toBe('5 of 5');
        const counts = reviewCounts(handle.getState());
        const value = (k: string): string => q(`[data-count="${k}"]`).textContent ?? '';
        expect(value('new')).toBe(String(counts.new));
        expect(value('duplicates')).toBe(String(counts.duplicates));
        expect(value('excluded')).toBe(String(counts.excluded));
        expect(value('merchants_to_remember')).toBe(String(counts.merchants_to_remember));
        expect(value('expenses_to_add')).toBe(String(counts.expenses_to_add));
        expect(value('expenses_to_link')).toBe(String(counts.expenses_to_link));
        expect(counts.new).toBe(4);
        expect(counts.duplicates).toBe(1);
        expect(counts.expenses_to_add).toBe(1);
      });

      it("shows each debt's balance before and after", async () => {
        await toReview();
        const debt = q('[data-debt="l1"]');
        expect(debt.textContent).toContain('Sample Card');
        expect(debt.querySelector('[data-si="debt-before"]')!.textContent).toBe('$900.00');
        expect(debt.querySelector('[data-si="debt-after"]')!.textContent).toBe('$1,200.00');
      });

      it('keeps the current balance as "after" for an older statement', async () => {
        await toReview({
          liabilities: [liability({ current_balance: 900, balance_as_of: '2026-10-02' })],
        });
        const debt = q('[data-debt="l1"]');
        expect(debt.querySelector('[data-si="debt-after"]')!.textContent).toBe('$900.00');
        expect(debt.textContent).toMatch(/older/i);
      });

      it('says how many rows will be saved without a category', async () => {
        const handle = await toReview();
        // SAFEWAY on checking and CAFE on the card have no category.
        expect(reviewCounts(handle.getState()).needs_review).toBe(2);
        expect(q('[data-count="needs_review"]').textContent).toBe('2');
        expect(modal().textContent).toMatch(/category can be changed later/);
      });

      it('Back returns to Recurring bills', async () => {
        await toReview();
        back().click();
        await flush();
        expect(shortLabel()).toBe('4 of 5');
      });
    });

    describe('Apply', () => {
      it('sends exactly one apply built by buildApplyRequest, even on a double click', async () => {
        const handle = await toReview();
        const expected = buildApplyRequest(handle.getState());
        const btn = q<HTMLButtonElement>('[data-si="apply"]');
        btn.click();
        btn.click();
        q<HTMLButtonElement>('[data-si="apply"]').click();
        await flush();
        const posts = callsTo('/api/smart-import/apply');
        expect(posts).toHaveLength(1);
        expect(posts[0]!.options?.method).toBe('POST');
        expect(posts[0]!.options?.body).toEqual(expected);
      });

      it('disables the button while the apply is in flight', async () => {
        let release: (v: unknown) => void = () => undefined;
        await toReview({ apply: () => new Promise((r) => (release = r)) });
        q<HTMLButtonElement>('[data-si="apply"]').click();
        const btn = q<HTMLButtonElement>('[data-si="apply"]');
        expect(btn.disabled).toBe(true);
        expect(back().disabled).toBe(true);
        release(applied());
        await flush();
        expect(q('[data-si="done-summary"]')).toBeTruthy();
      });

      it('PUTs the settings patch after a successful apply', async () => {
        const handle = await toReview();
        const expected = buildSettingsPatch(handle.getState(), context().settings);
        q<HTMLButtonElement>('[data-si="apply"]').click();
        await flush();
        const order = writes();
        expect(order.indexOf('POST /api/smart-import/apply')).toBeLessThan(
          order.indexOf('PUT /api/smart-import/settings')
        );
        const put = callsTo('/api/smart-import/settings').find((c) => c.options?.method === 'PUT');
        expect(put!.options!.body).toEqual(expected);
      });

      it('shows a soft warning when the settings save fails after the apply', async () => {
        await toDone({
          settingsPut: () => {
            throw new ApiError(500, 'x');
          },
        });
        expect(q('[data-si="done-summary"]')).toBeTruthy();
        expect(q('[data-si="settings-warning"]').textContent).toMatch(/import is saved/i);
      });

      it('catches ApplyTooLargeError before sending anything', async () => {
        const many = Array.from({ length: 13 }, (_, i) =>
          statement({
            file_hash: `hash-${i}`,
            account: { kind: 'checking', key: `acct:${i}`, last4: null, institution: null },
            transactions: [txn(0, { dedupe_base: `x${i}` })],
          })
        );
        setup(base({ analyze: () => okAnswer(...many), recurring: () => ({ candidates: [] }) }));
        await open();
        await toAccounts([csvFile('big.csv')]);
        next().click();
        await flush();
        next().click();
        await flush();
        next().click();
        await flush();
        q<HTMLButtonElement>('[data-si="apply"]').click();
        await flush();
        expect(callsTo('/api/smart-import/apply')).toHaveLength(0);
        expect(q('[data-si="apply-error"]').textContent).toMatch(/12 statements/);
        expect(shortLabel()).toBe('5 of 5');
      });

      it('stays on Review with a fixed message when the apply fails', async () => {
        await toReview({
          apply: () => {
            throw new ApiError(500, 'secret detail', { detail: 'secret detail' });
          },
        });
        q<HTMLButtonElement>('[data-si="apply"]').click();
        await flush();
        expect(q('[data-si="apply-error"]').textContent).toMatch(/nothing was saved/i);
        expect(modal().textContent).not.toContain('secret detail');
        expect(q<HTMLButtonElement>('[data-si="apply"]').disabled).toBe(false);
        expect(seen).toEqual([]);
      });

      it('refreshes the budget and debts after the apply', async () => {
        await toDone();
        expect(seen).toEqual(expect.arrayContaining(['liabilities:balance', 'budget:reload']));
      });

      it('leaves the Budget page to reload itself when it is not showing', async () => {
        vi.mocked(getCurrentTab).mockReturnValue('debts');
        await toDone();
        expect(seen).toEqual(['liabilities:balance']);
      });

      it('writes nothing before Apply (steps 1 to 4 and Review)', async () => {
        await toRecurring();
        typeInto(ctl<HTMLInputElement>('gym club', 'rec-name'), 'Gym membership');
        change(ctl('safeway', 'rec-category'), 'c2');
        await flush();
        next().click();
        await flush();
        back().click();
        await flush();
        next().click();
        await flush();
        expect(shortLabel()).toBe('5 of 5');
        const allowed = ['POST /api/smart-import/preview', 'POST /api/v2/smart-import/recurring'];
        expect(writes().length).toBeGreaterThan(0);
        for (const w of writes()) expect(allowed).toContain(w);
      });

      it('closes without the discard prompt once applied', async () => {
        await toDone();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await flush();
        expect(document.getElementById('dynamic-modal')).toBeNull();
      });
    });

    describe('Done', () => {
      it('shows the summary, skipped files and balances that were not recorded', async () => {
        await toDone({
          apply: () =>
            applied({
              imports: [
                {
                  import_id: 'imp-2',
                  file_hash: 'hash-card',
                  txn_new: 1,
                  txn_duplicate: 0,
                  txn_excluded: 0,
                  balance: 'skipped_existing',
                },
              ],
              skipped_files: ['hash-chk'],
            }),
        });
        expect(q('.smart-import-progress-short').textContent).toBe('Done');
        const text = q('[data-si="done-summary"]').textContent ?? '';
        expect(text).toContain('1 transaction saved');
        expect(text).toContain('checking.csv');
        expect(text).toMatch(/already imported/i);
        expect(text).toMatch(/A balance for .* was already recorded/);
      });

      it('explains a future statement date and a credit balance', async () => {
        await toDone({
          apply: () =>
            applied({
              imports: [
                {
                  import_id: 'imp-2',
                  file_hash: 'hash-card',
                  txn_new: 1,
                  txn_duplicate: 0,
                  txn_excluded: 0,
                  balance: 'skipped_future',
                },
              ],
            }),
        });
        expect(q('[data-si="done-summary"]').textContent).toMatch(/in the future/i);
      });

      it('"See planned vs actual" opens Budget > Expenses and closes the wizard', async () => {
        await toDone();
        q<HTMLButtonElement>('[data-si="planned"]').click();
        await flush();
        expect(vi.mocked(showTab)).toHaveBeenCalledWith('budget');
        expect(vi.mocked(showBudgetTab)).toHaveBeenCalledWith('expenses');
        expect(document.getElementById('dynamic-modal')).toBeNull();
      });
    });

    describe('Undo', () => {
      it('asks first, listing what goes and that remembered merchants stay', async () => {
        await toDone();
        q<HTMLButtonElement>('[data-si="undo"]').click();
        await flush();
        const text = q('.smart-import-confirm-text').textContent ?? '';
        expect(text).toContain('4 transactions');
        expect(text).toContain('1 expense it added');
        expect(text).toContain('1 debt balance');
        expect(text).toContain('Remembered merchants stay.');
        expect(writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);
        q<HTMLButtonElement>('[data-si="undo-cancel"]').click();
        await flush();
        expect(writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);
        expect(q('[data-si="undo"]')).toBeTruthy();
      });

      it('sends one DELETE per import id and shows kept and reassigned', async () => {
        seen = [];
        await toDone({
          undo: (id) =>
            id === 'imp-1'
              ? undone({
                  kept: [{ table: 'budget_expenses', id: 'x1', reason: 'edited' }],
                  reassigned: { transactions: 2 },
                })
              : undone({
                  deleted: { transactions: 1, recurring_candidates: 0, expenses: 0, snapshots: 1 },
                  kept: [{ table: 'budget_expenses', id: 'x2', reason: 'linked_to_debt' }],
                }),
        });
        seen = [];
        q<HTMLButtonElement>('[data-si="undo"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="undo-confirm"]').click();
        await flush();
        expect(writes().filter((w) => w.startsWith('DELETE'))).toEqual([
          'DELETE /api/smart-import/imports/imp-1',
          'DELETE /api/smart-import/imports/imp-2',
        ]);
        const result = q('[data-si="undo-result"]').textContent ?? '';
        expect(result).toContain('3 transactions');
        expect(result).toMatch(/changed after the import/i);
        expect(result).toMatch(/a debt links to it/i);
        expect(result).toMatch(/2 transactions .*another import/i);
        expect(result).toContain('Remembered merchants stay');
        expect(modal().querySelector('[data-si="undo"]')).toBeNull();
        expect(result).toContain('Removed 3 transactions, 1 expense and 1 debt balance.');
        expect(modal().querySelector('[data-si="done-summary"]')).toBeNull();
        expect(seen).toEqual(expect.arrayContaining(['liabilities:balance', 'budget:reload']));
      });

      it('reports a partial undo and offers the rest again', async () => {
        await toDone({
          undo: (id) => {
            if (id === 'imp-2') throw new ApiError(500, 'x');
            return undone();
          },
        });
        q<HTMLButtonElement>('[data-si="undo"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="undo-confirm"]').click();
        await flush();
        expect(q('[data-si="undo-error"]').textContent).toMatch(/1 of 2/);
        expect(q('[data-si="undo"]')).toBeTruthy();
        q<HTMLButtonElement>('[data-si="undo"]').click();
        await flush();
        q<HTMLButtonElement>('[data-si="undo-confirm"]').click();
        await flush();
        const deletes = writes().filter((w) => w.startsWith('DELETE'));
        expect(deletes).toEqual([
          'DELETE /api/smart-import/imports/imp-1',
          'DELETE /api/smart-import/imports/imp-2',
          'DELETE /api/smart-import/imports/imp-2',
        ]);
      });
    });

    it('lays the recurring cards out for every breakpoint', () => {
      const css = readFileSync(resolve(import.meta.dirname, '../../style.css'), 'utf8');
      const start = css.indexOf('/* Smart import wizard: Recurring, Review and Done */');
      expect(start).toBeGreaterThan(-1);
      const block = css.slice(start);
      expect(block).toMatch(/@media \(max-width: 1024px\)/);
      expect(block).toMatch(/@media \(max-width: 768px\)/);
      expect(block).toMatch(/@media \(max-width: 480px\)/);
    });
  });

  it('has no em-dash in the module sources', () => {
    const dash = String.fromCharCode(0x2014);
    for (const f of [
      '../../src/features/smart-import.ts',
      '../../src/utils/smart-import-render.ts',
    ]) {
      expect(readFileSync(resolve(import.meta.dirname, f), 'utf8')).not.toContain(dash);
    }
  });
});
