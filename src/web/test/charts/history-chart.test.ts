/**
 * The dashboard history chart: portfolio traces by default, Net worth / Assets /
 * Debts traces in net-worth mode.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const react = vi.fn().mockResolvedValue(undefined);

import { updateHistoryChart, setHistoryMode } from '@/charts/allocation';
import { store } from '@/state/store';
import { setTheme } from '@/state/theme';
import type { SnapshotHistory } from '@/types/api';

const day = (n: number): string => `2026-09-${String(n).padStart(2, '0')}`;
const history: SnapshotHistory[] = [1, 2, 3].map((n) => ({
  date: day(n),
  total: 1000 + n * 10,
  retirement: 400,
  taxable: 600,
  liabilities: 300,
  net_worth: 700 + n * 10,
}));

type Trace = { name: string; y: number[]; line: { width: number } };
type Call = [string, Trace[], Record<string, any>];
const calls = (): Call[] => react.mock.calls as unknown as Call[];
const traces = (): Trace[] => react.mock.calls[0]![1] as Trace[];

beforeEach(() => {
  react.mockClear();
  (globalThis as unknown as { Plotly: unknown }).Plotly = { react };
  document.body.innerHTML = '<div id="chart-history"></div>';
  store.set('currentHistoryDays', 3650);
  setHistoryMode(false);
});

describe('updateHistoryChart', () => {
  it('keeps the portfolio traces without liabilities', async () => {
    await updateHistoryChart(history, true);
    expect(traces().map((t) => t.name)).toEqual(['Total', 'Retirement', 'Taxable']);
  });

  it('plots Net worth, Assets and Debts (positive) in net-worth mode', async () => {
    setHistoryMode(true);
    await updateHistoryChart(history, true);
    const t = traces();
    expect(t.map((x) => x.name)).toEqual(['Net worth', 'Assets', 'Debts']);
    expect(t[0]!.y).toEqual([710, 720, 730]);
    expect(t[1]!.y).toEqual([1010, 1020, 1030]);
    expect(t[2]!.y).toEqual([300, 300, 300]);
    expect(t[0]!.line.width).toBe(2);
    expect(t[1]!.line.width).toBe(1);
  });

  it('uses the dark colors and a dark paper in the dark theme', async () => {
    setTheme('dark');
    await updateHistoryChart(history, true);
    const layout = calls()[0]![2];
    expect(layout.paper_bgcolor).toBe('#1a1a2e');
    expect(layout.plot_bgcolor).toBe('#1a1a2e');
    expect(layout.yaxis.gridcolor).toBe('#333355');
    expect(layout.yaxis.color).toBe('#e0e0e0');
    expect(layout.yaxis.automargin).toBe(true);
  });

  it('re-renders with the new theme colors when the theme toggles, without stacking', async () => {
    setTheme('dark');
    await updateHistoryChart(history, true);
    await updateHistoryChart(history, true);
    react.mockClear();
    setTheme('light');
    await vi.waitFor(() => expect(react).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(react).toHaveBeenCalledTimes(1);
    const layout = calls()[0]![2];
    expect(layout.paper_bgcolor).toBe('#ffffff');
    expect(layout.yaxis.gridcolor).toBe('#e0e0e0');
    expect(layout.xaxis.gridcolor).toBe('#e0e0e0');
  });

  it('stops following the theme once the chart shows an empty state', async () => {
    setTheme('dark');
    await updateHistoryChart(history, true);
    await updateHistoryChart([], true);
    react.mockClear();
    setTheme('light');
    await new Promise((r) => setTimeout(r, 10));
    expect(react).not.toHaveBeenCalled();
  });
});
