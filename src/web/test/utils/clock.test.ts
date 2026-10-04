import { describe, it, expect, afterEach, vi } from 'vitest';
import { today } from '@/utils/clock';

describe('today', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the local calendar day, not the UTC day', () => {
    vi.useFakeTimers();
    // Local noon-ish construction: pick an instant, then compare to local getters.
    vi.setSystemTime(new Date(2026, 2, 9, 23, 30, 0)); // local 23:30, UTC date may be the 10th
    expect(today()).toBe('2026-03-09');
    vi.setSystemTime(new Date(2026, 0, 1, 0, 15, 0)); // local 00:15, UTC date may be Dec 31
    expect(today()).toBe('2026-01-01');
  });
});
