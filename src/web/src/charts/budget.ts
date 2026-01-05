/**
 * Budget chart rendering for paycheck, cash flow, expenses, and transitions.
 */

import {
  renderChart,
  getBaseLayout,
  getAxisConfig,
  chartPalette,
  getColorByIndex,
} from './plotly-utils';
import { getChartColors } from '@/state/theme';
import { apiCall } from '@/api/client';
import { formatCurrency } from '@/utils/format';

/**
 * Paycheck chart data from API.
 */
export interface PaycheckChartData {
  periods: number[];
  gross: number[];
  takehome: number[];
  federal_tax: number[];
  state_tax: number[];
  social_security?: number[];
  fica?: number[];
  medicare?: number[];
  pretax: number[];
  limits?: {
    ss_wage_base: number;
    limit_401k: number;
  };
}

/**
 * Cash flow summary from API.
 */
export interface CashFlowSummary {
  gross_income: number;
  federal_income_tax: number;
  state_income_tax: number;
  social_security_tax: number;
  medicare_tax: number;
  total_pretax_deductions: number;
  total_expenses: number;
  net_savings: number;
}

/**
 * Expense item for chart.
 */
export interface ExpenseChartItem {
  category_name?: string;
  monthly_amount: number;
}

/**
 * Transition year data from API.
 */
export interface TransitionYear {
  age: number;
  employment_income: number;
  withdrawal_needed: number;
  ss_income: number;
  total_income: number;
}

/**
 * Social Security comparison row.
 */
export interface SSComparisonRow {
  claiming_age: number;
  monthly_benefit: number;
  annual_benefit: number;
  percent_of_fra: number;
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
          ? '#1e1e1e'
          : '#ffffff'
        : colors.background,
    bordercolor: colors.grid,
    font: { color: colors.text },
  };
}

/**
 * Show empty state message in a container.
 */
function showEmptyState(container: HTMLElement, message: string): void {
  container.textContent = '';
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = message;
  container.appendChild(p);
}

/**
 * Load and render paycheck YTD cumulative chart.
 * Shows gross income, taxes, and deductions over pay periods.
 */
export async function loadPaycheckChart(): Promise<void> {
  const container = document.getElementById('paycheck-chart');

  try {
    const chartData = await apiCall<PaycheckChartData>('/api/budget/paycheck-chart-data');

    if (!chartData || !chartData.periods || chartData.periods.length === 0) {
      if (container) {
        showEmptyState(container, 'Add income to see paycheck breakdown chart.');
      }
      return;
    }

    const colors = getChartColors();

    // Build annotations for SS wage cap
    const annotations: Record<string, unknown>[] = [];
    if (chartData.limits && chartData.gross && chartData.gross.length > 0) {
      const finalGross = chartData.gross[chartData.gross.length - 1];
      if (finalGross !== undefined && finalGross > chartData.limits.ss_wage_base) {
        const capPeriod = chartData.gross.findIndex((g) => g >= chartData.limits!.ss_wage_base) + 1;
        if (capPeriod > 0) {
          const ssTax = chartData.social_security || chartData.fica || [];
          annotations.push({
            x: capPeriod,
            y: ssTax[capPeriod - 1] || 0,
            text: 'SS Cap Reached',
            showarrow: true,
            arrowhead: 2,
            ax: 40,
            ay: -30,
            font: { size: 10, color: chartPalette.yellow },
          });
        }
      }
    }

    const ssTax = chartData.social_security || chartData.fica || [];

    await renderChart(
      'paycheck-chart',
      [
        {
          name: 'Gross Income',
          x: chartData.periods,
          y: chartData.gross,
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.blue, width: 2 },
          fill: 'tozeroy',
          fillcolor: 'rgba(59, 130, 246, 0.1)',
        },
        {
          name: 'Take-home',
          x: chartData.periods,
          y: chartData.takehome,
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.green, width: 2 },
        },
        {
          name: 'Federal Tax',
          x: chartData.periods,
          y: chartData.federal_tax,
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.red, width: 2 },
        },
        {
          name: 'State Tax',
          x: chartData.periods,
          y: chartData.state_tax,
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.orange, width: 2 },
        },
        {
          name: 'Social Security',
          x: chartData.periods,
          y: ssTax,
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.yellow, width: 2 },
          hovertemplate: chartData.limits
            ? `Period %{x}<br>YTD SS: $%{y:,.0f}<br>Cap: $${chartData.limits.ss_wage_base.toLocaleString()} wage base<extra></extra>`
            : undefined,
        },
        {
          name: 'Medicare',
          x: chartData.periods,
          y: chartData.medicare || [],
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.purple, width: 2 },
          visible: chartData.medicare ? true : 'legendonly',
        },
        {
          name: 'Pre-tax (401k/HSA)',
          x: chartData.periods,
          y: chartData.pretax,
          type: 'scatter',
          mode: 'lines',
          line: { color: chartPalette.indigo, width: 2, dash: 'dot' },
          hovertemplate: chartData.limits
            ? `Period %{x}<br>YTD Pre-tax: $%{y:,.0f}<br>401k limit: $${chartData.limits.limit_401k.toLocaleString()}<extra></extra>`
            : undefined,
        },
      ],
      {
        ...getBaseLayout(),
        margin: { t: 20, r: 20, b: 80, l: 70 },
        xaxis: {
          ...getAxisConfig(),
          title: 'Pay Period',
          tickmode: 'linear',
          dtick: Math.ceil(chartData.periods.length / 13),
        },
        yaxis: {
          ...getAxisConfig(),
          title: 'Cumulative YTD ($)',
          tickformat: '$,.0f',
        },
        legend: {
          orientation: 'h',
          y: -0.2,
          font: { color: colors.text },
        },
        annotations,
        hovermode: 'x unified',
        hoverlabel: getHoverLabel(),
      },
      { responsive: true, displayModeBar: false }
    );
  } catch (error) {
    console.error('Error loading paycheck chart:', error);
    if (container) {
      showEmptyState(container, 'Error loading paycheck data.');
    }
  }
}

/**
 * Render cash flow waterfall chart.
 * Shows income breakdown from gross to net savings.
 * @param summary - Cash flow summary data
 */
export async function renderCashFlowWaterfall(summary: CashFlowSummary): Promise<void> {
  const colors = getChartColors();

  await renderChart(
    'cashflow-waterfall-chart',
    [
      {
        type: 'waterfall',
        orientation: 'v',
        x: [
          'Gross Income',
          'Federal Tax',
          'State Tax',
          'FICA',
          'Pre-tax',
          'Net Income',
          'Expenses',
          'Savings',
        ],
        y: [
          summary.gross_income,
          -summary.federal_income_tax,
          -summary.state_income_tax,
          -(summary.social_security_tax + summary.medicare_tax),
          -summary.total_pretax_deductions,
          0, // subtotal
          -summary.total_expenses,
          0, // final total
        ],
        measure: [
          'absolute',
          'relative',
          'relative',
          'relative',
          'relative',
          'total',
          'relative',
          'total',
        ],
        connector: { line: { color: colors.grid } },
        decreasing: { marker: { color: chartPalette.red } },
        increasing: { marker: { color: chartPalette.green } },
        totals: { marker: { color: chartPalette.blue } },
      },
    ],
    {
      ...getBaseLayout(),
      margin: { t: 20, r: 20, b: 60, l: 80 },
      xaxis: {
        ...getAxisConfig(),
      },
      yaxis: {
        ...getAxisConfig(),
        title: 'Annual Amount ($)',
        tickformat: '$,.0f',
      },
      showlegend: false,
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Update expenses category pie chart.
 * @param expenses - Array of expense items
 */
export async function updateExpensesCategoryChart(
  expenses: ExpenseChartItem[] | null
): Promise<void> {
  const container = document.getElementById('expenses-category-chart');

  if (!expenses || expenses.length === 0) {
    if (container) {
      showEmptyState(container, 'Add expenses to see category breakdown.');
    }
    return;
  }

  // Group by category
  const byCategory: Record<string, number> = {};
  expenses.forEach((exp) => {
    const cat = exp.category_name || 'Other';
    byCategory[cat] = (byCategory[cat] || 0) + exp.monthly_amount;
  });

  const labels = Object.keys(byCategory);
  const values = Object.values(byCategory);
  const colors = getChartColors();

  await renderChart(
    'expenses-category-chart',
    [
      {
        type: 'pie',
        labels,
        values,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'outside',
        textfont: { color: colors.text },
        marker: {
          colors: labels.map((_, i) => getColorByIndex(i)),
        },
      },
    ],
    {
      ...getBaseLayout(),
      margin: { t: 20, r: 20, b: 20, l: 20 },
      showlegend: false,
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Render income transition stacked area chart.
 * Shows employment income, portfolio withdrawals, and Social Security over time.
 * @param years - Array of transition year data
 */
export async function renderTransitionChart(years: TransitionYear[]): Promise<void> {
  const ages = years.map((y) => y.age);
  const colors = getChartColors();

  await renderChart(
    'transition-chart',
    [
      {
        name: 'Employment Income',
        x: ages,
        y: years.map((y) => y.employment_income),
        type: 'scatter',
        mode: 'none',
        fill: 'tozeroy',
        fillcolor: 'rgba(34, 197, 94, 0.6)',
        stackgroup: 'one',
      },
      {
        name: 'Portfolio Withdrawals',
        x: ages,
        y: years.map((y) => y.withdrawal_needed),
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(59, 130, 246, 0.6)',
        stackgroup: 'one',
      },
      {
        name: 'Social Security',
        x: ages,
        y: years.map((y) => y.ss_income),
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(139, 92, 246, 0.6)',
        stackgroup: 'one',
      },
      {
        name: 'Expenses',
        x: ages,
        y: years.map((y) => y.total_income),
        type: 'scatter',
        mode: 'lines',
        line: { color: chartPalette.red, width: 2, dash: 'dash' },
      },
    ],
    {
      ...getBaseLayout(),
      margin: { t: 20, r: 20, b: 80, l: 80 },
      xaxis: {
        ...getAxisConfig(),
        title: 'Age',
      },
      yaxis: {
        ...getAxisConfig(),
        title: 'Annual Amount ($)',
        tickformat: '$,.0f',
      },
      legend: {
        orientation: 'h',
        y: -0.2,
        font: { color: colors.text },
      },
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Render Social Security comparison table.
 * Shows benefits at different claiming ages.
 * @param ssData - Array of SS comparison rows
 */
export function renderSSComparison(ssData: SSComparisonRow[] | null): void {
  const container = document.getElementById('ss-comparison-table');
  if (!container) return;

  if (!ssData || ssData.length === 0) {
    showEmptyState(container, 'No Social Security data available.');
    return;
  }

  // Build table using safe DOM methods
  container.textContent = '';

  const table = document.createElement('table');
  table.className = 'data-table';

  // Create header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = ['Claiming Age', 'Monthly Benefit', 'Annual Benefit', '% of FRA'];
  headers.forEach((text) => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Create body
  const tbody = document.createElement('tbody');
  ssData.forEach((row) => {
    const tr = document.createElement('tr');

    const cells = [
      row.claiming_age.toString(),
      formatCurrency(row.monthly_benefit),
      formatCurrency(row.annual_benefit),
      `${row.percent_of_fra.toFixed(1)}%`,
    ];

    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  container.appendChild(table);
}
