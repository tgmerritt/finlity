import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { onTabChange } from '@/ui/tabs';
import { formatCurrency } from '@/utils/format';
import { loadExpenses } from '@/pages/budget';
import { openSmartImportLazy } from '@/utils/smart-import-launcher';
import { on } from '@/state/events';
import type { BankStatementImportResponse, RecurringCandidateResponse } from '@/types/api';

/**
 * Entry points of the Expenses import card. Uploading is the wizard's job now
 * (features/smart-import.ts, loaded on demand); this module only opens it, and
 * keeps accept and reject for candidates the old flow left pending.
 */
export function initBankStatementUpload(): void {
  const fileInput = document.querySelector<HTMLInputElement>('#bank-statement-file');
  const uploadBtn = document.querySelector<HTMLButtonElement>('#bank-statement-upload-btn');
  const dropZone = document.querySelector<HTMLElement>('#bank-statement-drop-zone');

  uploadBtn?.addEventListener('click', () => {
    void openSmartImportLazy();
  });

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        void openSmartImportLazy({ files: Array.from(fileInput.files) });
      }
      fileInput.value = '';
    });
  }

  if (dropZone) {
    dropZone.addEventListener('click', () => fileInput?.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput?.click();
      }
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-active');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-active');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-active');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        void openSmartImportLazy({ files: Array.from(e.dataTransfer.files) });
      }
    });
  }

  onTabChange((tab) => {
    if (tab === 'budget') void loadLegacyCandidates();
  });
  on('profile:switched', () => void loadLegacyCandidates());
  on('demo:toggled', () => void loadLegacyCandidates());
  void loadLegacyCandidates();
}

/**
 * Pending candidates from the old upload flow, if any. The wizard resolves its
 * own candidates before Apply, so for most people this panel never shows.
 */
export async function loadLegacyCandidates(): Promise<void> {
  try {
    const imports = await apiCall<BankStatementImportResponse[]>(
      '/api/budget/bank-statements/imports'
    );
    const pending = (imports || []).flatMap((i) => i.candidates || []);
    renderCandidates(pending.filter((c) => c.status === 'pending'));
  } catch (error) {
    console.error('Legacy candidates load failed:', error instanceof Error ? error.name : 'error');
    renderCandidates([]);
  }
}

/** A newer render makes a slower categories fetch from an older one drop its rows. */
let renderGeneration = 0;

function renderCandidates(candidates: RecurringCandidateResponse[]): void {
  renderGeneration += 1;
  const generation = renderGeneration;
  const container = document.querySelector<HTMLElement>('#recurring-candidates-list');
  const reviewPanel = document.querySelector<HTMLElement>('#recurring-candidates-panel');
  const cancelBtn = document.querySelector<HTMLButtonElement>('#recurring-candidates-cancel');

  const pendingCandidates = candidates.filter((c) => c.status === 'pending');
  const hasPending = pendingCandidates.length > 0;

  if (reviewPanel) reviewPanel.style.display = hasPending ? 'block' : 'none';

  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.addEventListener('click', () => {
      void cancelAllCandidates();
    });
    cancelBtn.dataset.bound = 'true';
  }

  if (!container) return;
  container.textContent = '';

  if (!hasPending) return;

  const renderItems = (categories: { id: string; name: string }[] | null) => {
    if (generation !== renderGeneration) return;
    for (const c of pendingCandidates) {
      const item = document.createElement('div');
      item.className = 'recurring-candidate-item';
      item.id = `candidate-${c.id}`;

      const leftDiv = document.createElement('div');
      leftDiv.className = 'candidate-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'candidate-name';
      nameSpan.textContent = c.name;

      const detailsSpan = document.createElement('span');
      detailsSpan.className = 'candidate-details';
      detailsSpan.textContent = `${formatCurrency(c.amount)} / ${formatFreq(c.frequency)} • ${c.occurrences} occurrences`;

      leftDiv.appendChild(nameSpan);
      leftDiv.appendChild(detailsSpan);

      if (categories) {
        const catSelect = document.createElement('select');
        catSelect.className = 'candidate-category-select';
        catSelect.dataset.candidateId = c.id;

        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Select category';
        catSelect.appendChild(defaultOpt);

        for (const cat of categories) {
          const opt = document.createElement('option');
          opt.value = cat.id;
          opt.textContent = cat.name;
          catSelect.appendChild(opt);
        }
        leftDiv.appendChild(catSelect);
      }

      const rightDiv = document.createElement('div');
      rightDiv.className = 'candidate-actions';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn btn-primary btn-sm';
      acceptBtn.textContent = 'Accept';
      acceptBtn.onclick = () => acceptRecurringCandidate(c.id);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn btn-secondary btn-sm';
      rejectBtn.textContent = 'Reject';
      rejectBtn.onclick = () => rejectRecurringCandidate(c.id);

      rightDiv.appendChild(acceptBtn);
      rightDiv.appendChild(rejectBtn);

      item.appendChild(leftDiv);
      item.appendChild(rightDiv);
      container.appendChild(item);
    }
  };

  apiCall<{ id: string; name: string }[]>('/api/budget/expense-categories')
    .then((categories) => {
      void renderItems(categories);
    })
    .catch(() => {
      void renderItems(null);
    });
}

function formatFreq(freq: string): string {
  const mapping: Record<string, string> = {
    weekly: 'Weekly',
    biweekly: 'Bi-weekly',
    monthly: 'Monthly',
    annual: 'Annual',
  };
  return mapping[freq.toLowerCase()] || freq;
}

export async function acceptRecurringCandidate(candidateId: string): Promise<void> {
  try {
    const categorySelect = document.querySelector<HTMLSelectElement>(
      '#candidate-' + candidateId + ' .candidate-category-select'
    );
    const categoryId = categorySelect?.value || null;
    const body: Record<string, unknown> = {};
    if (categoryId) body['category_id'] = categoryId;

    const resp = await apiCall<{ status: string; deduped?: boolean }>(
      `/api/budget/bank-statements/candidates/${candidateId}/accept`,
      { method: 'POST', body }
    );

    const el = document.getElementById(`candidate-${candidateId}`);
    if (el) el.remove();

    if (resp?.deduped) {
      showToast('Linked to existing expense (no duplicate created)', 'info');
    } else {
      showToast('Expense added', 'success');
    }
    await loadExpenses();
    checkAllReviewed();
  } catch (error: any) {
    showToast(error?.message || 'Failed to accept candidate', 'error');
  }
}

export async function rejectRecurringCandidate(candidateId: string): Promise<void> {
  try {
    await apiCall(`/api/budget/bank-statements/candidates/${candidateId}/reject`, {
      method: 'POST',
    });

    const el = document.getElementById(`candidate-${candidateId}`);
    if (el) el.remove();

    showToast('Transaction dismissed', 'info');
    checkAllReviewed();
  } catch (error: any) {
    showToast(error?.message || 'Failed to reject candidate', 'error');
  }
}

async function cancelAllCandidates(): Promise<void> {
  const container = document.querySelector<HTMLElement>('#recurring-candidates-list');
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>('.recurring-candidate-item'));
  if (items.length === 0) {
    closeReviewPanel();
    return;
  }
  if (
    !confirm(
      `Discard ${items.length} detected transaction${items.length !== 1 ? 's' : ''} without adding any expenses?`
    )
  ) {
    return;
  }
  const ids = items.map((el) => el.id.replace(/^candidate-/, '')).filter(Boolean);
  const results = await Promise.allSettled(
    ids.map((id) =>
      apiCall(`/api/budget/bank-statements/candidates/${id}/reject`, { method: 'POST' })
    )
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    showToast(`Discarded ${ids.length - failed} of ${ids.length}; ${failed} failed.`, 'warning');
  } else {
    showToast('All detected transactions discarded.', 'info');
  }
  closeReviewPanel();
}

function closeReviewPanel(): void {
  const reviewPanel = document.querySelector<HTMLElement>('#recurring-candidates-panel');
  const container = document.querySelector<HTMLElement>('#recurring-candidates-list');

  if (reviewPanel) reviewPanel.style.display = 'none';
  if (container) container.textContent = '';
}

function checkAllReviewed(): void {
  const container = document.querySelector<HTMLElement>('#recurring-candidates-list');
  if (!container) return;

  const items = container.querySelectorAll('.recurring-candidate-item');
  if (items.length === 0) {
    closeReviewPanel();
  }
}
