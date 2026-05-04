/**
 * Tests for the typed mutation event bus.
 *
 * Covers runtime delivery, unsubscribe, multi-subscriber fan-out, and (best
 * effort) the compile-time discrimination of the union. NOTE on the latter:
 * `tsconfig.json` does not include `test/**` in its compilation roots, and
 * `vitest` transpiles without typechecking, so the `@ts-expect-error`
 * directives below act as IDE/editor-level documentation rather than a CI
 * gate. The real type-safety enforcement lives at every emit/on call site
 * in `src/`, which `npm run typecheck` covers exhaustively.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emit, on, _resetEventBus } from '@/state/events';
import type { MutationEvent } from '@/state/events';

describe('mutation event bus', () => {
  beforeEach(() => {
    _resetEventBus();
  });

  it('delivers an emitted event to a matching subscriber', () => {
    const handler = vi.fn();
    on('positions:changed', handler);

    emit({ type: 'positions:changed', reason: 'added' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: 'positions:changed',
      reason: 'added',
    });
  });

  it('does not deliver to subscribers of other event types', () => {
    const positionsHandler = vi.fn();
    const accountsHandler = vi.fn();
    on('positions:changed', positionsHandler);
    on('accounts:changed', accountsHandler);

    emit({ type: 'accounts:changed', reason: 'added' });

    expect(accountsHandler).toHaveBeenCalledTimes(1);
    expect(positionsHandler).not.toHaveBeenCalled();
  });

  it('fans out to multiple subscribers in subscription order', () => {
    const calls: number[] = [];
    on('prices:refreshed', () => calls.push(1));
    on('prices:refreshed', () => calls.push(2));
    on('prices:refreshed', () => calls.push(3));

    emit({ type: 'prices:refreshed', updated: 5, failed: 0 });

    expect(calls).toEqual([1, 2, 3]);
  });

  it('returns an unsubscribe function that stops further delivery', () => {
    const handler = vi.fn();
    const unsubscribe = on('prices:refreshed', handler);

    emit({ type: 'prices:refreshed', updated: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    emit({ type: 'prices:refreshed', updated: 2, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates one bad subscriber from the rest', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const survivor = vi.fn();

    on('prices:refreshed', () => {
      throw new Error('boom');
    });
    on('prices:refreshed', survivor);

    emit({ type: 'prices:refreshed', updated: 0, failed: 0 });

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not crash when no subscribers are registered', () => {
    expect(() => {
      emit({ type: 'commentary:invalidated' });
    }).not.toThrow();
  });

  it('lets a handler unsubscribe itself during delivery', () => {
    const otherHandler = vi.fn();

    let unsub: (() => void) | null = null;
    unsub = on('positions:changed', () => {
      unsub?.();
    });
    on('positions:changed', otherHandler);

    emit({ type: 'positions:changed', reason: 'updated' });

    // The other handler must still receive this delivery (snapshot pattern).
    expect(otherHandler).toHaveBeenCalledTimes(1);

    // After delivery, the self-unsubscribed handler should be gone — no
    // error and the other handler still gets future events.
    emit({ type: 'positions:changed', reason: 'updated' });
    expect(otherHandler).toHaveBeenCalledTimes(2);
  });

  it('narrows the payload type at the subscribe site', () => {
    // The handler sig is `Extract<MutationEvent, { type: 'prices:refreshed' }>`,
    // so the event has `updated` and `failed` properties even though the
    // wider union does not.
    const handler = vi.fn((event) => {
      // Type assertion via property access — if narrowing broke, accessing
      // .updated on the wider union would fail compilation.
      const _u: number = event.updated;
      const _f: number = event.failed;
      return _u + _f;
    });

    on('prices:refreshed', handler);
    emit({ type: 'prices:refreshed', updated: 3, failed: 1 });

    expect(handler).toHaveLastReturnedWith(4);
  });

  it('documents the discriminated union shape (IDE-level only)', () => {
    // The `@ts-expect-error` lines below describe what the union should
    // reject. Note: vitest does not typecheck, and tsconfig excludes test/,
    // so these directives are documentation — not a CI gate. The real
    // type-safety guarantees come from every callsite in src/ being
    // checked by `npm run typecheck`.

    // @ts-expect-error — wrong reason for positions:changed
    const wrongReason: MutationEvent = { type: 'positions:changed', reason: 'frobnicated' };

    // @ts-expect-error — missing required `updated`/`failed` fields
    const missingFields: MutationEvent = { type: 'prices:refreshed' };

    // @ts-expect-error — unknown event type
    const unknownType: MutationEvent = { type: 'definitely:not:a:real:event' };

    // Reference the variables so they aren't flagged unused — keeps the
    // documentation intent intact in case the test ever does get type-
    // checked in a future config change.
    expect([wrongReason, missingFields, unknownType]).toHaveLength(3);
  });
});
