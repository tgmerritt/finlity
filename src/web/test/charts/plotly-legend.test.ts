/**
 * Phone legend placement: legends go horizontally below the plot at 768px and below.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { phoneLegendLayout, renderChart } from '@/charts/plotly-utils';

describe('phoneLegendLayout', () => {
  const withLegend = {
    showlegend: true,
    margin: { l: 60, r: 30, t: 40, b: 40 },
    legend: { orientation: 'h', y: 1.15, font: { size: 11 } },
  };

  it('places the legend horizontally below the plot at 768px and below', () => {
    for (const width of [360, 390, 768]) {
      const out = phoneLegendLayout(withLegend, width);
      expect(out.legend).toMatchObject({ orientation: 'h', x: 0, xanchor: 'left', yanchor: 'top' });
      expect((out.legend as { y: number }).y).toBeLessThan(0);
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
    expect((out.legend as { y: number }).y).toBeLessThan(0);
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
    expect(layout.legend.y).toBeLessThan(0);
    expect(layout.margin.b).toBeGreaterThan(40);
  });

  it('keeps the legend where the chart put it on desktop', async () => {
    window.innerWidth = 1440;
    await renderChart('c', [], { showlegend: true, legend: { orientation: 'h', y: 1.1 } });
    expect(react.mock.calls[0]![2].legend.y).toBe(1.1);
  });
});
