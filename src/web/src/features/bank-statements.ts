import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { formatCurrency } from '@/utils/format';
import { loadExpenses } from '@/pages/budget';
import { store } from '@/state/store';
import type { BankStatementBatchResponse, RecurringCandidateResponse } from '@/types/api';

const ALLOWED_EXTENSIONS = ['.csv', '.pdf'];

export function initBankStatementUpload(): void {
  const fileInput = document.querySelector<HTMLInputElement>('#bank-statement-file');
  const uploadBtn = document.querySelector<HTMLButtonElement>('#bank-statement-upload-btn');
  const dropZone = document.querySelector<HTMLElement>('#bank-statement-drop-zone');

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        handleBankStatementFiles(Array.from(fileInput.files));
      }
      fileInput.value = '';
    });
  }

  if (dropZone) {
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
        handleBankStatementFiles(Array.from(e.dataTransfer.files));
      }
    });
  }
}

async function handleBankStatementFiles(files: File[]): Promise<void> {
  const valid = files.filter((f) =>
    ALLOWED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))
  );
  if (valid.length === 0) {
    showToast('Please upload CSV or PDF bank statement files.', 'error');
    return;
  }
  if (valid.length < files.length) {
    showToast(`${files.length - valid.length} unsupported file(s) ignored.`, 'warning');
  }

  const uploadBtn = document.querySelector<HTMLButtonElement>('#bank-statement-upload-btn');
  const uploadStatus = document.querySelector<HTMLElement>('#bank-statement-status');

  if (uploadBtn) uploadBtn.setAttribute('disabled', 'true');
  if (uploadStatus) {
    uploadStatus.style.display = 'block';
    uploadStatus.textContent =
      valid.length === 1 ? 'Analyzing statement…' : `Analyzing ${valid.length} statements…`;
    uploadStatus.className = 'bank-statement-status loading';
  }

  try {
    // Pass entity_id as a form field alongside file upload
    const formData = new FormData();
    for (const file of valid) {
      formData.append('files', file);
    }
    const currentEntityId = store.get('currentEntityId');
    if (currentEntityId) {
      formData.append('entity_id', currentEntityId);
    }

    const result = await apiCall<BankStatementBatchResponse>(
      '/api/budget/bank-statements/upload',
      {
        method: 'POST',
        body: formData,
      }
    );

    const allDuplicate = result.files_imported === 0 && result.files_skipped > 0;
    if (uploadStatus) {
      const skippedNote =
        result.files_skipped > 0
          ? ` (${result.files_skipped} duplicate${result.files_skipped > 1 ? 's' : ''} skipped)`
          : '';
      if (allDuplicate) {
        uploadStatus.textContent =
          result.candidates.length > 0
            ? `Showing ${result.candidates.length} pending transaction(s) from previously-imported file(s).`
            : 'All transactions from these files were already reviewed.';
      } else if (result.candidates.length > 0) {
        uploadStatus.textContent = `Found ${result.candidates.length} recurring transaction(s) across ${result.files_imported} statement(s)${skippedNote}.`;
      } else {
        uploadStatus.textContent = `No recurring transactions detected across ${result.files_imported} statement(s)${skippedNote}.`;
      }
      uploadStatus.className = 'bank-statement-status success';
    }

    renderCandidates(result.candidates);
    if (allDuplicate) {
      if (result.candidates.length > 0) {
        showToast('These files were already imported — showing pending transactions.', 'info');
      } else {
        showToast('Files already imported and fully reviewed.', 'info');
      }
    } else {
      const count = result.files_imported;
      showToast(`${count} statement${count !== 1 ? 's' : ''} imported`, 'success');
    }
  } catch (error: any) {
    const errorMessage = error?.message || 'An error occurred during upload.';
    if (uploadStatus) {
      uploadStatus.textContent = errorMessage;
      uploadStatus.className = 'bank-statement-status error';
    }
    showToast(errorMessage, 'error');
  } finally {
    if (uploadBtn) uploadBtn.removeAttribute('disabled');
  }
}

function renderCandidates(candidates: RecurringCandidateResponse[]): void {
  const container = document.querySelector<HTMLElement>('#recurring-candidates-list');
  const reviewPanel = document.querySelector<HTMLElement>('#recurring-candidates-panel');
  const importPanel = document.querySelector<HTMLElement>('#bank-statement-import-panel');
  const cancelBtn = document.querySelector<HTMLButtonElement>('#recurring-candidates-cancel');

  const pendingCandidates = candidates.filter((c) => c.status === 'pending');
  const hasPending = pendingCandidates.length > 0;

  if (reviewPanel) reviewPanel.style.display = hasPending ? 'block' : 'none';
  if (importPanel) importPanel.style.display = hasPending ? 'none' : '';

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
        defaultOpt.textContent = '— Select category —';
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
  const importPanel = document.querySelector<HTMLElement>('#bank-statement-import-panel');
  const uploadStatus = document.querySelector<HTMLElement>('#bank-statement-status');
  const container = document.querySelector<HTMLElement>('#recurring-candidates-list');

  if (reviewPanel) reviewPanel.style.display = 'none';
  if (importPanel) importPanel.style.display = '';
  if (uploadStatus) {
    uploadStatus.style.display = 'none';
    uploadStatus.textContent = '';
    uploadStatus.className = 'bank-statement-status';
  }
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
