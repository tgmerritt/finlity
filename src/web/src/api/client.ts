/**
 * API client for making HTTP requests to the backend.
 * Handles authentication, error handling, and async task polling.
 */

import { generateSignatureHeaders, isSigningRequired } from '@/state/session';
import type { TaskStatus } from '@/types/api';

const API_BASE = '';

/**
 * Get the API base URL.
 * Returns empty string for same-origin requests.
 */
export function getBaseUrl(): string {
  return API_BASE;
}

/**
 * HTTP methods that require HMAC signing in multi-user mode.
 */
const SIGNING_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];

/**
 * API call options.
 */
export interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

/**
 * API error with status code and message.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Make an API call to the backend.
 * @param endpoint - API endpoint (relative path)
 * @param options - Request options
 * @returns Response data
 * @throws ApiError on failure
 */
export async function apiCall<T>(endpoint: string, options: ApiCallOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, timeout = 30000 } = options;

  // Build request headers
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  // Add HMAC signature for mutating requests in multi-user mode
  // Body is included in signature to prevent tampering
  if (SIGNING_METHODS.includes(method) && isSigningRequired()) {
    const signatureHeaders = await generateSignatureHeaders(method, endpoint, body);
    Object.assign(requestHeaders, signatureHeaders);
  }

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : null,
      credentials: 'include',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle error responses
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      let errorData: unknown;

      try {
        errorData = await response.json();
        if (typeof errorData === 'object' && errorData !== null && 'detail' in errorData) {
          errorMessage = String((errorData as { detail: unknown }).detail);
        }
      } catch {
        // Response body is not JSON
        errorMessage = response.statusText || errorMessage;
      }

      throw new ApiError(response.status, errorMessage, errorData);
    }

    // Parse response
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return (await response.json()) as T;
    }

    // Return empty object for non-JSON responses
    return {} as T;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'Request timeout');
    }

    throw new ApiError(0, error instanceof Error ? error.message : 'Network error');
  }
}

/**
 * Options for task polling.
 */
export interface TaskPollingOptions {
  /** Polling interval in ms (default: 2000) */
  interval?: number;
  /** Maximum wait time in ms (default: 300000 = 5 minutes) */
  maxWaitMs?: number;
  /** Progress callback called on each poll */
  onProgress?: (task: TaskStatus) => void;
}

/**
 * Poll for async task completion.
 * @param taskId - Task ID to poll
 * @param options - Polling options
 * @returns Task result
 * @throws ApiError if task fails or times out
 */
export async function pollForTaskResult<T>(
  taskId: string,
  options: TaskPollingOptions = {}
): Promise<T> {
  const { interval = 2000, maxWaitMs = 300000, onProgress } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const status = await apiCall<TaskStatus>(`/api/tasks/${taskId}`);

    // Call progress callback if provided
    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'completed') {
      return status.result as T;
    }

    if (status.status === 'failed') {
      throw new ApiError(500, status.error || 'Task failed');
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new ApiError(0, 'Task polling timeout');
}

/**
 * Run an async API call that returns a task ID, then poll for completion.
 * Used for long-running operations on Heroku (30s timeout).
 * @param endpoint - API endpoint
 * @param options - Request options
 * @param taskOptions - Task polling options
 * @returns Task result
 */
export async function runAsyncApiCall<T>(
  endpoint: string,
  options: ApiCallOptions = {},
  taskOptions: TaskPollingOptions = {}
): Promise<T> {
  const response = await apiCall<{ task_id: string; status: string }>(endpoint, options);

  // Check for async task response (backend may return 'running' or 'pending')
  if ((response.status === 'running' || response.status === 'pending') && response.task_id) {
    return pollForTaskResult<T>(response.task_id, taskOptions);
  }

  // If not async, return the response directly
  return response as unknown as T;
}

/**
 * Upload a file to the API via multipart/form-data.
 * Content-Type header is intentionally omitted to let the browser set the multipart boundary.
 * @param endpoint - API endpoint
 * @param file - File to upload
 * @param fieldName - Form field name (default: 'file')
 * @param timeout - Request timeout in ms (default: 120000 for large files)
 * @returns Response data
 * @throws ApiError on upload failure or timeout
 */
export async function uploadFile<T>(
  endpoint: string,
  file: File,
  fieldName = 'file',
  timeout = 120000 // 2 minutes default for file uploads
): Promise<T> {
  const formData = new FormData();
  formData.append(fieldName, file);

  // Get signature headers if needed (file content not included in signature)
  let signatureHeaders: Record<string, string> = {};
  if (isSigningRequired()) {
    signatureHeaders = await generateSignatureHeaders('POST', endpoint);
  }

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      body: formData,
      headers: signatureHeaders,
      credentials: 'include',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = await response.json();
        if (typeof errorData === 'object' && errorData !== null && 'detail' in errorData) {
          errorMessage = String((errorData as { detail: unknown }).detail);
        }
      } catch (parseError) {
        // Error response is not JSON - log for debugging
        console.debug(`Upload error response is not JSON for ${endpoint}:`, parseError);
        errorMessage = response.statusText || errorMessage;
      }
      throw new ApiError(response.status, errorMessage);
    }

    return (await response.json()) as T;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'Upload timeout');
    }

    throw new ApiError(0, error instanceof Error ? error.message : 'Upload failed');
  }
}
