/**
 * Loading overlay for async operations.
 */

import { store } from '@/state/store';
import { getElementById } from '@/utils/html';

/**
 * Show the global loading overlay.
 * @param message - Loading message to display
 */
export function showLoading(message = 'Loading...'): void {
  store.set('isLoading', true);
  store.set('loadingMessage', message);

  const overlay = getElementById('loading-overlay');
  const textElement = overlay?.querySelector('.loading-text');

  if (overlay) {
    // The HTML markup starts with the `hidden` utility class, which is
    // `display: none !important` globally. That !important beats any inline
    // style we set, so the overlay would never appear unless we strip the
    // class. Toggle it explicitly here (and re-add in hideLoading).
    overlay.classList.remove('hidden');
    overlay.classList.add('visible');
  }

  if (textElement) {
    textElement.textContent = message;
  }
}

/**
 * Hide the global loading overlay.
 */
export function hideLoading(): void {
  store.set('isLoading', false);

  const overlay = getElementById('loading-overlay');
  if (overlay) {
    overlay.classList.remove('visible');
    overlay.classList.add('hidden');
  }
}

/**
 * Update the loading message.
 * @param message - New message to display
 */
export function updateLoadingMessage(message: string): void {
  store.set('loadingMessage', message);

  const overlay = getElementById('loading-overlay');
  const textElement = overlay?.querySelector('.loading-text');

  if (textElement) {
    textElement.textContent = message;
  }
}

/**
 * Run an async operation with loading indicator.
 * @param operation - Async operation to run
 * @param message - Loading message
 * @returns Operation result
 */
export async function withLoading<T>(
  operation: () => Promise<T>,
  message = 'Loading...'
): Promise<T> {
  showLoading(message);
  try {
    return await operation();
  } finally {
    hideLoading();
  }
}

/**
 * Show inline loading spinner in an element.
 * @param element - Target element
 * @param message - Optional message
 */
export function showInlineLoading(element: HTMLElement, message?: string): void {
  // Clear existing content
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }

  // Create spinner container
  const spinner = document.createElement('div');
  spinner.className = 'inline-spinner';

  // Add spinner element
  const spinnerIcon = document.createElement('div');
  spinnerIcon.className = 'spinner-small';
  spinner.appendChild(spinnerIcon);

  // Add message if provided
  if (message) {
    const messageSpan = document.createElement('span');
    messageSpan.className = 'spinner-message';
    messageSpan.textContent = message;
    spinner.appendChild(messageSpan);
  }

  element.appendChild(spinner);
}

/**
 * Check if loading is active.
 * @returns True if loading overlay is visible
 */
export function isLoading(): boolean {
  return store.get('isLoading');
}
