/**
 * API client for making HTTP requests to the backend.
 * Handles authentication, error handling, and async task polling.
 */

import { generateSignatureHeaders, isSigningRequired } from '@/state/session';
import { store } from '@/state/store';
import { showToast } from '@/ui/toast';
import { LocalHttpError } from '@/database/local-error';
import type { TaskStatus } from '@/types/api';
import {
  tryLocalRoute,
  matchPayloadRoute,
  isPassthroughAllowed,
  NOT_HANDLED,
  LocalModeDisabledError,
  getLocalAPI,
} from './dispatcher';

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
  // Local/remote dispatch hook (hosted mode only). When dataMode is
  // 'server' (the default, and the only value in self-hosted Docker use),
  // this block is skipped entirely and the function falls through to the
  // exact network path that existed before the dispatcher was introduced —
  // that fallthrough is the byte-identical regression guarantee for server
  // mode. See src/api/dispatcher.ts for the route tables.
  if (store.get('dataMode') === 'local') {
    // Special case: bank statement upload takes a FormData body (multipart
    // files + optional entity_id), which doesn't fit the JSON-body route
    // tables below. It needs both a signed multipart upload (to the v2
    // stateless parser) and local persistence, so it's composed here
    // instead of the generic LOCAL/PAYLOAD tables. See dispatcher.ts's
    // handleLocalBankStatementUpload for the composition.
    if (endpoint === '/api/budget/bank-statements/upload' && options.body instanceof FormData) {
      return (await handleLocalBankStatementUpload(options.body)) as T;
    }

    // Special case: price refresh needs an actual network round-trip to
    // the stateless v2 price fetcher (getStaleTickers() locally -> GET
    // /api/v2/prices?tickers=... -> LocalAPI.applyPriceUpdates), so it
    // can't be a no-network LOCAL route either.
    if (endpoint.startsWith('/api/imports/refresh-prices')) {
      return (await handleLocalRefreshPrices(endpoint)) as T;
    }

    // Special case (F5): "analyze all portfolio funds" loops local is_fund=1
    // tickers, calls the stateless v2 fund/analyze endpoint per ticker, and
    // writes the returned sector back into local positions — a genuine
    // multi-request composite, not a single endpoint rewrite.
    if (
      endpoint === '/api/analysis/fund/analyze-portfolio' &&
      (options.method ?? 'GET') === 'POST'
    ) {
      return (await handleLocalAnalyzePortfolioFunds()) as T;
    }

    // Special case (F5): "update sectors for all positions missing one"
    // loops local tickers lacking a sector, calls the stateless v2
    // positions/sectors endpoint in one batched request, and writes the
    // results back into local positions.
    if (
      endpoint === '/api/analysis/positions/update-sectors' &&
      (options.method ?? 'GET') === 'POST'
    ) {
      return (await handleLocalUpdatePositionSectors()) as T;
    }

    try {
      const localResult = await tryLocalRoute(endpoint, options);
      if (localResult !== NOT_HANDLED) {
        return localResult as T;
      }
    } catch (error) {
      if (error instanceof LocalModeDisabledError) {
        throw new ApiError(400, error.message);
      }
      if (error instanceof LocalHttpError) {
        throw new ApiError(error.status, error.message);
      }
      throw error;
    }

    const payloadMatch = matchPayloadRoute(endpoint, options);
    if (payloadMatch !== NOT_HANDLED) {
      const result = await runAsyncApiCall<unknown>(payloadMatch.endpoint, payloadMatch.options);
      // F13: after a successful local-mode Monte Carlo run, persist a
      // summary row locally so the dashboard-metrics composite (see
      // dispatcher.ts) can report real numbers instead of always claiming
      // simulation_required: true. Keyed off the *original* v1-shaped
      // endpoint (payloadMatch.endpoint is the rewritten /api/v2/... one).
      if (endpoint === '/api/projections/monte-carlo') {
        persistLocalMonteCarloResult(options.body, result);
      }
      // F14: surface data_warnings (excluded positions) from any v2
      // analysis/projection response as a one-time-per-page-load toast.
      surfaceDataWarnings(endpoint, result);
      return (payloadMatch.postProcess ? payloadMatch.postProcess(result) : result) as T;
    }

    // F5: anything left is only allowed to fall through to the network
    // (unchanged, below) if it's on the explicit PASSTHROUGH allowlist
    // (session/tasks/v2/settings-version/deployment-info/inference-
    // providers/health). Everything else reaching this point missed every
    // LOCAL/DISABLED/PAYLOAD route on purpose or by omission — either way,
    // silently sending it to a real v1 server endpoint in local mode would
    // be a data-routing bug, so fail loud instead.
    const method = options.method ?? 'GET';
    if (!isPassthroughAllowed(endpoint, method)) {
      const message = `No local-mode route for ${method} ${endpoint}`;
      console.error(message);
      throw new ApiError(404, message);
    }
  }

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
          errorMessage = String(errorData.detail);
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
export async function uploadFiles<T>(
  endpoint: string,
  files: File[],
  fieldName = 'files',
  timeout = 120000
): Promise<T> {
  const formData = new FormData();
  for (const file of files) {
    formData.append(fieldName, file);
  }

  let signatureHeaders: Record<string, string> = {};
  if (isSigningRequired()) {
    signatureHeaders = await generateSignatureHeaders('POST', endpoint);
  }

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
        const errorData: unknown = await response.json();
        if (typeof errorData === 'object' && errorData !== null && 'detail' in errorData) {
          errorMessage = String(errorData.detail);
        }
      } catch (parseError) {
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

/**
 * F14: endpoint families (v1 path prefixes) that get a single throttled
 * data_warnings toast per page load, rather than one per request. Grouped
 * coarsely by feature area — a user re-running risk analysis five times in
 * a row doesn't need five identical "N positions excluded" toasts, but
 * moving from analysis to projections is a different-enough context to
 * warrant a fresh one.
 */
function dataWarningsEndpointFamily(endpoint: string): string {
  const [pathOnly] = endpoint.split('?');
  const segments = (pathOnly ?? endpoint).split('/').filter(Boolean);
  // e.g. "/api/analysis/risk" -> "analysis", "/api/projections/monte-carlo" -> "projections"
  return segments[1] ?? pathOnly ?? endpoint;
}

/** F14: endpoint families already warned about in this page load. Reset only by a full page reload (intentional — see dataWarningsEndpointFamily's docstring). */
const warnedDataWarningFamilies = new Set<string>();

/** Test-only hook: reset the per-page-load data_warnings throttle. */
export function resetDataWarningsThrottle(): void {
  warnedDataWarningFamilies.clear();
}

/**
 * F14: if `result` includes a non-null `data_warnings.excluded_positions`
 * (the optional field v2 analysis/projection responses may include - see
 * this file's header contract note), show a single warning toast for this
 * endpoint family, once per page load. Silently does nothing for responses
 * without the field (older/unaffected endpoints) or once already warned.
 */
function surfaceDataWarnings(endpoint: string, result: unknown): void {
  if (typeof result !== 'object' || result === null) return;
  const dataWarnings = (result as { data_warnings?: unknown }).data_warnings;
  if (!dataWarnings || typeof dataWarnings !== 'object') return;

  const excluded = (dataWarnings as { excluded_positions?: unknown; count?: unknown })
    .excluded_positions;
  const count = (dataWarnings as { count?: unknown }).count;
  const excludedCount =
    typeof count === 'number' ? count : Array.isArray(excluded) ? excluded.length : 0;
  if (excludedCount <= 0) return;

  const family = dataWarningsEndpointFamily(endpoint);
  if (warnedDataWarningFamilies.has(family)) return;
  warnedDataWarningFamilies.add(family);

  showToast(
    `${excludedCount} position${excludedCount === 1 ? '' : 's'} excluded from analysis — missing prices`,
    'warning'
  );
}

/**
 * Local-mode composition for POST /api/budget/bank-statements/upload.
 *
 * The v1 endpoint takes multipart files + an optional entity_id form field
 * and, server-side, both parses the statements AND persists the import +
 * recurring candidates in one step. In hosted/local mode there is no
 * server-side persistence, so this splits that into two calls: a signed
 * multipart upload to the stateless /api/v2/bank-statements/parse endpoint
 * (parsing only, see src/api/v2/bank_statements.py), then
 * LocalAPI.recordStatementImport() per parsed file to persist locally and
 * dedupe by content_hash exactly like the v1 handler does.
 *
 * Returns a BankStatementBatchResponse-shaped result (see
 * src/web/src/types/api.d.ts) so callers (src/features/bank-statements.ts)
 * don't need to know the request was split.
 */
async function handleLocalBankStatementUpload(formData: FormData): Promise<{
  files_imported: number;
  files_skipped: number;
  total_rows: number;
  candidates: Array<{
    id: string;
    import_id: string;
    name: string;
    amount: number;
    frequency: string;
    occurrences: number;
    status: string;
    created_expense_id: string | null;
  }>;
}> {
  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  const entityId = formData.get('entity_id');

  const parseResult = await uploadFiles<{
    imports: Array<{ file_name: string; content_hash: string; row_count: number }>;
    candidates: Array<{ name: string; amount: number; frequency: string; occurrences: number }>;
  }>('/api/v2/bank-statements/parse', files, 'files');

  const api = getLocalAPI();
  let filesImported = 0;
  let filesSkipped = 0;
  let totalRows = 0;
  const allCandidates: Array<{
    id: string;
    import_id: string;
    name: string;
    amount: number;
    frequency: string;
    occurrences: number;
    status: string;
    created_expense_id: string | null;
  }> = [];

  // Candidates are computed once across the whole batch server-side (see
  // _detect_recurring in src/api/bank_statements.py); attach them to the
  // first newly-recorded import only, so accepting/rejecting doesn't
  // duplicate rows across every file in this batch.
  let candidatesAttached = false;

  for (const imp of parseResult.imports) {
    totalRows += imp.row_count;
    const result = api.recordStatementImport({
      file_name: imp.file_name,
      content_hash: imp.content_hash,
      row_count: imp.row_count,
      entity_id: typeof entityId === 'string' && entityId ? entityId : null,
      candidates: candidatesAttached ? [] : parseResult.candidates,
    });

    if (result.already_imported) {
      filesSkipped++;
    } else {
      filesImported++;
      if (!candidatesAttached) {
        allCandidates.push(...result.candidates);
        candidatesAttached = true;
      }
    }

    if (result.already_imported && !candidatesAttached) {
      // Already-imported file: still surface any pending candidates from
      // that earlier import so the review UI isn't empty.
      allCandidates.push(...result.candidates);
    }
  }

  return {
    files_imported: filesImported,
    files_skipped: filesSkipped,
    total_rows: totalRows,
    candidates: allCandidates,
  };
}

/**
 * Local-mode composition for POST /api/imports/refresh-prices[?force=true].
 *
 * v1 fetches live quotes server-side and writes them into its own price
 * cache table. In hosted/local mode there is no server-side cache to write,
 * so this: finds stale tickers locally (or *all* updatable tickers when
 * force=true, matching v1's force-refresh semantics), fetches current
 * quotes from the stateless /api/v2/prices endpoint, and applies them via
 * LocalAPI.applyPriceUpdates. Returns a PriceRefreshResponse-shaped result
 * (see src/web/src/pages/dashboard.ts) so callers don't need to know the
 * request was split.
 */
async function handleLocalRefreshPrices(endpoint: string): Promise<{
  all_fresh: boolean;
  updated: number;
  attempted: number;
  failed: number;
  failed_tickers: string[];
}> {
  const force = endpoint.includes('force=true');
  const api = getLocalAPI();

  // maxAgeHours=0 treats every cached ticker as stale (age-in-hours > 0 is
  // true for anything cached even an instant ago) plus any uncached ones —
  // i.e. "all updatable tickers", matching v1's force-refresh semantics.
  const tickers = force ? api.getStaleTickers(0) : api.getStaleTickers();

  if (tickers.length === 0) {
    return { all_fresh: true, updated: 0, attempted: 0, failed: 0, failed_tickers: [] };
  }

  const result = await apiCall<{
    prices: Array<{
      ticker: string;
      current_price: number;
      previous_close?: number | null;
      year_high?: number | null;
      year_low?: number | null;
    }>;
    errors: Array<{ ticker: string; error: string }>;
  }>(`/api/v2/prices?tickers=${encodeURIComponent(tickers.join(','))}`);

  if (result.prices.length > 0) {
    api.applyPriceUpdates(
      result.prices.map((p) => ({
        ticker: p.ticker,
        price: p.current_price,
        previous_close: p.previous_close ?? null,
        year_high: p.year_high ?? null,
        year_low: p.year_low ?? null,
      }))
    );
  }

  return {
    all_fresh: result.errors.length === 0,
    updated: result.prices.length,
    attempted: tickers.length,
    failed: result.errors.length,
    failed_tickers: result.errors.map((e) => e.ticker),
  };
}

/**
 * Derive a single "primary sector" from a fund/analyze result the same way
 * the v1 server does (src/api/analysis.py's analyze_portfolio_funds): the
 * largest entry in sector_breakdown if present, else a simplified
 * category->sector mapping from morningstar_category, else null (no sector
 * determinable).
 */
function primarySectorFromFundAnalysis(result: {
  sector_breakdown?: Record<string, number> | null;
  morningstar_category?: string | null;
}): string | null {
  if (result.sector_breakdown && Object.keys(result.sector_breakdown).length > 0) {
    return Object.entries(result.sector_breakdown).sort((a, b) => b[1] - a[1])[0]![0];
  }
  const category = result.morningstar_category?.toLowerCase();
  if (!category) return null;
  if (category.includes('technology')) return 'Technology';
  if (category.includes('healthcare') || category.includes('health')) return 'Healthcare';
  if (category.includes('financial')) return 'Financials';
  if (category.includes('energy')) return 'Energy';
  if (category.includes('real estate')) return 'Real Estate';
  if (category.includes('consumer')) return 'Consumer';
  if (category.includes('industrial')) return 'Industrials';
  if (category.includes('blend') || category.includes('growth') || category.includes('value')) {
    return 'Diversified';
  }
  return null;
}

/**
 * Local-mode composition for POST /api/analysis/fund/analyze-portfolio.
 *
 * v1 finds all is_fund=1 positions server-side, analyzes each unique
 * ticker via FundDataService, and writes the derived primary sector back
 * onto every position sharing that ticker (src/api/analysis.py). In hosted/
 * local mode there's no server-side fund service to call directly, so this
 * loops the local is_fund=1 tickers, calls the stateless
 * /api/v2/fund/analyze endpoint (same per-ticker contract as
 * /api/analysis/fund/analyze — see the PAYLOAD rewire in dispatcher.ts) for
 * each, and applies the result locally via LocalAPI.setSectorForTicker.
 * Matches v1's 10-fund-per-call limit to avoid hammering the same rate
 * limits the server is protecting against.
 */
async function handleLocalAnalyzePortfolioFunds(): Promise<{
  analyzed: Array<Record<string, unknown>>;
  total_funds: number;
  positions_updated: number;
  message?: string;
}> {
  const api = getLocalAPI();
  const fundTickers = api.getFundTickers();

  if (fundTickers.length === 0) {
    return {
      analyzed: [],
      total_funds: 0,
      positions_updated: 0,
      message: 'No funds found in portfolio',
    };
  }

  const analyzed: Array<Record<string, unknown>> = [];
  let positionsUpdated = 0;

  for (const ticker of fundTickers.slice(0, 10)) {
    try {
      const result = await apiCall<{
        ticker: string;
        name?: string;
        morningstar_category?: string;
        style?: string;
        region?: string;
        sector_breakdown?: Record<string, number>;
        data_source: string;
      }>('/api/v2/fund/analyze', { method: 'POST', body: { ticker } });

      const primarySector = primarySectorFromFundAnalysis(result);
      if (primarySector) {
        positionsUpdated += api.setSectorForTicker(ticker, primarySector);
      }

      analyzed.push({ ...result, primary_sector: primarySector });
    } catch (error) {
      analyzed.push({ ticker, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return { analyzed, total_funds: fundTickers.length, positions_updated: positionsUpdated };
}

/**
 * Local-mode composition for POST /api/analysis/positions/update-sectors.
 *
 * v1 finds tickers missing a sector (excluding non-tradeable synthetic
 * forms — CDs/bonds/T-bills/I-bonds/cash/real-estate), looks each up via
 * multiple data sources server-side, and writes the sector back onto every
 * position sharing that ticker (src/api/analysis.py). In hosted/local mode,
 * LocalAPI.getTickersMissingSector() applies the identical exclusion filter,
 * then this makes one batched call to the stateless
 * /api/v2/positions/sectors endpoint and applies the results via
 * LocalAPI.setSectorForTicker. Matches v1's 20-ticker-per-call limit.
 */
async function handleLocalUpdatePositionSectors(): Promise<{
  analyzed: Array<{ ticker: string; sector: string | null; error?: string }>;
  total_tickers: number;
  positions_updated: number;
  message?: string;
}> {
  const api = getLocalAPI();
  const tickers = api.getTickersMissingSector();

  if (tickers.length === 0) {
    return {
      analyzed: [],
      total_tickers: 0,
      positions_updated: 0,
      message: 'All positions already have sectors',
    };
  }

  const batch = tickers.slice(0, 20);
  const result = await apiCall<{
    sectors: Record<string, string | null>;
    errors: Array<{ ticker: string; error: string }>;
  }>('/api/v2/positions/sectors', { method: 'POST', body: { tickers: batch } });

  const errorByTicker = new Map(result.errors.map((e) => [e.ticker, e.error]));
  let positionsUpdated = 0;
  const analyzed: Array<{ ticker: string; sector: string | null; error?: string }> = [];

  for (const ticker of batch) {
    const sector = result.sectors[ticker] ?? null;
    if (sector) {
      positionsUpdated += api.setSectorForTicker(ticker, sector);
      analyzed.push({ ticker, sector });
    } else {
      analyzed.push({
        ticker,
        sector: null,
        error: errorByTicker.get(ticker) ?? 'Could not determine sector from any source',
      });
    }
  }

  return { analyzed, total_tickers: tickers.length, positions_updated: positionsUpdated };
}

/**
 * F13: persist a local Monte Carlo run to the local monte_carlo_results
 * table, so the dashboard-metrics composite can report real numbers on
 * subsequent loads instead of always showing simulation_required: true.
 * Defensive about the response shape - the v2 contract for this endpoint's
 * exact success/percentile field names wasn't in the tree when this was
 * written (see this file's header note), so any field it doesn't recognize
 * is just left out rather than guessed; required-not-null DB columns
 * (current_age, retirement_age, portfolio_balance, success_rate) fall back
 * to computed/zero values only when truly absent, and errors here are
 * swallowed with a console.warn - a failed local save must never surface
 * as a user-facing failure of the simulation itself, which already
 * succeeded by the time this runs.
 */
function persistLocalMonteCarloResult(requestBody: unknown, result: unknown): void {
  try {
    const req = (requestBody ?? {}) as {
      current_age?: number;
      retirement_age?: number;
      current_balance?: number;
      monthly_contribution?: number;
      monthly_withdrawal?: number;
    };
    const res = (result ?? {}) as {
      success_rate?: number;
      median_end_value?: number;
      median_final_value?: number;
      percentile_10?: number;
      worst_case_final?: number;
      percentile_90?: number;
      best_case_final?: number;
    };

    if (req.current_age === undefined || req.retirement_age === undefined) {
      // Not enough information to satisfy the NOT NULL schema columns —
      // skip rather than write a row with fabricated ages.
      return;
    }

    getLocalAPI().saveMonteCarloResult({
      current_age: req.current_age,
      retirement_age: req.retirement_age,
      portfolio_balance: req.current_balance ?? getLocalAPI().getPortfolio().total_value,
      monthly_contribution: req.monthly_contribution ?? 0,
      monthly_withdrawal: req.monthly_withdrawal ?? 0,
      success_rate: res.success_rate ?? 0,
      median_final_value: res.median_final_value ?? res.median_end_value ?? null,
      worst_case_final: res.worst_case_final ?? res.percentile_10 ?? null,
      best_case_final: res.best_case_final ?? res.percentile_90 ?? null,
    });
  } catch (error) {
    console.warn('Failed to persist local Monte Carlo result:', error);
  }
}

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
        const errorData: unknown = await response.json();
        if (typeof errorData === 'object' && errorData !== null && 'detail' in errorData) {
          errorMessage = String(errorData.detail);
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

/**
 * Upload a file plus extra string form fields via multipart/form-data.
 * Like `uploadFile`, but for endpoints that take additional Form(...)
 * fields alongside the file (e.g. /api/v2/import/parse's `accounts` JSON
 * string field).
 * @param endpoint - API endpoint
 * @param file - File to upload
 * @param fields - Extra form fields (string values only)
 * @param fieldName - Form field name for the file (default: 'file')
 * @param timeout - Request timeout in ms (default: 120000 for large files)
 * @returns Response data
 * @throws ApiError on upload failure or timeout
 */
export async function uploadFileWithFields<T>(
  endpoint: string,
  file: File,
  fields: Record<string, string> = {},
  fieldName = 'file',
  timeout = 120000
): Promise<T> {
  const formData = new FormData();
  formData.append(fieldName, file);
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }

  let signatureHeaders: Record<string, string> = {};
  if (isSigningRequired()) {
    signatureHeaders = await generateSignatureHeaders('POST', endpoint);
  }

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
        const errorData: unknown = await response.json();
        if (typeof errorData === 'object' && errorData !== null && 'detail' in errorData) {
          errorMessage = String(errorData.detail);
        }
      } catch (parseError) {
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
