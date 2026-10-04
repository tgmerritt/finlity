/**
 * API response types that mirror the Python Pydantic models.
 * These types represent the shape of data returned by the FastAPI backend.
 */

// Enums matching Python enums
export type AccountType =
  | 'taxable'
  | 'traditional_401k'
  | 'roth_401k'
  | 'traditional_ira'
  | 'roth_ira'
  | 'hsa'
  | 'pension'
  | '529'
  | 'hysa'
  | 'real_estate'
  | (string & {}); // Allow custom types

export type Brokerage = 'schwab' | 'fidelity' | 'vanguard' | 'other' | (string & {});

export type AssetClass = 'equity' | 'fixed_income' | 'alternative' | 'cash';

export type PositionType =
  'equity' | 'fund' | 'cash' | 'cd' | 'bond' | 'treasury' | 'real_estate' | 'option';

// Account responses
export interface AccountResponse {
  id: string;
  name: string;
  account_type: AccountType;
  display_type: string;
  brokerage: Brokerage;
  value: number;
  cost_basis: number | null;
  position_count: number;
  beneficiary?: string | null;
  is_retirement: boolean;
}

// Position responses
export interface PositionResponse {
  id: string;
  account_id: string;
  account_name: string;
  ticker: string;
  name: string | null;
  shares: number;
  current_price: number | null;
  cost_basis: number | null;
  market_value: number;
  accrued_value?: number | null;
  gain_loss: number | null;
  gain_loss_pct: number | null;
  is_fund: boolean;
  asset_class: AssetClass;
  position_type: PositionType;
  maturity_date?: string | null;
  purchase_date?: string | null;
  interest_rate?: number | null;
  // Options-specific (null for non-option positions)
  option_underlying?: string | null;
  option_expiration?: string | null;
  option_strike?: number | null;
  option_type?: string | null; // "C" or "P"
  contract_multiplier?: number | null;
  contracts?: number | null; // alias for shares when position_type == 'option'
  premium?: number | null; // alias for current_price when position_type == 'option'
}

// Portfolio summary
export interface PortfolioSummary {
  total_value: number;
  total_cost_basis: number | null;
  total_gain_loss: number | null;
  retirement_value: number;
  taxable_value: number;
  account_count: number;
  position_count: number;
  accounts: AccountResponse[];
  /** Present on every response; false when a view filters accounts (no other liability fields then). */
  liabilities_included?: boolean;
  liabilities_total?: number;
  /** total_value minus liabilities_total. */
  net_worth?: number;
  liabilities?: DashboardLiability[];
}

/** One active liability in the dashboard summary. */
export interface DashboardLiability {
  id: string;
  name: string;
  liability_type: LiabilityType;
  balance: number;
  interest_rate: number | null;
  payment_amount: number | null;
  payment_frequency: string | null;
  payoff_date: string | null;
  linked_position_id: string | null;
  entity_id: string | null;
  is_amortizing: boolean;
  last_reported_date: string | null;
}

/** What the dashboard route merges in from the liabilities module. */
export interface DashboardLiabilities<H> {
  summary: Pick<
    PortfolioSummary,
    'liabilities_included' | 'liabilities_total' | 'net_worth' | 'liabilities'
  >;
  history: Array<H & { liabilities?: number; net_worth?: number }>;
}

// Dashboard data (combined endpoint)
export interface DashboardData {
  summary: PortfolioSummary;
  positions: DashboardPosition[];
  history: SnapshotHistory[];
  imports: ImportHistoryItem[];
  view_id: string | null;
  demo_mode: boolean;
}

export interface DashboardPosition {
  id: string;
  ticker: string;
  name: string;
  shares: number;
  price: number | null;
  value: number;
  accrued_value?: number | null;
  cost_basis: number | null;
  account: string;
  account_type: string;
  is_fund: boolean;
  position_type: PositionType;
  interest_rate?: number | null;
  purchase_date?: string | null;
  maturity_date?: string | null;
  // Options-specific (undefined for non-option positions)
  option_underlying?: string | null;
  option_expiration?: string | null;
  option_strike?: number | null;
  option_type?: string | null;
  contract_multiplier?: number | null;
  contracts?: number | null;
  premium?: number | null;
  previous_close?: number | null;
}

export interface SnapshotHistory {
  date: string;
  total: number;
  retirement: number;
  taxable: number;
  /** Total owed that day; only when liabilities are included. */
  liabilities?: number;
  net_worth?: number;
}

export interface ImportHistoryItem {
  file: string;
  date: string;
  account_type: string;
  status: string;
}

// Account type options
export interface AccountTypeOption {
  value: string;
  label: string;
  is_retirement: boolean;
  description?: string | null;
  has_beneficiary: boolean;
}

// Create/update requests
export interface CreateAccountRequest {
  name: string;
  account_type: string;
  brokerage?: string;
  beneficiary?: string | null;
  custom_type_name?: string | null;
  is_retirement?: boolean | null;
}

export interface CreatePositionRequest {
  account_id: string;
  ticker: string;
  shares: number;
  name?: string | null;
  current_price?: number | null;
  cost_basis?: number | null;
  is_fund?: boolean;
  position_type?: PositionType;
  asset_class?: AssetClass;
}

export interface CreateCashPositionRequest {
  account_id: string;
  amount: number;
  name?: string;
  interest_rate?: number | null;
}

export interface CreateCDPositionRequest {
  account_id: string;
  amount: number;
  name: string;
  interest_rate: number;
  maturity_date: string;
  purchase_date?: string | null;
}

export interface CreateRealEstateRequest {
  account_id: string;
  name: string;
  current_value: number;
  cost_basis: number;
  purchase_date?: string | null;
}

// Analysis types
export interface AllocationData {
  labels: string[];
  values: number[];
  percentages: number[];
}

export interface PerformanceMetrics {
  total_value: number;
  total_cost_basis: number | null;
  total_gain_loss: number | null;
  total_gain_loss_pct: number | null;
  day_change: number | null;
  day_change_pct: number | null;
}

// Budget types
export interface IncomeSource {
  id: string;
  name: string;
  income_type: string;
  gross_annual: number;
  pay_frequency: string;
  state?: string;
  is_active?: boolean;
  notes?: string | null;
}

export interface Expense {
  id: string;
  name: string;
  category_id?: string;
  category_name?: string;
  amount: number;
  monthly_amount: number;
  frequency: string;
  is_essential?: boolean;
  is_active?: boolean;
  notes?: string | null;
}

export interface PaycheckBreakdown {
  gross: number;
  federal_income_tax: number;
  social_security: number;
  medicare: number;
  additional_medicare: number;
  state_income_tax: number;
  total_pretax_deductions: number;
  net_pay: number;
  total_taxes: number;
  total_fica: number;
}

// Projection types
export interface MonteCarloResult {
  success_rate: number;
  median_end_value: number;
  percentile_10: number;
  percentile_90: number;
  chart_data: {
    years: number[];
    median: number[];
    p10: number[];
    p90: number[];
    p25: number[];
    p75: number[];
  };
}

export interface FireCalculation {
  fire_number: number;
  years_to_fire: number | null;
  current_savings_rate: number;
  monthly_expenses: number;
  safe_withdrawal_amount: number;
}

// Session types
export interface SessionInitResponse {
  hmac_key: string | null;
  signing_required: boolean;
}

// Settings types
export interface SettingsResponse {
  demo_mode: boolean;
  ai_model?: string;
  age?: number;
  retirement_age?: number;
  filing_status?: string;
  state?: string;
}

// Profile types
export interface Profile {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon?: string;
  is_active: boolean;
  created_at?: string;
  last_accessed?: string;
}

// Entity types (for multi-person household tracking)
export interface Entity {
  id: string;
  name: string;
  entity_type: 'individual' | 'household' | 'trust' | 'llc';
  is_default: boolean;
  is_household: boolean;
  color: string;
  icon: string;
  account_count: number;
  income_count: number;
  expense_count: number;
}

// View types
export interface PortfolioView {
  id: string;
  name: string;
  account_ids: string | string[];
  created_at?: string;
  is_default?: boolean;
}

// Trigger types
export interface Trigger {
  id: string;
  name: string;
  trigger_type: 'price_above' | 'price_below' | 'allocation_above' | 'allocation_below';
  ticker?: string | null;
  target_value: number;
  is_active: boolean;
  last_triggered?: string | null;
  notes?: string | null;
}

// Task types (for async operations)
export interface TaskStatus {
  task_id: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  result?: unknown;
  error?: string;
  progress?: number;
  progress_message?: string;
}

// Generic API response wrapper
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

// Plugin types
export interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  plugin_type: 'importer' | 'analyzer' | 'widget' | 'provider' | 'exporter';
  enabled: boolean;
  has_settings: boolean;
  requires_approval: boolean;
  approved: boolean;
  source_url?: string | null;
  author?: string | null;
}

// Budget types - Deduction
export interface Deduction {
  id: string;
  label?: string;
  name?: string;
  deduction_type: string;
  amount_per_period: number;
  employer_match?: number;
  is_percentage?: boolean;
  is_active?: boolean;
  notes?: string | null;
}

// AI Provider types
export interface AIProvider {
  id: string;
  name?: string;
  display_name?: string;
  models: AIModel[];
  is_available?: boolean;
  requires_api_key?: boolean;
  api_key_configured?: boolean;
}

export interface AIModel {
  id: string;
  name?: string;
  display_name?: string;
  description?: string;
  is_default?: boolean;
  context_length?: number;
  capabilities?: string[];
}

// Duplicate position detection
export interface DuplicateGroup {
  ticker: string;
  positions: DashboardPosition[];
  total_shares: number;
  total_value: number;
}

// Import data types
export interface ImportParseResult {
  filename: string;
  account_type?: string;
  positions: ImportPosition[];
  errors: string[];
  warnings: string[];
}

export interface ImportPosition {
  ticker: string;
  name?: string;
  shares: number;
  price?: number;
  cost_basis?: number;
  selected: boolean;
}

// Commentary cache types
export interface CommentaryEntry {
  content: string;
  timestamp: number;
  isStatic: boolean;
}

// Retirement metrics
export interface RetirementMetrics {
  retirement_age: number | null;
  years_to_retirement: number | null;
  fire_number: number | null;
  coast_number: number | null;
  current_age: number | null;
  target_retirement_age: number | null;
  current_savings_rate: number | null;
  safe_withdrawal_amount: number | null;
  social_security_estimate: number | null;
}

// Price status
export interface PriceStatus {
  last_updated: string | null;
  stale_count: number;
  total_count: number;
}

// Expense ratio drag (Cost & Tax Efficiency card on Analysis page)
export interface ExpenseDragHolding {
  ticker: string;
  position_value: number;
  expense_ratio: number;
  annual_drag_dollars: number;
}

export interface ExpenseDragResponse {
  portfolio_expense_ratio: number; // decimal, e.g. 0.0032 = 0.32%
  benchmark_expense_ratio: number; // decimal, e.g. 0.0004 = 0.04%
  annual_drag_dollars: number;
  annual_drag_basis_points: number;
  covered_value: number;
  uncovered_value: number;
  top_drag_holdings: ExpenseDragHolding[];
}

// Position correlation (heatmap on Analysis page)
export interface CorrelationEntry {
  ticker1: string;
  ticker2: string;
  correlation: number;
}

export interface CorrelationResponse {
  tickers: string[];
  matrix: number[][];
  high_correlations: CorrelationEntry[];
  low_correlations: CorrelationEntry[];
}

// Bank Statement import types
export interface RecurringCandidateResponse {
  id: string;
  import_id: string;
  name: string;
  amount: number;
  frequency: string;
  occurrences: number;
  status: 'pending' | 'accepted' | 'rejected';
  created_expense_id: string | null;
}

export interface BankStatementImportResponse {
  id: string;
  file_name: string;
  row_count: number;
  status: string;
  error_message: string | null;
  uploaded_at: string;
  analyzed_at: string | null;
  candidates: RecurringCandidateResponse[];
}

export interface BankStatementBatchResponse {
  files_imported: number;
  files_skipped: number;
  total_rows: number;
  candidates: RecurringCandidateResponse[];
}

// Liabilities (src/api/liabilities.py). Dates are 'YYYY-MM-DD' strings.
export type LiabilityType =
  'mortgage' | 'auto_loan' | 'student_loan' | 'credit_card' | 'personal_loan' | 'heloc' | 'other';

export type LiabilityFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

export type LiabilityPropertyInstruction =
  | { mode: 'link'; position_id: string }
  | {
      mode: 'create';
      name: string;
      value: number;
      cost_basis?: number | null;
      purchase_date?: string | null;
    };

export type LiabilityCashFlowInstruction =
  | { mode: 'create'; category_id?: string | null }
  | { mode: 'link'; expense_id: string }
  | { mode: 'none' };

export interface LiabilityFields {
  name: string;
  liability_type: LiabilityType;
  lender?: string | null;
  interest_rate?: number | null;
  payment_amount?: number | null;
  payment_frequency?: LiabilityFrequency;
  next_payment_date?: string | null;
  escrow_amount?: number | null;
  original_principal?: number | null;
  origination_date?: string | null;
  term_months?: number | null;
  maturity_date?: string | null;
  credit_limit?: number | null;
  is_amortizing?: boolean | null;
  entity_id?: string | null;
  linked_position_id?: string | null;
  notes?: string | null;
}

export interface CreateLiabilityInput extends LiabilityFields {
  current_balance: number;
  balance_as_of?: string | null;
  source?: 'manual' | 'wizard';
  property?: LiabilityPropertyInstruction | null;
  cash_flow?: LiabilityCashFlowInstruction | null;
}

/** Partial update. Balance changes go through RecordBalanceInput. */
export type UpdateLiabilityInput = Partial<LiabilityFields> & {
  expense_id?: string | null;
  is_active?: boolean;
};

export interface RecordBalanceInput {
  balance: number;
  as_of?: string | null;
}

export interface LiabilityResponse {
  id: string;
  entity_id: string | null;
  name: string;
  liability_type: LiabilityType;
  lender: string | null;
  current_balance: number;
  balance_as_of: string;
  interest_rate: number | null;
  payment_amount: number | null;
  payment_frequency: string;
  next_payment_date: string | null;
  escrow_amount: number | null;
  original_principal: number | null;
  origination_date: string | null;
  term_months: number | null;
  maturity_date: string | null;
  credit_limit: number | null;
  is_amortizing: boolean;
  linked_position_id: string | null;
  expense_id: string | null;
  source: string;
  source_ref: string | null;
  is_active: boolean;
  closed_date: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  estimated_balance: number;
  payoff_date: string | null;
  periods_remaining: number | null;
  total_interest_remaining: number | null;
  monthly_payment: number;
  monthly_cash_flow: number;
  linked_position: { id: string; name: string | null; value: number | null } | null;
  linked_position_missing: boolean;
  expense: { id: string; name: string; monthly_amount: number | null } | null;
  expense_missing: boolean;
  last_reported_date: string | null;
}

export interface LiabilityHistoryPoint {
  date: string;
  balance: number;
  source: string | null;
}

export interface LiabilityHistoryResponse {
  liability_id: string;
  reported: LiabilityHistoryPoint[];
  series: LiabilityHistoryPoint[];
}

export interface DeleteLiabilityResult {
  deleted: boolean;
  id: string;
  expense_deleted: boolean;
}

/**
 * POST /api/liabilities/convert-position (design section 8). The mortgage's
 * type, source and linked position are set by the conversion.
 * - property_value: the position is untouched; the mortgage links to it.
 * - equity: home_value is required; the position's current_price becomes
 *   home_value / (shares * contract_multiplier), nothing else changes.
 * - loan: the position is deleted; mortgage.current_balance defaults to the
 *   absolute position value; add_home optionally creates a home to link.
 */
export interface ConvertPositionInput {
  position_id: string;
  mode: 'property_value' | 'equity' | 'loan';
  /** Equity mode only, and required there. */
  home_value?: number | null;
  /** Loan mode only. */
  add_home?: {
    name: string;
    value: number;
    cost_basis?: number | null;
    purchase_date?: string | null;
  } | null;
  mortgage: {
    name?: string;
    lender?: string | null;
    /** Required except in loan mode. */
    current_balance?: number | null;
    balance_as_of?: string | null;
    interest_rate?: number | null;
    payment_amount?: number | null;
    payment_frequency?: LiabilityFrequency;
    next_payment_date?: string | null;
    escrow_amount?: number | null;
    original_principal?: number | null;
    origination_date?: string | null;
    term_months?: number | null;
    maturity_date?: string | null;
    entity_id?: string | null;
    notes?: string | null;
  };
  cash_flow?: LiabilityCashFlowInstruction | null;
}

export interface ConvertPositionResult {
  liability: LiabilityResponse;
  /** The converted position after the change; null in loan mode (it was deleted). */
  position: { id: string; name: string | null; value: number | null } | null;
  /** Rows the conversion created (a reused property account is not listed). */
  created: { account_id: string | null; position_id: string | null; expense_id: string | null };
}

/** POST /api/liabilities/{id}/revert-conversion */
export interface RevertConversionResult {
  reverted: boolean;
}

// Smart import (src/api/smart_import.py). Dates are 'YYYY-MM-DD'; datetimes are
// ISO text without a timezone.
export interface SmartImportSettings {
  retention_months: 0 | 12 | 24 | 36;
  ai_enabled: boolean;
  pdf_ai_enabled: boolean;
  /** CSV layout signature (sha256 hex) -> { field: header name }. */
  csv_layouts: Record<string, Record<string, string>>;
  /** 'acct:...' or 'label:...' -> label. */
  accounts: Record<string, string>;
}

export type SmartImportSettingsUpdate = Partial<SmartImportSettings>;

export interface SmartImportContext {
  rules: { id: string; merchant_key: string; category_id: string | null; kind: string | null }[];
  categories: { id: string; name: string }[];
  accounts: {
    account_key: string;
    label: string | null;
    last4: string | null;
    kind: string;
    institution: string | null;
    liability_id: string | null;
  }[];
  csv_layouts: SmartImportSettings['csv_layouts'];
  settings: SmartImportSettings;
}

export type SmartImportAccountKind = 'checking' | 'savings' | 'credit_card' | 'loan' | 'unknown';

export interface PreviewStatement {
  file_hash: string;
  account_key?: string | null;
  account_kind: SmartImportAccountKind;
  institution?: string | null;
  dedupe_keys: string[];
  merchant_keys: string[];
}

export interface PreviewRequest {
  statements: PreviewStatement[];
}

export interface PreviewResponse {
  existing_dedupe_keys: string[];
  prior_files: { file_hash: string; import_id: string; imported_at: string | null }[];
  liability_suggestions: {
    file_hash: string;
    account_key: string | null;
    liability_id: string;
    reason: 'previous_import' | 'lender_match';
  }[];
  history: { merchant_key: string; posted_date: string; amount: number }[];
}

export interface SmartImportSummary {
  import_id: string;
  batch_id: string;
  file_name: string;
  origin: string;
  format: string;
  parser: string;
  account_kind: string;
  account_key: string | null;
  account_label: string | null;
  account_last4: string | null;
  institution: string | null;
  period_start: string | null;
  period_end: string | null;
  closing_balance: number | null;
  closing_balance_date: string | null;
  liability_id: string | null;
  txn_new: number;
  txn_duplicate: number;
  txn_excluded: number;
  ai_used: number;
  ai_provider: string | null;
  imported_at: string | null;
}

export interface MerchantRuleResponse {
  id: string;
  merchant_key: string;
  category_id: string | null;
  category_name: string | null;
  category_deleted: boolean;
  kind: string | null;
  hits: number;
  source: string;
  updated_at: string | null;
}

export interface SmartImportDeleted {
  deleted: true;
}

export interface SmartImportTransactionsDeleted {
  deleted: number;
}

export type SmartImportTxnKind =
  'expense' | 'income' | 'transfer' | 'payment' | 'refund' | 'fee' | 'interest';

export type SmartImportFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

/** One reviewed transaction of POST /api/smart-import/apply (server ApplyTransaction). */
export interface ApplyTxn {
  posted_date: string;
  amount: number;
  description: string;
  merchant_key: string;
  kind: SmartImportTxnKind;
  category_id?: string | null;
  category_source: 'user' | 'rule' | 'seed' | 'ai' | 'none';
  ai_confidence?: number | null;
  external_id?: string | null;
  dedupe_key: string;
  excluded?: boolean;
}

/** One statement of an apply batch (server ApplyStatement). */
export interface ApplyStatement {
  file_hash: string;
  file_name: string;
  origin: 'file' | 'sample' | 'connector';
  format: 'csv' | 'ofx' | 'pdf' | 'connector';
  parser: string;
  account: {
    kind: SmartImportAccountKind;
    key: string;
    label?: string | null;
    last4?: string | null;
    institution?: string | null;
  };
  period?: { start?: string | null; end?: string | null } | null;
  closing_balance?: { amount: number; as_of: string } | null;
  liability_id?: string | null;
  ai_used?: boolean;
  ai_provider?: string | null;
  transactions: ApplyTxn[];
}

/** A remembered merchant choice (server ApplyRule). */
export interface ApplyRule {
  merchant_key: string;
  category_id?: string | null;
  kind?: SmartImportTxnKind | null;
  source?: 'user' | 'import' | 'ai' | 'connector';
}

/** A recurring candidate decision (server ApplyRecurring); expense_id only with 'link'. */
export interface ApplyRecurring {
  merchant_key: string;
  name: string;
  amount: number;
  frequency: SmartImportFrequency;
  category_id: string;
  occurrences: number;
  file_hash: string;
  decision: 'create' | 'link' | 'reject';
  expense_id?: string | null;
}

/** Body of POST /api/smart-import/apply (server ApplyRequest). */
export interface ApplyRequest {
  batch_id: string;
  entity_id?: string | null;
  statements: ApplyStatement[];
  rules?: ApplyRule[];
  recurring?: ApplyRecurring[];
}

export interface ApplyResponse {
  imports: {
    import_id: string;
    file_hash: string;
    txn_new: number;
    txn_duplicate: number;
    txn_excluded: number;
    balance: 'recorded' | 'skipped_existing' | 'skipped_future' | 'none';
  }[];
  skipped_files: string[];
  rules_saved: number;
  expenses_created: number;
  expenses_linked: number;
  pruned: number;
}

export interface SmartImportUndoResponse {
  undone: true;
  deleted: {
    transactions: number;
    recurring_candidates: number;
    expenses: number;
    snapshots: number;
  };
  reassigned: { transactions: number };
  kept: { table: string; id: string; reason: string }[];
}

export interface SpendingSummary {
  months_covered: number;
  months: string[];
  categories: {
    category_id: string | null;
    category_name: string;
    actual_monthly: number;
    planned_monthly: number;
    difference: number;
  }[];
  totals: { actual_monthly: number; planned_monthly: number; difference: number };
}
