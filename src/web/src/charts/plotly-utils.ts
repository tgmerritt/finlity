/**
 * Plotly chart utilities with theme-aware configuration.
 */

import { getChartColors, onThemeChange } from '@/state/theme';

// Plotly is loaded via CDN and available as a global
// We use 'any' here because the full Plotly types are complex
// and the CDN-loaded library doesn't have type definitions
declare const Plotly: {
  newPlot: (
    el: string | HTMLElement,
    data: PlotlyData[],
    layout?: PlotlyLayout,
    config?: PlotlyConfig
  ) => Promise<void>;
  react: (
    el: string | HTMLElement,
    data: PlotlyData[],
    layout?: PlotlyLayout,
    config?: PlotlyConfig
  ) => Promise<void>;
  relayout: (el: string | HTMLElement, update: Partial<PlotlyLayout>) => Promise<void>;
  purge: (el: string | HTMLElement) => void;
};

// Simplified Plotly types for our use cases
interface PlotlyLayout {
  title?: string | { text: string };
  paper_bgcolor?: string;
  plot_bgcolor?: string;
  font?: { family?: string; color?: string };
  margin?: { l?: number; r?: number; t?: number; b?: number };
  autosize?: boolean;
  xaxis?: PlotlyAxis;
  yaxis?: PlotlyAxis;
  showlegend?: boolean;
  barmode?: string;
  [key: string]: unknown;
}

interface PlotlyAxis {
  title?: string | { text: string; font?: { color?: string }; standoff?: number };
  gridcolor?: string;
  zerolinecolor?: string;
  tickcolor?: string;
  linecolor?: string;
  color?: string;
  [key: string]: unknown;
}

interface PlotlyData {
  type?: string;
  x?: (number | string | Date)[];
  y?: (number | string)[];
  values?: number[];
  labels?: string[];
  name?: string;
  mode?: string;
  marker?: {
    color?: string | string[];
    colors?: string[];
    size?: number | number[];
    line?: { color?: string; width?: number; dash?: string };
  };
  line?: { color?: string; width?: number; dash?: string; shape?: string };
  fill?: string;
  fillcolor?: string;
  hole?: number;
  textinfo?: string;
  hovertemplate?: string | undefined;
  connector?: { line?: { color?: string; width?: number; dash?: string } };
  [key: string]: unknown;
}

interface PlotlyConfig {
  responsive?: boolean;
  displayModeBar?: boolean | 'hover';
  displaylogo?: boolean;
  modeBarButtonsToRemove?: string[];
  [key: string]: unknown;
}

/**
 * Base layout configuration for all charts.
 * @returns Plotly layout object with theme-aware colors
 */
export function getBaseLayout(): Partial<PlotlyLayout> {
  const colors = getChartColors();

  return {
    paper_bgcolor: colors.background,
    plot_bgcolor: colors.background,
    font: {
      family: 'Inter, system-ui, sans-serif',
      color: colors.text,
    },
    margin: { l: 60, r: 30, t: 40, b: 40 },
    autosize: true,
  };
}

/**
 * Get axis configuration with theme colors.
 * @param title - Axis title
 * @returns Axis configuration
 */
export function getAxisConfig(title?: string): Partial<PlotlyAxis> {
  const colors = getChartColors();

  const config: Partial<PlotlyAxis> = {
    gridcolor: colors.grid,
    zerolinecolor: colors.grid,
    tickcolor: colors.text,
    linecolor: colors.grid,
    color: colors.text,
  };

  if (title) {
    config.title = { text: title, font: { color: colors.text } };
  }

  return config;
}

/**
 * Default chart configuration.
 */
export function getChartConfig(): Partial<PlotlyConfig> {
  return {
    responsive: true,
    displayModeBar: 'hover',
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
  };
}

/** Phone breakpoint (px), matching the 768px rules in style.css. Legends move below the plot at or under it. */
export const PHONE_MAX_WIDTH = 768;

/** Bottom margin (px) reserved per row of legend entries placed below the plot. */
const PHONE_LEGEND_ROW_HEIGHT = 24;

/** Gap (px) between the axis tick labels and the legend (rotated date labels need the room). */
const PHONE_LEGEND_GAP = 28;

/** Rough width (px) of one legend entry: swatch plus padding, and per character of its label. */
const LEGEND_ENTRY_BASE_WIDTH = 34;
const LEGEND_CHAR_WIDTH = 6.5;

/** Labels Plotly would list in the legend for these traces (pies list their slice labels). */
function legendLabels(data: PlotlyData[]): string[] {
  const labels: string[] = [];
  for (const trace of data) {
    if (trace.visible === false || trace.showlegend === false) continue;
    if (trace.type === 'pie' && Array.isArray(trace.labels)) {
      labels.push(...trace.labels.map(String));
    } else {
      labels.push(trace.name ?? '');
    }
  }
  return labels;
}

/** Estimate how many rows a horizontal legend wraps to at this width. Keeps it simple: greedy packing. */
function estimateLegendRows(labels: string[], availableWidth: number): number {
  const width = Math.max(availableWidth, 100);
  let rows = 1;
  let used = 0;
  for (const label of labels) {
    const entry = LEGEND_ENTRY_BASE_WIDTH + label.length * LEGEND_CHAR_WIDTH;
    if (used > 0 && used + entry > width) {
      rows += 1;
      used = 0;
    }
    used += entry;
  }
  return rows;
}

/**
 * On phones, place a shown legend horizontally at the bottom of the chart
 * container, left aligned, and grow the bottom margin by about one row height
 * per estimated legend row. Anchoring to the container (not the plot) keeps the
 * plot area from shrinking under the legend on short charts. Returns the same
 * layout object when the viewport is wider than a phone or no legend shows.
 * A legend counts as shown when asked for, or when Plotly would show it by
 * default (more than one visible trace and showlegend/legend both unset).
 * @param layout - Chart layout (before merging with the base layout)
 * @param viewportWidth - Current viewport width in px
 * @param data - Chart traces, used for the default-legend case and row estimate
 */
export function phoneLegendLayout(
  layout: Partial<PlotlyLayout>,
  viewportWidth: number,
  data: PlotlyData[] = []
): Partial<PlotlyLayout> {
  if (viewportWidth > PHONE_MAX_WIDTH) return layout;
  if (layout.showlegend === false) return layout;
  const labels = legendLabels(data);
  const defaultLegend = layout.showlegend === undefined && !layout.legend && labels.length > 1;
  if (layout.showlegend !== true && !layout.legend && !defaultLegend) return layout;

  const baseMargin = getBaseLayout().margin;
  const margin = { ...baseMargin, ...layout.margin };
  const available = viewportWidth - (margin.l ?? 0) - (margin.r ?? 0);
  const rows = estimateLegendRows(labels, available);
  return {
    ...layout,
    showlegend: true,
    legend: {
      ...(layout.legend as Record<string, unknown> | undefined),
      orientation: 'h',
      x: 0,
      xanchor: 'left',
      yref: 'container',
      y: 0,
      yanchor: 'bottom',
    },
    margin: { ...margin, b: (margin.b ?? 40) + PHONE_LEGEND_GAP + rows * PHONE_LEGEND_ROW_HEIGHT },
  };
}

/**
 * Create or update a Plotly chart.
 * @param elementId - DOM element ID
 * @param data - Chart data
 * @param layout - Chart layout (merged with base layout)
 * @param config - Chart config
 */
export async function renderChart(
  elementId: string,
  data: PlotlyData[],
  layout: Partial<PlotlyLayout> = {},
  config: Partial<PlotlyConfig> = {}
): Promise<void> {
  const element = document.getElementById(elementId);
  if (!element) {
    console.warn(`Chart element not found: ${elementId}`);
    return;
  }

  const mergedLayout = {
    ...getBaseLayout(),
    ...phoneLegendLayout(layout, window.innerWidth, data),
  };

  const mergedConfig = {
    ...getChartConfig(),
    ...config,
  };

  await Plotly.react(elementId, data, mergedLayout, mergedConfig);
}

/**
 * Update chart layout (e.g., for theme changes).
 * @param elementId - DOM element ID
 * @param layoutUpdates - Layout updates to apply
 */
export async function updateChartLayout(
  elementId: string,
  layoutUpdates: Partial<PlotlyLayout> = {}
): Promise<void> {
  const element = document.getElementById(elementId);
  if (!element) return;

  // The margin is chart specific (and grows on phones to fit a legend below
  // the plot), so a theme change must not reset it to the base value.
  const baseUpdates = getBaseLayout();
  delete baseUpdates.margin;
  await Plotly.relayout(elementId, { ...baseUpdates, ...layoutUpdates });
}

/**
 * Destroy a chart and clean up.
 * @param elementId - DOM element ID
 */
export function destroyChart(elementId: string): void {
  const element = document.getElementById(elementId);
  if (element) {
    Plotly.purge(elementId);
  }
}

/**
 * Register a chart for automatic theme updates.
 * @param elementId - DOM element ID
 * @returns Cleanup function
 */
export function registerChartForThemeUpdates(elementId: string): () => void {
  return onThemeChange(() => {
    updateChartLayout(elementId).catch(console.error);
  });
}

/**
 * Color palette for charts.
 */
export const chartPalette = {
  blue: '#4a90d9',
  purple: '#7c3aed',
  green: '#22c55e',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  teal: '#14b8a6',
  pink: '#ec4899',
  indigo: '#6366f1',
  cyan: '#06b6d4',
};

/**
 * Get a color from the palette by index.
 * @param index - Color index
 * @returns Color hex value
 */
export function getColorByIndex(index: number): string {
  const colors = Object.values(chartPalette);
  return colors[index % colors.length] ?? chartPalette.blue;
}

/**
 * Format number for chart display.
 * @param value - Number to format
 * @param prefix - Prefix (e.g., '$')
 * @param suffix - Suffix (e.g., '%')
 * @returns Formatted string
 */
export function formatChartValue(value: number, prefix = '', suffix = ''): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${prefix}${(value / 1_000_000).toFixed(1)}M${suffix}`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${prefix}${(value / 1_000).toFixed(1)}K${suffix}`;
  }
  return `${prefix}${value.toFixed(0)}${suffix}`;
}

/**
 * Create allocation pie chart data.
 * @param labels - Category labels
 * @param values - Values for each category
 * @returns Plotly data array
 */
export function createPieChartData(labels: string[], values: number[]): PlotlyData[] {
  const colors = labels.map((_, i) => getColorByIndex(i));

  return [
    {
      type: 'pie',
      labels,
      values,
      hole: 0.4,
      marker: { colors },
      textinfo: 'percent',
      hovertemplate: '%{label}<br>%{value:$,.0f}<br>%{percent}<extra></extra>',
    },
  ];
}

/**
 * Create time series line chart data.
 * @param dates - Array of dates
 * @param values - Array of values
 * @param name - Series name
 * @param color - Line color
 * @returns Plotly data array
 */
export function createLineChartData(
  dates: string[],
  values: number[],
  name: string,
  color = chartPalette.blue
): PlotlyData[] {
  return [
    {
      type: 'scatter',
      mode: 'lines',
      x: dates,
      y: values,
      name,
      line: { color, width: 2 },
      fill: 'tozeroy',
      fillcolor: `${color}20`,
      hovertemplate: '%{x}<br>%{y:$,.0f}<extra></extra>',
    },
  ];
}

/**
 * Create bar chart data.
 * @param labels - X-axis labels
 * @param values - Bar values
 * @param name - Series name
 * @param color - Bar color (or array of colors)
 * @returns Plotly data array
 */
export function createBarChartData(
  labels: string[],
  values: number[],
  name: string,
  color: string | string[] = chartPalette.blue
): PlotlyData[] {
  return [
    {
      type: 'bar',
      x: labels,
      y: values,
      name,
      marker: { color },
      hovertemplate: '%{x}<br>%{y:$,.0f}<extra></extra>',
    },
  ];
}
