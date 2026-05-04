/**
 * Position correlation heatmap rendering.
 *
 * Surfaces redundancy in the portfolio (e.g. holding both VTI and VTSAX which
 * are ~98% correlated) by plotting an NxN correlation matrix and listing
 * high-correlation pairs as redundancy candidates.
 */

import { apiCall } from '@/api/client';
import {
  renderChart,
  getBaseLayout,
  getAxisConfig,
  registerChartForThemeUpdates,
} from './plotly-utils';
import { getChartColors } from '@/state/theme';
import { setStateView, clearStateView } from '@/ui/state-view';
import type { CorrelationEntry, CorrelationResponse } from '@/types/api';

const CHART_ID = 'correlation-heatmap';
const EMPTY_ID = 'correlation-heatmap-empty';
const REDUNDANCY_LIST_ID = 'correlation-redundancy-list';

/**
 * Default threshold above which a pair is flagged as a redundancy candidate.
 * Pairs with correlation > this value typically duplicate exposure (e.g. VTI
 * and VTSAX track the same index ~98% correlation).
 */
export const HIGH_CORRELATION_THRESHOLD = 0.85;

/**
 * Filter a list of correlation entries down to redundancy candidates above
 * `threshold`, sorted from highest correlation to lowest. Pure function so
 * it can be unit-tested without DOM/Plotly.
 */
export function filterRedundancyPairs(
  entries: CorrelationEntry[],
  threshold: number = HIGH_CORRELATION_THRESHOLD
): CorrelationEntry[] {
  return entries
    .filter((e) => e.correlation > threshold)
    .sort((a, b) => b.correlation - a.correlation);
}

/**
 * Get hover label configuration for current theme (mirrors allocation.ts).
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
 * Show the empty-state message and hide the chart container.
 *
 * Behavior preserved from the previous ad-hoc implementation; the message
 * is now rendered through the shared `state-view` component so it matches
 * the look of every other empty state in the app.
 */
function showEmptyState(message: string, kind: 'empty' | 'error' = 'empty'): void {
  const empty = document.getElementById(EMPTY_ID);
  const chart = document.getElementById(CHART_ID);
  const list = document.getElementById(REDUNDANCY_LIST_ID);

  if (empty) {
    empty.style.display = '';
    setStateView(empty, {
      kind,
      title: kind === 'error' ? 'Could not load correlation data' : 'Not enough data yet',
      description: message,
    });
  }
  if (chart) {
    chart.style.display = 'none';
  }
  if (list) {
    list.textContent = '';
  }
}

/**
 * Hide the empty-state and ensure the chart container is visible. Called
 * when real data is about to render.
 */
function clearEmptyState(): void {
  const empty = document.getElementById(EMPTY_ID);
  const chart = document.getElementById(CHART_ID);

  if (empty) {
    clearStateView(empty);
    empty.style.display = 'none';
  }
  if (chart) {
    chart.style.display = '';
  }
}

/**
 * Render the redundancy-pairs callout list.
 */
function renderRedundancyList(entries: CorrelationEntry[]): void {
  const list = document.getElementById(REDUNDANCY_LIST_ID);
  if (!list) return;

  list.textContent = '';

  const candidates = filterRedundancyPairs(entries);

  if (candidates.length === 0) {
    const note = document.createElement('p');
    note.className = 'text-muted';
    note.textContent = 'No high-correlation pairs detected — your holdings are well diversified.';
    list.appendChild(note);
    return;
  }

  const heading = document.createElement('p');
  heading.className = 'text-muted';
  heading.textContent = 'Consider whether you need both — these move together:';
  list.appendChild(heading);

  const ul = document.createElement('ul');
  ul.className = 'redundancy-pairs';
  for (const pair of candidates) {
    const li = document.createElement('li');
    li.textContent = `${pair.ticker1} ↔ ${pair.ticker2}: ${pair.correlation.toFixed(2)}`;
    ul.appendChild(li);
  }
  list.appendChild(ul);
}

/**
 * Render the heatmap into #correlation-heatmap.
 */
async function renderHeatmap(tickers: string[], matrix: number[][]): Promise<void> {
  // Make sure the heatmap container is visible and any prior state-view is
  // gone before Plotly renders.
  clearEmptyState();

  // Diverging scale: blue (negative / good diversification) -> neutral ->
  // red (positive / redundancy). Explicit 3-stop scale instead of the built-in
  // 'RdBu' (which is reversed) for clarity and theme stability.
  const colorscale: [number, string][] = [
    [0, '#3b82f6'],
    [0.5, '#f3f4f6'],
    [1, '#ef4444'],
  ];

  await renderChart(
    CHART_ID,
    [
      {
        type: 'heatmap',
        z: matrix,
        x: tickers,
        y: tickers,
        zmin: -1,
        zmax: 1,
        zmid: 0,
        colorscale,
        hovertemplate: '%{y} ↔ %{x}<br>Correlation: %{z:.2f}<extra></extra>',
      },
    ],
    {
      ...getBaseLayout(),
      margin: { t: 20, b: 70, l: 70, r: 30 },
      xaxis: {
        ...getAxisConfig(),
        tickangle: -45,
        automargin: true,
      },
      yaxis: {
        ...getAxisConfig(),
        // Convention for correlation matrices: diagonal runs top-left to
        // bottom-right. Plotly default puts y=0 at the bottom; reverse it.
        autorange: 'reversed',
        automargin: true,
      },
      hoverlabel: getHoverLabel(),
    },
    { responsive: true, displayModeBar: false }
  );
}

let themeUnsubscribe: (() => void) | null = null;

/**
 * Fetch correlation data and render the heatmap + redundancy list.
 *
 * The endpoint returns an empty matrix when the portfolio has fewer than 2
 * positions ≥1% of total weight or insufficient price history; in that case
 * we render the empty-state message.
 */
export async function loadCorrelationHeatmap(): Promise<void> {
  try {
    const data = await apiCall<CorrelationResponse>('/api/analysis/correlation');

    if (!data.matrix || data.matrix.length === 0 || data.tickers.length < 2) {
      showEmptyState(
        'Need at least 2 positions ≥1% of portfolio with 1 year of price history to compute correlations.'
      );
      return;
    }

    await renderHeatmap(data.tickers, data.matrix);
    renderRedundancyList(data.high_correlations);

    // Register once so paper/plot bg + axis colors update on theme toggle.
    // The diverging colorscale itself is theme-independent.
    if (!themeUnsubscribe) {
      themeUnsubscribe = registerChartForThemeUpdates(CHART_ID);
    }
  } catch (error) {
    console.error('Error loading correlation heatmap:', error);
    showEmptyState(
      error instanceof Error ? error.message : 'Could not load correlation data.',
      'error'
    );
  }
}
