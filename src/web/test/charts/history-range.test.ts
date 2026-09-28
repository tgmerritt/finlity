/**
 * Tests for history chart range helpers (pure functions, no Plotly).
 */
import { describe, it, expect } from 'vitest';
import {
  filterHistoryForRange,
  hasPlottableHistory,
  historyDateAxis,
  HISTORY_EMPTY_MESSAGE,
  MIN_HISTORY_POINTS,
} from '@/charts/history-range';
import type { SnapshotHistory } from '@/types/api';

const snap = (date: string, total = 100): SnapshotHistory =>
  ({ date, total, retirement: total / 2, taxable: total / 2 }) as SnapshotHistory;

describe('filterHistoryForRange', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const history = [snap('2026-06-01'), snap('2026-09-01'), snap('2026-09-27')];

  it('keeps snapshots within the last N days', () => {
    expect(filterHistoryForRange(history, 30, now).map((h) => h.date)).toEqual([
      '2026-09-01',
      '2026-09-27',
    ]);
  });

  it('returns everything for a range longer than the history', () => {
    expect(filterHistoryForRange(history, 3650, now)).toHaveLength(3);
  });
});

describe('hasPlottableHistory', () => {
  it('needs at least two distinct dates', () => {
    expect(MIN_HISTORY_POINTS).toBe(2);
    expect(hasPlottableHistory([])).toBe(false);
    expect(hasPlottableHistory([snap('2026-09-27')])).toBe(false);
    expect(hasPlottableHistory([snap('2026-09-27T00:00:00'), snap('2026-09-27T23:59:59')])).toBe(false);
    expect(hasPlottableHistory([snap('2026-09-26'), snap('2026-09-27')])).toBe(true);
  });
});

describe('historyDateAxis', () => {
  it('uses a date axis with day-level ticks', () => {
    const axis = historyDateAxis();
    expect(axis.type).toBe('date');
    expect(axis.tickformat).toBe('%b %d');
  });

  it('has a plain empty-state message without em-dashes', () => {
    expect(HISTORY_EMPTY_MESSAGE).not.toContain('—');
  });
});
