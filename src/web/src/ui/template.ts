/**
 * Modal factory helpers. Replaces 85+ hardcoded <div class="modal-overlay">
 * blocks in index.html with on-demand DOM construction.
 *
 * These helpers only construct and attach the overlay — use showModal /
 * closeModal from @/ui/modal to manage lifecycle.
 */

export interface CreateModalOptions {
  /** ID for the overlay element. */
  id: string;
  /** Header title. */
  title: string;
  /** Optional subtitle rendered under the title. */
  subtitle?: string;
  /** Body content (string is rendered as text, Node appended as-is). */
  body: string | Node;
  /** Footer content (buttons, etc). */
  footer?: string | Node;
  /** Width preset. Defaults to 'md'. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Extra className on the outer overlay. */
  className?: string;
}

function appendContent(parent: HTMLElement, content: string | Node): void {
  if (typeof content === 'string') {
    parent.textContent = content;
  } else {
    parent.appendChild(content);
  }
}

/**
 * Build a standard modal overlay. Returns the overlay element; caller is
 * responsible for appending it to the DOM and wiring open/close actions.
 */
export function createModal(options: CreateModalOptions): HTMLDivElement {
  const {
    id,
    title,
    subtitle,
    body,
    footer,
    size = 'md',
    className,
  } = options;

  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = `modal-overlay${className ? ` ${className}` : ''}`;
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const modal = document.createElement('div');
  modal.className = `modal modal-${size}`;
  overlay.appendChild(modal);

  const header = document.createElement('div');
  header.className = 'modal-header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  if (subtitle) {
    const subEl = document.createElement('p');
    subEl.className = 'modal-subtitle';
    subEl.textContent = subtitle;
    header.appendChild(subEl);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => {
    overlay.style.display = 'none';
  });
  header.appendChild(closeBtn);

  modal.appendChild(header);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  appendContent(bodyEl, body);
  modal.appendChild(bodyEl);

  if (footer !== undefined) {
    const footerEl = document.createElement('div');
    footerEl.className = 'modal-footer';
    appendContent(footerEl, footer);
    modal.appendChild(footerEl);
  }

  return overlay;
}

/**
 * Confirm-style modal with OK/Cancel buttons. Resolves true on confirm,
 * false on cancel/close.
 */
export function confirmModal(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  const { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel' } = options;

  return new Promise<boolean>((resolve) => {
    const body = document.createElement('p');
    body.textContent = message;

    const footer = document.createDocumentFragment();
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = cancelLabel;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = confirmLabel;

    footer.appendChild(cancel);
    footer.appendChild(confirm);

    const overlay = createModal({
      id: `confirm-modal-${Date.now()}`,
      title,
      body,
      footer,
      size: 'sm',
    });

    function cleanup(result: boolean): void {
      overlay.remove();
      resolve(result);
    }

    cancel.addEventListener('click', () => cleanup(false));
    confirm.addEventListener('click', () => cleanup(true));

    document.body.appendChild(overlay);
    overlay.style.display = 'flex';
  });
}
