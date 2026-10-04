/**
 * Expenses import card entry points, and the legacy pending candidates that the
 * wizard replaced the upload for.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn() }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/ui/tabs', () => ({ onTabChange: vi.fn(), showTab: vi.fn(), getCurrentTab: vi.fn() }));
vi.mock('@/pages/budget', () => ({ loadExpenses: vi.fn(async () => {}) }));
vi.mock('@/utils/smart-import-launcher', () => ({ openSmartImportLazy: vi.fn() }));

import { apiCall } from '@/api/client';
import { onTabChange } from '@/ui/tabs';
import { loadExpenses } from '@/pages/budget';
import { openSmartImportLazy } from '@/utils/smart-import-launcher';
import { showToast } from '@/ui/toast';
import {
  initBankStatementUpload,
  loadLegacyCandidates,
  acceptRecurringCandidate,
  rejectRecurringCandidate,
} from '@/features/bank-statements';

const apiCallMock = vi.mocked(apiCall);
const launcher = vi.mocked(openSmartImportLazy);
const EM_DASH = String.fromCharCode(0x2014);

function cand(id: string, status = 'pending') {
  return {
    id,
    name: `Gym ${id}`,
    amount: 30,
    frequency: 'monthly',
    occurrences: 3,
    status,
  };
}

function page(): void {
  document.body.innerHTML = `
    <div class="card" id="bank-statement-import-panel">
      <button id="bank-statement-upload-btn" type="button">Import statements</button>
      <input type="file" id="bank-statement-file" accept=".csv,.ofx,.qfx,.pdf" multiple>
      <div id="bank-statement-drop-zone" class="drop-zone"></div>
    </div>
    <div id="recurring-candidates-panel" style="display:none">
      <button id="recurring-candidates-cancel" type="button">Cancel</button>
      <div id="recurring-candidates-list"></div>
    </div>`;
}

function routes(imports: unknown): void {
  apiCallMock.mockImplementation(async (url: string) => {
    if (url === '/api/budget/bank-statements/imports') {
      if (imports === 'fail') throw new Error('boom');
      return imports;
    }
    if (url === '/api/budget/expense-categories') return [{ id: 'c1', name: 'Fitness' }];
    return { status: 'ok' };
  });
}

describe('entry points', () => {
  beforeEach(() => {
    page();
    apiCallMock.mockReset();
    launcher.mockReset();
    vi.mocked(onTabChange).mockReset();
    routes([]);
    initBankStatementUpload();
  });

  it('the Import statements button opens the wizard', () => {
    document.getElementById('bank-statement-upload-btn')!.click();
    expect(launcher).toHaveBeenCalledWith();
  });

  it('dropping files opens the wizard with them and uploads nothing itself', () => {
    const files = [new File(['a'], 'a.csv'), new File(['b'], 'b.ofx')];
    const zone = document.getElementById('bank-statement-drop-zone')!;
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files } });
    zone.dispatchEvent(drop);
    expect(launcher).toHaveBeenCalledWith({ files });
    expect(apiCallMock.mock.calls.some(([u]) => String(u).includes('/upload'))).toBe(false);
  });

  it('picking files from the drop zone opens the wizard with them', () => {
    const input = document.getElementById('bank-statement-file') as HTMLInputElement;
    const files = [new File(['a'], 'a.pdf')];
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(launcher).toHaveBeenCalledWith({ files });
  });

  it('opens the file picker from the drop zone with the keyboard', () => {
    const input = document.getElementById('bank-statement-file') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    const zone = document.getElementById('bank-statement-drop-zone')!;
    zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(click).toHaveBeenCalled();
  });

  it('reloads the legacy candidates when the Budget tab opens', () => {
    const handler = vi.mocked(onTabChange).mock.calls[0]![0];
    apiCallMock.mockClear();
    handler('budget' as never);
    expect(apiCallMock).toHaveBeenCalledWith('/api/budget/bank-statements/imports');
  });
});

describe('legacy pending candidates', () => {
  beforeEach(() => {
    page();
    apiCallMock.mockReset();
    vi.mocked(loadExpenses).mockClear();
  });

  it('shows the panel only when a legacy candidate is pending', async () => {
    routes([{ id: 'x', candidates: [cand('a', 'accepted'), cand('b', 'rejected')] }]);
    await loadLegacyCandidates();
    expect(document.getElementById('recurring-candidates-panel')!.style.display).toBe('none');

    routes([
      { id: 'x', candidates: [cand('a'), cand('b', 'accepted')] },
      { id: 'y', candidates: [cand('c')] },
    ]);
    await loadLegacyCandidates();
    expect(document.getElementById('recurring-candidates-panel')!.style.display).toBe('block');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.recurring-candidate-item')).toHaveLength(2)
    );
  });

  it('keeps the import card in view next to pending candidates', async () => {
    routes([{ id: 'x', candidates: [cand('a')] }]);
    await loadLegacyCandidates();
    expect(document.getElementById('bank-statement-import-panel')!.style.display).toBe('');
  });

  it('stays hidden when the list cannot be read', async () => {
    routes('fail');
    await loadLegacyCandidates();
    expect(document.getElementById('recurring-candidates-panel')!.style.display).toBe('none');
  });

  it('accepts through the legacy route with the chosen category', async () => {
    routes([{ id: 'x', candidates: [cand('a')] }]);
    await loadLegacyCandidates();
    await vi.waitFor(() =>
      expect(document.querySelector('.candidate-category-select')).not.toBeNull()
    );
    const select = document.querySelector<HTMLSelectElement>('.candidate-category-select')!;
    select.value = 'c1';
    document.querySelector<HTMLButtonElement>('.candidate-actions .btn-primary')!.click();
    await vi.waitFor(() =>
      expect(apiCallMock).toHaveBeenCalledWith('/api/budget/bank-statements/candidates/a/accept', {
        method: 'POST',
        body: { category_id: 'c1' },
      })
    );
    await vi.waitFor(() => expect(loadExpenses).toHaveBeenCalled());
    expect(document.getElementById('candidate-a')).toBeNull();
    expect(document.getElementById('recurring-candidates-panel')!.style.display).toBe('none');
  });

  it('rejects through the legacy route', async () => {
    routes([{ id: 'x', candidates: [cand('a')] }]);
    await loadLegacyCandidates();
    await vi.waitFor(() => expect(document.getElementById('candidate-a')).not.toBeNull());
    await rejectRecurringCandidate('a');
    expect(apiCallMock).toHaveBeenCalledWith('/api/budget/bank-statements/candidates/a/reject', {
      method: 'POST',
    });
    expect(document.getElementById('candidate-a')).toBeNull();
  });

  it('exports accept for the window handlers', async () => {
    routes([]);
    await acceptRecurringCandidate('zz');
    expect(apiCallMock).toHaveBeenCalledWith(
      '/api/budget/bank-statements/candidates/zz/accept',
      expect.anything()
    );
  });

  it('writes no em-dash into the DOM or a toast', async () => {
    routes([{ id: 'x', candidates: [cand('a')] }]);
    await loadLegacyCandidates();
    await vi.waitFor(() =>
      expect(document.querySelector('.candidate-category-select')).not.toBeNull()
    );
    expect(document.body.textContent).not.toContain(EM_DASH);
    for (const call of vi.mocked(showToast).mock.calls)
      expect(String(call[0])).not.toContain(EM_DASH);
  });
});
