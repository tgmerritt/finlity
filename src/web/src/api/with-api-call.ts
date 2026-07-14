/**
 * DRY wrapper around `apiCall` that centralizes showLoading + error reporting.
 *
 * Callers pass an endpoint and a handler for the success case. Loading and
 * error UI are handled uniformly so individual pages do not repeat the
 * showLoading/try/catch/finally pattern.
 */

import { apiCall, ApiError, type ApiCallOptions } from './client';
import { hideLoading, showLoading } from '@/ui/loading';
import { showError } from '@/ui/toast';

export interface WithApiCallOptions<T> extends ApiCallOptions {
  /** Message shown in the loading overlay. Omit to skip the overlay. */
  loadingMessage?: string;
  /** Override the toast shown on error. Omit for the server-provided detail. */
  errorMessage?: string;
  /** Skip toasting on error (caller will handle). */
  silentErrors?: boolean;
  /** Handler invoked with the parsed response body. */
  onSuccess?: (data: T) => void | Promise<void>;
}

/**
 * Call an API endpoint with uniform loading + error UX. Returns the parsed
 * response on success, or `null` if the request errored (to let callers
 * short-circuit without reading `.catch`).
 */
export async function withApiCall<T>(
  endpoint: string,
  options: WithApiCallOptions<T> = {}
): Promise<T | null> {
  const { loadingMessage, errorMessage, silentErrors, onSuccess, ...apiOptions } = options;

  if (loadingMessage) showLoading(loadingMessage);

  try {
    const data = await apiCall<T>(endpoint, apiOptions);
    if (onSuccess) await onSuccess(data);
    return data;
  } catch (err) {
    if (!silentErrors) {
      const message = errorMessage ?? (err instanceof ApiError ? err.message : 'Unexpected error');
      showError(message);
    }
    return null;
  } finally {
    if (loadingMessage) hideLoading();
  }
}
