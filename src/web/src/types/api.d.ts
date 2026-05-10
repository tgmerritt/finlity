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

export type PositionType = 'equity' | 'fund' | 'cash' | 'cd' | 'bond' | 'treasury' | 'real_estate';

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
}

export interface SnapshotHistory {
  date: string;
  total: number;
  retirement: number;
  taxable: number;
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
  portfolio_expense_ratio: number;     // decimal, e.g. 0.0032 = 0.32%
  benchmark_expense_ratio: number;     // decimal, e.g. 0.0004 = 0.04%
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