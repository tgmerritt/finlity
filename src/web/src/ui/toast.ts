/**
 * Toast notification system for user feedback.
 */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastOptions {
  duration?: number;
  dismissible?: boolean;
}

/**
 * Create an SVG icon element.
 */
function createIcon(type: ToastType): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');

  switch (type) {
    case 'success': {
      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('points', '20 6 9 17 4 12');
      svg.appendChild(polyline);
      break;
    }
    case 'error': {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '10');
      svg.appendChild(circle);
      const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line1.setAttribute('x1', '15');
      line1.setAttribute('y1', '9');
      line1.setAttribute('x2', '9');
      line1.setAttribute('y2', '15');
      svg.appendChild(line1);
      const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line2.setAttribute('x1', '9');
      line2.setAttribute('y1', '9');
      line2.setAttribute('x2', '15');
      line2.setAttribute('y2', '15');
      svg.appendChild(line2);
      break;
    }
    case 'warning': {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'
      );
      svg.appendChild(path);
      const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line1.setAttribute('x1', '12');
      line1.setAttribute('y1', '9');
      line1.setAttribute('x2', '12');
      line1.setAttribute('y2', '13');
      svg.appendChild(line1);
      const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line2.setAttribute('x1', '12');
      line2.setAttribute('y1', '17');
      line2.setAttribute('x2', '12.01');
      line2.setAttribute('y2', '17');
      svg.appendChild(line2);
      break;
    }
    case 'info':
    default: {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '10');
      svg.appendChild(circle);
      const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line1.setAttribute('x1', '12');
      line1.setAttribute('y1', '16');
      line1.setAttribute('x2', '12');
      line1.setAttribute('y2', '12');
      svg.appendChild(line1);
      const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line2.setAttribute('x1', '12');
      line2.setAttribute('y1', '8');
      line2.setAttribute('x2', '12.01');
      line2.setAttribute('y2', '8');
      svg.appendChild(line2);
      break;
    }
  }

  return svg;
}

/**
 * Show a toast notification.
 * @param message - Message to display
 * @param type - Toast type (success, error, warning, info)
 * @param options - Additional options
 */
export function showToast(
  message: string,
  type: ToastType = 'info',
  options: ToastOptions = {}
): void {
  const { duration = 3000, dismissible = true } = options;

  // Get or create toast container
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  // Add icon
  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.appendChild(createIcon(type));
  toast.appendChild(iconSpan);

  // Add message (using textContent for safety)
  const messageSpan = document.createElement('span');
  messageSpan.className = 'toast-message';
  messageSpan.textContent = message;
  toast.appendChild(messageSpan);

  // Add close button if dismissible
  if (dismissible) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u00D7'; // &times; character
    closeBtn.addEventListener('click', () => removeToast(toast));
    toast.appendChild(closeBtn);
  }

  // Add to container
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('toast-visible');
  });

  // Auto-remove after duration
  if (duration > 0) {
    setTimeout(() => removeToast(toast), duration);
  }
}

/**
 * Remove a toast with animation.
 */
function removeToast(toast: HTMLElement): void {
  toast.classList.remove('toast-visible');
  toast.classList.add('toast-hiding');

  setTimeout(() => {
    toast.remove();
  }, 300); // Match CSS transition duration
}

/**
 * Show a success toast.
 */
export function showSuccess(message: string, options?: ToastOptions): void {
  showToast(message, 'success', options);
}

/**
 * Show an error toast.
 */
export function showError(message: string, options?: ToastOptions): void {
  showToast(message, 'error', { duration: 5000, ...options });
}

/**
 * Show a warning toast.
 */
export function showWarning(message: string, options?: ToastOptions): void {
  showToast(message, 'warning', options);
}

/**
 * Show an info toast.
 */
export function showInfo(message: string, options?: ToastOptions): void {
  showToast(message, 'info', options);
}
