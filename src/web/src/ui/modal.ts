/**
 * Unified modal system.
 * Consolidates multiple modal patterns into a single API.
 *
 * Security: Content passed to modals should be sanitized before display.
 * Use escapeHtml() for user-provided text, or pass HTMLElement for complex content.
 */

import { querySelector } from '@/utils/html';

/**
 * Modal configuration options.
 */
export interface ModalConfig {
  title: string;
  /** HTML content string (should be pre-sanitized) or HTMLElement */
  content: string | HTMLElement;
  onSave?: (event: Event) => void | Promise<void>;
  onClose?: () => void;
  saveButtonText?: string;
  cancelButtonText?: string;
  showFooter?: boolean;
  modalClass?: string;
}

/**
 * Active dynamic modal tracking for cleanup.
 */
let activeDynamicModal: HTMLElement | null = null;

// =====================
// Generic Modal (static HTML element)
// =====================

/**
 * Show the generic modal with title and content.
 * Uses the static #generic-modal element in index.html.
 * @param title - Modal title (will be escaped)
 * @param content - HTML content for modal body (should be pre-sanitized)
 */
export function showModal(title: string, content: string): void {
  const modal = querySelector<HTMLElement>('#generic-modal');
  const titleEl = querySelector<HTMLElement>('#generic-modal-title');
  const bodyEl = querySelector<HTMLElement>('#generic-modal-body');

  if (titleEl) titleEl.textContent = title;
  if (bodyEl) {
    // Note: content is expected to be pre-sanitized by caller
    // This matches the original app.js behavior
    bodyEl.innerHTML = content;
  }
  if (modal) {
    // See showModalById: `hidden` is `display:none !important`, so remove it.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

/**
 * Close the generic modal.
 */
export function closeModal(): void {
  const modal = querySelector<HTMLElement>('#generic-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

// =====================
// Dynamic Modal (created on demand)
// =====================

/**
 * Build modal DOM structure safely.
 */
function buildModalElement(config: ModalConfig): HTMLElement {
  const {
    title,
    content,
    onSave,
    saveButtonText = 'Save',
    cancelButtonText = 'Cancel',
    showFooter = true,
    modalClass = '',
  } = config;

  const modal = document.createElement('div');
  modal.className = `modal ${modalClass}`.trim();
  modal.id = 'dynamic-modal';
  modal.style.display = 'flex';

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  modal.appendChild(backdrop);

  // Create modal content container
  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';

  const titleEl = document.createElement('h2');
  titleEl.textContent = title; // Safe: uses textContent
  header.appendChild(titleEl);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  header.appendChild(closeBtn);

  modalContent.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'modal-body';

  if (typeof content === 'string') {
    // Content is HTML string - expected to be pre-sanitized by caller
    body.innerHTML = content;
  } else {
    // Content is HTMLElement - safe
    body.appendChild(content);
  }

  modalContent.appendChild(body);

  // Footer
  if (showFooter) {
    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.setAttribute('data-action', 'cancel');
    cancelBtn.textContent = cancelButtonText;
    footer.appendChild(cancelBtn);

    if (onSave) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary';
      saveBtn.setAttribute('data-action', 'save');
      saveBtn.textContent = saveButtonText;
      footer.appendChild(saveBtn);
    }

    modalContent.appendChild(footer);
  }

  modal.appendChild(modalContent);

  return modal;
}

/**
 * Create and show a dynamic modal.
 * Modal is appended to body and removed on close.
 * @param config - Modal configuration
 * @returns The created modal element
 */
export function createDynamicModal(config: ModalConfig): HTMLElement {
  // Remove existing dynamic modal if any
  closeDynamicModal();

  const modal = buildModalElement(config);

  // Add event listeners
  const backdrop = modal.querySelector('.modal-backdrop');
  const closeBtn = modal.querySelector('.modal-close');
  const cancelBtn = modal.querySelector('[data-action="cancel"]');
  const saveBtn = modal.querySelector('[data-action="save"]');

  const handleClose = () => {
    closeDynamicModal();
    config.onClose?.();
  };

  backdrop?.addEventListener('click', handleClose);
  closeBtn?.addEventListener('click', handleClose);
  cancelBtn?.addEventListener('click', handleClose);

  if (saveBtn && config.onSave) {
    saveBtn.addEventListener('click', async (event) => {
      await config.onSave!(event);
    });
  }

  // Add escape key handler
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      handleClose();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);

  document.body.appendChild(modal);
  activeDynamicModal = modal;

  return modal;
}

/**
 * Close and remove the dynamic modal.
 */
export function closeDynamicModal(): void {
  if (activeDynamicModal) {
    activeDynamicModal.remove();
    activeDynamicModal = null;
  }
  // Also check by ID for backwards compatibility
  const modal = document.getElementById('dynamic-modal');
  if (modal) {
    modal.remove();
  }
  // Clean up legacy budget modal
  const budgetModal = document.getElementById('budget-modal');
  if (budgetModal) {
    budgetModal.remove();
  }
}

// =====================
// Feature-specific Modal Helpers
// =====================

/**
 * Show a specific modal by element ID.
 * @param modalId - The ID of the modal element
 */
export function showModalById(modalId: string): void {
  const modal = document.getElementById(modalId);
  if (modal) {
    // Modals ship with the `hidden` utility class, which is
    // `display: none !important` — an inline `style.display` cannot beat
    // `!important`, so we must remove the class to actually reveal the modal.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

/**
 * Hide a specific modal by element ID.
 * @param modalId - The ID of the modal element
 */
export function hideModalById(modalId: string): void {
  const modal = document.getElementById(modalId);
  if (modal) {
    // Re-add `hidden` so it stays hidden even if something later clears the
    // inline style; mirrors showModalById's removal of the class.
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}

// Profile Modal
export function showProfileModal(): void {
  showModalById('profile-modal');
}

export function hideProfileModal(): void {
  hideModalById('profile-modal');
}

// Edit Position Modal
export function showEditPositionModal(): void {
  showModalById('edit-position-modal');
}

export function hideEditPositionModal(): void {
  hideModalById('edit-position-modal');
}

// Add Position Modal
export function showAddPositionModal(): void {
  showModalById('add-position-modal');
}

export function hideAddPositionModal(): void {
  hideModalById('add-position-modal');
}

// Plugin Install Modal
export function showInstallPluginModal(): void {
  showModalById('install-plugin-modal');
}

export function hideInstallPluginModal(): void {
  hideModalById('install-plugin-modal');
}

// View Modal
export function showViewModal(): void {
  showModalById('view-modal');
}

export function hideViewModal(): void {
  hideModalById('view-modal');
}

// Trigger Modal
export function showTriggerModal(): void {
  showModalById('trigger-modal');
}

export function hideTriggerModal(): void {
  hideModalById('trigger-modal');
}

// Import Modal
export function showImportModal(): void {
  showModalById('import-modal');
}

export function hideImportModal(): void {
  hideModalById('import-modal');
}

// Global Chat Modal
export function showGlobalChatModal(): void {
  showModalById('global-chat-modal');
}

export function hideGlobalChatModal(): void {
  hideModalById('global-chat-modal');
}

// =====================
// Confirmation Dialog
// =====================

/**
 * Show a confirmation dialog.
 * @param message - The confirmation message (will be escaped)
 * @param onConfirm - Callback when confirmed
 * @param options - Additional options
 */
export function showConfirmDialog(
  message: string,
  onConfirm: () => void | Promise<void>,
  options: {
    title?: string;
    confirmText?: string;
    cancelText?: string;
    isDangerous?: boolean;
  } = {}
): void {
  const {
    title = 'Confirm',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isDangerous = false,
  } = options;

  // Build content safely using DOM
  const contentEl = document.createElement('p');
  contentEl.textContent = message; // Safe: uses textContent

  const modal = createDynamicModal({
    title,
    content: contentEl,
    saveButtonText: confirmText,
    cancelButtonText: cancelText,
    onSave: async () => {
      await onConfirm();
      closeDynamicModal();
    },
    modalClass: isDangerous ? 'modal-danger' : '',
  });

  // Style the confirm button if dangerous
  if (isDangerous) {
    const saveBtn = modal.querySelector('[data-action="save"]');
    if (saveBtn) {
      saveBtn.classList.remove('btn-primary');
      saveBtn.classList.add('btn-danger');
    }
  }
}

// =====================
// Initialization
// =====================

/**
 * Initialize modal system.
 * Sets up close button handlers for static modals.
 */
export function initModal(): void {
  // Setup generic modal close button
  const genericModalClose = document.querySelector('#generic-modal .modal-close');
  if (genericModalClose) {
    genericModalClose.addEventListener('click', closeModal);
  }

  // Setup generic modal backdrop click
  const genericModalBackdrop = document.querySelector('#generic-modal .modal-backdrop');
  if (genericModalBackdrop) {
    genericModalBackdrop.addEventListener('click', closeModal);
  }

  // Setup close buttons for all static modals
  document.querySelectorAll('.modal .modal-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      if (modal instanceof HTMLElement) {
        modal.style.display = 'none';
      }
    });
  });

  // Setup backdrop clicks for all static modals
  document.querySelectorAll('.modal .modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', () => {
      const modal = backdrop.closest('.modal');
      if (modal instanceof HTMLElement) {
        modal.style.display = 'none';
      }
    });
  });
}

// =====================
// Legacy Compatibility
// =====================

/**
 * Create modal for budget items (legacy compatibility).
 * Maps to createDynamicModal.
 * @param title - Modal title
 * @param content - HTML content (should be pre-sanitized)
 * @param onSave - Save callback
 */
export function createModal(
  title: string,
  content: string,
  onSave: (event: Event) => void
): HTMLElement {
  return createDynamicModal({
    title,
    content,
    onSave,
  });
}

/**
 * Close budget modal (legacy compatibility).
 * Maps to closeDynamicModal.
 */
export function closeBudgetModal(): void {
  closeDynamicModal();
}
