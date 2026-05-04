/**
 * Tests for the correlation chart helper logic.
 *
 * Pure-function unit tests only — Plotly rendering itself is exercised in
 * the browser, not under jsdom.
 */

import { describe, it, expect } from 'vitest';
import {
  filterRedundancyPairs,
  HIGH_CORRELATION_THRESHOLD,
} from '@/charts/correlation';
import type { CorrelationEntry } from '@/types/api';

const entries: CorrelationEntry[] = [
  { ticker1: 'VTI', ticker2: 'VTSAX', correlation: 0.98 },
  { ticker1: 'VOO', ticker2: 'SPY', correlation: 0.99 },
  { ticker1: 'AAPL', ticker2: 'MSFT', correlation: 0.72 },
  { ticker1: 'TLT', ticker2: 'GLD', correlation: -0.15 },
  { ticker1: 'QQQ', ticker2: 'VTI', correlation: 0.86 },
];

describe('filterRedundancyPairs', () => {
  it('keeps only pairs above the default 0.85 threshold', () => {
    const result = filterRedundancyPairs(entries);
    const tickers = result.map((e) => `${e.ticker1}/${e.ticker2}`);
    expect(tickers).toEqual(['VOO/SPY', 'VTI/VTSAX', 'QQQ/VTI']);
  });

  it('sorts results from highest correlation to lowest', () => {
    const result = filterRedundancyPairs(entries);
    const corrs = result.map((e) => e.correlation);
    expect(corrs).toEqual([...corrs].sort((a, b) => b - a));
  });

  it('respects a custom threshold', () => {
    const result = filterRedundancyPairs(entries, 0.7);
    expect(result).toHaveLength(4);
  });

  it('uses strict greater-than (does not include exactly the threshold)', () => {
    const at = [{ ticker1: 'A', ticker2: 'B', correlation: 0.85 }];
    expect(filterRedundancyPairs(at)).toEqual([]);
  });

  it('returns an empty array when nothing qualifies', () => {
    const low = [
      { ticker1: 'A', ticker2: 'B', correlation: 0.3 },
      { ticker1: 'C', ticker2: 'D', correlation: -0.5 },
    ];
    expect(filterRedundancyPairs(low)).toEqual([]);
  });

  it('exposes a sensible default threshold', () => {
    expect(HIGH_CORRELATION_THRESHOLD).toBe(0.85);
  });
});
