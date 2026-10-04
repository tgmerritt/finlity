/**
 * Local API layer - mirrors server endpoints using client-side SQLite.
 *
 * This allows the app to work entirely offline with a local database. Method
 * response shapes are ported 1:1 from the server handlers (see CLAUDE.md /
 * WS2 plan) so a later wiring layer can swap between the HTTP API client and
 * this LocalAPI transparently. Source-of-truth server files:
 * src/api/portfolio.py, src/api/budget.py, src/api/entities.py,
 * src/api/settings.py, src/api/bank_statements.py, src/api/analysis.py
 * (trigger CRUD), src/api/imports.py (price-status),
 * src/database/operations.py, src/database/seed_loader.py,
 * src/budget/state_taxes.py.
 */

import type { ClientDatabase } from './client-database';
import * as liabilities from './local-liabilities';
import type {
  ConvertPositionInput,
  ConvertPositionResult,
  CreateLiabilityInput,
  DashboardLiabilities,
  DeleteLiabilityResult,
  LiabilityHistoryResponse,
  LiabilityResponse,
  RecordBalanceInput,
  RevertConversionResult,
  UpdateLiabilityInput,
} from '@/types/api';

// =====================================================================
// Shared helpers
// =====================================================================

function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function boolToInt(value: boolean | undefined): number {
  return value ? 1 : 0;
}

/** Account types that count as retirement accounts by inference (matches Account.is_retirement in models.py). */
const RETIREMENT_ACCOUNT_TYPES = new Set([
  'traditional_401k',
  'roth_401k',
  'traditional_ira',
  'roth_ira',
  'hsa',
  'pension',
]);

/** Predefined account types (matches src/models/account_types.py PREDEFINED_ACCOUNT_TYPES). */
const PREDEFINED_ACCOUNT_TYPES: Record<
  string,
  { label: string; is_retirement: boolean; description: string; has_beneficiary?: boolean }
> = {
  traditional_401k: {
    label: 'Traditional 401(k)',
    is_retirement: true,
    description: 'Employer-sponsored pre-tax retirement account',
  },
  roth_401k: {
    label: 'Roth 401(k)',
    is_retirement: true,
    description: 'Employer-sponsored after-tax retirement account',
  },
  traditional_ira: {
    label: 'Traditional IRA',
    is_retirement: true,
    description: 'Individual pre-tax retirement account',
  },
  roth_ira: {
    label: 'Roth IRA',
    is_retirement: true,
    description: 'Individual after-tax retirement account',
  },
  pension: { label: 'Pension', is_retirement: true, description: 'Defined benefit pension plan' },
  hsa: {
    label: 'Health Savings Account',
    is_retirement: true,
    description: 'Tax-advantaged medical savings account',
  },
  taxable: {
    label: 'Taxable Brokerage',
    is_retirement: false,
    description: 'Regular taxable investment account',
  },
  '529': {
    label: '529 College Savings',
    is_retirement: false,
    has_beneficiary: true,
    description: 'Tax-advantaged education savings account',
  },
  hysa: {
    label: 'High-Yield Savings',
    is_retirement: false,
    description: 'High-yield savings account',
  },
  checking: {
    label: 'Checking Account',
    is_retirement: false,
    description: 'Bank checking account',
  },
  savings: { label: 'Savings Account', is_retirement: false, description: 'Bank savings account' },
  treasury_direct: {
    label: 'Treasury Direct',
    is_retirement: false,
    description: 'Government bonds (I-bonds, T-bills, etc.)',
  },
  property: {
    label: 'Property',
    is_retirement: false,
    description: 'Real Estate including land and buildings',
  },
  misc: {
    label: 'Miscellaneous',
    is_retirement: false,
    description: 'Other assets with a cost basis & present value (artwork, memorabilia, etc.)',
  },
};

function getDisplayType(accountType: string, customTypeName: string | null): string {
  if (accountType.startsWith('custom:')) {
    return customTypeName || accountType.slice(7);
  }
  return PREDEFINED_ACCOUNT_TYPES[accountType]?.label ?? accountType;
}

/** Pay frequency -> periods per year (matches src/budget/tax_calculator.py PAY_FREQUENCIES). */
const PAY_FREQUENCIES: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
};

/** Expense frequency -> annual multiplier (matches src/api/budget.py). */
const EXPENSE_FREQUENCY_MULTIPLIERS: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  annual: 1,
  one_time: 0,
};

/** Full US state list with tax type (matches src/budget/state_taxes.py get_all_states). */
const ALL_STATES: Array<{ code: string; name: string; type: 'graduated' | 'flat' | 'none' }> = [
  { code: 'AL', name: 'Alabama', type: 'graduated' },
  { code: 'AK', name: 'Alaska', type: 'none' },
  { code: 'AZ', name: 'Arizona', type: 'flat' },
  { code: 'AR', name: 'Arkansas', type: 'graduated' },
  { code: 'CA', name: 'California', type: 'graduated' },
  { code: 'CO', name: 'Colorado', type: 'flat' },
  { code: 'CT', name: 'Connecticut', type: 'graduated' },
  { code: 'DE', name: 'Delaware', type: 'graduated' },
  { code: 'DC', name: 'District of Columbia', type: 'graduated' },
  { code: 'FL', name: 'Florida', type: 'none' },
  { code: 'GA', name: 'Georgia', type: 'graduated' },
  { code: 'HI', name: 'Hawaii', type: 'graduated' },
  { code: 'ID', name: 'Idaho', type: 'flat' },
  { code: 'IL', name: 'Illinois', type: 'flat' },
  { code: 'IN', name: 'Indiana', type: 'flat' },
  { code: 'IA', name: 'Iowa', type: 'graduated' },
  { code: 'KS', name: 'Kansas', type: 'graduated' },
  { code: 'KY', name: 'Kentucky', type: 'flat' },
  { code: 'LA', name: 'Louisiana', type: 'graduated' },
  { code: 'ME', name: 'Maine', type: 'graduated' },
  { code: 'MD', name: 'Maryland', type: 'graduated' },
  { code: 'MA', name: 'Massachusetts', type: 'flat' },
  { code: 'MI', name: 'Michigan', type: 'flat' },
  { code: 'MN', name: 'Minnesota', type: 'graduated' },
  { code: 'MS', name: 'Mississippi', type: 'graduated' },
  { code: 'MO', name: 'Missouri', type: 'graduated' },
  { code: 'MT', name: 'Montana', type: 'graduated' },
  { code: 'NE', name: 'Nebraska', type: 'graduated' },
  { code: 'NV', name: 'Nevada', type: 'none' },
  { code: 'NH', name: 'New Hampshire', type: 'none' },
  { code: 'NJ', name: 'New Jersey', type: 'graduated' },
  { code: 'NM', name: 'New Mexico', type: 'graduated' },
  { code: 'NY', name: 'New York', type: 'graduated' },
  { code: 'NC', name: 'North Carolina', type: 'flat' },
  { code: 'ND', name: 'North Dakota', type: 'graduated' },
  { code: 'OH', name: 'Ohio', type: 'graduated' },
  { code: 'OK', name: 'Oklahoma', type: 'graduated' },
  { code: 'OR', name: 'Oregon', type: 'graduated' },
  { code: 'PA', name: 'Pennsylvania', type: 'flat' },
  { code: 'RI', name: 'Rhode Island', type: 'graduated' },
  { code: 'SC', name: 'South Carolina', type: 'graduated' },
  { code: 'SD', name: 'South Dakota', type: 'none' },
  { code: 'TN', name: 'Tennessee', type: 'none' },
  { code: 'TX', name: 'Texas', type: 'none' },
  { code: 'UT', name: 'Utah', type: 'flat' },
  { code: 'VT', name: 'Vermont', type: 'graduated' },
  { code: 'VA', name: 'Virginia', type: 'graduated' },
  { code: 'WA', name: 'Washington', type: 'none' },
  { code: 'WV', name: 'West Virginia', type: 'graduated' },
  { code: 'WI', name: 'Wisconsin', type: 'graduated' },
  { code: 'WY', name: 'Wyoming', type: 'none' },
];

// =====================================================================
// Row types (raw shapes as read from SQLite)
// =====================================================================

interface EntityRow {
  id: string;
  name: string;
  entity_type: string;
  is_default: number;
  is_household: number;
  color: string;
  icon: string;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  entity_id: string | null;
  name: string;
  account_type: string;
  brokerage: string | null;
  beneficiary: string | null;
  custom_type_name: string | null;
  is_retirement_account: number;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  id: string;
  account_id: string;
  ticker: string;
  name: string | null;
  shares: number;
  cost_basis: number | null;
  current_price: number | null;
  sector: string | null;
  is_fund: number;
  asset_class: string | null;
  position_type: string | null;
  maturity_date: string | null;
  interest_rate: number | null;
  purchase_date: string | null;
  last_import_id: string | null;
  updated_at: string;
  option_underlying: string | null;
  option_expiration: string | null;
  option_strike: number | null;
  option_type: string | null;
  contract_multiplier: number | null;
}

interface PortfolioSnapshotRow {
  id: string;
  snapshot_date: string;
  total_value: number | null;
  retirement_value: number | null;
  taxable_value: number | null;
  positions_json: string | null;
  created_at: string;
}

export interface PriceCacheRow {
  ticker: string;
  current_price: number | null;
  previous_close: number | null;
  year_high: number | null;
  year_low: number | null;
  last_updated: string | null;
}

interface AppSettingRow {
  key: string;
  value: string | null;
  encrypted: number;
  updated_at: string;
}

interface AllocationTriggerRow {
  id: string;
  name: string;
  condition_type: string;
  ticker: string | null;
  account_type: string | null;
  sector: string | null;
  operator: string;
  threshold: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface PortfolioViewRow {
  id: string;
  name: string;
  account_ids: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface BudgetIncomeSourceRow {
  id: string;
  entity_id: string | null;
  name: string;
  income_type: string;
  gross_annual: number;
  pay_frequency: string;
  state: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface BudgetTaxConfigRow {
  id: string;
  entity_id: string | null;
  tax_year: number;
  filing_status: string;
  state: string | null;
  ss_benefit_override: number | null;
  additional_withholding: number | null;
  itemized_deduction: number | null;
  ss_claiming_age: number | null;
  created_at: string;
  updated_at: string;
}

interface BudgetExpenseCategoryRow {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  created_at: string;
}

interface BudgetExpenseRow {
  id: string;
  entity_id: string | null;
  category_id: string;
  name: string;
  amount: number;
  frequency: string;
  is_pretax: number;
  is_mortgage: number;
  principal_portion: number | null;
  interest_portion: number | null;
  is_active: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
}

interface BudgetPretaxDeductionRow {
  id: string;
  income_source_id: string | null;
  label: string | null;
  deduction_type: string;
  amount_per_period: number;
  employer_match: number | null;
  is_percentage: number;
  max_annual: number | null;
  created_at: string;
  updated_at: string;
}

interface BankStatementImportRow {
  id: string;
  entity_id: string | null;
  file_name: string;
  content_hash: string;
  row_count: number;
  status: string;
  error_message: string | null;
  uploaded_at: string;
  analyzed_at: string | null;
}

interface RecurringCandidateRow {
  id: string;
  import_id: string;
  name: string;
  amount: number;
  frequency: string;
  occurrences: number;
  status: string;
  created_expense_id: string | null;
  created_at: string;
}

// =====================================================================
// Public response / input types
// =====================================================================

// ---- Portfolio ----

export interface AccountTypeResponse {
  value: string;
  label: string;
  is_retirement: boolean;
  description: string | null;
  has_beneficiary: boolean;
}

export interface AccountResponse {
  id: string;
  name: string;
  account_type: string;
  display_type: string;
  brokerage: string;
  value: number;
  cost_basis: number | null;
  position_count: number;
  beneficiary: string | null;
  is_retirement: boolean;
  entity_id: string | null;
}

export interface CreateAccountInput {
  name: string;
  account_type: string;
  brokerage?: string;
  beneficiary?: string | null;
  custom_type_name?: string | null;
  is_retirement?: boolean | null;
  entity_id?: string | null;
}

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
  accrued_value: number | null;
  gain_loss: number | null;
  gain_loss_pct: number | null;
  sector: string | null;
  is_fund: boolean;
  asset_class: string;
  position_type: string;
  maturity_date: string | null;
  purchase_date: string | null;
  interest_rate: number | null;
  option_underlying: string | null;
  option_expiration: string | null;
  option_strike: number | null;
  option_type: string | null;
  contract_multiplier: number | null;
  contracts: number | null;
  premium: number | null;
}

export interface CreatePositionInput {
  account_id: string;
  ticker: string;
  shares: number;
  name?: string | null;
  current_price?: number | null;
  cost_basis?: number | null;
  is_fund?: boolean;
  position_type?: string;
  asset_class?: string;
}

export interface CreateCashPositionInput {
  account_id: string;
  amount: number;
  name?: string;
  interest_rate?: number | null;
}

export interface CreateCDPositionInput {
  account_id: string;
  amount: number;
  name: string;
  interest_rate: number;
  maturity_date: string;
  purchase_date?: string | null;
}

export interface CreateRealEstatePositionInput {
  account_id: string;
  name: string;
  current_value: number;
  cost_basis: number;
  purchase_date?: string | null;
}

export interface UpdatePositionInput {
  shares?: number;
  current_price?: number;
  cost_basis?: number;
  name?: string;
  interest_rate?: number;
  purchase_date?: string;
  maturity_date?: string;
}

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

export interface DuplicatePositionGroup {
  ticker: string;
  shares: number;
  positions: Array<{
    id: string;
    account_id: string;
    account_name: string;
    name: string | null;
    value: number;
  }>;
  reason: string;
}

export interface DuplicatesResponse {
  duplicates: DuplicatePositionGroup[];
  count: number;
  has_duplicates: boolean;
}

export interface SnapshotResponse {
  id: string;
  snapshot_date: string;
  total_value: number | null;
  retirement_value: number | null;
  taxable_value: number | null;
}

export interface HistoryPoint {
  date: string;
  total: number | null;
  retirement: number | null;
  taxable: number | null;
}

// ---- Budget ----

export interface IncomeSourceResponse {
  id: string;
  name: string;
  income_type: string;
  gross_annual: number;
  pay_frequency: string;
  state: string;
  is_active: boolean;
  gross_per_period: number;
}

export interface CreateIncomeSourceInput {
  name: string;
  income_type?: string;
  gross_annual: number;
  pay_frequency?: string;
  state?: string;
  is_active?: boolean;
  entity_id?: string | null;
}

export interface UpdateIncomeSourceInput {
  name?: string;
  income_type?: string;
  gross_annual?: number;
  pay_frequency?: string;
  state?: string;
  is_active?: boolean;
}

export interface ExpenseResponse {
  id: string;
  category_id: string;
  category_name: string;
  name: string;
  amount: number;
  frequency: string;
  is_pretax: boolean;
  is_mortgage: boolean;
  principal_portion: number | null;
  interest_portion: number | null;
  is_active: boolean;
  annual_amount: number;
  monthly_amount: number;
}

export interface CreateExpenseInput {
  category_id: string;
  name: string;
  amount: number;
  frequency?: string;
  is_pretax?: boolean;
  is_mortgage?: boolean;
  principal_portion?: number | null;
  interest_portion?: number | null;
  is_active?: boolean;
  entity_id?: string | null;
}

export interface UpdateExpenseInput {
  category_id?: string;
  name?: string;
  amount?: number;
  frequency?: string;
  is_pretax?: boolean;
  is_mortgage?: boolean;
  principal_portion?: number | null;
  interest_portion?: number | null;
  is_active?: boolean;
}

export interface DeductionResponse {
  id: string;
  income_source_id: string | null;
  income_source_name: string | null;
  pay_frequency: string;
  periods_per_year: number;
  label: string | null;
  deduction_type: string;
  amount_per_period: number;
  employer_match: number;
  is_percentage: boolean;
  max_annual: number | null;
  annual_amount: number;
  employer_annual: number;
}

export interface CreateDeductionInput {
  income_source_id?: string | null;
  label?: string | null;
  deduction_type?: string;
  amount_per_period: number;
  employer_match?: number;
  is_percentage?: boolean;
  max_annual?: number | null;
}

export interface UpdateDeductionInput {
  income_source_id?: string | null;
  label?: string | null;
  deduction_type?: string;
  amount_per_period?: number;
  employer_match?: number;
  is_percentage?: boolean;
  max_annual?: number | null;
}

export interface TaxConfigResponse {
  id: string | null;
  tax_year: number;
  filing_status: string;
  state: string;
  ss_benefit_override: number | null;
  additional_withholding: number;
  itemized_deduction: number | null;
  use_standard_deduction: boolean;
  ss_claiming_age: number;
}

export interface UpdateTaxConfigInput {
  tax_year?: number;
  filing_status?: string;
  state?: string;
  ss_benefit_override?: number | null;
  additional_withholding?: number;
  itemized_deduction?: number | null;
  ss_claiming_age?: number;
}

export interface ExpenseCategoryResponse {
  id: string;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
}

export interface StateInfo {
  code: string;
  name: string;
  type: 'graduated' | 'flat' | 'none';
}

// ---- Entities ----

export interface EntityResponse {
  id: string;
  name: string;
  entity_type: string;
  is_default: boolean;
  is_household: boolean;
  color: string;
  icon: string;
  account_count: number;
  income_count: number;
  expense_count: number;
}

export interface CreateEntityInput {
  name: string;
  entity_type?: string;
  is_default?: boolean;
  color?: string | null;
  icon?: string | null;
}

export interface UpdateEntityInput {
  name?: string;
  entity_type?: string;
  is_default?: boolean;
  color?: string | null;
  icon?: string | null;
}

export interface EntitySummaryResponse {
  entity_id: string;
  entity_name: string;
  total_value: number;
  total_cost: number;
  total_gain_loss: number;
  retirement_value: number;
  taxable_value: number;
  accounts: Array<{
    id: string;
    name: string;
    type: string;
    display_type: string;
    value: number;
    is_retirement: boolean;
  }>;
}

export interface AutoDetectResponse {
  success: boolean;
  entities_created: string[];
  entities_created_count: number;
  accounts_assigned: number;
  income_sources_assigned: number;
  household_entity_id: string;
  detected_names: string[];
  failed_assignments: string[];
  warnings: string | null;
}

// ---- Triggers ----

export interface TriggerResponse {
  id: string;
  name: string;
  condition_type: string;
  operator: string;
  threshold: number;
  ticker: string | null;
  account_type: string | null;
  sector: string | null;
  is_active: boolean;
}

export interface CreateTriggerInput {
  name: string;
  condition_type: string;
  operator: string;
  threshold: number;
  ticker?: string | null;
  account_type?: string | null;
  sector?: string | null;
}

// ---- Portfolio views ----

export interface ViewResponse {
  id: string;
  name: string;
  account_ids: string[];
  is_default: boolean;
}

export interface CreateViewInput {
  name: string;
  account_ids: string[];
  is_default?: boolean;
}

export interface UpdateViewInput {
  name?: string;
  account_ids?: string[];
  is_default?: boolean;
}

// ---- Bank statements ----

export interface RecurringCandidateResponse {
  id: string;
  import_id: string;
  name: string;
  amount: number;
  frequency: string;
  occurrences: number;
  status: string;
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

export interface RecordStatementImportInput {
  file_name: string;
  content_hash: string;
  row_count: number;
  entity_id?: string | null;
  candidates: Array<{ name: string; amount: number; frequency?: string; occurrences?: number }>;
}

export interface RecordStatementImportResult {
  import_id: string;
  already_imported: boolean;
  candidates: RecurringCandidateResponse[];
}

export interface AcceptCandidateInput {
  category_id?: string | null;
  frequency?: string | null;
  amount?: number | null;
}

export interface AcceptCandidateResult {
  status: 'accepted';
  expense_id: string;
  candidate_id: string;
  deduped: boolean;
}

// ---- Prices & snapshots ----

export interface PriceStatusResponse {
  total_tickers: number;
  cached_tickers: number;
  fresh_tickers: number;
  stale_tickers: number;
  oldest_update: string | null;
  newest_update: string | null;
  all_fresh: boolean;
  user_timezone: string;
}

export interface ImportPositionsInput {
  account_id: string;
  positions: Array<{
    ticker: string;
    shares: number;
    name?: string | null;
    cost_basis?: number | null;
    current_price?: number | null;
    sector?: string | null;
    is_fund?: boolean;
    asset_class?: string;
    position_type?: string;
  }>;
  replace_existing?: boolean;
}

// =====================================================================
// Local API
// =====================================================================

/**
 * Local API layer using client-side SQLite. Mirrors the server's REST
 * response shapes exactly so a dispatcher can swap between the HTTP client
 * and this class transparently.
 */
export class LocalAPI {
  constructor(private db: ClientDatabase) {}

  // ===================================================================
  // Portfolio: account types
  // ===================================================================

  /** GET /api/portfolio/account-types */
  getAccountTypes(): AccountTypeResponse[] {
    return Object.entries(PREDEFINED_ACCOUNT_TYPES).map(([value, info]) => ({
      value,
      label: info.label,
      is_retirement: info.is_retirement,
      description: info.description,
      has_beneficiary: info.has_beneficiary ?? false,
    }));
  }

  // ===================================================================
  // Portfolio: accounts
  // ===================================================================

  private isAccountRetirement(row: AccountRow): boolean {
    if (toBool(row.is_retirement_account)) return true;
    return RETIREMENT_ACCOUNT_TYPES.has(row.account_type);
  }

  private accountValueAndCost(accountId: string): {
    value: number;
    cost: number;
    positionCount: number;
  } {
    const positions = this.db.query<PositionRow>('SELECT * FROM positions WHERE account_id = ?', [
      accountId,
    ]);
    let value = 0;
    let cost = 0;
    for (const pos of positions) {
      value += this.marketValue(pos);
      if (pos.cost_basis) cost += pos.cost_basis;
    }
    return { value, cost, positionCount: positions.length };
  }

  private toAccountResponse(row: AccountRow): AccountResponse {
    const { value, cost, positionCount } = this.accountValueAndCost(row.id);
    return {
      id: row.id,
      name: row.name,
      account_type: row.account_type,
      display_type: getDisplayType(row.account_type, row.custom_type_name),
      brokerage: row.brokerage ?? 'other',
      value,
      cost_basis: cost > 0 ? cost : null,
      position_count: positionCount,
      beneficiary: row.beneficiary,
      is_retirement: this.isAccountRetirement(row),
      entity_id: row.entity_id,
    };
  }

  /** GET /api/portfolio/accounts */
  getAccounts(): AccountResponse[] {
    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts ORDER BY name');
    return accounts.map((acc) => this.toAccountResponse(acc));
  }

  /** POST /api/portfolio/accounts */
  createAccount(data: CreateAccountInput): {
    id: string;
    name: string;
    account_type: string;
    display_type: string;
    brokerage: string;
    beneficiary: string | null;
    is_retirement: boolean;
  } {
    const id = uuid();
    let customTypeName = data.custom_type_name ?? null;
    if (data.account_type.startsWith('custom:') && !customTypeName) {
      customTypeName = data.account_type.slice(7);
    }
    const isRetirement =
      data.is_retirement !== undefined && data.is_retirement !== null
        ? data.is_retirement
        : RETIREMENT_ACCOUNT_TYPES.has(data.account_type);

    this.db.execute(
      `INSERT INTO accounts (id, entity_id, name, account_type, brokerage, beneficiary, custom_type_name, is_retirement_account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.entity_id ?? null,
        data.name,
        data.account_type,
        data.brokerage ?? 'other',
        data.beneficiary ?? null,
        customTypeName,
        boolToInt(isRetirement),
      ]
    );

    return {
      id,
      name: data.name,
      account_type: data.account_type,
      display_type: getDisplayType(data.account_type, customTypeName),
      brokerage: data.brokerage ?? 'other',
      beneficiary: data.beneficiary ?? null,
      is_retirement: isRetirement,
    };
  }

  /** DELETE /api/portfolio/accounts/{id} */
  deleteAccount(accountId: string): { message: string } {
    this.db.execute('DELETE FROM positions WHERE account_id = ?', [accountId]);
    this.db.execute('DELETE FROM accounts WHERE id = ?', [accountId]);
    return { message: 'Account deleted' };
  }

  // ===================================================================
  // Portfolio: positions
  // ===================================================================

  /**
   * Market value matching Position.market_value in models.py:
   * shares * current_price * (contract_multiplier || 1).
   */
  private marketValue(pos: PositionRow): number {
    if (pos.current_price && pos.shares) {
      const multiplier = pos.contract_multiplier || 1;
      return pos.shares * pos.current_price * multiplier;
    }
    return 0;
  }

  /**
   * Accrued value for CD/bond/APY-cash positions, matching
   * operations.py calculate_accrued_value: simple interest based on
   * purchase_date age. Falls back to marketValue() for everything else
   * (including options, which already apply the contract multiplier).
   */
  private accruedValue(pos: PositionRow): number {
    if (!pos.current_price) return 0;
    if (pos.interest_rate && pos.interest_rate > 0) {
      const principal = pos.current_price;
      const apy = pos.interest_rate;
      if (pos.purchase_date) {
        const daysHeld =
          (Date.now() - new Date(pos.purchase_date).getTime()) / (1000 * 60 * 60 * 24);
        const yearsHeld = daysHeld / 365.0;
        return principal * (1 + apy * yearsHeld);
      }
      return principal;
    }
    return this.marketValue(pos);
  }

  /** Effective displayed value: accrued value when interest-bearing, else plain market value. */
  private effectiveValue(pos: PositionRow): number {
    if (pos.interest_rate && pos.interest_rate > 0) {
      return this.accruedValue(pos);
    }
    return this.marketValue(pos);
  }

  private toPositionResponse(pos: PositionRow, accountName: string): PositionResponse {
    const marketValue = this.effectiveValue(pos);
    const accrued = pos.interest_rate ? this.accruedValue(pos) : null;

    let gainLoss: number | null = null;
    let gainLossPct: number | null = null;
    if (pos.cost_basis && marketValue) {
      gainLoss = marketValue - pos.cost_basis;
      if (pos.cost_basis > 0) {
        gainLossPct = (gainLoss / pos.cost_basis) * 100;
      }
    }

    const posType = pos.position_type || 'equity';
    const isOption = posType === 'option';

    return {
      id: pos.id,
      account_id: pos.account_id,
      account_name: accountName,
      ticker: pos.ticker,
      name: pos.name,
      shares: pos.shares,
      current_price: pos.current_price,
      cost_basis: pos.cost_basis,
      market_value: marketValue,
      accrued_value: accrued,
      gain_loss: gainLoss,
      gain_loss_pct: gainLossPct,
      sector: pos.sector,
      is_fund: toBool(pos.is_fund),
      asset_class: pos.asset_class ?? 'equity',
      position_type: posType,
      maturity_date: pos.maturity_date,
      purchase_date: pos.purchase_date,
      interest_rate: pos.interest_rate,
      option_underlying: isOption ? pos.option_underlying : null,
      option_expiration: isOption ? pos.option_expiration : null,
      option_strike: isOption ? pos.option_strike : null,
      option_type: isOption ? pos.option_type : null,
      contract_multiplier: isOption ? pos.contract_multiplier : null,
      contracts: isOption ? pos.shares : null,
      premium: isOption ? pos.current_price : null,
    };
  }

  /** GET /api/portfolio/positions */
  getPositions(accountId?: string | null): PositionResponse[] {
    let sql =
      'SELECT p.*, a.name as account_name FROM positions p JOIN accounts a ON p.account_id = a.id';
    const params: unknown[] = [];
    if (accountId) {
      sql += ' WHERE p.account_id = ?';
      params.push(accountId);
    }
    sql += ' ORDER BY a.name, p.ticker';

    const rows = this.db.query<PositionRow & { account_name: string }>(sql, params);
    return rows.map((row) => this.toPositionResponse(row, row.account_name));
  }

  /** POST /api/portfolio/positions */
  createPosition(data: CreatePositionInput): {
    id: string;
    ticker: string;
    shares: number;
    position_type: string;
    message: string;
  } {
    const id = uuid();
    const ticker = data.ticker.toUpperCase();
    this.db.execute(
      `INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, is_fund, asset_class, position_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.account_id,
        ticker,
        data.name ?? null,
        data.shares,
        data.cost_basis ?? null,
        data.current_price ?? null,
        boolToInt(data.is_fund),
        data.asset_class ?? 'equity',
        data.position_type ?? 'equity',
      ]
    );
    return {
      id,
      ticker,
      shares: data.shares,
      position_type: data.position_type ?? 'equity',
      message: `Position added: ${data.shares} shares of ${ticker}`,
    };
  }

  /** POST /api/portfolio/positions/cash */
  createCashPosition(data: CreateCashPositionInput): {
    id: string;
    amount: number;
    interest_rate: number | null;
    message: string;
  } {
    const id = uuid();
    const name = data.name ?? 'Cash';
    const interestRate = data.interest_rate ?? null;
    this.db.execute(
      `INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, is_fund, asset_class, position_type, interest_rate, purchase_date)
       VALUES (?, ?, 'CASH', ?, 1.0, ?, ?, 0, 'cash', 'cash', ?, ?)`,
      [
        id,
        data.account_id,
        name,
        data.amount,
        data.amount,
        interestRate,
        interestRate ? nowIso() : null,
      ]
    );
    const message = interestRate
      ? `Cash position added: $${data.amount} at ${interestRate * 100}% APY`
      : `Cash position added: $${data.amount}`;
    return { id, amount: data.amount, interest_rate: interestRate, message };
  }

  /** POST /api/portfolio/positions/cd */
  createCDPosition(data: CreateCDPositionInput): {
    id: string;
    amount: number;
    interest_rate: number;
    maturity_date: string;
    message: string;
  } {
    const id = uuid();
    const purchaseDate = data.purchase_date ?? nowIso();
    this.db.execute(
      `INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, is_fund, asset_class, position_type, maturity_date, interest_rate, purchase_date)
       VALUES (?, ?, 'CD', ?, 1.0, ?, ?, 0, 'fixed_income', 'cd', ?, ?, ?)`,
      [
        id,
        data.account_id,
        data.name,
        data.amount,
        data.amount,
        data.maturity_date,
        data.interest_rate,
        purchaseDate,
      ]
    );
    return {
      id,
      amount: data.amount,
      interest_rate: data.interest_rate,
      maturity_date: data.maturity_date,
      message: `CD position added: $${data.amount} at ${data.interest_rate * 100}% maturing ${data.maturity_date}`,
    };
  }

  /**
   * F10: today's calendar date as "YYYY-MM-DD" in the *local* timezone
   * (Date.toISOString() would give the UTC date, which is exactly the bug
   * being fixed here). Used to compare against stored maturity_date values
   * by date-string prefix rather than by parsing both sides into epoch ms.
   */
  private static todayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * F10: extract the "YYYY-MM-DD" calendar-date prefix from a maturity_date
   * value, which may be stored either as a bare date ("YYYY-MM-DD", from
   * createCDPosition) or a full ISO datetime (from a server-exported
   * profile - see src/api/portfolio.py's `maturity.isoformat()`).
   */
  private static dateOnly(value: string): string {
    return value.slice(0, 10);
  }

  /**
   * F10: number of calendar days from today to `maturity_date`, both
   * compared as local calendar dates (not epoch ms) to avoid the off-by-
   * one-day error `new Date("YYYY-MM-DD").getTime()` introduces in
   * negative UTC offsets (it parses the date string as UTC midnight, which
   * is already in the past from the perspective of a US timezone on the
   * same calendar day).
   */
  private static daysUntil(maturityDate: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [y, m, d] = LocalAPI.dateOnly(maturityDate).split('-').map(Number);
    const maturity = new Date(y!, m! - 1, d);
    return Math.round((maturity.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  }

  /**
   * GET /api/portfolio/positions/cd/upcoming
   *
   * F10: v1's get_upcoming_cd_maturities has a future-only lower bound
   * (`maturity_date > utcnow()`) that this lacked entirely - without it, a
   * CD that already matured yesterday would still show up in "upcoming"
   * maturities alongside ones genuinely in the future. Also fixed: compares
   * calendar-date strings (see dateOnly/daysUntil above) instead of epoch
   * ms, so "days until maturity" matches what the user sees on their
   * calendar regardless of timezone.
   *
   * NOTE: this is an intentional divergence from the server's naive-UTC
   * comparison, not an attempt to preserve exact parity with it - comparing
   * calendar dates is what a user actually expects from a maturity-date
   * display, and the server's UTC-midnight comparison is itself the source
   * of the "matured a day early" bug this fixes.
   */
  getUpcomingCDMaturities(days = 30): Array<{
    id: string;
    account_id: string;
    name: string | null;
    amount: number | null;
    interest_rate: number | null;
    maturity_date: string | null;
    days_until_maturity: number;
  }> {
    const rows = this.db.query<PositionRow>(
      "SELECT * FROM positions WHERE position_type = 'cd' AND maturity_date IS NOT NULL"
    );
    const todayStr = LocalAPI.todayDateString();
    return rows
      .filter((r) => {
        if (!r.maturity_date) return false;
        const maturityStr = LocalAPI.dateOnly(r.maturity_date);
        const daysUntil = LocalAPI.daysUntil(r.maturity_date);
        // Future-only lower bound (matches v1): strictly after today, and
        // within the requested window.
        return maturityStr > todayStr && daysUntil <= days;
      })
      .map((r) => ({
        id: r.id,
        account_id: r.account_id,
        name: r.name,
        amount: r.current_price,
        interest_rate: r.interest_rate,
        maturity_date: r.maturity_date,
        days_until_maturity: r.maturity_date ? LocalAPI.daysUntil(r.maturity_date) : 0,
      }));
  }

  /**
   * POST /api/portfolio/positions/cd/check-maturities
   *
   * F10: compares calendar-date strings instead of epoch ms (see
   * getUpcomingCDMaturities's docstring for why) - a CD matures once
   * today's local calendar date reaches its maturity date, not once UTC
   * midnight of that date has passed.
   */
  checkCDMaturities(): {
    matured_count: number;
    converted: Array<{ id: string; name: string | null; final_value: number }>;
    message: string;
  } {
    const rows = this.db.query<PositionRow>(
      "SELECT * FROM positions WHERE position_type = 'cd' AND maturity_date IS NOT NULL"
    );
    const todayStr = LocalAPI.todayDateString();
    const converted: Array<{ id: string; name: string | null; final_value: number }> = [];

    for (const row of rows) {
      if (row.maturity_date && LocalAPI.dateOnly(row.maturity_date) <= todayStr) {
        const finalValue = this.accruedValue(row);
        this.db.execute(
          `UPDATE positions SET ticker = 'CASH', position_type = 'cash', asset_class = 'cash', current_price = ?, cost_basis = ?, maturity_date = NULL, updated_at = ? WHERE id = ?`,
          [finalValue, finalValue, nowIso(), row.id]
        );
        converted.push({ id: row.id, name: row.name, final_value: finalValue });
      }
    }

    return {
      matured_count: converted.length,
      converted,
      message:
        converted.length > 0
          ? `${converted.length} CD(s) converted to cash`
          : 'No CDs have matured',
    };
  }

  /** POST /api/portfolio/positions/real-estate */
  createRealEstatePosition(data: CreateRealEstatePositionInput): {
    id: string;
    name: string;
    current_value: number;
    cost_basis: number;
    unrealized_gain: number;
    position_type: string;
  } {
    const id = uuid();
    this.db.execute(
      `INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, is_fund, asset_class, position_type, purchase_date)
       VALUES (?, ?, 'RE', ?, 1.0, ?, ?, 0, 'alternative', 'real_estate', ?)`,
      [
        id,
        data.account_id,
        data.name,
        data.cost_basis,
        data.current_value,
        data.purchase_date ?? null,
      ]
    );
    return {
      id,
      name: data.name,
      current_value: data.current_value,
      cost_basis: data.cost_basis,
      unrealized_gain: data.current_value - data.cost_basis,
      position_type: 'real_estate',
    };
  }

  /** PUT /api/portfolio/positions/{id} */
  updatePosition(
    positionId: string,
    data: UpdatePositionInput
  ): { message: string; position_id: string; updates: Record<string, unknown> } {
    const updates: string[] = [];
    const params: unknown[] = [];
    const echoedUpdates: Record<string, unknown> = {};

    const fieldMap: Array<[keyof UpdatePositionInput, string]> = [
      ['shares', 'shares'],
      ['current_price', 'current_price'],
      ['cost_basis', 'cost_basis'],
      ['name', 'name'],
      ['interest_rate', 'interest_rate'],
      ['purchase_date', 'purchase_date'],
      ['maturity_date', 'maturity_date'],
    ];

    for (const [inputKey, column] of fieldMap) {
      const value = data[inputKey];
      if (value !== undefined) {
        updates.push(`${column} = ?`);
        params.push(value);
        echoedUpdates[inputKey] = value;
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(positionId);
      this.db.execute(`UPDATE positions SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    return { message: 'Position updated', position_id: positionId, updates: echoedUpdates };
  }

  /** DELETE /api/portfolio/positions/{id} */
  deletePosition(positionId: string): { message: string } {
    this.db.execute('DELETE FROM positions WHERE id = ?', [positionId]);
    return { message: 'Position deleted' };
  }

  /**
   * Set the sector column for every position matching `ticker` (case-
   * insensitive). Mirrors the server's Database.update_positions_sector(),
   * which the v1 fund/analyze-portfolio and positions/update-sectors
   * handlers both use to apply sector metadata to every position sharing a
   * ticker, not just one - see src/api/analysis.py. Used by the local-mode
   * composites for those two endpoints (see dispatcher.ts), which apply
   * sector metadata returned by the stateless v2 fund/analyze and
   * positions/sectors endpoints to the local positions table. Not exposed
   * through updatePosition()'s generic field map since sector is only ever
   * written by these server-derived composites, never directly by the user.
   * Returns the number of rows updated.
   */
  setSectorForTicker(ticker: string, sector: string | null): number {
    const result = this.db.execute(
      'UPDATE positions SET sector = ?, updated_at = ? WHERE UPPER(ticker) = UPPER(?)',
      [sector, nowIso(), ticker]
    );
    return result.changes;
  }

  /**
   * Tickers eligible for sector enrichment: unique, uppercased tickers
   * across all positions that are missing a sector and aren't one of the
   * non-tradeable synthetic ticker forms used for CDs/bonds/T-bills/
   * I-bonds/cash/real-estate. Mirrors v1's update_position_sectors
   * candidate-selection filter exactly (src/api/analysis.py) so local mode
   * skips the same non-tradeable positions the server does.
   */
  getTickersMissingSector(): string[] {
    const nonTradeablePrefixes = ['CD-', 'BOND-', 'TBILL-', 'IBOND-'];
    const nonTradeableTickers = new Set(['CASH', 'CD', 'MONEY', 'RE']);
    const tickers = new Set<string>();
    for (const p of this.getPositions()) {
      if (!p.ticker || p.sector) continue;
      const ticker = p.ticker.toUpperCase();
      if (nonTradeablePrefixes.some((prefix) => ticker.startsWith(prefix))) continue;
      if (nonTradeableTickers.has(ticker)) continue;
      tickers.add(ticker);
    }
    return Array.from(tickers);
  }

  /** Unique, uppercased tickers across all is_fund=1 positions. */
  getFundTickers(): string[] {
    return Array.from(
      new Set(
        this.getPositions()
          .filter((p) => p.is_fund && p.ticker)
          .map((p) => p.ticker.toUpperCase())
      )
    );
  }

  // ===================================================================
  // Portfolio: summary, duplicates, export
  // ===================================================================

  /** GET /api/portfolio */
  getPortfolio(): PortfolioSummary {
    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts');
    const accountResponses = accounts.map((a) => this.toAccountResponse(a));

    let totalValue = 0;
    let totalCost = 0;
    let retirementValue = 0;
    let taxableValue = 0;
    let positionCount = 0;

    for (const acc of accountResponses) {
      totalValue += acc.value;
      totalCost += acc.cost_basis ?? 0;
      if (acc.is_retirement) {
        retirementValue += acc.value;
      } else {
        taxableValue += acc.value;
      }
      positionCount += acc.position_count;
    }

    return {
      total_value: totalValue,
      total_cost_basis: totalCost > 0 ? totalCost : null,
      total_gain_loss: totalCost > 0 ? totalValue - totalCost : null,
      retirement_value: retirementValue,
      taxable_value: taxableValue,
      account_count: accounts.length,
      position_count: positionCount,
      accounts: accountResponses,
    };
  }

  /**
   * F13: persist a locally-run Monte Carlo simulation result so the
   * dashboard-metrics composite (see dispatcher.ts) can report real numbers
   * instead of always claiming `simulation_required: true`. Called from
   * client.ts after a successful /api/v2/projections/monte-carlo response
   * in local mode. Only columns available from the request params +
   * response are populated; anything the current v2 response shape doesn't
   * return (e.g. earliest_retirement_age) is left NULL rather than guessed.
   */
  saveMonteCarloResult(data: {
    current_age: number;
    retirement_age: number;
    portfolio_balance: number;
    monthly_contribution?: number;
    monthly_withdrawal?: number;
    success_rate: number;
    median_final_value?: number | null;
    worst_case_final?: number | null;
    best_case_final?: number | null;
    entity_id?: string | null;
  }): { id: string } {
    const id = uuid();
    this.db.execute(
      `INSERT INTO monte_carlo_results
         (id, entity_id, current_age, retirement_age, portfolio_balance, monthly_contribution,
          monthly_withdrawal, success_rate, median_final_value, worst_case_final, best_case_final)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.entity_id ?? null,
        data.current_age,
        data.retirement_age,
        data.portfolio_balance,
        data.monthly_contribution ?? 0,
        data.monthly_withdrawal ?? 0,
        data.success_rate,
        data.median_final_value ?? null,
        data.worst_case_final ?? null,
        data.best_case_final ?? null,
      ]
    );
    return { id };
  }

  /**
   * F13: the most recent locally-saved Monte Carlo result (by run_date),
   * for the dashboard-metrics composite to surface. Returns null if no
   * simulation has ever been run and saved locally.
   */
  getLatestMonteCarloResult(): {
    current_age: number;
    retirement_age: number;
    portfolio_balance: number;
    success_rate: number;
    median_final_value: number | null;
    worst_case_final: number | null;
    best_case_final: number | null;
    run_date: string;
  } | null {
    const rows = this.db.query<{
      current_age: number;
      retirement_age: number;
      portfolio_balance: number;
      success_rate: number;
      median_final_value: number | null;
      worst_case_final: number | null;
      best_case_final: number | null;
      run_date: string;
    }>('SELECT * FROM monte_carlo_results ORDER BY run_date DESC LIMIT 1');
    return rows[0] ?? null;
  }

  /**
   * GET /api/portfolio/duplicates - ports operations.py find_duplicate_positions:
   * group all positions by (ticker.upper(), round(shares, 6)); any group whose
   * members span 2+ distinct accounts is flagged. Real estate positions are skipped.
   */
  getDuplicates(): DuplicatesResponse {
    const positions = this.db.query<PositionRow>('SELECT * FROM positions');
    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts');
    const accountNames = new Map<string, string>(accounts.map((a) => [a.id, a.name]));

    const groups = new Map<string, PositionRow[]>();
    for (const pos of positions) {
      // A home is one whole unit (shares 1.0), so two of them are two properties.
      if (pos.position_type === 'real_estate') continue;
      const key = `${pos.ticker.toUpperCase()}::${Math.round(pos.shares * 1e6) / 1e6}`;
      const group = groups.get(key);
      if (group) {
        group.push(pos);
      } else {
        groups.set(key, [pos]);
      }
    }

    const duplicates: DuplicatePositionGroup[] = [];
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const uniqueAccounts = new Set(group.map((p) => p.account_id));
      if (uniqueAccounts.size < 2) continue;

      const [ticker, sharesStr] = key.split('::');
      const shares = Number(sharesStr);
      const names = group.map((p) => accountNames.get(p.account_id) ?? 'Unknown');

      duplicates.push({
        ticker: ticker ?? '',
        shares,
        positions: group.map((p) => ({
          id: p.id,
          account_id: p.account_id,
          account_name: accountNames.get(p.account_id) ?? 'Unknown',
          name: p.name,
          value: this.marketValue(p),
        })),
        reason: `Exact same quantity (${shares.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 })}) of ${ticker} found in ${uniqueAccounts.size} different accounts: ${names.join(', ')}`,
      });
    }

    return { duplicates, count: duplicates.length, has_duplicates: duplicates.length > 0 };
  }

  /** GET /api/portfolio/export/{dataType} - returns CSV text (accounts | positions | snapshots). */
  exportCsv(dataType: 'accounts' | 'positions' | 'snapshots'): string {
    const escape = (v: string | number | boolean | null | undefined): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const toRow = (values: Array<string | number | boolean | null | undefined>): string =>
      values.map(escape).join(',');

    if (dataType === 'accounts') {
      const header = [
        'id',
        'name',
        'account_type',
        'display_type',
        'brokerage',
        'beneficiary',
        'is_retirement',
        'created_at',
      ];
      const accounts = this.db.query<AccountRow>('SELECT * FROM accounts ORDER BY name');
      const lines = accounts.map((a) =>
        toRow([
          a.id,
          a.name,
          a.account_type,
          getDisplayType(a.account_type, a.custom_type_name),
          a.brokerage ?? 'other',
          a.beneficiary,
          toBool(a.is_retirement_account) || RETIREMENT_ACCOUNT_TYPES.has(a.account_type),
          a.created_at,
        ])
      );
      return [toRow(header), ...lines].join('\n');
    }

    if (dataType === 'positions') {
      const header = [
        'id',
        'account_id',
        'account_name',
        'ticker',
        'name',
        'shares',
        'current_price',
        'cost_basis',
        'market_value',
        'gain_loss',
        'is_fund',
        'asset_class',
        'position_type',
        'maturity_date',
        'interest_rate',
      ];
      const rows = this.db.query<PositionRow & { account_name: string }>(
        'SELECT p.*, a.name as account_name FROM positions p JOIN accounts a ON p.account_id = a.id ORDER BY a.name, p.ticker'
      );
      const lines = rows.map((p) => {
        const marketValue = this.effectiveValue(p);
        const gainLoss = p.cost_basis ? marketValue - p.cost_basis : null;
        return toRow([
          p.id,
          p.account_id,
          p.account_name,
          p.ticker,
          p.name,
          p.shares,
          p.current_price,
          p.cost_basis,
          marketValue,
          gainLoss,
          toBool(p.is_fund),
          p.asset_class,
          p.position_type,
          p.maturity_date,
          p.interest_rate,
        ]);
      });
      return [toRow(header), ...lines].join('\n');
    }

    // snapshots
    const header = [
      'id',
      'snapshot_date',
      'total_value',
      'retirement_value',
      'taxable_value',
      'created_at',
    ];
    const snapshots = this.db.query<PortfolioSnapshotRow>(
      'SELECT * FROM portfolio_snapshots ORDER BY snapshot_date DESC'
    );
    const lines = snapshots.map((s) =>
      toRow([
        s.id,
        s.snapshot_date,
        s.total_value,
        s.retirement_value,
        s.taxable_value,
        s.created_at,
      ])
    );
    return [toRow(header), ...lines].join('\n');
  }

  // ===================================================================
  // Snapshots, history & prices
  // ===================================================================

  /**
   * POST /api/portfolio/snapshot -> takeSnapshot(): ports operations.py
   * take_snapshot - upserts by today's date (UTC, midnight-truncated).
   */
  takeSnapshot(): { message: string; snapshot_date: string; total_value: number } {
    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts');
    const accountMap = new Map<string, AccountRow>(accounts.map((a) => [a.id, a]));
    const positions = this.db.query<PositionRow>('SELECT * FROM positions');

    let totalValue = 0;
    let retirementValue = 0;
    let taxableValue = 0;
    const positionsData: Array<Record<string, unknown>> = [];

    for (const pos of positions) {
      const account = accountMap.get(pos.account_id);
      const value = this.marketValue(pos);
      totalValue += value;

      const isRetirement = account ? this.isAccountRetirement(account) : false;
      if (isRetirement) {
        retirementValue += value;
      } else {
        taxableValue += value;
      }

      positionsData.push({
        account_id: pos.account_id,
        account_name: account?.name ?? null,
        account_type: account?.account_type ?? null,
        ticker: pos.ticker,
        name: pos.name,
        shares: pos.shares,
        price: pos.current_price,
        value,
        cost_basis: pos.cost_basis,
      });
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const existing = this.db.query<PortfolioSnapshotRow>(
      'SELECT id FROM portfolio_snapshots WHERE snapshot_date = ?',
      [todayIso]
    )[0];

    if (existing) {
      this.db.execute(
        'UPDATE portfolio_snapshots SET total_value = ?, retirement_value = ?, taxable_value = ?, positions_json = ? WHERE id = ?',
        [totalValue, retirementValue, taxableValue, JSON.stringify(positionsData), existing.id]
      );
    } else {
      this.db.execute(
        'INSERT INTO portfolio_snapshots (id, snapshot_date, total_value, retirement_value, taxable_value, positions_json) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), todayIso, totalValue, retirementValue, taxableValue, JSON.stringify(positionsData)]
      );
    }

    return { message: 'Snapshot created', snapshot_date: todayIso, total_value: totalValue };
  }

  /** GET /api/portfolio/snapshots */
  getSnapshots(limit = 365): SnapshotResponse[] {
    const rows = this.db.query<PortfolioSnapshotRow>(
      'SELECT * FROM portfolio_snapshots ORDER BY snapshot_date DESC LIMIT ?',
      [limit]
    );
    return rows.map((s) => ({
      id: s.id,
      snapshot_date: s.snapshot_date,
      total_value: s.total_value,
      retirement_value: s.retirement_value,
      taxable_value: s.taxable_value,
    }));
  }

  /**
   * Dashboard history chart data - mirrors src/main.py get_dashboard_data's
   * `history` field: ascending-date list of {date, total, retirement, taxable}
   * derived from the most recent 365 snapshots.
   */
  getHistory(limit = 365): HistoryPoint[] {
    const snapshots = this.getSnapshots(limit);
    return snapshots
      .slice()
      .reverse()
      .map((s) => ({
        date: s.snapshot_date,
        total: s.total_value,
        retirement: s.retirement_value,
        taxable: s.taxable_value,
      }));
  }

  /**
   * GET /api/imports/price-status equivalent. "Updatable" tickers exclude
   * cash/CD/real-estate position types (they don't track a market ticker
   * price), matching the server's scoping in operations.py.
   */
  getPriceStatus(maxAgeHours = 24, timezone = 'UTC'): PriceStatusResponse {
    const updatablePositions = this.db.query<{ ticker: string }>(
      "SELECT DISTINCT ticker FROM positions WHERE position_type NOT IN ('cash', 'cd', 'real_estate')"
    );
    const tickers = new Set(updatablePositions.map((p) => p.ticker.toUpperCase()));
    const priceCache = this.db.query<PriceCacheRow>('SELECT * FROM price_cache');
    const cacheMap = new Map<string, PriceCacheRow>(
      priceCache.map((p) => [p.ticker.toUpperCase(), p])
    );

    let freshCount = 0;
    let cachedCount = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    const now = Date.now();

    for (const ticker of tickers) {
      const cached = cacheMap.get(ticker);
      if (!cached || !cached.last_updated) continue;
      cachedCount++;
      const ageHours = (now - new Date(cached.last_updated).getTime()) / (1000 * 60 * 60);
      if (ageHours <= maxAgeHours) freshCount++;
      if (!oldest || cached.last_updated < oldest) oldest = cached.last_updated;
      if (!newest || cached.last_updated > newest) newest = cached.last_updated;
    }

    const totalTickers = tickers.size;
    const staleTickers = totalTickers - freshCount;

    return {
      total_tickers: totalTickers,
      cached_tickers: cachedCount,
      fresh_tickers: freshCount,
      stale_tickers: staleTickers,
      oldest_update: oldest,
      newest_update: newest,
      all_fresh: staleTickers === 0,
      user_timezone: timezone,
    };
  }

  /** All price_cache rows (current and previous close, 52-week range). */
  getPriceCacheRows(): PriceCacheRow[] {
    return this.db.query<PriceCacheRow>('SELECT * FROM price_cache');
  }

  /** Tickers whose price_cache entry is missing or older than maxAgeHours. */
  getStaleTickers(maxAgeHours = 24): string[] {
    const updatablePositions = this.db.query<{ ticker: string }>(
      "SELECT DISTINCT ticker FROM positions WHERE position_type NOT IN ('cash', 'cd', 'real_estate')"
    );
    const tickers = new Set(updatablePositions.map((p) => p.ticker.toUpperCase()));
    const priceCache = this.db.query<PriceCacheRow>('SELECT * FROM price_cache');
    const cacheMap = new Map<string, PriceCacheRow>(
      priceCache.map((p) => [p.ticker.toUpperCase(), p])
    );
    const now = Date.now();

    const stale: string[] = [];
    for (const ticker of tickers) {
      const cached = cacheMap.get(ticker);
      if (!cached || !cached.last_updated) {
        stale.push(ticker);
        continue;
      }
      const ageHours = (now - new Date(cached.last_updated).getTime()) / (1000 * 60 * 60);
      if (ageHours > maxAgeHours) stale.push(ticker);
    }
    return stale;
  }

  /** Update price_cache + positions.current_price for each ticker -> price pair. */
  applyPriceUpdates(
    prices: Array<{
      ticker: string;
      price: number;
      previous_close?: number | null;
      year_high?: number | null;
      year_low?: number | null;
    }>
  ): { updated: number } {
    for (const p of prices) {
      const ticker = p.ticker.toUpperCase();
      const now = nowIso();
      this.db.execute(
        `INSERT INTO price_cache (ticker, current_price, previous_close, year_high, year_low, last_updated)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticker) DO UPDATE SET current_price = excluded.current_price,
           previous_close = excluded.previous_close, year_high = excluded.year_high,
           year_low = excluded.year_low, last_updated = excluded.last_updated`,
        [ticker, p.price, p.previous_close ?? null, p.year_high ?? null, p.year_low ?? null, now]
      );
      this.db.execute('UPDATE positions SET current_price = ?, updated_at = ? WHERE ticker = ?', [
        p.price,
        now,
        ticker,
      ]);
    }
    return { updated: prices.length };
  }

  // ===================================================================
  // Positions import persist (client-side POST /api/import/positions)
  // ===================================================================

  /**
   * Ports db.upsert_position: match key is (account_id, ticker); on
   * conflict updates shares/name/cost_basis/current_price/sector/is_fund/
   * asset_class/position_type/updated_at (id/created_at/account_id/ticker
   * are preserved). Optionally clears existing positions for the account
   * first (replace_existing), matching the CSV import "replace" mode.
   */
  importPositions(data: ImportPositionsInput): { imported: number; account_id: string } {
    if (data.replace_existing) {
      this.db.execute('DELETE FROM positions WHERE account_id = ?', [data.account_id]);
    }

    for (const p of data.positions) {
      const ticker = p.ticker.toUpperCase();
      const existing = this.db.query<PositionRow>(
        'SELECT * FROM positions WHERE account_id = ? AND ticker = ?',
        [data.account_id, ticker]
      )[0];

      if (existing) {
        this.db.execute(
          `UPDATE positions SET shares = ?, name = COALESCE(?, name), cost_basis = COALESCE(?, cost_basis),
             current_price = COALESCE(?, current_price), sector = COALESCE(?, sector), is_fund = ?,
             asset_class = ?, position_type = ?, updated_at = ? WHERE id = ?`,
          [
            p.shares,
            p.name ?? null,
            p.cost_basis ?? null,
            p.current_price ?? null,
            p.sector ?? null,
            boolToInt(p.is_fund),
            p.asset_class ?? 'equity',
            p.position_type ?? 'equity',
            nowIso(),
            existing.id,
          ]
        );
      } else {
        this.db.execute(
          `INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, sector, is_fund, asset_class, position_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuid(),
            data.account_id,
            ticker,
            p.name ?? ticker,
            p.shares,
            p.cost_basis ?? null,
            p.current_price ?? null,
            p.sector ?? null,
            boolToInt(p.is_fund),
            p.asset_class ?? 'equity',
            p.position_type ?? 'equity',
          ]
        );
      }
    }

    return { imported: data.positions.length, account_id: data.account_id };
  }

  // ===================================================================
  // Budget: income sources
  // ===================================================================

  private toIncomeSourceResponse(row: BudgetIncomeSourceRow): IncomeSourceResponse {
    const periods = PAY_FREQUENCIES[row.pay_frequency] ?? 26;
    return {
      id: row.id,
      name: row.name,
      income_type: row.income_type,
      gross_annual: row.gross_annual,
      pay_frequency: row.pay_frequency,
      state: row.state ?? 'CA',
      is_active: toBool(row.is_active),
      gross_per_period: row.gross_annual / periods,
    };
  }

  /** GET /api/budget/income (active only, ordered by name) */
  getIncomeSources(): IncomeSourceResponse[] {
    const rows = this.db.query<BudgetIncomeSourceRow>(
      'SELECT * FROM budget_income_sources WHERE is_active = 1 ORDER BY name'
    );
    return rows.map((r) => this.toIncomeSourceResponse(r));
  }

  /** POST /api/budget/income */
  createIncomeSource(data: CreateIncomeSourceInput): {
    id: string;
    name: string;
    income_type: string;
    gross_annual: number;
    pay_frequency: string;
    state: string;
    is_active: boolean;
  } {
    const id = uuid();
    const incomeType = data.income_type ?? 'employment';
    const payFrequency = data.pay_frequency ?? 'biweekly';
    const state = data.state ?? 'CA';
    const isActive = data.is_active ?? true;
    this.db.execute(
      `INSERT INTO budget_income_sources (id, entity_id, name, income_type, gross_annual, pay_frequency, state, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.entity_id ?? null,
        data.name,
        incomeType,
        data.gross_annual,
        payFrequency,
        state,
        boolToInt(isActive),
      ]
    );
    return {
      id,
      name: data.name,
      income_type: incomeType,
      gross_annual: data.gross_annual,
      pay_frequency: payFrequency,
      state,
      is_active: isActive,
    };
  }

  /** PUT /api/budget/income/{id} */
  updateIncomeSource(id: string, data: UpdateIncomeSourceInput): { updated: boolean; id: string } {
    const updates: string[] = [];
    const params: unknown[] = [];
    const fieldMap: Array<[keyof UpdateIncomeSourceInput, string]> = [
      ['name', 'name'],
      ['income_type', 'income_type'],
      ['gross_annual', 'gross_annual'],
      ['pay_frequency', 'pay_frequency'],
      ['state', 'state'],
    ];
    for (const [key, column] of fieldMap) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(data[key]);
      }
    }
    if (data.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(boolToInt(data.is_active));
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      this.db.execute(
        `UPDATE budget_income_sources SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
    }
    return { updated: true, id };
  }

  /** DELETE /api/budget/income/{id} */
  deleteIncomeSource(id: string): { deleted: boolean; id: string } {
    this.db.execute('DELETE FROM budget_income_sources WHERE id = ?', [id]);
    return { deleted: true, id };
  }

  // ===================================================================
  // Budget: expense categories
  // ===================================================================

  /** GET /api/budget/expense-categories */
  getExpenseCategories(): ExpenseCategoryResponse[] {
    const rows = this.db.query<BudgetExpenseCategoryRow>(
      'SELECT * FROM budget_expense_categories ORDER BY sort_order'
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon ?? '',
      color: r.color ?? '#6b7280',
      sort_order: r.sort_order,
    }));
  }

  // ===================================================================
  // Budget: expenses
  // ===================================================================

  private toExpenseResponse(row: BudgetExpenseRow, categoryName: string): ExpenseResponse {
    const multiplier = EXPENSE_FREQUENCY_MULTIPLIERS[row.frequency] ?? 12;
    const annualAmount = row.frequency === 'one_time' ? row.amount : row.amount * multiplier;
    return {
      id: row.id,
      category_id: row.category_id,
      category_name: categoryName,
      name: row.name,
      amount: row.amount,
      frequency: row.frequency,
      is_pretax: toBool(row.is_pretax),
      is_mortgage: toBool(row.is_mortgage),
      principal_portion: row.principal_portion,
      interest_portion: row.interest_portion,
      is_active: toBool(row.is_active),
      annual_amount: annualAmount,
      monthly_amount: annualAmount / 12,
    };
  }

  /** GET /api/budget/expenses */
  getExpenses(): ExpenseResponse[] {
    const rows = this.db.query<BudgetExpenseRow & { category_name: string | null }>(
      `SELECT e.*, c.name as category_name FROM budget_expenses e
       LEFT JOIN budget_expense_categories c ON e.category_id = c.id`
    );
    return rows.map((r) => this.toExpenseResponse(r, r.category_name ?? 'Other'));
  }

  /** POST /api/budget/expenses */
  createExpense(data: CreateExpenseInput): {
    id: string;
    name: string;
    amount: number;
    frequency: string;
  } {
    const id = uuid();
    const frequency = data.frequency ?? 'monthly';
    this.db.execute(
      `INSERT INTO budget_expenses (id, entity_id, category_id, name, amount, frequency, is_pretax, is_mortgage, principal_portion, interest_portion, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.entity_id ?? null,
        data.category_id,
        data.name,
        data.amount,
        frequency,
        boolToInt(data.is_pretax),
        boolToInt(data.is_mortgage),
        data.principal_portion ?? null,
        data.interest_portion ?? null,
        boolToInt(data.is_active ?? true),
      ]
    );
    return { id, name: data.name, amount: data.amount, frequency };
  }

  // ===================================================================
  // Liabilities (see local-liabilities.ts)
  // ===================================================================

  /** Liabilities part of GET /api/dashboard/data (read only). */
  getDashboardLiabilities<H extends { date: string; total: number | null }>(
    filtered: boolean,
    history: H[],
    totalValue: number
  ): DashboardLiabilities<H> {
    return liabilities.dashboardLiabilities(this.db, filtered, history, totalValue);
  }

  /** GET /api/liabilities */
  getLiabilities(entityId?: string | null, includeArchived = false): LiabilityResponse[] {
    return liabilities.getLiabilities(this.db, entityId, includeArchived);
  }

  /** POST /api/liabilities */
  createLiability(input: CreateLiabilityInput): LiabilityResponse {
    return liabilities.createLiability(this.db, input);
  }

  /** GET /api/liabilities/{id} */
  getLiability(id: string): LiabilityResponse {
    return liabilities.getLiability(this.db, id);
  }

  /** PUT /api/liabilities/{id} */
  updateLiability(id: string, input: UpdateLiabilityInput, syncExpense = true): LiabilityResponse {
    return liabilities.updateLiability(this.db, id, input, syncExpense);
  }

  /** DELETE /api/liabilities/{id} */
  deleteLiability(id: string, deleteExpense = false): DeleteLiabilityResult {
    return liabilities.deleteLiability(this.db, id, deleteExpense);
  }

  /** GET /api/liabilities/{id}/history */
  getLiabilityHistory(id: string): LiabilityHistoryResponse {
    return liabilities.getLiabilityHistory(this.db, id);
  }

  /** POST /api/liabilities/{id}/balance */
  recordLiabilityBalance(id: string, input: RecordBalanceInput): LiabilityResponse {
    return liabilities.recordLiabilityBalance(this.db, id, input);
  }

  /** POST /api/liabilities/convert-position */
  convertPosition(input: ConvertPositionInput): ConvertPositionResult {
    return liabilities.convertPosition(this.db, input);
  }

  /** POST /api/liabilities/{id}/revert-conversion */
  revertConversion(id: string): RevertConversionResult {
    return liabilities.revertConversion(this.db, id);
  }

  /** PUT /api/budget/expenses/{id} */
  updateExpense(id: string, data: UpdateExpenseInput): { updated: boolean; id: string } {
    const updates: string[] = [];
    const params: unknown[] = [];
    const fieldMap: Array<[keyof UpdateExpenseInput, string]> = [
      ['category_id', 'category_id'],
      ['name', 'name'],
      ['amount', 'amount'],
      ['frequency', 'frequency'],
      ['principal_portion', 'principal_portion'],
      ['interest_portion', 'interest_portion'],
    ];
    for (const [key, column] of fieldMap) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(data[key]);
      }
    }
    if (data.is_pretax !== undefined) {
      updates.push('is_pretax = ?');
      params.push(boolToInt(data.is_pretax));
    }
    if (data.is_mortgage !== undefined) {
      updates.push('is_mortgage = ?');
      params.push(boolToInt(data.is_mortgage));
    }
    if (data.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(boolToInt(data.is_active));
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      this.db.execute(`UPDATE budget_expenses SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    return { updated: true, id };
  }

  /** DELETE /api/budget/expenses/{id} */
  deleteExpense(id: string): { deleted: boolean; id: string } {
    this.db.execute('DELETE FROM budget_expenses WHERE id = ?', [id]);
    return { deleted: true, id };
  }

  // ===================================================================
  // Budget: pretax deductions
  // ===================================================================

  private toDeductionResponse(
    row: BudgetPretaxDeductionRow,
    incomeSourceName: string | null,
    payFrequency: string
  ): DeductionResponse {
    const periodsPerYear = PAY_FREQUENCIES[payFrequency] ?? 26;
    const employerMatch = row.employer_match ?? 0;
    return {
      id: row.id,
      income_source_id: row.income_source_id,
      income_source_name: incomeSourceName,
      pay_frequency: payFrequency,
      periods_per_year: periodsPerYear,
      label: row.label,
      deduction_type: row.deduction_type,
      amount_per_period: row.amount_per_period,
      employer_match: employerMatch,
      is_percentage: toBool(row.is_percentage),
      max_annual: row.max_annual,
      annual_amount: row.amount_per_period * periodsPerYear,
      employer_annual: employerMatch ? employerMatch * periodsPerYear : 0,
    };
  }

  /** GET /api/budget/deductions */
  getDeductions(): DeductionResponse[] {
    const rows = this.db.query<
      BudgetPretaxDeductionRow & { income_source_name: string | null; pay_frequency: string | null }
    >(
      `SELECT d.*, s.name as income_source_name, s.pay_frequency as pay_frequency
       FROM budget_pretax_deductions d
       LEFT JOIN budget_income_sources s ON d.income_source_id = s.id`
    );
    return rows.map((r) =>
      this.toDeductionResponse(r, r.income_source_name, r.pay_frequency ?? 'biweekly')
    );
  }

  /** POST /api/budget/deductions */
  createDeduction(data: CreateDeductionInput): {
    id: string;
    label: string | null;
    deduction_type: string;
    amount_per_period: number;
  } {
    const id = uuid();
    const deductionType = data.deduction_type ?? '401k';
    this.db.execute(
      `INSERT INTO budget_pretax_deductions (id, income_source_id, label, deduction_type, amount_per_period, employer_match, is_percentage, max_annual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.income_source_id ?? null,
        data.label ?? null,
        deductionType,
        data.amount_per_period,
        data.employer_match ?? 0,
        boolToInt(data.is_percentage),
        data.max_annual ?? null,
      ]
    );
    return {
      id,
      label: data.label ?? null,
      deduction_type: deductionType,
      amount_per_period: data.amount_per_period,
    };
  }

  /** PUT /api/budget/deductions/{id} */
  updateDeduction(id: string, data: UpdateDeductionInput): DeductionResponse {
    const updates: string[] = [];
    const params: unknown[] = [];
    const fieldMap: Array<[keyof UpdateDeductionInput, string]> = [
      ['income_source_id', 'income_source_id'],
      ['label', 'label'],
      ['deduction_type', 'deduction_type'],
      ['amount_per_period', 'amount_per_period'],
      ['employer_match', 'employer_match'],
      ['max_annual', 'max_annual'],
    ];
    for (const [key, column] of fieldMap) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(data[key]);
      }
    }
    if (data.is_percentage !== undefined) {
      updates.push('is_percentage = ?');
      params.push(boolToInt(data.is_percentage));
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      this.db.execute(
        `UPDATE budget_pretax_deductions SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
    }

    const row = this.db.query<
      BudgetPretaxDeductionRow & { income_source_name: string | null; pay_frequency: string | null }
    >(
      `SELECT d.*, s.name as income_source_name, s.pay_frequency as pay_frequency
       FROM budget_pretax_deductions d LEFT JOIN budget_income_sources s ON d.income_source_id = s.id
       WHERE d.id = ?`,
      [id]
    )[0];
    if (!row) {
      throw new Error(`Deduction ${id} not found after update`);
    }
    return this.toDeductionResponse(row, row.income_source_name, row.pay_frequency ?? 'biweekly');
  }

  /** DELETE /api/budget/deductions/{id} */
  deleteDeduction(id: string): { deleted: boolean; id: string } {
    this.db.execute('DELETE FROM budget_pretax_deductions WHERE id = ?', [id]);
    return { deleted: true, id };
  }

  // ===================================================================
  // Budget: tax config
  // ===================================================================

  /** GET /api/budget/tax-config (per entity; entityId undefined/null = household default) */
  getTaxConfig(entityId?: string | null): TaxConfigResponse {
    const rows = entityId
      ? this.db.query<BudgetTaxConfigRow>('SELECT * FROM budget_tax_config WHERE entity_id = ?', [
          entityId,
        ])
      : this.db.query<BudgetTaxConfigRow>(
          'SELECT * FROM budget_tax_config WHERE entity_id IS NULL'
        );
    const row = rows[0];

    if (!row) {
      return {
        id: null,
        tax_year: 2024,
        filing_status: 'single',
        state: 'CA',
        ss_benefit_override: null,
        additional_withholding: 0,
        itemized_deduction: null,
        use_standard_deduction: true,
        ss_claiming_age: 67,
      };
    }

    return {
      id: row.id,
      tax_year: row.tax_year,
      filing_status: row.filing_status,
      state: row.state ?? 'CA',
      ss_benefit_override: row.ss_benefit_override,
      additional_withholding: row.additional_withholding ?? 0,
      itemized_deduction: row.itemized_deduction,
      use_standard_deduction: row.itemized_deduction === null,
      ss_claiming_age: row.ss_claiming_age ?? 67,
    };
  }

  /** PUT /api/budget/tax-config */
  updateTaxConfig(data: UpdateTaxConfigInput, entityId?: string | null): { updated: boolean } {
    const rows = entityId
      ? this.db.query<BudgetTaxConfigRow>('SELECT * FROM budget_tax_config WHERE entity_id = ?', [
          entityId,
        ])
      : this.db.query<BudgetTaxConfigRow>(
          'SELECT * FROM budget_tax_config WHERE entity_id IS NULL'
        );
    const existing = rows[0];

    if (!existing) {
      this.db.execute(
        `INSERT INTO budget_tax_config (id, entity_id, tax_year, filing_status, state, ss_benefit_override, additional_withholding, itemized_deduction, ss_claiming_age)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
          entityId ?? null,
          data.tax_year ?? 2024,
          data.filing_status ?? 'single',
          data.state ?? 'CA',
          data.ss_benefit_override ?? null,
          data.additional_withholding ?? 0,
          data.itemized_deduction ?? null,
          data.ss_claiming_age ?? 67,
        ]
      );
      return { updated: true };
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    const fieldMap: Array<[keyof UpdateTaxConfigInput, string]> = [
      ['tax_year', 'tax_year'],
      ['filing_status', 'filing_status'],
      ['state', 'state'],
      ['ss_benefit_override', 'ss_benefit_override'],
      ['additional_withholding', 'additional_withholding'],
      ['itemized_deduction', 'itemized_deduction'],
      ['ss_claiming_age', 'ss_claiming_age'],
    ];
    for (const [key, column] of fieldMap) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(data[key]);
      }
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(existing.id);
      this.db.execute(`UPDATE budget_tax_config SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    return { updated: true };
  }

  /** GET /api/budget/states */
  getStates(): StateInfo[] {
    return ALL_STATES;
  }

  // ===================================================================
  // Entities
  // ===================================================================

  private toEntityResponse(row: EntityRow): EntityResponse {
    const accountCount =
      this.db.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM accounts WHERE entity_id = ?',
        [row.id]
      )[0]?.count ?? 0;
    const incomeCount =
      this.db.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM budget_income_sources WHERE entity_id = ?',
        [row.id]
      )[0]?.count ?? 0;
    const expenseCount =
      this.db.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM budget_expenses WHERE entity_id = ?',
        [row.id]
      )[0]?.count ?? 0;

    return {
      id: row.id,
      name: row.name,
      entity_type: row.entity_type,
      is_default: toBool(row.is_default),
      is_household: toBool(row.is_household),
      color: row.color ?? '#4A90D9',
      icon: row.icon ?? 'user',
      account_count: accountCount,
      income_count: incomeCount,
      expense_count: expenseCount,
    };
  }

  private validateEntityColor(color: string | null | undefined): void {
    if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      throw new Error('Invalid color format; expected #RRGGBB');
    }
  }

  /** GET /api/entities/ */
  getEntities(): EntityResponse[] {
    const rows = this.db.query<EntityRow>('SELECT * FROM entities ORDER BY name');
    return rows.map((r) => this.toEntityResponse(r));
  }

  /** GET /api/entities/{id} */
  getEntity(id: string): EntityResponse | null {
    const row = this.db.query<EntityRow>('SELECT * FROM entities WHERE id = ?', [id])[0];
    return row ? this.toEntityResponse(row) : null;
  }

  /** POST /api/entities/ */
  createEntity(data: CreateEntityInput): EntityResponse {
    if (!data.name || !data.name.trim()) {
      throw new Error('Entity name must not be empty');
    }
    this.validateEntityColor(data.color);
    const id = uuid();
    this.db.execute(
      `INSERT INTO entities (id, name, entity_type, is_default, is_household, color, icon)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        data.name,
        data.entity_type ?? 'individual',
        boolToInt(data.is_default),
        data.color ?? '#4A90D9',
        data.icon ?? 'user',
      ]
    );
    const row = this.db.query<EntityRow>('SELECT * FROM entities WHERE id = ?', [id])[0];
    if (!row) throw new Error('Failed to create entity');
    return this.toEntityResponse(row);
  }

  /** PUT /api/entities/{id} */
  updateEntity(id: string, data: UpdateEntityInput): EntityResponse | null {
    if (data.name !== undefined && !data.name.trim()) {
      throw new Error('Entity name must not be empty');
    }
    this.validateEntityColor(data.color);

    const updates: string[] = [];
    const params: unknown[] = [];
    const fieldMap: Array<[keyof UpdateEntityInput, string]> = [
      ['name', 'name'],
      ['entity_type', 'entity_type'],
      ['color', 'color'],
      ['icon', 'icon'],
    ];
    for (const [key, column] of fieldMap) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(data[key]);
      }
    }
    if (data.is_default !== undefined) {
      updates.push('is_default = ?');
      params.push(boolToInt(data.is_default));
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      this.db.execute(`UPDATE entities SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const row = this.db.query<EntityRow>('SELECT * FROM entities WHERE id = ?', [id])[0];
    return row ? this.toEntityResponse(row) : null;
  }

  /**
   * DELETE /api/entities/{id}
   *
   * F11: mirrors the server's Database.delete_entity() (src/database/
   * operations.py), which unassigns (sets entity_id to NULL on) accounts,
   * budget_income_sources, and budget_expenses before deleting the entity
   * row - those three tables are exactly the ones the server nulls;
   * budget_tax_config and monte_carlo_results are left alone (the server
   * doesn't touch them either). Without this, deleting an entity left
   * dangling entity_id references on those rows pointing at a
   * now-nonexistent entity.
   */
  deleteEntity(id: string): { success: boolean; message: string } {
    this.db.execute('UPDATE accounts SET entity_id = NULL WHERE entity_id = ?', [id]);
    this.db.execute('UPDATE budget_income_sources SET entity_id = NULL WHERE entity_id = ?', [id]);
    this.db.execute('UPDATE budget_expenses SET entity_id = NULL WHERE entity_id = ?', [id]);
    this.db.execute('DELETE FROM entities WHERE id = ?', [id]);
    return { success: true, message: 'Entity deleted' };
  }

  /** GET /api/entities/{id}/summary */
  getEntitySummary(entityId: string): EntitySummaryResponse {
    const entity = this.db.query<EntityRow>('SELECT * FROM entities WHERE id = ?', [entityId])[0];
    const accounts = entityId
      ? this.db.query<AccountRow>('SELECT * FROM accounts WHERE entity_id = ?', [entityId])
      : this.db.query<AccountRow>('SELECT * FROM accounts');

    let totalValue = 0;
    let totalCost = 0;
    let retirementValue = 0;
    let taxableValue = 0;
    const accountList: EntitySummaryResponse['accounts'] = [];

    for (const account of accounts) {
      const { value, cost } = this.accountValueAndCost(account.id);
      totalValue += value;
      totalCost += cost;
      const isRetirement = this.isAccountRetirement(account);
      if (isRetirement) {
        retirementValue += value;
      } else {
        taxableValue += value;
      }
      accountList.push({
        id: account.id,
        name: account.name,
        type: account.account_type,
        display_type: getDisplayType(account.account_type, account.custom_type_name),
        value,
        is_retirement: isRetirement,
      });
    }

    return {
      entity_id: entityId,
      entity_name: entity?.name ?? '',
      total_value: totalValue,
      total_cost: totalCost,
      total_gain_loss: totalCost > 0 ? totalValue - totalCost : 0,
      retirement_value: retirementValue,
      taxable_value: taxableValue,
      accounts: accountList,
    };
  }

  /**
   * POST /api/entities/auto-detect - ports entities.py's possessive-name
   * regex detection: ^(?:[A-Za-z]+\s+)?([A-Z][a-z]+)(?:'s?\s|\s) over
   * account + income source names, excluding a fixed word list, then
   * creates/reuses entities and assigns matching accounts/income sources.
   */
  autoDetectEntities(): AutoDetectResponse {
    const namePattern = /^(?:[A-Za-z]+\s+)?([A-Z][a-z]+)(?:'s?\s|\s)/;
    const excludedNames = new Set([
      'Roth',
      'Traditional',
      'Rollover',
      'Inherited',
      'Beneficiary',
      'Individual',
      'Joint',
      'Custodial',
      'Trust',
      'Estate',
      'Schwab',
      'Fidelity',
      'Vanguard',
      'Marcus',
      'Optum',
      'Human',
      'Principal',
      'Merrill',
      'Morgan',
      'Chase',
      'Wells',
      'Citi',
      'Ally',
      'Capital',
      'American',
      'United',
      'First',
      'National',
      'High',
      'Yield',
      'Savings',
      'Checking',
      'Money',
      'Market',
      'Health',
      'College',
      'Education',
      'Retirement',
      'Brokerage',
      'Taxable',
      'Investment',
      'Personal',
      'Business',
      'Corporate',
    ]);
    const colors = ['#4A90D9', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];

    // Ensure household entity exists (should already, from seedDefaults, but be defensive)
    let household = this.db.query<EntityRow>('SELECT * FROM entities WHERE is_household = 1')[0];
    if (!household) {
      const id = uuid();
      this.db.execute(
        `INSERT INTO entities (id, name, entity_type, is_default, is_household, color, icon) VALUES (?, 'Household', 'household', 0, 1, '#2ECC71', 'users')`,
        [id]
      );
      household = this.db.query<EntityRow>('SELECT * FROM entities WHERE id = ?', [id])[0]!;
    }

    const associations = new Map<string, string[]>(); // detected name -> ["account:<id>", "income:<id>", ...]
    const detectedNames = new Set<string>();

    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts');
    for (const account of accounts) {
      const match = namePattern.exec(account.name);
      const detected = match?.[1];
      if (!detected || excludedNames.has(detected)) continue;
      detectedNames.add(detected);
      const list = associations.get(detected) ?? [];
      list.push(`account:${account.id}`);
      associations.set(detected, list);
    }

    const incomeSources = this.db.query<BudgetIncomeSourceRow>(
      'SELECT * FROM budget_income_sources'
    );
    for (const income of incomeSources) {
      const match = namePattern.exec(income.name);
      const detected = match?.[1];
      if (!detected || excludedNames.has(detected)) continue;
      detectedNames.add(detected);
      const list = associations.get(detected) ?? [];
      list.push(`income:${income.id}`);
      associations.set(detected, list);
    }

    const entitiesCreated: string[] = [];
    const failedAssignments: string[] = [];
    let accountsAssigned = 0;
    let incomeSourcesAssigned = 0;

    const sortedNames = Array.from(detectedNames).sort();
    let colorIndex = 0;
    for (const name of sortedNames) {
      let entity = this.db.query<EntityRow>('SELECT * FROM entities WHERE LOWER(name) = LOWER(?)', [
        name,
      ])[0];
      if (!entity) {
        const id = uuid();
        const color = colors[colorIndex % colors.length];
        colorIndex++;
        this.db.execute(
          `INSERT INTO entities (id, name, entity_type, is_default, is_household, color, icon) VALUES (?, ?, 'individual', 0, 0, ?, 'user')`,
          [id, name, color]
        );
        entity = this.db.query<EntityRow>('SELECT * FROM entities WHERE id = ?', [id])[0]!;
        entitiesCreated.push(name);
      }

      for (const ref of associations.get(name) ?? []) {
        const [kind, refId] = ref.split(':');
        try {
          if (kind === 'account') {
            this.db.execute('UPDATE accounts SET entity_id = ?, updated_at = ? WHERE id = ?', [
              entity.id,
              nowIso(),
              refId,
            ]);
            accountsAssigned++;
          } else if (kind === 'income') {
            this.db.execute(
              'UPDATE budget_income_sources SET entity_id = ?, updated_at = ? WHERE id = ?',
              [entity.id, nowIso(), refId]
            );
            incomeSourcesAssigned++;
          }
        } catch {
          failedAssignments.push(ref);
        }
      }
    }

    return {
      success: true,
      entities_created: entitiesCreated,
      entities_created_count: entitiesCreated.length,
      accounts_assigned: accountsAssigned,
      income_sources_assigned: incomeSourcesAssigned,
      household_entity_id: household.id,
      detected_names: sortedNames,
      failed_assignments: failedAssignments,
      warnings: null,
    };
  }

  /** POST /api/entities/accounts/{id}/assign */
  assignAccountToEntity(
    accountId: string,
    entityId: string | null
  ): { success: boolean; account_id: string; entity_id: string | null } {
    this.db.execute('UPDATE accounts SET entity_id = ?, updated_at = ? WHERE id = ?', [
      entityId,
      nowIso(),
      accountId,
    ]);
    return { success: true, account_id: accountId, entity_id: entityId };
  }

  /** POST /api/entities/income/{id}/assign */
  assignIncomeToEntity(
    incomeId: string,
    entityId: string | null
  ): { success: boolean; income_id: string; entity_id: string | null } {
    this.db.execute('UPDATE budget_income_sources SET entity_id = ?, updated_at = ? WHERE id = ?', [
      entityId,
      nowIso(),
      incomeId,
    ]);
    return { success: true, income_id: incomeId, entity_id: entityId };
  }

  /** POST /api/entities/expenses/{id}/assign */
  assignExpenseToEntity(
    expenseId: string,
    entityId: string | null
  ): { success: boolean; expense_id: string; entity_id: string | null } {
    this.db.execute('UPDATE budget_expenses SET entity_id = ?, updated_at = ? WHERE id = ?', [
      entityId,
      nowIso(),
      expenseId,
    ]);
    return { success: true, expense_id: expenseId, entity_id: entityId };
  }

  // ===================================================================
  // Triggers (allocation_triggers CRUD only - evaluation is server-side)
  // ===================================================================

  private toTriggerResponse(row: AllocationTriggerRow): TriggerResponse {
    return {
      id: row.id,
      name: row.name,
      condition_type: row.condition_type,
      operator: row.operator,
      threshold: row.threshold,
      ticker: row.ticker,
      account_type: row.account_type,
      sector: row.sector,
      is_active: toBool(row.is_active),
    };
  }

  /** GET /api/analysis/triggers */
  getTriggers(activeOnly = false): TriggerResponse[] {
    const rows = activeOnly
      ? this.db.query<AllocationTriggerRow>(
          'SELECT * FROM allocation_triggers WHERE is_active = 1 ORDER BY name'
        )
      : this.db.query<AllocationTriggerRow>('SELECT * FROM allocation_triggers ORDER BY name');
    return rows.map((r) => this.toTriggerResponse(r));
  }

  /** POST /api/analysis/triggers */
  createTrigger(data: CreateTriggerInput): TriggerResponse {
    const id = uuid();
    this.db.execute(
      `INSERT INTO allocation_triggers (id, name, condition_type, ticker, account_type, sector, operator, threshold, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        data.name,
        data.condition_type,
        data.ticker ?? null,
        data.account_type ?? null,
        data.sector ?? null,
        data.operator,
        data.threshold,
      ]
    );
    const row = this.db.query<AllocationTriggerRow>(
      'SELECT * FROM allocation_triggers WHERE id = ?',
      [id]
    )[0];
    if (!row) throw new Error('Failed to create trigger');
    return this.toTriggerResponse(row);
  }

  /** DELETE /api/analysis/triggers/{id} */
  deleteTrigger(id: string): { message: string } {
    this.db.execute('DELETE FROM allocation_triggers WHERE id = ?', [id]);
    return { message: 'Trigger deleted' };
  }

  /** PUT /api/analysis/triggers/{id}/toggle */
  toggleTrigger(id: string): { id: string; is_active: boolean } {
    const row = this.db.query<AllocationTriggerRow>(
      'SELECT * FROM allocation_triggers WHERE id = ?',
      [id]
    )[0];
    const newValue = row ? !toBool(row.is_active) : true;
    this.db.execute('UPDATE allocation_triggers SET is_active = ?, updated_at = ? WHERE id = ?', [
      boolToInt(newValue),
      nowIso(),
      id,
    ]);
    return { id, is_active: newValue };
  }

  // ===================================================================
  // Portfolio views (settings.py)
  // ===================================================================

  private toViewResponse(row: PortfolioViewRow): ViewResponse {
    let accountIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.account_ids);
      accountIds = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      accountIds = [];
    }
    return {
      id: row.id,
      name: row.name,
      account_ids: accountIds,
      is_default: toBool(row.is_default),
    };
  }

  /** GET /api/settings/views */
  getViews(): ViewResponse[] {
    const rows = this.db.query<PortfolioViewRow>('SELECT * FROM portfolio_views ORDER BY name');
    return rows.map((r) => this.toViewResponse(r));
  }

  /** GET /api/settings/views/current */
  getCurrentView(): ViewResponse {
    let row = this.db.query<PortfolioViewRow>(
      'SELECT * FROM portfolio_views WHERE is_default = 1'
    )[0];
    if (!row) {
      row = this.db.query<PortfolioViewRow>(
        "SELECT * FROM portfolio_views WHERE name = 'All Accounts'"
      )[0];
    }
    if (!row) {
      const id = uuid();
      this.db.execute(
        `INSERT INTO portfolio_views (id, name, account_ids, is_default) VALUES (?, 'All Accounts', '[]', 1)`,
        [id]
      );
      row = this.db.query<PortfolioViewRow>('SELECT * FROM portfolio_views WHERE id = ?', [id])[0]!;
    }
    return this.toViewResponse(row);
  }

  /** POST /api/settings/views */
  createView(data: CreateViewInput): ViewResponse {
    const id = uuid();
    this.db.execute(
      `INSERT INTO portfolio_views (id, name, account_ids, is_default) VALUES (?, ?, ?, ?)`,
      [id, data.name, JSON.stringify(data.account_ids), boolToInt(data.is_default)]
    );
    const row = this.db.query<PortfolioViewRow>('SELECT * FROM portfolio_views WHERE id = ?', [
      id,
    ])[0];
    if (!row) throw new Error('Failed to create view');
    return this.toViewResponse(row);
  }

  /** PUT /api/settings/views/{id} */
  updateView(id: string, data: UpdateViewInput): ViewResponse | null {
    const updates: string[] = [];
    const params: unknown[] = [];
    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }
    if (data.account_ids !== undefined) {
      updates.push('account_ids = ?');
      params.push(JSON.stringify(data.account_ids));
    }
    if (data.is_default !== undefined) {
      updates.push('is_default = ?');
      params.push(boolToInt(data.is_default));
    }
    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      this.db.execute(`UPDATE portfolio_views SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    const row = this.db.query<PortfolioViewRow>('SELECT * FROM portfolio_views WHERE id = ?', [
      id,
    ])[0];
    return row ? this.toViewResponse(row) : null;
  }

  /** DELETE /api/settings/views/{id} */
  deleteView(id: string): { status: string; id: string } {
    const row = this.db.query<PortfolioViewRow>('SELECT * FROM portfolio_views WHERE id = ?', [
      id,
    ])[0];
    if (row && row.name === 'All Accounts') {
      throw new Error('Cannot delete the All Accounts view');
    }
    this.db.execute('DELETE FROM portfolio_views WHERE id = ?', [id]);
    return { status: 'deleted', id };
  }

  /** PUT /api/settings/views/{id}/set-default */
  setDefaultView(id: string): { status: string; id: string; name: string } {
    this.db.execute('UPDATE portfolio_views SET is_default = 0');
    this.db.execute('UPDATE portfolio_views SET is_default = 1, updated_at = ? WHERE id = ?', [
      nowIso(),
      id,
    ]);
    const row = this.db.query<PortfolioViewRow>('SELECT * FROM portfolio_views WHERE id = ?', [
      id,
    ])[0];
    return { status: 'updated', id, name: row?.name ?? '' };
  }

  // ===================================================================
  // Settings / config (app_settings, section-keyed)
  // ===================================================================

  /** Maps a config section name to its app_settings storage key (matches settings.py). */
  private static readonly CONFIG_SECTION_KEYS: Record<string, string> = {
    personal: 'personal_settings',
    targets: 'target_allocations',
    market: 'market_assumptions',
    monte_carlo: 'monte_carlo_settings',
    withdrawal: 'withdrawal_settings',
  };

  private readConfigSection<T = Record<string, unknown>>(storageKey: string): T | null {
    const row = this.db.query<AppSettingRow>('SELECT value FROM app_settings WHERE key = ?', [
      storageKey,
    ])[0];
    if (!row || row.value === null) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private writeConfigSection(storageKey: string, value: unknown): void {
    this.db.execute(
      `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [storageKey, JSON.stringify(value), nowIso()]
    );
  }

  /**
   * GET /api/settings/config - returns the section-mapped config dict
   * (personal/targets/market/monte_carlo/withdrawal), NOT a raw dump of
   * app_settings (which would leak schema_version and any stored API keys).
   */
  getConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const [section, storageKey] of Object.entries(LocalAPI.CONFIG_SECTION_KEYS)) {
      config[section] = this.readConfigSection(storageKey) ?? {};
    }
    return config;
  }

  /** GET /api/settings/config/{section} */
  getConfigSection(section: string): Record<string, unknown> | null {
    const storageKey = LocalAPI.CONFIG_SECTION_KEYS[section];
    if (!storageKey) return null;
    return { [section]: this.readConfigSection(storageKey) ?? {} };
  }

  /** PUT /api/settings/config/{section} - stores the whole section value verbatim. */
  updateConfigSection(section: string, value: unknown): { status: string; [key: string]: unknown } {
    const storageKey = LocalAPI.CONFIG_SECTION_KEYS[section];
    if (!storageKey) {
      throw new Error(`Unknown config section: ${section}`);
    }
    this.writeConfigSection(storageKey, value);
    return { status: 'updated', [section]: value };
  }

  /**
   * PUT /api/settings/config/targets/{subsection} - the "targets" section is
   * a nested object keyed by subsection (asset_class/sector/geography/style);
   * this merges into the existing targets object rather than overwriting it.
   */
  updateTargetsSubsection(
    subsection: string,
    value: unknown
  ): { status: string; [key: string]: unknown } {
    const existing =
      this.readConfigSection<Record<string, unknown>>(LocalAPI.CONFIG_SECTION_KEYS['targets']!) ??
      {};
    existing[subsection] = value;
    this.writeConfigSection(LocalAPI.CONFIG_SECTION_KEYS['targets']!, existing);
    return { status: 'updated', [subsection]: value };
  }

  /** Backward-compatible generic getter/setter for a single arbitrary app_settings key (legacy behavior). */
  getRawSetting(key: string): unknown {
    const row = this.db.query<AppSettingRow>('SELECT value FROM app_settings WHERE key = ?', [
      key,
    ])[0];
    if (!row || row.value === null) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  updateConfig(key: string, value: unknown): { updated: boolean } {
    this.writeConfigSection(key, value);
    return { updated: true };
  }

  // ===================================================================
  // Bank statements (local persistence after server-side stateless parse)
  // ===================================================================

  private toRecurringCandidateResponse(row: RecurringCandidateRow): RecurringCandidateResponse {
    return {
      id: row.id,
      import_id: row.import_id,
      name: row.name,
      amount: row.amount,
      frequency: row.frequency,
      occurrences: row.occurrences,
      status: row.status,
      created_expense_id: row.created_expense_id,
    };
  }

  /**
   * Records a bank statement import + its recurring candidates. Dedupes by
   * content_hash: if an import with the same hash already exists, no new
   * import row is created and its (already-pending) candidates are
   * re-surfaced, matching the server's already_imported/files_skipped
   * behavior in bank_statements.py.
   */
  recordStatementImport(data: RecordStatementImportInput): RecordStatementImportResult {
    const existing = this.db.query<BankStatementImportRow>(
      'SELECT * FROM bank_statement_imports WHERE content_hash = ?',
      [data.content_hash]
    )[0];

    if (existing) {
      const candidates = this.db.query<RecurringCandidateRow>(
        'SELECT * FROM recurring_candidates WHERE import_id = ?',
        [existing.id]
      );
      return {
        import_id: existing.id,
        already_imported: true,
        candidates: candidates.map((c) => this.toRecurringCandidateResponse(c)),
      };
    }

    const importId = uuid();
    this.db.execute(
      `INSERT INTO bank_statement_imports (id, entity_id, file_name, content_hash, row_count, status, uploaded_at, analyzed_at)
       VALUES (?, ?, ?, ?, ?, 'analyzed', ?, ?)`,
      [
        importId,
        data.entity_id ?? null,
        data.file_name,
        data.content_hash,
        data.row_count,
        nowIso(),
        nowIso(),
      ]
    );

    const candidateResponses: RecurringCandidateResponse[] = [];
    for (const c of data.candidates) {
      const candidateId = uuid();
      const frequency = c.frequency ?? 'monthly';
      const occurrences = c.occurrences ?? 1;
      this.db.execute(
        `INSERT INTO recurring_candidates (id, import_id, name, amount, frequency, occurrences, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [candidateId, importId, c.name, c.amount, frequency, occurrences]
      );
      candidateResponses.push({
        id: candidateId,
        import_id: importId,
        name: c.name,
        amount: c.amount,
        frequency,
        occurrences,
        status: 'pending',
        created_expense_id: null,
      });
    }

    return { import_id: importId, already_imported: false, candidates: candidateResponses };
  }

  /** GET /api/budget/bank-statements/imports */
  getStatementImports(): BankStatementImportResponse[] {
    const imports = this.db.query<BankStatementImportRow>(
      'SELECT * FROM bank_statement_imports ORDER BY uploaded_at DESC'
    );
    return imports.map((imp) => {
      const candidates = this.db.query<RecurringCandidateRow>(
        'SELECT * FROM recurring_candidates WHERE import_id = ?',
        [imp.id]
      );
      return {
        id: imp.id,
        file_name: imp.file_name,
        row_count: imp.row_count,
        status: imp.status,
        error_message: imp.error_message,
        uploaded_at: imp.uploaded_at,
        analyzed_at: imp.analyzed_at,
        candidates: candidates.map((c) => this.toRecurringCandidateResponse(c)),
      };
    });
  }

  /** GET candidates list (all imports), matching bank-statements.ts consumption. */
  getRecurringCandidates(status?: string): RecurringCandidateResponse[] {
    const rows = status
      ? this.db.query<RecurringCandidateRow>(
          'SELECT * FROM recurring_candidates WHERE status = ? ORDER BY created_at DESC',
          [status]
        )
      : this.db.query<RecurringCandidateRow>(
          'SELECT * FROM recurring_candidates ORDER BY created_at DESC'
        );
    return rows.map((c) => this.toRecurringCandidateResponse(c));
  }

  /**
   * POST /api/budget/bank-statements/candidates/{id}/accept - ports
   * bank_statements.py's accept logic: entity_id is inherited from the
   * parent import; if an active expense with the same name (case
   * insensitive) + frequency already exists, the candidate is linked to it
   * instead of creating a duplicate (deduped: true).
   */
  acceptCandidate(candidateId: string, data: AcceptCandidateInput = {}): AcceptCandidateResult {
    const candidate = this.db.query<RecurringCandidateRow>(
      'SELECT * FROM recurring_candidates WHERE id = ?',
      [candidateId]
    )[0];
    if (!candidate) {
      throw new Error(`Candidate ${candidateId} not found`);
    }

    const importRow = this.db.query<BankStatementImportRow>(
      'SELECT * FROM bank_statement_imports WHERE id = ?',
      [candidate.import_id]
    )[0];
    const entityId = importRow?.entity_id ?? null;

    const frequency = data.frequency ?? candidate.frequency;
    const amount = data.amount ?? candidate.amount;

    const existingExpense = this.db.query<BudgetExpenseRow>(
      `SELECT * FROM budget_expenses WHERE LOWER(name) = LOWER(?) AND frequency = ? AND is_active = 1`,
      [candidate.name, frequency]
    )[0];

    let expenseId: string;
    let deduped: boolean;

    if (existingExpense) {
      expenseId = existingExpense.id;
      deduped = true;
    } else {
      let categoryId = data.category_id ?? null;
      if (!categoryId) {
        let other = this.db.query<BudgetExpenseCategoryRow>(
          "SELECT * FROM budget_expense_categories WHERE name = 'Other'"
        )[0];
        if (!other) {
          const id = uuid();
          this.db.execute(
            `INSERT INTO budget_expense_categories (id, name, icon, color, sort_order) VALUES (?, 'Other', 'ellipsis', '#6b7280', 99)`,
            [id]
          );
          other = this.db.query<BudgetExpenseCategoryRow>(
            'SELECT * FROM budget_expense_categories WHERE id = ?',
            [id]
          )[0]!;
        }
        categoryId = other.id;
      }

      expenseId = uuid();
      this.db.execute(
        `INSERT INTO budget_expenses (id, entity_id, category_id, name, amount, frequency, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [expenseId, entityId, categoryId, candidate.name, amount, frequency]
      );
      deduped = false;
    }

    this.db.execute(
      `UPDATE recurring_candidates SET status = 'accepted', created_expense_id = ? WHERE id = ?`,
      [expenseId, candidateId]
    );

    return { status: 'accepted', expense_id: expenseId, candidate_id: candidateId, deduped };
  }

  /** POST /api/budget/bank-statements/candidates/{id}/reject */
  rejectCandidate(candidateId: string): { status: 'rejected'; candidate_id: string } {
    this.db.execute(`UPDATE recurring_candidates SET status = 'rejected' WHERE id = ?`, [
      candidateId,
    ]);
    return { status: 'rejected', candidate_id: candidateId };
  }
}

// Export a factory function
export function createLocalAPI(clientDatabase: ClientDatabase): LocalAPI {
  return new LocalAPI(clientDatabase);
}
