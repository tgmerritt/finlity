/**
 * Projections page module.
 * Handles Monte Carlo simulations, FIRE calculator, and tax projections.
 */

import { apiCall, runAsyncApiCall } from '@/api/client';
import { store } from '@/state/store';
import { setStateView, clearStateView } from '@/ui/state-view';
import { showLoading, hideLoading, updateLoadingMessage } from '@/ui/loading';
import { onTabChange } from '@/ui/tabs';
import { showToast } from '@/ui/toast';
import { formatCurrency, formatNumber } from '@/utils/format';
import {
  displayProjectionResults,
  renderTaxBurdenChart,
  renderAccountBalanceChart,
  renderTaxWithdrawalTable,
  type MonteCarloProjectionResult,
  type TaxBurdenChartData,
  type TaxWithdrawalYear,
} from '@/charts/projections';

/** Phone breakpoint, matching the 768px rules in style.css. */
const PHONE_MAX_WIDTH = 768;

/**
 * Retirement metrics response from API.
 */
export interface DashboardMetrics {
  monthly_retirement_income: number | null;
  withdrawal_rate: number | null;
  success_probability: number | null;
  earliest_retirement_age: number | null;
  fire_number: number | null;
  target_monthly_income: number | null;
  target_retirement_age: number | null;
  current_age: number | null;
  simulation_required: boolean;
  coast_number: number | null;
}

/**
 * Tax projection API result.
 */
interface TaxProjectionResult {
  summary: {
    total_federal_tax: number;
    total_state_tax: number;
    total_tax: number;
    average_effective_rate: number;
    total_withdrawn: number;
    total_gross_withdrawn?: number;
    final_balance: number;
    // Pre-retirement (accumulation phase) tax totals
    pre_retirement_federal_tax?: number;
    pre_retirement_state_tax?: number;
    pre_retirement_total_tax?: number;
    pre_retirement_avg_effective_rate?: number;
    // Post-retirement (withdrawal phase) tax totals
    post_retirement_federal_tax?: number;
    post_retirement_state_tax?: number;
    post_retirement_total_tax?: number;
  };
  chart_data: TaxBurdenChartData & {
    taxable_balances: number[];
    traditional_balances: number[];
    roth_balances: number[];
    total_balances: number[];
  };
  years: TaxWithdrawalYear[];
}

/**
 * Account balances by tax type.
 */
interface AccountBalancesByType {
  taxable: number;
  traditional: number;
  roth: number;
  total: number;
}

/**
 * FIRE calculation result.
 */
interface FireResult {
  fire_number: number;
  years_to_fire: number;
  progress_pct: number;
}

/**
 * Monte Carlo parameters.
 */
interface MonteCarloParams {
  current_age: number;
  retirement_age: number;
  monthly_contribution: number;
  monthly_withdrawal: number;
  stock_allocation: number;
  bond_allocation: number;
  use_tax_aware_withdrawals?: boolean;
  account_balances?: {
    taxable: number;
    traditional: number;
    roth: number;
  };
  tax_rate_ordinary?: number;
  tax_rate_capital_gains?: number;
  tax_rate_state?: number;
  cost_basis_ratio?: number;
  contribution_traditional_pct?: number;
  contribution_roth_pct?: number;
  contribution_taxable_pct?: number;
}

/**
 * Tax projection parameters.
 */
interface TaxProjectionParams {
  current_age: number;
  retirement_age: number;
  end_age: number;
  annual_spending: number;
  expected_return: number;
  inflation_rate: number;
  monthly_contribution: number;
  contribution_to_traditional_pct: number;
  contribution_to_roth_pct: number;
  contribution_to_taxable_pct: number;
  federal_tax_rate: number;
  state_tax_rate: number;
  capital_gains_rate: number;
  cost_basis_ratio: number;
  taxable_balance?: number;
  traditional_balance?: number;
  roth_balance?: number;
}

/**
 * Get numeric value from input element.
 */
function getInputValue(id: string, defaultValue = 0): number {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el || el.value === '') return defaultValue;
  const value = parseFloat(el.value);
  return isNaN(value) ? defaultValue : value;
}

/**
 * Set input element placeholder.
 */
function setInputPlaceholder(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el && !el.value) {
    el.placeholder = value;
  }
}

/**
 * Run Monte Carlo projection simulation.
 * Uses async task polling for long-running operations.
 */
export async function runProjection(event: Event): Promise<void> {
  event.preventDefault();

  showLoading('Running Monte Carlo simulation...');
  const form = event.target as HTMLFormElement;
  form.classList.add('loading');

  const params: MonteCarloParams = {
    current_age: getInputValue('current-age'),
    retirement_age: getInputValue('retirement-age'),
    monthly_contribution: getInputValue('monthly-contribution'),
    monthly_withdrawal: getInputValue('monthly-withdrawal'),
    stock_allocation: getInputValue('stock-allocation') / 100,
    bond_allocation: getInputValue('bond-allocation') / 100,
  };

  // Check if tax-aware mode is enabled
  const useTaxAwareEl = document.getElementById('use-tax-aware') as HTMLInputElement | null;
  const useTaxAware = useTaxAwareEl?.checked || false;

  if (useTaxAware) {
    params.use_tax_aware_withdrawals = true;
    params.account_balances = {
      taxable: getInputValue('balance-taxable'),
      traditional: getInputValue('balance-traditional'),
      roth: getInputValue('balance-roth'),
    };
    params.tax_rate_ordinary = getInputValue('tax-rate-ordinary', 22) / 100;
    params.tax_rate_capital_gains = getInputValue('tax-rate-cap-gains', 15) / 100;
    params.tax_rate_state = getInputValue('tax-rate-state', 5) / 100;
    params.cost_basis_ratio = getInputValue('cost-basis-ratio', 60) / 100;
    params.contribution_traditional_pct = getInputValue('contrib-traditional', 60) / 100;
    params.contribution_roth_pct = getInputValue('contrib-roth', 25) / 100;
    params.contribution_taxable_pct = getInputValue('contrib-taxable', 15) / 100;
  }

  try {
    // Use async API helper - handles both sync and async (background task) responses
    const result = await runAsyncApiCall<MonteCarloProjectionResult>(
      '/api/projections/monte-carlo?async_mode=true',
      {
        method: 'POST',
        body: params,
      },
      {
        maxWaitMs: 300000, // 5 minutes max
        interval: 2000,
        onProgress: (task) => {
          const progress = task.progress ? Math.round(task.progress * 100) : 0;
          const message = task.progress_message || `Running simulation... ${progress}%`;
          updateLoadingMessage(message);
        },
      }
    );

    await displayProjectionResults(result, params.retirement_age);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    await loadRetirementMetrics();
  } catch (error) {
    console.error('Error running projection:', error);
    showToast('Failed to run projection: ' + (error as Error).message, 'error');
  } finally {
    form.classList.remove('loading');
    hideLoading();
  }
}

/**
 * Load the retirement metric tiles at the top of the Projections tab.
 * If an entity is selected, loads metrics filtered to that entity.
 *
 * @returns true if metrics loaded successfully, false on error
 */
export async function loadRetirementMetrics(): Promise<boolean> {
  const errorHost = document.getElementById('retirement-metrics-error');

  try {
    // Build URL with entity filter if one is selected
    const currentEntityId = store.get('currentEntityId');
    let url = '/api/portfolio/dashboard-metrics';
    if (currentEntityId) {
      url += `?entity_id=${encodeURIComponent(currentEntityId)}`;
    }

    const metrics = await apiCall<DashboardMetrics>(url);

    // Success: scrub any prior inline error.
    if (errorHost) {
      clearStateView(errorHost);
      errorHost.style.display = 'none';
    }

    // Update Monthly Retirement Income
    const monthlyIncomeEl = document.getElementById('monthly-retirement-income');
    const withdrawalLabel = document.getElementById('withdrawal-rate-label');
    if (monthlyIncomeEl) {
      if (metrics.monthly_retirement_income !== null) {
        monthlyIncomeEl.textContent = formatCurrency(metrics.monthly_retirement_income);
        if (withdrawalLabel) {
          withdrawalLabel.textContent = `at ${metrics.withdrawal_rate}% of projected portfolio`;
        }
      } else {
        monthlyIncomeEl.textContent = '--';
        if (withdrawalLabel) {
          withdrawalLabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Success Probability
    const successProbEl = document.getElementById('success-probability');
    const successSublabel = document.getElementById('success-sublabel');
    if (successProbEl) {
      if (metrics.success_probability !== null) {
        successProbEl.textContent = `${metrics.success_probability}%`;
        successProbEl.classList.remove('positive', 'negative');
        if (metrics.success_probability >= 80) {
          successProbEl.classList.add('positive');
        } else if (metrics.success_probability < 50) {
          successProbEl.classList.add('negative');
        }
        if (successSublabel) {
          successSublabel.textContent = 'of not running out by age 90';
        }
      } else {
        successProbEl.textContent = '--';
        successProbEl.classList.remove('positive', 'negative');
        if (successSublabel) {
          successSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Earliest Retirement Age
    const retireAgeEl = document.getElementById('earliest-retirement-age');
    const retireSublabel = document.getElementById('retire-sublabel');
    if (retireAgeEl) {
      if (metrics.earliest_retirement_age != null) {
        retireAgeEl.textContent = `Age ${metrics.earliest_retirement_age}`;
        if (retireSublabel) {
          retireSublabel.textContent = 'with 80%+ success rate';
        }
      } else {
        retireAgeEl.textContent = '--';
        if (retireSublabel) {
          retireSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update FIRE Number
    const fireNumberEl = document.getElementById('fire-number');
    const fireSublabel = document.getElementById('fire-sublabel');
    if (fireNumberEl) {
      if (metrics.fire_number !== null) {
        fireNumberEl.textContent = formatCurrency(metrics.fire_number);
        if (fireSublabel) {
          if (metrics.target_monthly_income) {
            fireSublabel.textContent = `for $${formatNumber(metrics.target_monthly_income, 0)}/yr target`;
          } else {
            fireSublabel.textContent = `projected at age ${metrics.target_retirement_age}`;
          }
        }
      } else {
        fireNumberEl.textContent = '--';
        if (fireSublabel) {
          fireSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Coast Number
    const coastNumberEl = document.getElementById('coast-number');
    const coastSublabel = document.getElementById('coast-sublabel');
    if (coastNumberEl) {
      if (metrics.coast_number !== null && metrics.coast_number !== undefined) {
        coastNumberEl.textContent = formatCurrency(metrics.coast_number);
        if (coastSublabel && metrics.current_age != null && metrics.target_retirement_age != null) {
          const yearsLeft = metrics.target_retirement_age - metrics.current_age;
          coastSublabel.textContent = `needed today to coast ${yearsLeft > 0 ? `${yearsLeft} yrs` : ''} to FIRE`;
        } else if (coastSublabel) {
          coastSublabel.textContent = "today's value to coast to FIRE";
        }
      } else {
        coastNumberEl.textContent = '--';
        if (coastSublabel) {
          coastSublabel.textContent = 'Set DOB and retirement age in Settings';
        }
      }
    }
    return true;
  } catch (error) {
    console.error('Error loading retirement metrics:', error);
    // Surface the failure inline above the metrics row so users see it
    // even after the toast disappears, with a one-click retry.
    if (errorHost) {
      errorHost.style.display = '';
      setStateView(errorHost, {
        kind: 'error',
        title: 'Could not load retirement metrics',
        description: error instanceof Error ? error.message : 'Unknown error.',
        action: {
          label: 'Retry',
          onClick: () => {
            loadRetirementMetrics().catch((err) =>
              console.error('Retirement metrics retry failed:', err)
            );
          },
        },
      });
    }
    showToast('Unable to load retirement metrics', 'error');
    return false;
  }
}

/**
 * Toggle tax-aware settings visibility.
 * Auto-loads account balances when enabled.
 */
export function toggleTaxAwareSettings(): void {
  const checkbox = document.getElementById('use-tax-aware') as HTMLInputElement | null;
  const settings = document.getElementById('tax-aware-settings');

  if (checkbox && settings) {
    settings.style.display = checkbox.checked ? 'block' : 'none';

    // Auto-load balances when enabling tax-aware mode
    if (checkbox.checked) {
      loadAccountBalancesByType();
    }
  }
}

/**
 * Toggle a collapsible config panel. The `collapsed` class is what the
 * stylesheet keys off (hides the body, shows the summary).
 */
export function toggleConfigPanel(panelId: string): void {
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.classList.toggle('collapsed');
  }
}

/**
 * On phones the inputs panel sits above the results, so collapse it once a
 * result is on screen. Desktop keeps it as the user left it.
 */
export function collapseConfigPanelOnPhone(panelId: string): void {
  if (window.innerWidth > PHONE_MAX_WIDTH) return;
  document.getElementById(panelId)?.classList.add('collapsed');
}

/**
 * Update the Monte Carlo config summary text shown in the collapsed header.
 * Displays key configuration values at a glance.
 */
export function updateMonteCarloConfigSummary(): void {
  const summary = document.getElementById('monte-carlo-config-summary');
  if (!summary) return;

  const currentAge = (document.getElementById('current-age') as HTMLInputElement)?.value || '35';
  const retirementAge =
    (document.getElementById('retirement-age') as HTMLInputElement)?.value || '65';
  const monthlyContribution =
    (document.getElementById('monthly-contribution') as HTMLInputElement)?.value || '0';
  const monthlyWithdrawal =
    (document.getElementById('monthly-withdrawal') as HTMLInputElement)?.value || '0';

  const contrib = parseInt(monthlyContribution, 10);
  const withdraw = parseInt(monthlyWithdrawal, 10);

  const parts: string[] = [];
  parts.push(`Age ${currentAge}→${retirementAge}`);
  if (contrib > 0) parts.push(`+$${contrib.toLocaleString()}/mo`);
  if (withdraw > 0) parts.push(`-$${withdraw.toLocaleString()}/mo`);

  summary.textContent = parts.join(' • ');
}

/**
 * Load account balances by tax type from the API.
 * Populates the tax-aware mode balance inputs.
 */
export async function loadAccountBalancesByType(): Promise<void> {
  try {
    const data = await apiCall<AccountBalancesByType>('/api/projections/account-balances-by-type');

    const taxableEl = document.getElementById('balance-taxable') as HTMLInputElement | null;
    const traditionalEl = document.getElementById('balance-traditional') as HTMLInputElement | null;
    const rothEl = document.getElementById('balance-roth') as HTMLInputElement | null;

    if (taxableEl) taxableEl.value = Math.round(data.taxable).toString();
    if (traditionalEl) traditionalEl.value = Math.round(data.traditional).toString();
    if (rothEl) rothEl.value = Math.round(data.roth).toString();

    showToast(`Loaded balances: ${formatCurrency(data.total)} total`, 'success');
  } catch (error) {
    console.error('Error loading account balances:', error);
    showToast('Failed to load account balances', 'error');
  }
}

/**
 * Calculate FIRE (Financial Independence, Retire Early) number.
 */
export async function calculateFire(event: Event): Promise<void> {
  event.preventDefault();

  const params = {
    annual_spending: getInputValue('annual-spending'),
    monthly_contribution: getInputValue('fire-contribution'),
  };

  try {
    const result = await apiCall<FireResult>('/api/projections/fire', {
      method: 'POST',
      body: params,
    });

    // Show results
    const resultsEl = document.getElementById('fire-results');
    if (resultsEl) {
      resultsEl.style.display = 'flex';
    }

    const fireNumber = document.getElementById('fire-calc-number');
    if (fireNumber) {
      fireNumber.textContent = formatCurrency(result.fire_number);
    }

    const fireYears = document.getElementById('fire-calc-years');
    if (fireYears) {
      fireYears.textContent =
        result.years_to_fire === Infinity ? 'Never' : `${result.years_to_fire.toFixed(1)} years`;
    }

    const fireProgress = document.getElementById('fire-calc-progress');
    if (fireProgress) {
      fireProgress.textContent = `${result.progress_pct.toFixed(1)}%`;
    }
  } catch (error) {
    console.error('Error calculating FIRE:', error);
    showToast('Failed to calculate FIRE number', 'error');
  }
}

/**
 * Load initial data for the taxes sub-tab.
 * Pre-fills balance placeholders from portfolio data.
 */
export async function loadTaxesTab(): Promise<void> {
  try {
    const data = await apiCall<AccountBalancesByType>('/api/projections/account-balances-by-type');

    // Only set placeholders if fields are empty (user hasn't entered custom values)
    setInputPlaceholder('tax-taxable-balance', formatCurrency(data.taxable));
    setInputPlaceholder('tax-traditional-balance', formatCurrency(data.traditional));
    setInputPlaceholder('tax-roth-balance', formatCurrency(data.roth));
  } catch (error) {
    console.error('Error loading account balances for taxes tab:', error);
  }
}

/**
 * Run tax projection simulation.
 * Validates inputs and runs projection with async task support.
 */
export async function runTaxProjection(event: Event): Promise<void> {
  event.preventDefault();

  // Validate required fields before running
  const requiredFields = [
    { id: 'tax-current-age', name: 'Current Age' },
    { id: 'tax-retirement-age', name: 'Retirement Age' },
    { id: 'tax-end-age', name: 'End Age' },
    { id: 'tax-annual-spending', name: 'Annual Spending' },
    { id: 'tax-expected-return', name: 'Expected Return' },
    { id: 'tax-inflation-rate', name: 'Inflation Rate' },
    { id: 'tax-contrib-traditional', name: 'Traditional %' },
    { id: 'tax-contrib-roth', name: 'Roth %' },
    { id: 'tax-contrib-taxable', name: 'Taxable %' },
    { id: 'tax-federal-rate', name: 'Federal Tax Rate' },
    { id: 'tax-state-rate', name: 'State Tax Rate' },
    { id: 'tax-capgains-rate', name: 'Capital Gains Rate' },
    { id: 'tax-cost-basis', name: 'Cost Basis %' },
  ];

  const missingFields: string[] = [];
  for (const field of requiredFields) {
    const el = document.getElementById(field.id) as HTMLInputElement | null;
    if (!el || el.value === '' || isNaN(parseFloat(el.value))) {
      missingFields.push(field.name);
    }
  }

  if (missingFields.length > 0) {
    const fieldList =
      missingFields.slice(0, 3).join(', ') + (missingFields.length > 3 ? '...' : '');
    showToast(`Please fill in all required fields: ${fieldList}`, 'error');
    return;
  }

  showLoading('Running tax projection...');
  const form = event.target as HTMLFormElement;
  form.classList.add('loading');

  const params: TaxProjectionParams = {
    current_age: getInputValue('tax-current-age'),
    retirement_age: getInputValue('tax-retirement-age'),
    end_age: getInputValue('tax-end-age'),
    annual_spending: getInputValue('tax-annual-spending'),
    expected_return: getInputValue('tax-expected-return') / 100,
    inflation_rate: getInputValue('tax-inflation-rate') / 100,
    monthly_contribution: getInputValue('tax-monthly-contribution'),
    contribution_to_traditional_pct: getInputValue('tax-contrib-traditional') / 100,
    contribution_to_roth_pct: getInputValue('tax-contrib-roth') / 100,
    contribution_to_taxable_pct: getInputValue('tax-contrib-taxable') / 100,
    federal_tax_rate: getInputValue('tax-federal-rate') / 100,
    state_tax_rate: getInputValue('tax-state-rate') / 100,
    capital_gains_rate: getInputValue('tax-capgains-rate') / 100,
    cost_basis_ratio: getInputValue('tax-cost-basis') / 100,
  };

  // Get optional balances (leave undefined if empty to auto-fill from portfolio)
  const taxableEl = document.getElementById('tax-taxable-balance') as HTMLInputElement | null;
  const traditionalEl = document.getElementById(
    'tax-traditional-balance'
  ) as HTMLInputElement | null;
  const rothEl = document.getElementById('tax-roth-balance') as HTMLInputElement | null;

  if (taxableEl?.value) params.taxable_balance = parseFloat(taxableEl.value);
  if (traditionalEl?.value) params.traditional_balance = parseFloat(traditionalEl.value);
  if (rothEl?.value) params.roth_balance = parseFloat(rothEl.value);

  try {
    // Use runAsyncApiCall to handle both sync and async (Heroku) responses
    const result = await runAsyncApiCall<TaxProjectionResult>(
      '/api/projections/tax-projection',
      {
        method: 'POST',
        body: params,
      },
      {
        onProgress: (task) => {
          if (task.progress_message) {
            showToast(task.progress_message, 'info');
          }
        },
      }
    );

    displayTaxProjectionResults(result);
    showToast('Tax projection complete', 'success');
  } catch (error) {
    console.error('Error running tax projection:', error);
    showToast(`Error: ${(error as Error).message}`, 'error');
  } finally {
    form.classList.remove('loading');
    hideLoading();
  }
}

/**
 * Display tax projection results.
 * Updates summary stats, charts, and withdrawal table.
 */
function displayTaxProjectionResults(result: TaxProjectionResult): void {
  // Validate result has required data
  if (!result || !result.summary) {
    showToast('Tax projection returned invalid data', 'error');
    console.error('Invalid tax projection result:', result);
    return;
  }

  // Get input parameters for context
  const currentAge = getInputValue('tax-current-age');
  const retirementAge = getInputValue('tax-retirement-age');
  const endAge = getInputValue('tax-end-age');
  const stateRate = getInputValue('tax-state-rate');
  const monthlyContrib = getInputValue('tax-monthly-contribution');
  const accumulationYears = retirementAge - currentAge;
  const withdrawalYears = endAge - retirementAge;

  // Update context banner
  const contextPeriod = document.getElementById('tax-context-period');
  const contextYears = document.getElementById('tax-context-years');

  if (contextPeriod) {
    if (accumulationYears > 0) {
      contextPeriod.textContent = `Age ${currentAge} → ${retirementAge} → ${endAge}`;
    } else {
      contextPeriod.textContent = `Age ${retirementAge} → ${endAge}`;
    }
  }

  if (contextYears) {
    if (accumulationYears > 0 && monthlyContrib > 0) {
      contextYears.textContent = `${accumulationYears}yr accumulation + ${withdrawalYears}yr`;
    } else {
      contextYears.textContent = `${withdrawalYears} years`;
    }
  }

  // Update summary stats
  const updateStat = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  updateStat('tax-total-federal', formatCurrency(result.summary.total_federal_tax));
  updateStat('tax-total-state', formatCurrency(result.summary.total_state_tax));
  updateStat('tax-total-all', formatCurrency(result.summary.total_tax));
  updateStat('tax-avg-rate', `${result.summary.average_effective_rate.toFixed(1)}%`);

  // Show gross withdrawals (before tax) - what users actually withdrew from accounts
  const grossWithdrawn = result.summary.total_gross_withdrawn || result.summary.total_withdrawn;
  updateStat('tax-total-withdrawn', formatCurrency(grossWithdrawn));
  updateStat('tax-final-balance', formatCurrency(result.summary.final_balance));

  // Update detail descriptions
  const federalDetail = document.getElementById('tax-federal-detail');
  if (federalDetail) {
    // Use post-retirement federal tax for annual average (not total which includes pre-retirement salary taxes)
    const postRetirementFederal =
      result.summary.post_retirement_federal_tax ?? result.summary.total_federal_tax;
    const avgAnnualFederal = postRetirementFederal / withdrawalYears;
    // Calculate federal effective rate (federal tax / gross withdrawn)
    const federalEffRate = grossWithdrawn > 0 ? (postRetirementFederal / grossWithdrawn) * 100 : 0;
    federalDetail.textContent = `~${formatCurrency(avgAnnualFederal)}/yr (~${federalEffRate.toFixed(1)}% effective rate)`;
  }

  const stateDetail = document.getElementById('tax-state-detail');
  const stateRateDisplay = document.getElementById('tax-state-rate-display');
  if (stateRateDisplay) stateRateDisplay.textContent = `${stateRate}%`;
  if (stateDetail) {
    if (stateRate === 0) {
      stateDetail.textContent = 'No state income tax configured';
    } else {
      // Use post-retirement state tax for annual average
      const postRetirementState =
        result.summary.post_retirement_state_tax ?? result.summary.total_state_tax;
      const avgAnnualState = postRetirementState / withdrawalYears;
      // Calculate state effective rate
      const stateEffRate = grossWithdrawn > 0 ? (postRetirementState / grossWithdrawn) * 100 : 0;
      stateDetail.textContent = `~${formatCurrency(avgAnnualState)}/yr (~${stateEffRate.toFixed(1)}% effective rate)`;
    }
  }

  const totalDetail = document.getElementById('tax-total-detail');
  if (totalDetail) {
    // Calculate total years (accumulation + withdrawal)
    const totalYears = accumulationYears + withdrawalYears;
    // Show whether this includes pre-retirement taxes
    const hasPreRetirement =
      accumulationYears > 0 && (result.summary.pre_retirement_total_tax ?? 0) > 0;
    if (hasPreRetirement) {
      const retirementPct =
        grossWithdrawn > 0
          ? (((result.summary.post_retirement_total_tax ?? 0) / grossWithdrawn) * 100).toFixed(1)
          : '0.0';
      totalDetail.textContent = `${retirementPct}% of gross withdrawals over ${totalYears} years`;
    } else {
      const taxAsPercent =
        grossWithdrawn > 0 ? ((result.summary.total_tax / grossWithdrawn) * 100).toFixed(1) : '0.0';
      totalDetail.textContent = `${taxAsPercent}% of gross withdrawals over ${withdrawalYears} years`;
    }
  }

  const withdrawnDetail = document.getElementById('tax-withdrawn-detail');
  if (withdrawnDetail) {
    const avgAnnualWithdrawal = grossWithdrawn / withdrawalYears;
    withdrawnDetail.textContent = `~${formatCurrency(avgAnnualWithdrawal)}/yr from all account types`;
  }

  const balanceDetail = document.getElementById('tax-balance-detail');
  const balanceCard = document.querySelector('.tax-stat-balance');
  if (balanceCard) {
    balanceCard.classList.remove('depleted', 'healthy');
    if (result.summary.final_balance <= 0) {
      balanceCard.classList.add('depleted');
      if (balanceDetail) balanceDetail.textContent = 'Portfolio depleted before end of projection';
    } else if (result.summary.final_balance > result.summary.total_withdrawn * 0.1) {
      balanceCard.classList.add('healthy');
      if (balanceDetail)
        balanceDetail.textContent = 'Healthy balance remaining for legacy/emergencies';
    } else {
      if (balanceDetail) balanceDetail.textContent = 'Remaining at end of projection';
    }
  }

  // Render charts
  renderTaxBurdenChart(result.chart_data);
  renderAccountBalanceChart(result.chart_data);

  // Render withdrawal table
  renderTaxWithdrawalTable(result.years);
}

/**
 * Initialize projections page.
 * Sets up form handlers and loads initial data.
 */
export function initProjections(): void {
  // Monte Carlo, FIRE, and tax projection forms use the inline onsubmit=""
  // handler in index.html — do not also bind here, or the submit fires twice.

  // Tax-aware toggle
  const taxAwareCheckbox = document.getElementById('use-tax-aware');
  if (taxAwareCheckbox) {
    taxAwareCheckbox.addEventListener('change', toggleTaxAwareSettings);
  }

  // Load balance refresh button
  const refreshBalancesBtn = document.getElementById('refresh-balances-btn');
  if (refreshBalancesBtn) {
    refreshBalancesBtn.addEventListener('click', loadAccountBalancesByType);
  }

  // Load taxes tab data when switching to taxes tab
  onTabChange((tab) => {
    if (tab === 'projections') {
      loadRetirementMetrics().catch((err) => console.error('Retirement metrics load failed:', err));
    }
    if (tab === 'taxes') {
      loadTaxesTab();
    }
  });
}
