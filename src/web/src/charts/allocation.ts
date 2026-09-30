/**
 * Allocation and history chart rendering.
 */

import { renderChart, getBaseLayout, getAxisConfig, chartPalette } from './plotly-utils';
import {
  filterHistoryForRange,
  hasPlottableHistory,
  historyDateAxis,
  HISTORY_EMPTY_MESSAGE,
} from './history-range';
import { getChartColors } from '@/state/theme';
import { store } from '@/state/store';
import { setStateView, clearStateView } from '@/ui/state-view';
import { rangeDays, type RangeKey } from '@/utils/portfolio-metrics';
import type { SnapshotHistory } from '@/types/api';

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
 * Record the selected history range in the store and reflect it on the range
 * buttons (active class and aria-pressed). Does not re-render the chart.
 */
export function applyHistoryRange(key: RangeKey): void {
  store.set('currentHistoryRange', key);
  store.set('currentHistoryDays', rangeDays(key));
  document.querySelectorAll<HTMLElement>('.time-range-btn[data-range]').forEach((btn) => {
    const active = btn.getAttribute('data-range') === key;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

/**
 * Select a history range and re-render the chart from the stored history.
 */
export async function setHistoryRange(key: RangeKey): Promise<void> {
  applyHistoryRange(key);
  await updateHistoryChart(store.get('fullHistoryData'), false);
}
