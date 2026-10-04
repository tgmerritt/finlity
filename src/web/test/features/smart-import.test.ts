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

import { apiCall, uploadFileWithContext, ApiError } from '@/api/client';
import { showToast } from '@/ui/toast';
import { closeDynamicModal } from '@/ui/modal';
import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import { openSmartImportWizard } from '@/features/smart-import';
import type {
  AnalyzeResponse,
  NormalizedStatement,
  PreviewResponse,
  SmartImportAiStatus,
  SmartImportContext,
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
          throw new ApiError(422, 'The PDF is password protected.');
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
          throw new ApiError(422, 'SELECT secret FROM something');
        },
      });
      await open();
      pick([csvFile()]);
      await flush();
      expect(modal().textContent).not.toContain('SELECT');
      expect(modal().textContent).toContain('could not be read');
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
        if (url === '/api/smart-import/extract') throw new ApiError(502, 'raw upstream text');
        return {};
      });
      q('[data-si="send-lines"]').click();
      await flush();
      expect(modal().textContent).not.toContain('raw upstream');
      expect(modal().textContent).toContain('could not read these lines');
      expect(q('.smart-import-lines')).not.toBeNull();
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
