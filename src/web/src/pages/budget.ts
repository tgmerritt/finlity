/**
 * Budget page module.
 * Handles income, expenses, deductions, paycheck preview, cash flow, and transitions.
 */

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { createDynamicModal, closeModal } from '@/ui/modal';
import { onTabChange } from '@/ui/tabs';
import { formatCurrency } from '@/utils/format';
import { escapeHtml } from '@/utils/html';
import { store } from '@/state/store';
import {
  loadPaycheckChart,
  renderCashFlowWaterfall,
  updateExpensesCategoryChart,
  renderTransitionChart,
  renderSSComparison,
  renderIncomeTransitionTable,
  type CashFlowSummary,
  type TransitionYear,
  type SSComparisonRow,
} from '@/charts/budget';
import type { IncomeSource, Expense, Deduction, LiabilityResponse } from '@/types/api';

/** Active debts by the id of the expense they are linked to (set by loadExpenses). */
let debtByExpense = new Map<string, LiabilityResponse>();

async function fetchLiabilities(): Promise<LiabilityResponse[]> {
  try {
    return (await apiCall<LiabilityResponse[]>('/api/liabilities')) ?? [];
  } catch (error) {
    console.error('Error loading debts:', (error as Error).name);
    return [];
  }
}

/**
 * Paycheck breakdown from API.
 */
interface PaycheckBreakdown {
  gross: number;
  federal_income_tax: number;
  state_income_tax: number;
  social_security: number;
  medicare: number;
  additional_medicare?: number;
  total_pretax_deductions: number;
  net_pay: number;
  total_taxes: number;
}

/**
 * Tax configuration.
 */
interface TaxConfig {
  filing_status: string;
  state: string;
  ss_claiming_age?: number;
}

/**
 * State definition for budget.
 */
interface StateDefinition {
  code: string;
  name: string;
  type: string;
}

/**
 * Transition projection response.
 */
interface TransitionResponse {
  years: TransitionYear[];
  ss_comparison: SSComparisonRow[];
}

/** Selected income index for paycheck preview. */
let selectedPaycheckIncomeIndex = 0;

/**
 * Format income type for display.
 */
function formatIncomeType(type: string): string {
  const types: Record<string, string> = {
    employment: 'Employment',
    self_employment: 'Self-Employment',
    rental: 'Rental',
    investment: 'Investment',
    other: 'Other',
  };
  return types[type] || type;
}

/**
 * Format pay frequency for display.
 */
function formatPayFrequency(freq: string): string {
  const freqs: Record<string, string> = {
    weekly: 'Weekly',
    biweekly: 'Bi-weekly',
    semimonthly: 'Semi-monthly',
    monthly: 'Monthly',
  };
  return freqs[freq] || freq;
}

/**
 * Format expense frequency for display.
 */
function formatExpenseFrequency(freq: string): string {
  const freqs: Record<string, string> = {
    weekly: 'Weekly',
    biweekly: 'Bi-weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    annual: 'Annual',
    one_time: 'One-time',
  };
  return freqs[freq] || freq;
}

/**
 * Format deduction type for display.
 */
function formatDeductionType(type: string): string {
  const types: Record<string, string> = {
    '401k': '401(k)',
    hsa: 'HSA',
    fsa: 'FSA',
    dental: 'Dental Insurance',
    vision: 'Vision Insurance',
    other: 'Other Pre-tax',
  };
  return types[type] || type;
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
 * Pay periods per year lookup.
 */
const periodsPerYear: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/**
 * Show budget sub-tab.
 */
export function showBudgetTab(tabName: string): void {
  // Hide all budget subtabs
  document.querySelectorAll('.budget-subtab').forEach((tab) => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.budget-nav-item').forEach((nav) => {
    nav.classList.remove('active');
  });

  // Show selected subtab
  const subtab = document.getElementById(`budget-${tabName}`);
  if (subtab) {
    subtab.classList.add('active');
  }

  // Activate nav item
  const navItem = document.querySelector(`.budget-nav-item[data-budget-tab="${tabName}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // Load subtab-specific data
  if (tabName === 'cashflow') {
    loadCashFlowData();
  }
}

/**
 * Load tax configuration.
 */
export async function loadTaxConfig(): Promise<void> {
  try {
    const data = await apiCall<TaxConfig>('/api/budget/tax-config');
    if (data) {
      const filingEl = document.getElementById('filing-status') as HTMLSelectElement | null;
      const stateEl = document.getElementById('tax-state') as HTMLSelectElement | null;
      if (filingEl && data.filing_status) {
        filingEl.value = data.filing_status;
      }
      if (stateEl && data.state) {
        stateEl.value = data.state;
      }
      const ssAgeEl = document.getElementById('transition-ss-age') as HTMLInputElement | null;
      const ssAge = data.ss_claiming_age;
      if (ssAgeEl && ssAge != null) {
        ssAgeEl.value = String(ssAge);
      }
    }
  } catch (error) {
    console.error('Error loading tax config:', error);
  }
}

/**
 * Save tax configuration.
 */
export async function saveTaxConfig(): Promise<void> {
  const filingStatus = (document.getElementById('filing-status') as HTMLSelectElement | null)
    ?.value;
  const state = (document.getElementById('tax-state') as HTMLSelectElement | null)?.value;

  try {
    await apiCall('/api/budget/tax-config', {
      method: 'PUT',
      body: {
        filing_status: filingStatus,
        state: state,
      },
    });
    updatePaycheckPreview();
  } catch (error) {
    console.error('Error saving tax config:', error);
  }
}

/**
 * Update budget calculations when config changes.
 */
export function updateBudgetCalc(): void {
  saveTaxConfig();
}

/**
 * Load income sources and display list.
 */
export async function loadIncomeSources(): Promise<void> {
  try {
    const data = await apiCall<IncomeSource[]>('/api/budget/income');
    store.set('incomeSources', data || []);
    const container = document.getElementById('income-sources-list');
    if (!container) return;

    if (!data || data.length === 0) {
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No income sources added yet. Click "Add Income" to get started.';
      container.appendChild(p);
      return;
    }

    // Build list using safe DOM methods
    container.textContent = '';
    data.forEach((income) => {
      const item = document.createElement('div');
      item.className = 'income-item';

      const info = document.createElement('div');
      info.className = 'income-item-info';

      const name = document.createElement('div');
      name.className = 'income-item-name';
      name.textContent = income.name;

      const details = document.createElement('div');
      details.className = 'income-item-details';
      details.textContent = `${formatIncomeType(income.income_type)} • ${formatPayFrequency(income.pay_frequency)} • ${income.state}`;

      info.appendChild(name);
      info.appendChild(details);

      const amount = document.createElement('div');
      amount.className = 'income-item-amount';
      amount.textContent = `${formatCurrency(income.gross_annual)}/yr`;

      const actions = document.createElement('div');
      actions.className = 'income-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-default';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => editIncome(income.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteIncome(income.id));

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(amount);
      item.appendChild(actions);
      container.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading income sources:', error);
  }
}

/**
 * Load deductions and display list.
 */
export async function loadDeductions(): Promise<void> {
  try {
    const data = await apiCall<Deduction[]>('/api/budget/deductions');
    store.set('deductions', data || []);
    const container = document.getElementById('deductions-list');
    if (!container) return;

    if (!data || data.length === 0) {
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No pre-tax deductions. Add 401k, HSA, FSA contributions here.';
      container.appendChild(p);
      return;
    }

    // Build list using safe DOM methods
    container.textContent = '';
    data.forEach((ded) => {
      const item = document.createElement('div');
      item.className = 'deduction-item';

      const info = document.createElement('div');
      info.className = 'deduction-item-info';

      const name = document.createElement('div');
      name.className = 'deduction-item-name';
      const displayName = ded.label
        ? `${ded.label} (${formatDeductionType(ded.deduction_type)})`
        : formatDeductionType(ded.deduction_type);
      name.textContent = displayName;

      const details = document.createElement('div');
      details.className = 'deduction-item-details';
      let detailText = ded.is_percentage
        ? `${ded.amount_per_period}% of gross`
        : `${formatCurrency(ded.amount_per_period)}/period`;
      if (ded.employer_match && ded.employer_match > 0) {
        detailText += ` + ${formatCurrency(ded.employer_match)} employer match`;
      }
      details.textContent = detailText;

      info.appendChild(name);
      info.appendChild(details);

      const amount = document.createElement('div');
      amount.className = 'deduction-item-amount';
      amount.textContent = `${formatCurrency(ded.amount_per_period * 26)}/yr`;

      const actions = document.createElement('div');
      actions.className = 'deduction-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-default';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => editDeduction(ded.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteDeduction(ded.id));

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(amount);
      item.appendChild(actions);
      container.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading deductions:', error);
  }
}

/**
 * Load expenses and display list.
 */
export async function loadExpenses(): Promise<void> {
  try {
    const data = await apiCall<Expense[]>('/api/budget/expenses');
    store.set('expenses', data || []);
    debtByExpense = new Map();
    for (const d of await fetchLiabilities()) {
      if (d.is_active && d.expense_id && !d.expense_missing) debtByExpense.set(d.expense_id, d);
    }
    const container = document.getElementById('expenses-list');
    if (!container) return;

    if (!data || data.length === 0) {
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'No expenses added yet. Click "Add Expense" to track your spending.';
      container.appendChild(p);
      return;
    }

    // Build list using safe DOM methods
    container.textContent = '';
    data.forEach((exp) => {
      const item = document.createElement('div');
      item.className = 'expense-item';

      const info = document.createElement('div');
      info.className = 'expense-item-info';

      const name = document.createElement('div');
      name.className = 'expense-item-name';
      name.textContent = exp.name;

      const details = document.createElement('div');
      details.className = 'expense-item-details';
      details.textContent = `${exp.category_name || 'Uncategorized'} • ${formatExpenseFrequency(exp.frequency)}`;

      const linked = debtByExpense.get(exp.id);
      if (linked) {
        const chip = document.createElement('span');
        chip.className = 'expense-debt-chip';
        chip.textContent = `Linked to ${linked.name}`;
        name.appendChild(chip);
      }

      info.appendChild(name);
      info.appendChild(details);

      const amount = document.createElement('div');
      amount.className = 'expense-item-amount';
      amount.textContent = `${formatCurrency(exp.monthly_amount)}/mo`;

      const actions = document.createElement('div');
      actions.className = 'expense-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-default';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => editExpense(exp.id));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteExpense(exp.id));

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(amount);
      item.appendChild(actions);
      container.appendChild(item);
    });

    // Update category chart
    await updateExpensesCategoryChart(data);
  } catch (error) {
    console.error('Error loading expenses:', error);
  }
}

/**
 * Update paycheck preview for selected income source.
 */
export async function updatePaycheckPreview(incomeIndex: number | null = null): Promise<void> {
  try {
    const incomeData = await apiCall<IncomeSource[]>('/api/budget/income');
    const container = document.getElementById('paycheck-breakdown');
    if (!container) return;

    if (!incomeData || incomeData.length === 0) {
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'Add income to see paycheck breakdown.';
      container.appendChild(p);
      return;
    }

    // Use provided index or default to selected
    if (incomeIndex !== null) {
      selectedPaycheckIncomeIndex = incomeIndex;
    }
    // Ensure index is valid
    if (selectedPaycheckIncomeIndex >= incomeData.length) {
      selectedPaycheckIncomeIndex = 0;
    }

    // Calculate paycheck for selected income source
    const primaryIncome = incomeData[selectedPaycheckIncomeIndex];
    if (!primaryIncome) return; // Guard against invalid index

    const filingStatus =
      (document.getElementById('filing-status') as HTMLSelectElement | null)?.value || 'single';
    const state =
      (document.getElementById('tax-state') as HTMLSelectElement | null)?.value ||
      primaryIncome.state ||
      'CA';

    const periods = periodsPerYear[primaryIncome.pay_frequency] || 26;
    const grossPerPeriod = primaryIncome.gross_annual / periods;

    // Get deductions for this income source
    const deductions = await apiCall<Deduction[]>('/api/budget/deductions');
    let pretax401k = 0,
      pretaxHsa = 0,
      pretaxFsa = 0,
      pretaxOther = 0;

    if (deductions && deductions.length > 0) {
      for (const ded of deductions) {
        if (ded.deduction_type === '401k') pretax401k = ded.amount_per_period || 0;
        else if (ded.deduction_type === 'hsa') pretaxHsa = ded.amount_per_period || 0;
        else if (ded.deduction_type === 'fsa') pretaxFsa = ded.amount_per_period || 0;
        else pretaxOther += ded.amount_per_period || 0;
      }
    }

    const paycheck = await apiCall<PaycheckBreakdown>('/api/budget/calculate-paycheck', {
      method: 'POST',
      body: {
        gross_per_period: grossPerPeriod,
        pay_frequency: primaryIncome.pay_frequency,
        filing_status: filingStatus,
        state: state,
        pretax_401k: pretax401k,
        pretax_hsa: pretaxHsa,
        pretax_fsa: pretaxFsa,
        pretax_other: pretaxOther,
      },
    });

    if (!paycheck) return;

    // Build the preview using safe DOM methods
    container.textContent = '';

    // Build income switcher if multiple sources
    if (incomeData.length > 1) {
      const switcher = document.createElement('div');
      switcher.className = 'paycheck-income-switcher';
      incomeData.forEach((inc, idx) => {
        const btn = document.createElement('button');
        btn.className =
          'paycheck-income-btn' + (idx === selectedPaycheckIncomeIndex ? ' active' : '');
        btn.textContent = inc.name || `Income ${idx + 1}`;
        btn.addEventListener('click', () => updatePaycheckPreview(idx));
        switcher.appendChild(btn);
      });
      container.appendChild(switcher);
    }

    // Calculate rates
    const grossPay = paycheck.gross || 0;
    const socialSecurity = paycheck.social_security || 0;
    const medicare = (paycheck.medicare || 0) + (paycheck.additional_medicare || 0);
    const pretaxDeductions = paycheck.total_pretax_deductions || 0;
    const totalTaxes = paycheck.total_taxes || 0;

    const effectiveTaxRate = grossPay > 0 ? (totalTaxes / grossPay) * 100 : 0;
    const annualGross = grossPay * (periodsPerYear[primaryIncome.pay_frequency] || 26);
    const marginalRate =
      annualGross > 578125
        ? 37
        : annualGross > 231250
          ? 35
          : annualGross > 182100
            ? 32
            : annualGross > 95375
              ? 24
              : annualGross > 44725
                ? 22
                : annualGross > 11000
                  ? 12
                  : 10;

    // Tax rates callout
    const callout = document.createElement('div');
    callout.className = 'paycheck-tax-rates-callout';

    const effectiveItem = document.createElement('div');
    effectiveItem.className = 'tax-rate-item';
    const effectiveLabel = document.createElement('span');
    effectiveLabel.className = 'tax-rate-label';
    effectiveLabel.textContent = 'Effective Tax Rate';
    const effectiveValue = document.createElement('span');
    effectiveValue.className = 'tax-rate-value';
    effectiveValue.textContent = `${effectiveTaxRate.toFixed(1)}%`;
    effectiveItem.appendChild(effectiveLabel);
    effectiveItem.appendChild(effectiveValue);

    const marginalItem = document.createElement('div');
    marginalItem.className = 'tax-rate-item';
    const marginalLabel = document.createElement('span');
    marginalLabel.className = 'tax-rate-label';
    marginalLabel.textContent = 'Marginal Federal Rate';
    const marginalValue = document.createElement('span');
    marginalValue.className = 'tax-rate-value';
    marginalValue.textContent = `${marginalRate}%`;
    marginalItem.appendChild(marginalLabel);
    marginalItem.appendChild(marginalValue);

    callout.appendChild(effectiveItem);
    callout.appendChild(marginalItem);
    container.appendChild(callout);

    // Breakdown grid
    const grid = document.createElement('div');
    grid.className = 'paycheck-breakdown-grid';

    // Earnings section
    const earningsSection = document.createElement('div');
    earningsSection.className = 'paycheck-section';
    const earningsHeader = document.createElement('h4');
    earningsHeader.textContent = 'Earnings';
    earningsSection.appendChild(earningsHeader);
    earningsSection.appendChild(createPaycheckLine('Gross Pay', formatCurrency(grossPay)));

    // Deductions section
    const deductionsSection = document.createElement('div');
    deductionsSection.className = 'paycheck-section';
    const deductionsHeader = document.createElement('h4');
    deductionsHeader.textContent = 'Deductions';
    deductionsSection.appendChild(deductionsHeader);
    deductionsSection.appendChild(
      createPaycheckLine(
        'Federal Income Tax',
        `-${formatCurrency(paycheck.federal_income_tax || 0)}`,
        'negative'
      )
    );
    deductionsSection.appendChild(
      createPaycheckLine(
        'State Income Tax',
        `-${formatCurrency(paycheck.state_income_tax || 0)}`,
        'negative'
      )
    );
    deductionsSection.appendChild(
      createPaycheckLine('Social Security', `-${formatCurrency(socialSecurity)}`, 'negative')
    );
    deductionsSection.appendChild(
      createPaycheckLine('Medicare', `-${formatCurrency(medicare)}`, 'negative')
    );
    deductionsSection.appendChild(
      createPaycheckLine('Pre-tax Deductions', `-${formatCurrency(pretaxDeductions)}`, 'negative')
    );
    deductionsSection.appendChild(
      createPaycheckLine('Net Pay', formatCurrency(paycheck.net_pay || 0), 'positive', true)
    );

    grid.appendChild(earningsSection);
    grid.appendChild(deductionsSection);
    container.appendChild(grid);
  } catch (error) {
    console.error('Error updating paycheck preview:', error);
  }
}

/**
 * Create a paycheck line item.
 */
function createPaycheckLine(
  label: string,
  amount: string,
  amountClass = '',
  isTotal = false
): HTMLElement {
  const line = document.createElement('div');
  line.className = 'paycheck-line' + (isTotal ? ' total' : '');

  const labelSpan = document.createElement('span');
  labelSpan.className = 'label';
  labelSpan.textContent = label;

  const amountSpan = document.createElement('span');
  amountSpan.className = 'amount' + (amountClass ? ` ${amountClass}` : '');
  amountSpan.textContent = amount;

  line.appendChild(labelSpan);
  line.appendChild(amountSpan);
  return line;
}

/**
 * Load cash flow data and update stats.
 */
export async function loadCashFlowData(): Promise<void> {
  try {
    const filingStatus =
      (document.getElementById('filing-status') as HTMLSelectElement | null)?.value || 'single';
    const state = (document.getElementById('tax-state') as HTMLSelectElement | null)?.value || 'CA';

    const summary = await apiCall<
      CashFlowSummary & {
        monthly_gross?: number;
        monthly_net?: number;
        monthly_expenses?: number;
        monthly_savings?: number;
        total_taxes?: number;
        net_income?: number;
        savings_rate?: number;
      }
    >('/api/budget/calculate-annual', {
      method: 'POST',
      body: {
        filing_status: filingStatus,
        state: state,
        tax_year: new Date().getFullYear(),
      },
    });

    if (!summary) return;

    // Update stats - handle both property name formats
    const monthlyGross = summary.monthly_gross || summary.gross_income / 12 || 0;
    const monthlyTaxes = summary.total_taxes ? summary.total_taxes / 12 : 0;
    const monthlyNet = summary.monthly_net || (summary.net_income ?? 0) / 12 || 0;
    const monthlyExpenses = summary.monthly_expenses || summary.total_expenses / 12 || 0;
    const monthlySavings = summary.monthly_savings || summary.net_savings / 12 || 0;
    const savingsRate = summary.savings_rate || 0;

    const updateStat = (id: string, value: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    updateStat('stat-monthly-gross', formatCurrency(monthlyGross));
    updateStat('stat-monthly-taxes', formatCurrency(monthlyTaxes));
    updateStat('stat-monthly-net', formatCurrency(monthlyNet));
    updateStat('stat-monthly-expenses', formatCurrency(monthlyExpenses));
    updateStat('stat-monthly-savings', formatCurrency(monthlySavings));
    updateStat('stat-savings-rate', `${savingsRate.toFixed(1)}%`);

    const debts = (await fetchLiabilities()).filter((d) => d.is_active);
    const debtCard = document.getElementById('stat-monthly-debt-card');
    if (debtCard) debtCard.hidden = debts.length === 0;
    updateStat(
      'stat-monthly-debt',
      formatCurrency(
        debts
          .filter((d) => d.expense_id && !d.expense_missing)
          .reduce((sum, d) => sum + d.monthly_cash_flow, 0)
      )
    );

    // Load charts
    await loadPaycheckChart();
    await renderCashFlowWaterfall(summary);
  } catch (error) {
    console.error('Error loading cash flow data:', error);
  }
}

/**
 * Run income transition projection.
 */
export async function runTransitionProjection(): Promise<void> {
  const currentAge = getInputValue('transition-current-age', 35);
  const retirementAge = getInputValue('transition-retirement-age', 65);
  const ssAge = getInputValue('transition-ss-age', 67);
  const endAge = getInputValue('transition-end-age', 95);
  const ssOverrideEl = document.getElementById('ss-override') as HTMLInputElement | null;
  const ssOverride = ssOverrideEl?.value ? parseFloat(ssOverrideEl.value) : null;

  try {
    const data = await apiCall<TransitionResponse>('/api/budget/income-transition', {
      method: 'POST',
      body: {
        current_age: currentAge,
        retirement_age: retirementAge,
        ss_claiming_age: ssAge,
        end_age: endAge,
        ss_benefit_override: ssOverride,
      },
    });

    if (data && data.years) {
      await renderTransitionChart(data.years);
      renderSSComparison(data.ss_comparison);
      renderIncomeTransitionTable(data.years);
    }
  } catch (error) {
    console.error('Error running transition projection:', error);
    showToast('Error running projection', 'error');
  }
}

/**
 * Load budget tab data.
 */
export async function loadBudgetTab(): Promise<void> {
  try {
    await Promise.all([loadTaxConfig(), loadIncomeSources(), loadDeductions(), loadExpenses()]);
    updatePaycheckPreview();
  } catch (error) {
    console.error('Error loading budget tab:', error);
  }
}

// =============================================================================
// Modal functions for adding/editing budget items
// =============================================================================

/**
 * Build state options HTML string.
 */
async function buildStateOptions(selectedState = 'CA'): Promise<string> {
  try {
    const states = await apiCall<StateDefinition[]>('/api/budget/states');
    if (states && states.length > 0) {
      return states
        .map((s) => {
          const taxInfo = s.type === 'none' ? ' (No income tax)' : '';
          const selected = s.code === selectedState ? ' selected' : '';
          return `<option value="${escapeHtml(s.code)}"${selected}>${escapeHtml(s.name)}${taxInfo}</option>`;
        })
        .join('');
    }
  } catch {
    console.warn('Could not load states, using default');
  }
  return `<option value="CA"${selectedState === 'CA' ? ' selected' : ''}>California</option>`;
}

/**
 * Show add income modal.
 */
export async function showAddIncomeModal(): Promise<void> {
  const stateOptions = await buildStateOptions();

  createDynamicModal({
    title: 'Add Income Source',
    content: `
      <div class="form-group">
        <label for="income-name">Name</label>
        <input type="text" id="income-name" placeholder="e.g., Primary Job">
      </div>
      <div class="form-group">
        <label for="income-type">Type</label>
        <select id="income-type">
          <option value="employment">Employment (W-2)</option>
          <option value="self_employment">Self-Employment (1099)</option>
          <option value="rental">Rental Income</option>
          <option value="investment">Investment Income</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label for="income-gross">Annual Gross Income</label>
        <input type="number" id="income-gross" placeholder="100000" min="0" step="1000">
      </div>
      <div class="form-group">
        <label for="income-frequency">Pay Frequency</label>
        <select id="income-frequency">
          <option value="weekly">Weekly (52/year)</option>
          <option value="biweekly" selected>Bi-weekly (26/year)</option>
          <option value="semimonthly">Semi-monthly (24/year)</option>
          <option value="monthly">Monthly (12/year)</option>
        </select>
      </div>
      <div class="form-group">
        <label for="income-state">State</label>
        <select id="income-state">${stateOptions}</select>
      </div>
    `,
    onSave: async () => {
      const data = {
        name: (document.getElementById('income-name') as HTMLInputElement).value,
        income_type: (document.getElementById('income-type') as HTMLSelectElement).value,
        gross_annual:
          parseFloat((document.getElementById('income-gross') as HTMLInputElement).value) || 0,
        pay_frequency: (document.getElementById('income-frequency') as HTMLSelectElement).value,
        state: (document.getElementById('income-state') as HTMLSelectElement).value,
      };

      await apiCall('/api/budget/income', {
        method: 'POST',
        body: data,
      });

      closeModal();
      loadIncomeSources();
      updatePaycheckPreview();
      showToast('Income source added', 'success');
    },
  });
}

/**
 * Show add expense modal.
 */
export function showAddExpenseModal(): void {
  createDynamicModal({
    title: 'Add Expense',
    content: `
      <div class="form-group">
        <label for="expense-name">Name</label>
        <input type="text" id="expense-name" placeholder="e.g., Mortgage">
      </div>
      <div class="form-group">
        <label for="expense-category">Category</label>
        <select id="expense-category">
          <option value="1">Housing</option>
          <option value="2">Utilities</option>
          <option value="3">Transportation</option>
          <option value="4">Insurance</option>
          <option value="5">Healthcare</option>
          <option value="6">Debt Payments</option>
          <option value="7">Food & Dining</option>
          <option value="8">Entertainment</option>
          <option value="9">Savings & Investments</option>
          <option value="10">Personal</option>
          <option value="11">Education</option>
          <option value="12">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label for="expense-amount">Amount</label>
        <input type="number" id="expense-amount" placeholder="2000" min="0" step="10">
      </div>
      <div class="form-group">
        <label for="expense-frequency">Frequency</label>
        <select id="expense-frequency">
          <option value="monthly" selected>Monthly</option>
          <option value="biweekly">Bi-weekly</option>
          <option value="weekly">Weekly</option>
          <option value="annual">Annual</option>
        </select>
      </div>
    `,
    onSave: async () => {
      const data = {
        name: (document.getElementById('expense-name') as HTMLInputElement).value,
        category_id: (document.getElementById('expense-category') as HTMLSelectElement).value,
        amount:
          parseFloat((document.getElementById('expense-amount') as HTMLInputElement).value) || 0,
        frequency: (document.getElementById('expense-frequency') as HTMLSelectElement).value,
      };

      await apiCall('/api/budget/expenses', {
        method: 'POST',
        body: data,
      });

      closeModal();
      loadExpenses();
      showToast('Expense added', 'success');
    },
  });
}

/**
 * Show add deduction modal.
 */
export function showAddDeductionModal(): void {
  createDynamicModal({
    title: 'Add Pre-tax Deduction',
    content: `
      <div class="form-group">
        <label for="deduction-label">Label (optional)</label>
        <input type="text" id="deduction-label" placeholder="e.g., John's 401k, Jane's HSA">
        <small style="color: var(--text-secondary); font-size: 0.85em;">Helpful for tracking multiple people's deductions</small>
      </div>
      <div class="form-group">
        <label for="deduction-type">Deduction Type</label>
        <select id="deduction-type">
          <option value="401k">401(k) Contribution</option>
          <option value="hsa">HSA Contribution</option>
          <option value="fsa">FSA (Healthcare/Dependent Care)</option>
          <option value="dental">Dental Insurance</option>
          <option value="vision">Vision Insurance</option>
          <option value="other">Other Pre-tax</option>
        </select>
      </div>
      <div class="form-group">
        <label for="deduction-amount">Amount Per Pay Period</label>
        <input type="number" id="deduction-amount" placeholder="500" min="0" step="25">
      </div>
      <div class="form-group">
        <label for="deduction-match">Employer Match Per Period (optional)</label>
        <input type="number" id="deduction-match" placeholder="250" min="0" step="25">
      </div>
    `,
    onSave: async () => {
      const data = {
        label: (document.getElementById('deduction-label') as HTMLInputElement).value || null,
        deduction_type: (document.getElementById('deduction-type') as HTMLSelectElement).value,
        amount_per_period:
          parseFloat((document.getElementById('deduction-amount') as HTMLInputElement).value) || 0,
        employer_match:
          parseFloat((document.getElementById('deduction-match') as HTMLInputElement).value) || 0,
      };

      await apiCall('/api/budget/deductions', {
        method: 'POST',
        body: data,
      });

      closeModal();
      loadDeductions();
      updatePaycheckPreview();
      showToast('Deduction added', 'success');
    },
  });
}

/**
 * Delete income source.
 */
export async function deleteIncome(id: string): Promise<void> {
  if (confirm('Delete this income source?')) {
    await apiCall(`/api/budget/income/${id}`, { method: 'DELETE' });
    loadIncomeSources();
    updatePaycheckPreview();
  }
}

/**
 * Delete expense.
 */
export async function deleteExpense(id: string): Promise<void> {
  if (confirm('Delete this expense?')) {
    await apiCall(`/api/budget/expenses/${id}`, { method: 'DELETE' });
    loadExpenses();
  }
}

/**
 * Delete deduction.
 */
export async function deleteDeduction(id: string): Promise<void> {
  if (confirm('Delete this deduction?')) {
    await apiCall(`/api/budget/deductions/${id}`, { method: 'DELETE' });
    loadDeductions();
    updatePaycheckPreview();
  }
}

/**
 * Edit income source.
 */
export function editIncome(id: string): void {
  const incomes = store.get('incomeSources');
  const income = incomes.find((i) => i.id === id);
  if (!income) {
    showToast('Income source not found', 'error');
    return;
  }

  createDynamicModal({
    title: 'Edit Income Source',
    content: `
      <div class="form-group">
        <label for="income-name">Name</label>
        <input type="text" id="income-name" value="${escapeHtml(income.name || '')}">
      </div>
      <div class="form-group">
        <label for="income-type">Type</label>
        <select id="income-type">
          <option value="employment"${income.income_type === 'employment' ? ' selected' : ''}>Employment (W-2)</option>
          <option value="self_employment"${income.income_type === 'self_employment' ? ' selected' : ''}>Self-Employment (1099)</option>
          <option value="rental"${income.income_type === 'rental' ? ' selected' : ''}>Rental Income</option>
          <option value="investment"${income.income_type === 'investment' ? ' selected' : ''}>Investment Income</option>
          <option value="other"${income.income_type === 'other' ? ' selected' : ''}>Other</option>
        </select>
      </div>
      <div class="form-group">
        <label for="income-gross">Annual Gross Income</label>
        <input type="number" id="income-gross" value="${income.gross_annual || ''}" min="0" step="1000">
      </div>
      <div class="form-group">
        <label for="income-frequency">Pay Frequency</label>
        <select id="income-frequency">
          <option value="weekly"${income.pay_frequency === 'weekly' ? ' selected' : ''}>Weekly (52/year)</option>
          <option value="biweekly"${income.pay_frequency === 'biweekly' ? ' selected' : ''}>Bi-weekly (26/year)</option>
          <option value="semimonthly"${income.pay_frequency === 'semimonthly' ? ' selected' : ''}>Semi-monthly (24/year)</option>
          <option value="monthly"${income.pay_frequency === 'monthly' ? ' selected' : ''}>Monthly (12/year)</option>
        </select>
      </div>
      <div class="form-group">
        <label for="income-state">State</label>
        <select id="income-state">
          <option value="CA"${income.state === 'CA' ? ' selected' : ''}>California</option>
          <option value="NY"${income.state === 'NY' ? ' selected' : ''}>New York</option>
          <option value="TX"${income.state === 'TX' ? ' selected' : ''}>Texas</option>
          <option value="FL"${income.state === 'FL' ? ' selected' : ''}>Florida</option>
          <option value="WA"${income.state === 'WA' ? ' selected' : ''}>Washington</option>
        </select>
      </div>
    `,
    onSave: async () => {
      const data = {
        name: (document.getElementById('income-name') as HTMLInputElement).value,
        income_type: (document.getElementById('income-type') as HTMLSelectElement).value,
        gross_annual:
          parseFloat((document.getElementById('income-gross') as HTMLInputElement).value) || 0,
        pay_frequency: (document.getElementById('income-frequency') as HTMLSelectElement).value,
        state: (document.getElementById('income-state') as HTMLSelectElement).value,
      };

      await apiCall(`/api/budget/income/${id}`, {
        method: 'PUT',
        body: data,
      });

      closeModal();
      loadIncomeSources();
      updatePaycheckPreview();
      showToast('Income source updated', 'success');
    },
  });
}

/**
 * Edit expense.
 */
export function editExpense(id: string): void {
  const expenseList = store.get('expenses');
  const expense = expenseList.find((e) => e.id === id);
  if (!expense) {
    showToast('Expense not found', 'error');
    return;
  }

  const linkedDebt = debtByExpense.get(id);
  const modal = createDynamicModal({
    title: 'Edit Expense',
    content: `
      <div class="form-group">
        <label for="expense-name">Name</label>
        <input type="text" id="expense-name" value="${escapeHtml(expense.name || '')}">
      </div>
      <div class="form-group">
        <label for="expense-category">Category</label>
        <select id="expense-category">
          <option value="1"${expense.category_id === '1' ? ' selected' : ''}>Housing</option>
          <option value="2"${expense.category_id === '2' ? ' selected' : ''}>Utilities</option>
          <option value="3"${expense.category_id === '3' ? ' selected' : ''}>Transportation</option>
          <option value="4"${expense.category_id === '4' ? ' selected' : ''}>Insurance</option>
          <option value="5"${expense.category_id === '5' ? ' selected' : ''}>Healthcare</option>
          <option value="6"${expense.category_id === '6' ? ' selected' : ''}>Debt Payments</option>
          <option value="7"${expense.category_id === '7' ? ' selected' : ''}>Food & Dining</option>
          <option value="8"${expense.category_id === '8' ? ' selected' : ''}>Entertainment</option>
          <option value="9"${expense.category_id === '9' ? ' selected' : ''}>Savings & Investments</option>
          <option value="10"${expense.category_id === '10' ? ' selected' : ''}>Personal</option>
          <option value="11"${expense.category_id === '11' ? ' selected' : ''}>Education</option>
          <option value="12"${expense.category_id === '12' ? ' selected' : ''}>Other</option>
        </select>
      </div>
      <div class="form-group">
        <label for="expense-amount">Monthly Amount</label>
        <input type="number" id="expense-amount" value="${expense.monthly_amount || ''}" min="0" step="10">
      </div>
      <div class="form-group">
        <label for="expense-frequency">Frequency</label>
        <select id="expense-frequency">
          <option value="monthly"${expense.frequency === 'monthly' ? ' selected' : ''}>Monthly</option>
          <option value="weekly"${expense.frequency === 'weekly' ? ' selected' : ''}>Weekly</option>
          <option value="biweekly"${expense.frequency === 'biweekly' ? ' selected' : ''}>Bi-weekly</option>
          <option value="quarterly"${expense.frequency === 'quarterly' ? ' selected' : ''}>Quarterly</option>
          <option value="annual"${expense.frequency === 'annual' ? ' selected' : ''}>Annual</option>
          <option value="one_time"${expense.frequency === 'one_time' ? ' selected' : ''}>One-time</option>
        </select>
      </div>
    `,
    onSave: async () => {
      const data = {
        name: (document.getElementById('expense-name') as HTMLInputElement).value,
        category_id: (document.getElementById('expense-category') as HTMLSelectElement).value,
        amount:
          parseFloat((document.getElementById('expense-amount') as HTMLInputElement).value) || 0,
        frequency: (document.getElementById('expense-frequency') as HTMLSelectElement).value,
      };

      await apiCall(`/api/budget/expenses/${id}`, {
        method: 'PUT',
        body: data,
      });

      closeModal();
      loadExpenses();
      showToast('Expense updated', 'success');
    },
  });
  if (linkedDebt) {
    const hint = document.createElement('p');
    hint.className = 'expense-debt-hint';
    hint.textContent = `This expense follows the debt ${linkedDebt.name}. Change the payment on the Debts page and this amount updates with it.`;
    modal.querySelector('.modal-body')?.prepend(hint);
  }
}

/**
 * Edit deduction.
 */
export function editDeduction(id: string): void {
  const deductionList = store.get('deductions');
  const deduction = deductionList.find((d) => d.id === id);
  if (!deduction) {
    showToast('Deduction not found', 'error');
    return;
  }

  createDynamicModal({
    title: 'Edit Pre-tax Deduction',
    content: `
      <div class="form-group">
        <label for="deduction-type">Type</label>
        <select id="deduction-type">
          <option value="401k"${deduction.deduction_type === '401k' ? ' selected' : ''}>401(k)</option>
          <option value="hsa"${deduction.deduction_type === 'hsa' ? ' selected' : ''}>HSA</option>
          <option value="fsa"${deduction.deduction_type === 'fsa' ? ' selected' : ''}>FSA</option>
          <option value="dental"${deduction.deduction_type === 'dental' ? ' selected' : ''}>Dental Insurance</option>
          <option value="vision"${deduction.deduction_type === 'vision' ? ' selected' : ''}>Vision Insurance</option>
          <option value="other"${deduction.deduction_type === 'other' ? ' selected' : ''}>Other Pre-tax</option>
        </select>
      </div>
      <div class="form-group">
        <label for="deduction-amount">Amount per Period</label>
        <input type="number" id="deduction-amount" value="${deduction.amount_per_period || ''}" min="0" step="10">
      </div>
      <div class="form-group">
        <label for="deduction-match">Employer Match (%)</label>
        <input type="number" id="deduction-match" value="${deduction.employer_match || 0}" min="0" max="100" step="0.5">
      </div>
    `,
    onSave: async () => {
      const data = {
        deduction_type: (document.getElementById('deduction-type') as HTMLSelectElement).value,
        amount_per_period:
          parseFloat((document.getElementById('deduction-amount') as HTMLInputElement).value) || 0,
        employer_match:
          parseFloat((document.getElementById('deduction-match') as HTMLInputElement).value) || 0,
      };

      await apiCall(`/api/budget/deductions/${id}`, {
        method: 'PUT',
        body: data,
      });

      closeModal();
      loadDeductions();
      updatePaycheckPreview();
      showToast('Deduction updated', 'success');
    },
  });
}

/**
 * Initialize budget page.
 */
export function initBudget(): void {
  // Budget sub-tab navigation
  document.querySelectorAll('.budget-nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const tabName = (item as HTMLElement).dataset.budgetTab;
      if (tabName) {
        showBudgetTab(tabName);
      }
    });
  });

  // Tax config changes
  const filingStatus = document.getElementById('filing-status');
  const taxState = document.getElementById('tax-state');
  if (filingStatus) {
    filingStatus.addEventListener('change', updateBudgetCalc);
  }
  if (taxState) {
    taxState.addEventListener('change', updateBudgetCalc);
  }

  // Add buttons
  const addIncomeBtn = document.getElementById('add-income-btn');
  if (addIncomeBtn) {
    addIncomeBtn.addEventListener('click', showAddIncomeModal);
  }

  const addExpenseBtn = document.getElementById('add-expense-btn');
  if (addExpenseBtn) {
    addExpenseBtn.addEventListener('click', showAddExpenseModal);
  }

  const addDeductionBtn = document.getElementById('add-deduction-btn');
  if (addDeductionBtn) {
    addDeductionBtn.addEventListener('click', showAddDeductionModal);
  }

  // Transition projection form
  const transitionForm = document.getElementById('transition-form');
  if (transitionForm) {
    transitionForm.addEventListener('submit', (e) => {
      e.preventDefault();
      runTransitionProjection();
    });
  }

  // Run transition button
  const runTransitionBtn = document.getElementById('run-transition-btn');
  if (runTransitionBtn) {
    runTransitionBtn.addEventListener('click', runTransitionProjection);
  }

  // Load budget data when switching to the budget tab
  onTabChange((tab) => {
    if (tab === 'budget') {
      loadBudgetTab();
    }
  });
}
