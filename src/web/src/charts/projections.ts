/**
 * Projection chart rendering for Monte Carlo, tax burden, and account balances.
 */

import {
  ensureThemeUpdates,
  renderChart,
  getBaseLayout,
  getAxisConfig,
  chartPalette,
} from './plotly-utils';
import { getChartColors } from '@/state/theme';
import { formatCurrency } from '@/utils/format';
import { today } from '@/utils/clock';
import { debtByYear, debtPayoffSummary, formatMonthYear } from '@/utils/liabilities';
import type { LiabilityResponse } from '@/types/api';

/**
 * Monte Carlo projection result from API.
 */
export interface MonteCarloProjectionResult {
  success_rate: number;
  median_final_value: number;
  worst_case_final: number;
  best_case_final: number;
  ages: number[];
  median_values: number[];
  percentile_10: number[];
  percentile_25: number[];
  percentile_75: number[];
  percentile_90: number[];
}

/**
 * Tax burden chart data from API.
 */
export interface TaxBurdenChartData {
  ages: number[];
  federal_taxes: number[];
  state_taxes: number[];
  effective_rates: number[];
}

/**
 * Account balance chart data from API.
 */
export interface AccountBalanceChartData {
  ages: number[];
  taxable_balances: number[];
  traditional_balances: number[];
  roth_balances: number[];
  total_balances: number[];
}

/**
 * Tax withdrawal year data for table.
 */
export interface TaxWithdrawalYear {
  age: number;
  phase: 'accumulation' | 'withdrawal';
  total_balance: number;
  rmd_amount: number;
  from_taxable: number;
  from_traditional: number;
  from_roth: number;
  federal_tax: number;
  state_tax: number;
  effective_rate: number;
  net_withdrawal: number;
}

/**
 * Get hover label configuration for current theme.
 */
function getHoverLabel(): Record<string, unknown> {
  const colors = getChartColors();
  return {
    bgcolor:
      colors.background === 'transparent'
        ? colors.text.includes('255')
          ? '#1f1f1f'
          : 'white'
        : colors.background,
    bordercolor: colors.grid,
    font: { color: colors.text },
  };
}

/**
 * Display Monte Carlo projection results.
 * Shows success rate stats and renders the projection chart.
 * @param result - Monte Carlo result from API
 * @param retirementAge - User's retirement age for vertical marker
 */
export async function displayProjectionResults(
  result: MonteCarloProjectionResult,
  retirementAge: number,
  liabilities: readonly LiabilityResponse[] = []
): Promise<void> {
  const resultsContainer = document.getElementById('projection-results');
  if (resultsContainer) {
    resultsContainer.style.display = 'block';
  }

  // Update success rate display with color coding
  const successRate = result.success_rate * 100;
  const successEl = document.getElementById('success-rate');
  if (successEl) {
    successEl.textContent = `${successRate.toFixed(1)}%`;
    successEl.className =
      'stat-value ' +
      (successRate >= 90 ? 'text-success' : successRate >= 70 ? 'text-warning' : 'text-error');
  }

  // Update summary stats
  const medianEl = document.getElementById('median-final');
  if (medianEl) medianEl.textContent = formatCurrency(result.median_final_value);

  const worstEl = document.getElementById('worst-case');
  if (worstEl) worstEl.textContent = formatCurrency(result.worst_case_final);

  const bestEl = document.getElementById('best-case');
  if (bestEl) bestEl.textContent = formatCurrency(result.best_case_final);

  const colors = getChartColors();
  const retirementIdx = result.ages.indexOf(retirementAge);
  const now = today();
  const firstAge = result.ages[0] ?? 0;
  const payoff = debtPayoffSummary(liabilities, now, firstAge);
  renderDebtPayoffCard(payoff);
  const debtTrace: {
    x: number[];
    y: number[];
    type: 'scatter';
    mode: 'lines';
    name: string;
    line: { color: string; width: number; dash: string };
  }[] = [];
  if (payoff) {
    const owed = debtByYear(
      liabilities,
      now,
      Math.max(0, (result.ages.at(-1) ?? firstAge) - firstAge)
    );
    debtTrace.push({
      x: result.ages,
      y: result.median_values.map(
        (v, i) => v - (owed[Math.max(0, Math.round((result.ages[i] ?? firstAge) - firstAge))] ?? 0)
      ),
      type: 'scatter',
      mode: 'lines',
      name: 'Median minus debt',
      line: { color: chartPalette.purple, width: 2, dash: 'dash' },
    });
  }

  // Render Monte Carlo fan chart
  ensureThemeUpdates('chart-projection');
  await renderChart(
    'chart-projection',
    [
      {
        x: result.ages,
        y: result.percentile_90,
        type: 'scatter',
        mode: 'lines',
        name: '90th %',
        line: { color: chartPalette.green, width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(34, 197, 94, 0.1)',
      },
      {
        x: result.ages,
        y: result.percentile_75,
        type: 'scatter',
        mode: 'lines',
        name: '75th %',
        line: { color: chartPalette.green, width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(34, 197, 94, 0.15)',
      },
      {
        x: result.ages,
        y: result.median_values,
        type: 'scatter',
        mode: 'lines',
        name: 'Median',
        line: { color: chartPalette.blue, width: 3 },
      },
      {
        x: result.ages,
        y: result.percentile_25,
        type: 'scatter',
        mode: 'lines',
        name: '25th %',
        line: { color: chartPalette.orange, width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(249, 115, 22, 0.15)',
      },
      {
        x: result.ages,
        y: result.percentile_10,
        type: 'scatter',
        mode: 'lines',
        name: '10th %',
        line: { color: chartPalette.red, width: 1 },
        fill: 'tonexty',
        fillcolor: 'rgba(239, 68, 68, 0.1)',
      },
      ...debtTrace,
    ],
    {
      ...getBaseLayout(),
      margin: { t: 20, b: 40, l: 100, r: 20 },
      xaxis: {
        ...getAxisConfig(),
        title: 'Age',
      },
      yaxis: {
        ...getAxisConfig(),
        title: { text: 'Portfolio Value', standoff: 15 },
        tickformat: '$,.0f',
        automargin: true,
      },
      legend: { orientation: 'h', y: 1.15 },
      hoverlabel: getHoverLabel(),
      shapes:
        retirementIdx >= 0
          ? [
              {
                type: 'line',
                x0: retirementAge,
                x1: retirementAge,
                y0: 0,
                y1: 1,
                yref: 'paper',
                line: { color: colors.grid, width: 2, dash: 'dash' },
              },
            ]
          : [],
    },
    { responsive: true, displayModeBar: false }
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Fill #debt-payoff-card from the summary, or hide it when there is none. */
function renderDebtPayoffCard(summary: ReturnType<typeof debtPayoffSummary>): void {
  const card = document.getElementById('debt-payoff-card');
  if (!card) return;
  card.textContent = '';
  card.hidden = summary === null;
  if (!summary) return;
  const free = summary.debtFreeDate
    ? `Debt-free by ${formatMonthYear(summary.debtFreeDate)}${summary.debtFreeAge === null ? '' : ` (age ${summary.debtFreeAge})`}`
    : 'No payoff date yet';
  card.appendChild(el('h4', 'debt-payoff-title', free));
  card.appendChild(
    el('p', 'debt-payoff-sub', `${formatCurrency(summary.interestLeft)} of interest still to pay`)
  );
  const list = el('ul', 'debt-payoff-list', '');
  for (const d of summary.debts) {
    const li = el('li', 'debt-payoff-item', '');
    li.appendChild(el('span', 'debt-payoff-name', d.name));
    li.appendChild(
      el(
        'span',
        'debt-payoff-date',
        d.payoffDate ? formatMonthYear(d.payoffDate) : 'No payoff date'
      )
    );
    list.appendChild(li);
  }
  card.appendChild(list);
  card.appendChild(
    el('p', 'debt-payoff-note', "Projections don't move paid-off payments into savings yet.")
  );
}

/**
 * Render tax burden chart with stacked bars and effective rate line.
 * @param chartData - Tax burden data from API
 */
export async function renderTaxBurdenChart(chartData: TaxBurdenChartData): Promise<void> {
  const colors = getChartColors();

  // Calculate max effective rate for y2 axis scaling
  const validRates = chartData.effective_rates.filter((r) => r > 0);
  const maxRate = validRates.length > 0 ? Math.max(...validRates, 30) : 30;

  ensureThemeUpdates('tax-burden-chart');

  await renderChart(
    'tax-burden-chart',
    [
      {
        x: chartData.ages,
        y: chartData.federal_taxes,
        type: 'bar',
        name: 'Federal Tax',
        marker: { color: chartPalette.blue },
      },
      {
        x: chartData.ages,
        y: chartData.state_taxes,
        type: 'bar',
        name: 'State Tax',
        marker: { color: chartPalette.purple },
      },
      {
        x: chartData.ages,
        y: chartData.effective_rates,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Effective Rate (%)',
        yaxis: 'y2',
        line: { color: chartPalette.orange, width: 2 },
        marker: { size: 4 },
      },
    ],
    {
      ...getBaseLayout(),
      barmode: 'stack',
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.15,
      },
      margin: { t: 20, r: 60, b: 60, l: 60 },
      xaxis: {
        ...getAxisConfig(),
        title: 'Age',
      },
      yaxis: {
        ...getAxisConfig(),
        title: 'Tax Amount',
        tickprefix: '$',
        tickformat: '.2s',
      },
      yaxis2: {
        title: 'Effective Rate (%)',
        overlaying: 'y',
        side: 'right',
        color: colors.text,
        ticksuffix: '%',
        range: [0, maxRate * 1.2],
      },
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Render account balance projection chart with area fills.
 * @param chartData - Account balance data from API
 */
export async function renderAccountBalanceChart(chartData: AccountBalanceChartData): Promise<void> {
  const colors = getChartColors();

  ensureThemeUpdates('tax-balance-chart');

  await renderChart(
    'tax-balance-chart',
    [
      {
        x: chartData.ages,
        y: chartData.taxable_balances,
        type: 'scatter',
        mode: 'lines',
        name: 'Taxable',
        line: { color: chartPalette.green, width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(34, 197, 94, 0.1)',
      },
      {
        x: chartData.ages,
        y: chartData.traditional_balances,
        type: 'scatter',
        mode: 'lines',
        name: 'Traditional (IRA/401k)',
        line: { color: chartPalette.orange, width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(249, 115, 22, 0.1)',
      },
      {
        x: chartData.ages,
        y: chartData.roth_balances,
        type: 'scatter',
        mode: 'lines',
        name: 'Roth',
        line: { color: chartPalette.cyan, width: 2 },
        fill: 'tozeroy',
        fillcolor: 'rgba(6, 182, 212, 0.1)',
      },
      {
        x: chartData.ages,
        y: chartData.total_balances,
        type: 'scatter',
        mode: 'lines',
        name: 'Total',
        line: { color: colors.text, width: 2, dash: 'dash' },
      },
    ],
    {
      ...getBaseLayout(),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.15,
      },
      margin: { t: 20, r: 20, b: 60, l: 60 },
      xaxis: {
        ...getAxisConfig(),
        title: 'Age',
      },
      yaxis: {
        ...getAxisConfig(),
        title: 'Balance',
        tickprefix: '$',
        tickformat: '.2s',
      },
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Render tax withdrawal table for retirement years.
 * @param years - Array of withdrawal year data from API
 */
export function renderTaxWithdrawalTable(years: TaxWithdrawalYear[] | null): void {
  const tbody = document.querySelector('#tax-withdrawal-table tbody');
  if (!tbody) return;

  // Clear existing rows safely
  while (tbody.firstChild) {
    tbody.removeChild(tbody.firstChild);
  }

  if (!years || years.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
    cell.className = 'text-muted';
    cell.textContent = 'No data available';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  // Filter to only show retirement years (withdrawal phase)
  const retirementYears = years.filter((year) => year.phase === 'withdrawal');

  if (retirementYears.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
    cell.className = 'text-muted';
    cell.textContent = 'No retirement years in projection';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  retirementYears.forEach((year) => {
    const row = document.createElement('tr');

    const cells = [
      year.age.toString(),
      formatCurrency(year.total_balance),
      year.rmd_amount > 0 ? formatCurrency(year.rmd_amount) : '-',
      year.from_taxable > 0 ? formatCurrency(year.from_taxable) : '-',
      year.from_traditional > 0 ? formatCurrency(year.from_traditional) : '-',
      year.from_roth > 0 ? formatCurrency(year.from_roth) : '-',
      formatCurrency(year.federal_tax),
      formatCurrency(year.state_tax),
      `${year.effective_rate.toFixed(1)}%`,
      formatCurrency(year.net_withdrawal),
    ];

    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      row.appendChild(td);
    });

    tbody.appendChild(row);
  });
}
