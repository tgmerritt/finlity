import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiCall, renderChart, registerChartForThemeUpdates } = vi.hoisted(() => ({
  apiCall: vi.fn(),
  renderChart: vi.fn().mockResolvedValue(undefined),
  registerChartForThemeUpdates: vi.fn().mockReturnValue(() => undefined),
}));
vi.mock('@/api/client', () => ({ apiCall, uploadFile: vi.fn(), getBaseUrl: () => '' }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/state/session', () => ({
  isSigningRequired: vi.fn().mockReturnValue(false),
  generateSignatureHeaders: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/charts/plotly-utils', () => ({ renderChart, registerChartForThemeUpdates }));

import { loadWidgets } from '@/features/plugins';

function widget(content: Record<string, unknown>): Record<string, unknown> {
  return { plugin_name: 'w', success: true, config: { title: 'W' }, content };
}

async function load(content: Record<string, unknown>): Promise<void> {
  apiCall.mockResolvedValue({ widgets: [widget(content)] });
  await loadWidgets();
}

describe('plugin widget charts', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="widget-loading"></div><div id="widget-grid"></div>';
    renderChart.mockClear();
    (window as unknown as Record<string, unknown>).__widgetScriptRan = false;
  });

  it('renders data.chart into the widget container through renderChart', async () => {
    const chart = {
      data: [{ type: 'treemap', labels: ['a'] }],
      layout: { margin: { t: 1 } },
      config: { displayModeBar: false },
    };
    await load({
      html: '<div data-chart-container class="c"></div>',
      data: { chart },
    });
    const target = document.querySelector('#widget-grid [data-chart-container]') as HTMLElement;
    expect(target.id).toBeTruthy();
    expect(renderChart).toHaveBeenCalledWith(target.id, chart.data, chart.layout, chart.config);
    expect(registerChartForThemeUpdates).toHaveBeenCalledWith(target.id);
  });

  it('appends a container when the widget HTML has none', async () => {
    await load({ html: '<p>hi</p>', data: { chart: { data: [] } } });
    const target = document.querySelector('.widget-body [data-chart-container]');
    expect(target).not.toBeNull();
    expect(renderChart).toHaveBeenCalledTimes(1);
  });

  it('leaves <script> in widget HTML inert and does not call renderChart without a chart', async () => {
    await load({ html: '<p>x</p><script>window.__widgetScriptRan = true;</script>' });
    expect((window as unknown as Record<string, unknown>).__widgetScriptRan).toBe(false);
    expect(renderChart).not.toHaveBeenCalled();
  });
});
