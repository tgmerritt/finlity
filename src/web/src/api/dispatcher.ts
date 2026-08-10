/**
 * Local/remote dispatcher — the hosted-mode routing layer inserted at the
 * `apiCall` choke point (see src/api/client.ts).
 *
 * When `dataMode === 'server'` this module is never consulted: `apiCall`
 * takes its existing network path unchanged (see the guard at the top of
 * `apiCall`). Everything below only runs when `dataMode === 'local'`
 * (hosted/multi-user mode), where all user data lives in the browser SQLite
 * DB (see src/database/client-database.ts) instead of a server database.
 *
 * Three route categories:
 * - LOCAL: served entirely from LocalAPI, no network call.
 * - PAYLOAD: rewritten into a POST to the stateless /api/v2/* endpoints,
 *   with the request body built from local data (portfolio/budget
 *   payloads). Re-enters `runAsyncApiCall` so HMAC signing and async
 *   task_id polling keep working unchanged.
 * - PASSTHROUGH: unchanged network call (session, tasks, inference
 *   providers, deployment-info, demo-mode, and /api/v2/** itself).
 * - DISABLED: short-circuited to a stub/empty response (plugins, profiles,
 *   api-key, folder-scanning imports) — these are server-local concepts
 *   that don't apply to a browser-only database.
 */

import { clientDB } from '@/database/client-database';
import { createLocalAPI, type LocalAPI } from '@/database/local-api';
import type { ApiCallOptions } from './client';

// =====================================================================
// LocalAPI singleton bound to the shared clientDB instance
// =====================================================================

let cachedLocalAPI: LocalAPI | null = null;

/** Get (or lazily create) the LocalAPI instance bound to the global clientDB. */
export function getLocalAPI(): LocalAPI {
  if (!cachedLocalAPI) {
    cachedLocalAPI = createLocalAPI(clientDB);
  }
  return cachedLocalAPI;
}

/** Test-only hook: reset the cached LocalAPI (e.g. after swapping clientDB in a test). */
export function resetLocalAPICache(): void {
  cachedLocalAPI = null;
}

// =====================================================================
// Portfolio / budget payload builders (WS1 contract: src/api/v2/payload.py)
// =====================================================================

export interface PositionPayload {
  id?: string;
  ticker: string;
  name?: string | null;
  shares: number;
  cost_basis?: number | null;
  current_price?: number | null;
  sector?: string | null;
  is_fund?: boolean;
  asset_class?: string;
  position_type?: string;
  maturity_date?: string | null;
  purchase_date?: string | null;
  interest_rate?: number | null;
  option_underlying?: string | null;
  option_expiration?: string | null;
  option_strike?: number | null;
  option_type?: string | null;
  contract_multiplier?: number | null;
}

export interface AccountPayload {
  id?: string;
  name: string;
  account_type: string;
  brokerage?: string;
  beneficiary?: string | null;
  custom_type_name?: string | null;
  is_retirement_account?: boolean;
  entity_id?: string | null;
  positions: PositionPayload[];
}

export interface PortfolioPayload {
  accounts: AccountPayload[];
}

export interface TriggerPayload {
  id?: string;
  name: string;
  condition_type: string;
  ticker?: string | null;
  account_type?: string | null;
  sector?: string | null;
  operator: string;
  threshold: number;
  is_active?: boolean;
}

export interface IncomeSourcePayload {
  id?: string;
  name: string;
  income_type?: string;
  gross_annual: number;
  pay_frequency?: string;
  state?: string;
  is_active?: boolean;
}

export interface DeductionPayload {
  id?: string;
  income_source_id?: string | null;
  label?: string | null;
  deduction_type: string;
  amount_per_period: number;
  employer_match?: number;
  is_percentage?: boolean;
  max_annual?: number | null;
}

export interface ExpensePayload {
  id?: string;
  category_id?: string | null;
  category_name?: string;
  name: string;
  amount: number;
  frequency?: string;
  is_pretax?: boolean;
  is_mortgage?: boolean;
  principal_portion?: number | null;
  interest_portion?: number | null;
  is_active?: boolean;
}

export interface TaxConfigPayload {
  id?: string;
  tax_year?: number;
  filing_status?: string;
  state?: string;
  ss_benefit_override?: number | null;
  additional_withholding?: number;
  itemized_deduction?: number | null;
  ss_claiming_age?: number;
}

/**
 * Build the full PortfolioPayload (all accounts + positions) from the local
 * database, matching src/api/v2/payload.py's AccountPayload/PositionPayload
 * shapes exactly (field-for-field) so it can be POSTed directly to any
 * /api/v2/analysis or /api/v2/projections endpoint that takes a portfolio
 * body.
 */
export function buildPortfolioPayload(): PortfolioPayload {
  const api = getLocalAPI();
  const accounts = api.getAccounts();
  const positions = api.getPositions();

  const accountPayloads: AccountPayload[] = accounts.map((acc) => ({
    id: acc.id,
    name: acc.name,
    account_type: acc.account_type,
    brokerage: acc.brokerage,
    beneficiary: acc.beneficiary,
    is_retirement_account: acc.is_retirement,
    entity_id: acc.entity_id,
    positions: [],
  }));
  const byAccountId = new Map(accountPayloads.map((a) => [a.id, a]));

  for (const pos of positions) {
    const account = byAccountId.get(pos.account_id);
    if (!account) continue;
    account.positions.push({
      id: pos.id,
      ticker: pos.ticker,
      name: pos.name,
      shares: pos.shares,
      cost_basis: pos.cost_basis,
      current_price: pos.current_price,
      sector: pos.sector,
      is_fund: pos.is_fund,
      asset_class: pos.asset_class,
      position_type: pos.position_type,
      maturity_date: pos.maturity_date,
      purchase_date: pos.purchase_date,
      interest_rate: pos.interest_rate,
      option_underlying: pos.option_underlying,
      option_expiration: pos.option_expiration,
      option_strike: pos.option_strike,
      option_type: pos.option_type,
      contract_multiplier: pos.contract_multiplier,
    });
  }

  return { accounts: accountPayloads };
}

/** Build the local trigger list as TriggerPayload[] for /api/v2/triggers/evaluate. */
export function buildTriggerPayloads(): TriggerPayload[] {
  const api = getLocalAPI();
  return api.getTriggers().map((t) => ({
    id: t.id,
    name: t.name,
    condition_type: t.condition_type,
    ticker: t.ticker,
    account_type: t.account_type,
    sector: t.sector,
    operator: t.operator,
    threshold: t.threshold,
    is_active: t.is_active,
  }));
}

/** Budget context shape shared by several v2 request bodies (budget.py / projections.py). */
export interface BudgetIncomeContext {
  income_sources: IncomeSourcePayload[];
  deductions: DeductionPayload[];
  tax_config: TaxConfigPayload;
}

/** Build the local budget context (income + deductions + tax config) for embedding in v2 requests. */
export function buildBudgetContext(entityId?: string | null): BudgetIncomeContext {
  const api = getLocalAPI();
  const income = api.getIncomeSources();
  const deductions = api.getDeductions();
  const taxConfig = api.getTaxConfig(entityId ?? null);

  return {
    income_sources: income.map((i) => ({
      id: i.id,
      name: i.name,
      income_type: i.income_type,
      gross_annual: i.gross_annual,
      pay_frequency: i.pay_frequency,
      state: i.state,
      is_active: i.is_active,
    })),
    deductions: deductions.map((d) => ({
      id: d.id,
      income_source_id: d.income_source_id,
      label: d.label,
      deduction_type: d.deduction_type,
      amount_per_period: d.amount_per_period,
      employer_match: d.employer_match,
      is_percentage: d.is_percentage,
      max_annual: d.max_annual,
    })),
    tax_config: {
      ...(taxConfig.id ? { id: taxConfig.id } : {}),
      tax_year: taxConfig.tax_year,
      filing_status: taxConfig.filing_status,
      state: taxConfig.state,
      ss_benefit_override: taxConfig.ss_benefit_override,
      additional_withholding: taxConfig.additional_withholding,
      itemized_deduction: taxConfig.itemized_deduction,
      ss_claiming_age: taxConfig.ss_claiming_age,
    },
  };
}

/** Build local expenses as ExpensePayload[] for /api/v2/budget/* requests that need them. */
export function buildExpensePayloads(): ExpensePayload[] {
  const api = getLocalAPI();
  return api.getExpenses().map((e) => ({
    id: e.id,
    category_id: e.category_id,
    category_name: e.category_name,
    name: e.name,
    amount: e.amount,
    frequency: e.frequency,
    is_pretax: e.is_pretax,
    is_mortgage: e.is_mortgage,
    principal_portion: e.principal_portion,
    interest_portion: e.interest_portion,
    is_active: e.is_active,
  }));
}

// =====================================================================
// Route matching helpers
// =====================================================================

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** Parsed request the dispatcher hands to a route handler. */
export interface DispatchRequest {
  method: HttpMethod;
  /** Path with query string stripped. */
  path: string;
  /** Parsed query params (from the original endpoint string). */
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (req: DispatchRequest, match: RegExpMatchArray) => unknown;

interface Route {
  method: HttpMethod | '*';
  pattern: RegExp;
  handler: RouteHandler;
}

/** Sentinel thrown by DISABLED routes that should surface as a toast rather than silent success. */
export class LocalModeDisabledError extends Error {}

function pathToRegex(path: string): RegExp {
  // Escape regex special chars, then turn `{param}` into a single-segment
  // capture group and a trailing `/**` into a multi-segment catch-all
  // (used by the plugins/profiles/api-key DISABLED prefix routes below).
  if (path.endsWith('/**')) {
    const prefix = path.slice(0, -3).replace(/[.+?^$()|[\]\\]/g, '\\$&');
    return new RegExp(`^${prefix}(?:/.*)?$`);
  }
  const escaped = path.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[a-zA-Z_]+\}/g, '([^/]+)');
  return new RegExp(`^${escaped}$`);
}

// =====================================================================
// Result marker so the dispatcher can distinguish "handled" from "not
// handled" without special-casing `undefined`/`null` return values.
// =====================================================================

const NOT_HANDLED = Symbol('not-handled');

/**
 * Attempt to resolve `endpoint`/`options` against the LOCAL and DISABLED
 * route tables. Returns the resolved value, or the NOT_HANDLED sentinel if
 * no LOCAL/DISABLED route matches (caller should then check PAYLOAD routes,
 * then fall through to network passthrough).
 *
 * Synchronous (every LOCAL/DISABLED handler reads/writes the in-memory
 * sql.js database directly, no I/O) — callers still `await` it in client.ts
 * for symmetry with the PAYLOAD path, which is genuinely async.
 *
 * Exported primarily for unit testing; the dispatch hook in client.ts's
 * `apiCall` is the integration point.
 */
export function tryLocalRoute(endpoint: string, options: ApiCallOptions): unknown {
  const [pathOnly, queryString = ''] = endpoint.split('?');
  const method = options.method ?? 'GET';
  const query = new URLSearchParams(queryString);
  const req: DispatchRequest = { method, path: pathOnly ?? endpoint, query, body: options.body };

  for (const route of localAndDisabledRoutes) {
    if (route.method !== '*' && route.method !== method) continue;
    const match = req.path.match(route.pattern);
    if (!match) continue;
    return route.handler(req, match);
  }

  return NOT_HANDLED;
}

/**
 * Resolve `endpoint`/`options` against the PAYLOAD route table and, if
 * matched, return the {endpoint, options} rewrite (POSTs data built from
 * the local DB to /api/v2/*). Returns NOT_HANDLED if nothing matches.
 *
 * The caller (dispatchApiCall) re-enters `runAsyncApiCall` with the
 * rewritten request so HMAC signing (below the apiCall hook) and async
 * task_id polling stay identical to the network path.
 */
export function matchPayloadRoute(
  endpoint: string,
  options: ApiCallOptions
): PayloadRewrite | typeof NOT_HANDLED {
  const [pathOnly, queryString = ''] = endpoint.split('?');
  const method = options.method ?? 'GET';
  const query = new URLSearchParams(queryString);
  const req: DispatchRequest = { method, path: pathOnly ?? endpoint, query, body: options.body };

  for (const route of payloadRoutes) {
    if (route.method !== '*' && route.method !== method) continue;
    const match = req.path.match(route.pattern);
    if (!match) continue;
    return route.handler(req, match);
  }

  return NOT_HANDLED;
}

export { NOT_HANDLED };

// =====================================================================
// PASSTHROUGH allowlist (F5)
//
// Anything that reaches here has already missed both the LOCAL/DISABLED
// table and the PAYLOAD table. Previously *everything* in that position
// fell through to an unchanged network call — silently sending local-mode
// traffic to real v1 server endpoints for any request the two tables above
// didn't happen to cover (a gap discovered by code review, not something
// intentionally designed in). Now it's an explicit allowlist: only the
// prefixes/endpoints below are allowed to hit the network unchanged; every
// other /api/* call in local mode is a routing bug and must fail loud
// (see isPassthroughAllowed's caller in client.ts) rather than silently
// leaking to the server.
// =====================================================================

const PASSTHROUGH_ALLOWLIST: Array<{ method: HttpMethod | '*'; pattern: RegExp }> = [
  { method: '*', pattern: /^\/api\/session(?:\/.*)?$/ },
  { method: '*', pattern: /^\/api\/tasks(?:\/.*)?$/ },
  { method: '*', pattern: /^\/api\/v2(?:\/.*)?$/ },
  { method: 'GET', pattern: /^\/api\/settings\/version$/ },
  { method: 'GET', pattern: /^\/api\/settings\/deployment-info$/ },
  { method: 'GET', pattern: /^\/api\/inference\/providers$/ },
  { method: 'GET', pattern: /^\/health$/ },
];

/**
 * True if `endpoint`/`method` is explicitly allowed to fall through to an
 * unchanged network call in local mode, after missing the LOCAL, DISABLED,
 * and PAYLOAD route tables. See PASSTHROUGH_ALLOWLIST above for the exact
 * list (mirrors the plan's PASSTHROUGH category).
 */
export function isPassthroughAllowed(endpoint: string, method: HttpMethod): boolean {
  const [pathOnly] = endpoint.split('?');
  return PASSTHROUGH_ALLOWLIST.some(
    (rule) =>
      (rule.method === '*' || rule.method === method) && rule.pattern.test(pathOnly ?? endpoint)
  );
}

// =====================================================================
// LOCAL + DISABLED routes
// =====================================================================

const localAndDisabledRoutes: Route[] = [];

function local(method: HttpMethod | '*', path: string, handler: RouteHandler): void {
  localAndDisabledRoutes.push({ method, pattern: pathToRegex(path), handler });
}

function disabled(method: HttpMethod | '*', path: string, handler: RouteHandler): void {
  localAndDisabledRoutes.push({ method, pattern: pathToRegex(path), handler });
}

// ---- Portfolio: account types, accounts, positions ----

local('GET', '/api/portfolio/account-types', () => getLocalAPI().getAccountTypes());
local('GET', '/api/portfolio/accounts', () => getLocalAPI().getAccounts());
local('POST', '/api/portfolio/accounts', (req) =>
  getLocalAPI().createAccount(req.body as Parameters<LocalAPI['createAccount']>[0])
);
local('DELETE', '/api/portfolio/accounts/{id}', (_req, m) => getLocalAPI().deleteAccount(m[1]!));

local('GET', '/api/portfolio/positions', (req) =>
  getLocalAPI().getPositions(req.query.get('account_id'))
);
local('POST', '/api/portfolio/positions', (req) =>
  getLocalAPI().createPosition(req.body as Parameters<LocalAPI['createPosition']>[0])
);
local('POST', '/api/portfolio/positions/cash', (req) =>
  getLocalAPI().createCashPosition(req.body as Parameters<LocalAPI['createCashPosition']>[0])
);
local('POST', '/api/portfolio/positions/cd', (req) =>
  getLocalAPI().createCDPosition(req.body as Parameters<LocalAPI['createCDPosition']>[0])
);
local('GET', '/api/portfolio/positions/cd/upcoming', (req) => {
  const days = req.query.get('days');
  return getLocalAPI().getUpcomingCDMaturities(days ? Number(days) : undefined);
});
local('POST', '/api/portfolio/positions/cd/check-maturities', () =>
  getLocalAPI().checkCDMaturities()
);
local('POST', '/api/portfolio/positions/real-estate', (req) =>
  getLocalAPI().createRealEstatePosition(
    req.body as Parameters<LocalAPI['createRealEstatePosition']>[0]
  )
);
local('PUT', '/api/portfolio/positions/{id}', (req, m) =>
  getLocalAPI().updatePosition(m[1]!, req.body as Parameters<LocalAPI['updatePosition']>[1])
);
local('DELETE', '/api/portfolio/positions/{id}', (_req, m) => getLocalAPI().deletePosition(m[1]!));

local('GET', '/api/portfolio', () => getLocalAPI().getPortfolio());
local('GET', '/api/portfolio/duplicates', () => getLocalAPI().getDuplicates());
local('GET', '/api/portfolio/export/{dataType}', (_req, m) =>
  getLocalAPI().exportCsv(m[1] as 'accounts' | 'positions' | 'snapshots')
);

// ---- Portfolio: dashboard-metrics composite ----
//
// DEVIATION: the plan's LOCAL route list doesn't call this endpoint out by
// name, but main.ts's boot sequence (refreshData -> loadRetirementMetrics)
// calls it unconditionally, so it must resolve locally or the boot flow
// throws.
//
// F13: WS2's local schema has a monte_carlo_results table; LocalAPI now
// exposes saveMonteCarloResult()/getLatestMonteCarloResult() (see
// local-api.ts), and client.ts writes a row there after every successful
// local-mode /api/v2/projections/monte-carlo response. This reads the
// latest saved row, if any, so the dashboard reflects a real simulation
// once one has been run - falling back to simulation_required: true only
// when nothing has ever been saved (matches the server's pre-first-run
// shape).
local('GET', '/api/portfolio/dashboard-metrics', () => {
  const api = getLocalAPI();
  const summary = api.getPortfolio();
  const latest = api.getLatestMonteCarloResult();

  if (!latest) {
    return {
      monthly_retirement_income: null,
      withdrawal_rate: 4,
      success_probability: null,
      earliest_retirement_age: null,
      fire_number: null,
      coast_number: null,
      current_age: null,
      target_retirement_age: null,
      target_monthly_income: null,
      last_simulation_date: null,
      total_portfolio_value: summary.total_value,
      projected_value_at_retirement: null,
      conservative_value_at_retirement: null,
      simulation_required: true,
    };
  }

  return {
    monthly_retirement_income: null,
    withdrawal_rate: 4,
    success_probability: latest.success_rate,
    earliest_retirement_age: null,
    fire_number: null,
    coast_number: null,
    current_age: latest.current_age,
    target_retirement_age: latest.retirement_age,
    target_monthly_income: null,
    last_simulation_date: latest.run_date,
    total_portfolio_value: summary.total_value,
    projected_value_at_retirement: latest.median_final_value,
    conservative_value_at_retirement: latest.worst_case_final,
    simulation_required: false,
  };
});

// ---- Portfolio: dashboard/data composite ----
//
// Composed from LocalAPI pieces to match src/main.py's get_dashboard_data
// shape ({summary, positions, history, imports, view_id, demo_mode}).
// DEVIATION: `imports` is always [] (no local file-import-history tracking
// in LocalAPI) and `demo_mode` is always false (server-only concept).
local('GET', '/api/dashboard/data', (req) => {
  const api = getLocalAPI();
  const viewId = req.query.get('view_id');

  let accountIds: Set<string> | null = null;
  if (viewId) {
    const views = api.getViews();
    const view = views.find((v) => v.id === viewId);
    if (view) accountIds = new Set(view.account_ids);
  }

  const accounts = api.getAccounts();
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const filteredAccounts = accountIds ? accounts.filter((a) => accountIds.has(a.id)) : accounts;

  const allPositions = api.getPositions();
  const positions = (
    accountIds ? allPositions.filter((p) => accountIds.has(p.account_id)) : allPositions
  ).map((p) => {
    const account = accountsById.get(p.account_id);
    return {
      id: p.id,
      ticker: p.ticker,
      name: p.name,
      shares: p.shares,
      price: p.current_price,
      value: p.market_value,
      accrued_value: p.accrued_value,
      cost_basis: p.cost_basis,
      account: p.account_name,
      account_type: account?.account_type ?? 'unknown',
      is_fund: p.is_fund,
      position_type: p.position_type,
      interest_rate: p.interest_rate,
      purchase_date: p.purchase_date,
      maturity_date: p.maturity_date,
      option_underlying: p.option_underlying,
      option_expiration: p.option_expiration,
      option_strike: p.option_strike,
      option_type: p.option_type,
      contract_multiplier: p.contract_multiplier,
      contracts: p.contracts,
      premium: p.premium,
    };
  });

  let totalValue = 0;
  let totalCostBasis = 0;
  let retirementValue = 0;
  let taxableValue = 0;
  for (const acc of filteredAccounts) {
    totalValue += acc.value;
    totalCostBasis += acc.cost_basis ?? 0;
    if (acc.is_retirement) retirementValue += acc.value;
    else taxableValue += acc.value;
  }

  const summary = {
    total_value: totalValue,
    total_cost_basis: totalCostBasis || null,
    total_gain_loss: totalCostBasis ? totalValue - totalCostBasis : null,
    retirement_value: retirementValue,
    taxable_value: taxableValue,
    account_count: filteredAccounts.length,
    position_count: positions.length,
    accounts: filteredAccounts,
  };

  return {
    summary,
    positions,
    history: api.getHistory(),
    imports: [],
    view_id: viewId ?? null,
    demo_mode: false,
  };
});

// ---- Import: persist parsed positions ----

local('POST', '/api/import/positions', (req) => {
  const result = getLocalAPI().importPositions(
    req.body as Parameters<LocalAPI['importPositions']>[0]
  );
  return { imported_count: result.imported, detail: undefined };
});

// ---- Prices: status + local refresh flow ----

local('GET', '/api/imports/price-status', (req) => {
  const maxAgeHours = req.query.get('max_age_hours');
  const timezone = req.query.get('timezone') ?? undefined;
  return getLocalAPI().getPriceStatus(maxAgeHours ? Number(maxAgeHours) : undefined, timezone);
});

// ---- Budget: income, expenses, deductions, tax-config, states, categories ----

local('GET', '/api/budget/income', () => getLocalAPI().getIncomeSources());
local('POST', '/api/budget/income', (req) =>
  getLocalAPI().createIncomeSource(req.body as Parameters<LocalAPI['createIncomeSource']>[0])
);
local('PUT', '/api/budget/income/{id}', (req, m) =>
  getLocalAPI().updateIncomeSource(m[1]!, req.body as Parameters<LocalAPI['updateIncomeSource']>[1])
);
local('DELETE', '/api/budget/income/{id}', (_req, m) => getLocalAPI().deleteIncomeSource(m[1]!));

local('GET', '/api/budget/expense-categories', () => getLocalAPI().getExpenseCategories());

local('GET', '/api/budget/expenses', () => getLocalAPI().getExpenses());
local('POST', '/api/budget/expenses', (req) =>
  getLocalAPI().createExpense(req.body as Parameters<LocalAPI['createExpense']>[0])
);
local('PUT', '/api/budget/expenses/{id}', (req, m) =>
  getLocalAPI().updateExpense(m[1]!, req.body as Parameters<LocalAPI['updateExpense']>[1])
);
local('DELETE', '/api/budget/expenses/{id}', (_req, m) => getLocalAPI().deleteExpense(m[1]!));

local('GET', '/api/budget/deductions', () => getLocalAPI().getDeductions());
local('POST', '/api/budget/deductions', (req) =>
  getLocalAPI().createDeduction(req.body as Parameters<LocalAPI['createDeduction']>[0])
);
local('PUT', '/api/budget/deductions/{id}', (req, m) =>
  getLocalAPI().updateDeduction(m[1]!, req.body as Parameters<LocalAPI['updateDeduction']>[1])
);
local('DELETE', '/api/budget/deductions/{id}', (_req, m) => getLocalAPI().deleteDeduction(m[1]!));

local('GET', '/api/budget/tax-config', (req) =>
  getLocalAPI().getTaxConfig(req.query.get('entity_id'))
);
local('PUT', '/api/budget/tax-config', (req) =>
  getLocalAPI().updateTaxConfig(
    req.body as Parameters<LocalAPI['updateTaxConfig']>[0],
    req.query.get('entity_id')
  )
);
local('GET', '/api/budget/states', () => getLocalAPI().getStates());

// ---- Budget: bank statement imports/candidates CRUD ----

local('GET', '/api/budget/bank-statements/imports', () => getLocalAPI().getStatementImports());
local('POST', '/api/budget/bank-statements/candidates/{id}/accept', (req, m) =>
  getLocalAPI().acceptCandidate(m[1]!, req.body as Parameters<LocalAPI['acceptCandidate']>[1])
);
local('POST', '/api/budget/bank-statements/candidates/{id}/reject', (_req, m) =>
  getLocalAPI().rejectCandidate(m[1]!)
);

// ---- Entities ----

local('GET', '/api/entities/', () => getLocalAPI().getEntities());
local('GET', '/api/entities/{id}', (_req, m) => getLocalAPI().getEntity(m[1]!));
local('POST', '/api/entities/', (req) =>
  getLocalAPI().createEntity(req.body as Parameters<LocalAPI['createEntity']>[0])
);
local('PUT', '/api/entities/{id}', (req, m) =>
  getLocalAPI().updateEntity(m[1]!, req.body as Parameters<LocalAPI['updateEntity']>[1])
);
local('DELETE', '/api/entities/{id}', (_req, m) => getLocalAPI().deleteEntity(m[1]!));
local('GET', '/api/entities/{id}/summary', (_req, m) => getLocalAPI().getEntitySummary(m[1]!));
local('POST', '/api/entities/auto-detect', () => getLocalAPI().autoDetectEntities());
local('POST', '/api/entities/accounts/{id}/assign', (req, m) =>
  getLocalAPI().assignAccountToEntity(m[1]!, (req.body as { entity_id: string | null }).entity_id)
);
local('POST', '/api/entities/income/{id}/assign', (req, m) =>
  getLocalAPI().assignIncomeToEntity(m[1]!, (req.body as { entity_id: string | null }).entity_id)
);
local('POST', '/api/entities/expenses/{id}/assign', (req, m) =>
  getLocalAPI().assignExpenseToEntity(m[1]!, (req.body as { entity_id: string | null }).entity_id)
);

// ---- Analysis: trigger CRUD (not evaluate/triggered — those are PAYLOAD) ----

local('GET', '/api/analysis/triggers', (req) =>
  getLocalAPI().getTriggers(req.query.get('active_only') === 'true')
);
local('POST', '/api/analysis/triggers', (req) =>
  getLocalAPI().createTrigger(req.body as Parameters<LocalAPI['createTrigger']>[0])
);
local('DELETE', '/api/analysis/triggers/{id}', (_req, m) => getLocalAPI().deleteTrigger(m[1]!));
local('PUT', '/api/analysis/triggers/{id}/toggle', (_req, m) => getLocalAPI().toggleTrigger(m[1]!));

// ---- Analysis: advisor chat/clear (client-side history only, no network) ----
//
// F5: v1's POST /api/analysis/advisor/chat/clear clears a server-side chat
// history. In local mode, chat history for the global advisor modal is kept
// entirely client-side (see ui/modal.ts's showGlobalChatModal/chat history
// array) and sent to /api/v2/analysis/advisor/chat on every turn - there is
// no server-side history to clear. This just needs to succeed as a no-op;
// the caller (analysis.ts's clearGlobalChat) is responsible for resetting
// its own in-memory history array and re-rendering the placeholder.
local('POST', '/api/analysis/advisor/chat/clear', () => ({ status: 'cleared' }));

// ---- Settings: demo mode (local stub — demo mode is a server-only concept) ----

/** Matches src/api/settings.py's get_demo_mode() response shape. */
local('GET', '/api/settings/demo-mode', () => ({
  enabled: false,
  demo_initialized: false,
  protected: false,
}));
disabled('PUT', '/api/settings/demo-mode', () => {
  throw new LocalModeDisabledError('Demo mode is not available in hosted/local mode.');
});

// ---- Settings: views ----

local('GET', '/api/settings/views', () => getLocalAPI().getViews());
local('GET', '/api/settings/views/current', () => getLocalAPI().getCurrentView());
local('POST', '/api/settings/views', (req) =>
  getLocalAPI().createView(req.body as Parameters<LocalAPI['createView']>[0])
);
local('PUT', '/api/settings/views/{id}', (req, m) =>
  getLocalAPI().updateView(m[1]!, req.body as Parameters<LocalAPI['updateView']>[1])
);
local('DELETE', '/api/settings/views/{id}', (_req, m) => getLocalAPI().deleteView(m[1]!));
local('PUT', '/api/settings/views/{id}/set-default', (_req, m) =>
  getLocalAPI().setDefaultView(m[1]!)
);

// ---- Settings: config sections ----

local('GET', '/api/settings/config', () => getLocalAPI().getConfig());
local('GET', '/api/settings/config/{section}', (_req, m) => getLocalAPI().getConfigSection(m[1]!));
local('PUT', '/api/settings/config/targets/{subsection}', (req, m) =>
  getLocalAPI().updateTargetsSubsection(m[1]!, req.body)
);
local('PUT', '/api/settings/config/{section}', (req, m) =>
  getLocalAPI().updateConfigSection(m[1]!, req.body)
);

// ---- DISABLED: plugins ----

disabled('GET', '/api/plugins', () => ({ plugins: [] }));
disabled('GET', '/api/plugins/installed', () => ({ plugins: [] }));
disabled('GET', '/api/analysis/plugins', () => ({ plugins: [] }));
disabled('GET', '/api/analysis/widgets', () => ({ widgets: [] }));
disabled('GET', '/api/plugins/security/permissions', () => ({ permissions: [] }));
disabled('*', '/api/plugins/**', () => {
  throw new LocalModeDisabledError('Plugins are disabled in hosted mode.');
});

// ---- DISABLED: profiles (single synthetic profile) ----

disabled('GET', '/api/profiles', () => [
  {
    id: 'local',
    name: clientDB.getStorageInfo().fileName ?? 'Local Database',
    description: 'Your local database file',
    color: '#4A90D9',
    icon: 'user',
    is_active: true,
  },
]);
disabled('POST', '/api/profiles', () => {
  throw new LocalModeDisabledError('Profiles are your local database files in hosted mode.');
});
disabled('POST', '/api/profiles/{id}/activate', () => ({
  id: 'local',
  name: clientDB.getStorageInfo().fileName ?? 'Local Database',
  description: 'Your local database file',
  color: '#4A90D9',
  icon: 'user',
  is_active: true,
}));
disabled('*', '/api/profiles/**', () => {
  throw new LocalModeDisabledError('Profiles are your local database files in hosted mode.');
});

// ---- DISABLED: api-key settings (server uses env keys in hosted mode) ----

disabled('GET', '/api/settings/api-keys/status', () => ({ api_keys: {} }));
disabled('*', '/api/settings/api-key/**', () => {
  throw new LocalModeDisabledError('API keys are managed by the server in hosted mode.');
});

// ---- DISABLED: folder-scanning imports (server-local filesystem only) ----

disabled('*', '/api/imports/scan', () => {
  throw new LocalModeDisabledError('Folder scanning is only available in server mode.');
});
disabled('*', '/api/imports/process', () => {
  throw new LocalModeDisabledError('Folder scanning is only available in server mode.');
});

// =====================================================================
// PAYLOAD routes: POST to /api/v2/* with a body built from local data.
// Handlers return the endpoint + rewritten body/options; the caller
// (dispatchApiCall) re-enters runAsyncApiCall so signing and task_id
// polling stay identical to the network path.
// =====================================================================

export interface PayloadRewrite {
  endpoint: string;
  options: ApiCallOptions;
  /** When set, only these fields of the resolved result are returned (used for /triggered filtering). */
  postProcess?: (result: unknown) => unknown;
}

type PayloadRouteHandler = (req: DispatchRequest, match: RegExpMatchArray) => PayloadRewrite;

interface PayloadRoute {
  method: HttpMethod | '*';
  pattern: RegExp;
  handler: PayloadRouteHandler;
}

const payloadRoutes: PayloadRoute[] = [];

function payload(method: HttpMethod | '*', path: string, handler: PayloadRouteHandler): void {
  payloadRoutes.push({ method, pattern: pathToRegex(path), handler });
}

const ANALYSIS_PORTFOLIO_ENDPOINTS: Record<string, string> = {
  '/api/analysis/allocation': '/api/v2/analysis/allocation',
  '/api/analysis/allocation/detailed': '/api/v2/analysis/allocation/detailed',
  '/api/analysis/performance': '/api/v2/analysis/performance',
  '/api/analysis/correlation': '/api/v2/analysis/correlation',
  '/api/analysis/expense-drag': '/api/v2/analysis/expense-drag',
  '/api/analysis/suggestions': '/api/v2/analysis/suggestions',
};

for (const [v1Path, v2Path] of Object.entries(ANALYSIS_PORTFOLIO_ENDPOINTS)) {
  payload('GET', v1Path, (req) => ({
    endpoint: `${v2Path}${req.query.toString() ? `?${req.query.toString()}` : ''}`,
    options: { method: 'POST', body: buildPortfolioPayload() },
  }));
}

/**
 * F7: build the optional `market_config`/`monte_carlo_config` dicts (see
 * this file's header contract doc) from the local settings sections, so
 * hosted users' saved market assumptions and Monte Carlo tuning actually
 * reach v2's risk/projections math instead of it silently falling back to
 * server-side defaults. Reads via LocalAPI.getConfigSection('market') /
 * ('monte_carlo'), whose storage keys (market_assumptions/
 * monte_carlo_settings) already use the same field names as the v2
 * contract (stock_mean_return, risk_free_rate, black_swan_probability,
 * etc. — see pages/settings.ts's save/load functions) — no field renaming
 * needed, just pass the section through under the `market`/`monte_carlo`
 * keys the contract expects. Returns `{}` for a section with nothing saved
 * yet, so v2 falls back to its own defaults exactly as it would with no
 * body field at all.
 */
function buildMarketMonteCarloConfig(): {
  market_config?: Record<string, unknown>;
  monte_carlo_config?: Record<string, unknown>;
} {
  const api = getLocalAPI();
  const market = api.getConfigSection('market')?.market as Record<string, unknown> | undefined;
  const monteCarlo = api.getConfigSection('monte_carlo')?.monte_carlo as
    Record<string, unknown> | undefined;

  const result: {
    market_config?: Record<string, unknown>;
    monte_carlo_config?: Record<string, unknown>;
  } = {};
  if (market && Object.keys(market).length > 0) result.market_config = market;
  if (monteCarlo && Object.keys(monteCarlo).length > 0) result.monte_carlo_config = monteCarlo;
  return result;
}

payload('GET', '/api/analysis/risk', (req) => ({
  endpoint: `/api/v2/analysis/risk${req.query.toString() ? `?${req.query.toString()}` : ''}`,
  options: {
    method: 'POST',
    body: { ...buildPortfolioPayload(), ...buildMarketMonteCarloConfig() },
  },
}));

payload('GET', '/api/analysis/triggers/evaluate', () => ({
  endpoint: '/api/v2/triggers/evaluate',
  options: {
    method: 'POST',
    body: { triggers: buildTriggerPayloads(), portfolio: buildPortfolioPayload() },
  },
}));

payload('GET', '/api/analysis/triggers/triggered', () => ({
  endpoint: '/api/v2/triggers/evaluate',
  options: {
    method: 'POST',
    body: { triggers: buildTriggerPayloads(), portfolio: buildPortfolioPayload() },
  },
  postProcess: (result: unknown): unknown =>
    Array.isArray(result) ? result.filter((r) => (r as { triggered?: boolean }).triggered) : result,
}));

payload('POST', '/api/analysis/advisor/analyze', (req) => ({
  endpoint: '/api/v2/analysis/advisor/analyze',
  options: {
    method: 'POST',
    body: { ...(req.body as Record<string, unknown>), portfolio: buildPortfolioPayload() },
  },
}));

payload('POST', '/api/analysis/advisor/chat', (req) => ({
  endpoint: '/api/v2/analysis/advisor/chat',
  options: {
    method: 'POST',
    body: { ...(req.body as Record<string, unknown>), portfolio: buildPortfolioPayload() },
  },
}));

// ---- Analysis: fund status/analyze (stateless — plain endpoint remap) ----

payload('GET', '/api/analysis/fund/status', () => ({
  endpoint: '/api/v2/fund/status',
  options: { method: 'GET' },
}));

payload('POST', '/api/analysis/fund/analyze', (req) => ({
  endpoint: '/api/v2/fund/analyze',
  options: { method: 'POST', body: req.body },
}));

// ---- Projections ----

const PROJECTIONS_PORTFOLIO_ENDPOINTS: Record<string, string> = {
  '/api/projections/monte-carlo': '/api/v2/projections/monte-carlo',
  '/api/projections/sensitivity': '/api/v2/projections/sensitivity',
};

for (const [v1Path, v2Path] of Object.entries(PROJECTIONS_PORTFOLIO_ENDPOINTS)) {
  payload('POST', v1Path, (req) => {
    const body = { ...(req.body as Record<string, unknown>) };
    if (body.current_balance === undefined || body.current_balance === null) {
      body.current_balance = getLocalAPI().getPortfolio().total_value;
    }
    // F7: embed market_config/monte_carlo_config from local settings
    // unless the caller already specified one explicitly (never override
    // an explicit per-request override with the saved defaults).
    const configs = buildMarketMonteCarloConfig();
    if (body.market_config === undefined && configs.market_config) {
      body.market_config = configs.market_config;
    }
    if (body.monte_carlo_config === undefined && configs.monte_carlo_config) {
      body.monte_carlo_config = configs.monte_carlo_config;
    }
    return { endpoint: v2Path, options: { method: 'POST', body } };
  });
}

payload('POST', '/api/projections/fire', (req) => ({
  endpoint: '/api/v2/projections/fire',
  options: { method: 'POST', body: req.body },
}));

payload('POST', '/api/projections/account-balances-by-type', () => ({
  endpoint: '/api/v2/projections/account-balances-by-type',
  options: { method: 'POST', body: buildPortfolioPayload() },
}));

payload('POST', '/api/projections/withdrawal-table', (req) => ({
  endpoint: '/api/v2/projections/withdrawal-table',
  options: { method: 'POST', body: req.body },
}));

payload('POST', '/api/projections/withdrawal-comparison', (req) => ({
  endpoint: '/api/v2/projections/withdrawal-comparison',
  options: { method: 'POST', body: req.body },
}));

payload('POST', '/api/projections/quick-projection', (req) => ({
  endpoint: '/api/v2/projections/quick-projection',
  options: { method: 'POST', body: req.body },
}));

payload('POST', '/api/projections/tax-projection', (req) => {
  const body = { ...(req.body as Record<string, unknown>) };
  if (body.use_budget_income) {
    body.budget = buildBudgetContext();
  }
  return { endpoint: '/api/v2/projections/tax-projection', options: { method: 'POST', body } };
});

// ---- Budget ----

payload('POST', '/api/budget/calculate-paycheck', (req) => ({
  endpoint: '/api/v2/budget/calculate-paycheck',
  options: { method: 'POST', body: req.body },
}));

payload('POST', '/api/budget/social-security', (req) => ({
  endpoint: '/api/v2/budget/social-security',
  options: { method: 'POST', body: req.body },
}));

payload('POST', '/api/budget/calculate-annual', (req) => {
  const budget = buildBudgetContext();
  return {
    endpoint: '/api/v2/budget/calculate-annual',
    options: {
      method: 'POST',
      body: {
        income_sources: budget.income_sources,
        expenses: buildExpensePayloads(),
        deductions: budget.deductions,
        ...(req.body as Record<string, unknown>),
      },
    },
  };
});

payload('POST', '/api/budget/income-transition', (req) => {
  const budget = buildBudgetContext();
  return {
    endpoint: '/api/v2/budget/income-transition',
    options: {
      method: 'POST',
      body: {
        ...(req.body as Record<string, unknown>),
        income_sources: budget.income_sources,
        expenses: buildExpensePayloads(),
      },
    },
  };
});

payload('GET', '/api/budget/paycheck-chart-data', () => {
  const budget = buildBudgetContext();
  return {
    endpoint: '/api/v2/budget/paycheck-chart-data',
    options: {
      method: 'POST',
      body: {
        income_sources: budget.income_sources,
        deductions: budget.deductions,
        expenses: buildExpensePayloads(),
        tax_config: budget.tax_config,
      },
    },
  };
});
