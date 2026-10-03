/**
 * Phone legend placement: legends go horizontally below the plot at 768px and below.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { phoneLegendLayout, renderChart, updateChartLayout } from '@/charts/plotly-utils';

describe('phoneLegendLayout', () => {
  const withLegend = {
    showlegend: true,
    margin: { l: 60, r: 30, t: 40, b: 40 },
    legend: { orientation: 'h', y: 1.15, font: { size: 11 } },
  };

  it('places the legend horizontally below the plot at 768px and below', () => {
    for (const width of [360, 390, 768]) {
      const out = phoneLegendLayout(withLegend, width);
      expect(out.legend).toMatchObject({
        orientation: 'h',
        x: 0,
        xanchor: 'left',
        yref: 'container',
        y: 0,
        yanchor: 'bottom',
      });
      expect((out.legend as { font: { size: number } }).font.size).toBe(11);
      expect(out.margin?.b).toBeGreaterThan(40);
      expect(out.margin?.l).toBe(60);
    }
  });

  it('leaves the layout alone above 768px', () => {
    expect(phoneLegendLayout(withLegend, 769)).toBe(withLegend);
    expect(phoneLegendLayout(withLegend, 1440)).toBe(withLegend);
  });

  it('leaves the layout alone when the legend is hidden or absent', () => {
    const hidden = { showlegend: false, legend: { orientation: 'h' } };
    const none = { margin: { b: 40 } };
    expect(phoneLegendLayout(hidden, 390)).toBe(hidden);
    expect(phoneLegendLayout(none, 390)).toBe(none);
  });

  it('treats an explicit legend object without showlegend as shown', () => {
    const out = phoneLegendLayout({ legend: { orientation: 'h', y: 1.1 } }, 390);
    expect(out.legend).toMatchObject({ yref: 'container', y: 0, yanchor: 'bottom' });
  });

  it('treats several visible traces with no legend settings as showing the default legend', () => {
    const traces = [{ name: 'Stocks' }, { name: 'Bonds' }];
    const out = phoneLegendLayout({ margin: { l: 60, r: 30, t: 40, b: 40 } }, 390, traces);
    expect(out.showlegend).toBe(true);
    expect(out.legend).toMatchObject({ yref: 'container', y: 0 });
    expect(out.margin?.b).toBeGreaterThan(40);
  });

  it('does not add a legend for one trace, hidden traces, or showlegend false', () => {
    const one = {};
    expect(phoneLegendLayout(one, 390, [{ name: 'A' }])).toBe(one);
    expect(phoneLegendLayout(one, 390, [{ name: 'A' }, { name: 'B', visible: false }])).toBe(one);
    const off = { showlegend: false };
    expect(phoneLegendLayout(off, 390, [{ name: 'A' }, { name: 'B' }])).toBe(off);
  });

  it('scales the bottom margin with the estimated legend rows', () => {
    const layout = { showlegend: true, margin: { l: 10, r: 10, t: 40, b: 40 } };
    const few = phoneLegendLayout(layout, 390, [{ name: 'A' }, { name: 'B' }]);
    const names = ['Checking account', 'Brokerage account', 'Retirement account', 'Savings account', 'Crypto wallet'];
    const many = phoneLegendLayout(layout, 390, names.map((name) => ({ name })));
    expect(few.margin?.b).toBe(40 + 28 + 24);
    expect(many.margin!.b!).toBeGreaterThanOrEqual(40 + 28 + 24 * 3);
    expect(many.margin!.b!).toBeGreaterThan(few.margin!.b!);
    expect((many.margin!.b! - 40 - 28) % 24).toBe(0);
  });
});

describe('renderChart on a phone', () => {
  const react = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    react.mockClear();
    (globalThis as unknown as { Plotly: unknown }).Plotly = { react };
    document.body.innerHTML = '<div id="c"></div>';
  });

  it('passes the below-plot legend to Plotly at phone width', async () => {
    window.innerWidth = 390;
    await renderChart('c', [], { showlegend: true, legend: { orientation: 'h', y: 1.1 } });
    const layout = react.mock.calls[0]![2];
    expect(layout.legend).toMatchObject({ yref: 'container', y: 0, yanchor: 'bottom' });
    expect(layout.margin.b).toBeGreaterThan(40);
  });

  it('keeps the legend where the chart put it on desktop', async () => {
    window.innerWidth = 1440;
    await renderChart('c', [], { showlegend: true, legend: { orientation: 'h', y: 1.1 } });
    expect(react.mock.calls[0]![2].legend.y).toBe(1.1);
  });
});

describe('updateChartLayout on a phone', () => {
  it('does not reset the chart margin or legend on a theme update', async () => {
    const relayout = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { Plotly: unknown }).Plotly = { relayout };
    document.body.innerHTML = '<div id="c"></div>';
    window.innerWidth = 390;
    await updateChartLayout('c');
    const update = relayout.mock.calls[0]![1];
    expect('margin' in update).toBe(false);
    expect('legend' in update).toBe(false);
    expect(update.paper_bgcolor).toBeDefined();
  });
});
