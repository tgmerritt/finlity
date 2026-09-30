/**
 * Allocation and history chart rendering.
 */

import {
  renderChart,
  getBaseLayout,
  getAxisConfig,
  chartPalette,
  getColorByIndex,
} from './plotly-utils';
import {
  filterHistoryForRange,
  hasPlottableHistory,
  historyDateAxis,
  HISTORY_EMPTY_MESSAGE,
} from './history-range';
import { getChartColors } from '@/state/theme';
import { store } from '@/state/store';
import { setStateView, clearStateView } from '@/ui/state-view';
import type { DashboardPosition, SnapshotHistory, PortfolioSummary } from '@/types/api';

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
 * Show empty-state message in a chart container. Thin wrapper over the
 * shared state-view component so the look matches every other empty state.
 */
function showEmptyState(container: HTMLElement, message: string): void {
  setStateView(container, {
    kind: 'empty',
    title: message,
  });
}

/**
 * Update allocation charts (account type and ticker allocation).
 * @param positions - Array of positions
 * @param _summary - Portfolio summary (unused but matches original signature)
 */
export async function updateAllocationCharts(
  positions: DashboardPosition[],
  _summary?: PortfolioSummary
): Promise<void> {
  // No positions → render an inline empty state in each chart container
  // instead of an empty Plotly canvas. Without this both pie charts show
  // up as blank squares on a fresh install.
  if (!positions || positions.length === 0) {
    const accountContainer = document.getElementById('chart-account-type');
    const allocContainer = document.getElementById('chart-allocation');
    if (accountContainer) showEmptyState(accountContainer, 'No allocation to chart yet');
    if (allocContainer) showEmptyState(allocContainer, 'No allocation to chart yet');
    return;
  }

  // We have data — clear any prior state-view before Plotly renders into
  // the container.
  const accountContainer = document.getElementById('chart-account-type');
  const allocContainer = document.getElementById('chart-allocation');
  if (accountContainer) clearStateView(accountContainer);
  if (allocContainer) clearStateView(allocContainer);

  const chartLayout = {
    ...getBaseLayout(),
    margin: { t: 10, b: 10, l: 10, r: 10 },
    showlegend: false,
    hoverlabel: getHoverLabel(),
  };

  // Account type allocation
  const accountAlloc: Record<string, number> = {};
  positions.forEach((pos) => {
    const type = pos.account_type || 'unknown';
    accountAlloc[type] = (accountAlloc[type] || 0) + (pos.value || 0);
  });

  const accountLabels = Object.keys(accountAlloc).map((k) =>
    k.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  );
  const accountValues = Object.values(accountAlloc);

  await renderChart(
    'chart-account-type',
    [
      {
        type: 'pie',
        labels: accountLabels,
        values: accountValues,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'inside',
        insidetextorientation: 'horizontal',
        hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>',
        marker: {
          colors: [
            chartPalette.blue,
            chartPalette.green,
            chartPalette.purple,
            chartPalette.orange,
            chartPalette.teal,
            chartPalette.red,
          ],
        },
      },
    ],
    chartLayout,
    { responsive: true, displayModeBar: false }
  );

  // Ticker allocation (top 10)
  const tickerAlloc: Record<string, number> = {};
  positions.forEach((pos) => {
    tickerAlloc[pos.ticker] = (tickerAlloc[pos.ticker] || 0) + (pos.value || 0);
  });

  const sortedTickers = Object.entries(tickerAlloc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const totalValue = Object.values(tickerAlloc).reduce((a, b) => a + b, 0);
  const topTenValue = sortedTickers.reduce((a, b) => a + b[1], 0);
  const otherValue = totalValue - topTenValue;

  const allocLabels = sortedTickers.map((t) => t[0]);
  const allocValues = sortedTickers.map((t) => t[1]);

  if (otherValue > 0) {
    allocLabels.push('Other');
    allocValues.push(otherValue);
  }

  await renderChart(
    'chart-allocation',
    [
      {
        type: 'pie',
        labels: allocLabels,
        values: allocValues,
        hole: 0.4,
        textinfo: 'label+percent',
        textposition: 'inside',
        insidetextorientation: 'horizontal',
        hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>',
        marker: {
          colors: allocLabels.map((_, i) => getColorByIndex(i)),
        },
      },
    ],
    chartLayout,
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Update portfolio history chart.
 * @param history - Array of history snapshots
 * @param storeData - Whether to store full history in state (default: true)
 */
export async function updateHistoryChart(
  history: SnapshotHistory[] | null,
  storeData = true
): Promise<void> {
  const container = document.getElementById('chart-history');

  // Store full history data for time range filtering
  if (storeData && history) {
    store.set('fullHistoryData', history);
  }

  if (!history || !hasPlottableHistory(history)) {
    if (container) {
      showEmptyState(container, HISTORY_EMPTY_MESSAGE);
    }
    return;
  }

  const currentHistoryDays = store.get('currentHistoryDays');
  const filteredHistory = filterHistoryForRange(history, currentHistoryDays);

  if (!hasPlottableHistory(filteredHistory)) {
    if (container) {
      showEmptyState(container, 'Not enough history for this range yet. Try a longer range.');
    }
    return;
  }

  const dates = filteredHistory.map((h) => h.date);
  const totals = filteredHistory.map((h) => h.total);
  const retirement = filteredHistory.map((h) => h.retirement);
  const taxable = filteredHistory.map((h) => h.taxable);

  // Scrub any prior state-view before Plotly renders.
  if (container) clearStateView(container);

  await renderChart(
    'chart-history',
    [
      {
        x: dates,
        y: totals,
        type: 'scatter',
        mode: 'lines',
        name: 'Total',
        line: { color: chartPalette.blue, width: 2 },
      },
      {
        x: dates,
        y: retirement,
        type: 'scatter',
        mode: 'lines',
        name: 'Retirement',
        line: { color: chartPalette.green, width: 1 },
      },
      {
        x: dates,
        y: taxable,
        type: 'scatter',
        mode: 'lines',
        name: 'Taxable',
        line: { color: chartPalette.orange, width: 1 },
      },
    ],
    {
      ...getBaseLayout(),
      margin: { t: 20, b: 40, l: 70, r: 20 },
      xaxis: {
        ...getAxisConfig(),
        ...historyDateAxis(filteredHistory),
      },
      yaxis: {
        ...getAxisConfig(),
        tickformat: '$,.0f',
      },
      legend: { orientation: 'h', y: 1.1 },
      hovermode: 'x unified',
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

/**
 * Set history time range and re-render chart.
 * @param days - Number of days to show
 */
export function setHistoryTimeRange(days: number): void {
  store.set('currentHistoryDays', days);

  // Update button states
  document.querySelectorAll('.time-range-btn').forEach((btn) => {
    btn.classList.remove('active');
    const btnDays = btn.getAttribute('data-days');
    if (btnDays && parseInt(btnDays, 10) === days) {
      btn.classList.add('active');
    }
  });

  // Re-render chart with filtered data
  const fullHistoryData = store.get('fullHistoryData');
  updateHistoryChart(fullHistoryData, false);
}

/**
 * Initialize time range button handlers.
 */
export function initHistoryTimeRangeButtons(): void {
  document.querySelectorAll('.time-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = btn.getAttribute('data-days');
      if (days) {
        setHistoryTimeRange(parseInt(days, 10));
      }
    });
  });
}
