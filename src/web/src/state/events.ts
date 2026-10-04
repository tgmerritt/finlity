/**
 * Typed mutation event bus.
 *
 * Wraps the long-standing `document.dispatchEvent(new CustomEvent(...))` pattern
 * with a type-safe surface so dispatchers and subscribers stop drifting on
 * string literals.
 *
 * Why this exists: a recent stale-price refresh bug (commit 55eb50c) shipped
 * because the price refresh mutated server state but no event fired, so the
 * "X stale" badge stayed wrong until the user reloaded. With this bus the
 * single discriminated union is the contract — every mutation has exactly one
 * typed event, and any view that needs to react has a single hook.
 *
 * The implementation is a module-private `Map<string, Set<Handler>>` — no
 * coupling to `document` and no external EventEmitter dependency.
 *
 * The bus is purely additive: existing `document.dispatchEvent(...)` calls
 * stay in place during the transition cycle so legacy subscribers in main.ts
 * keep working. Migrate them opportunistically.
 */

/**
 * Discriminated union of every mutation event in the app.
 *
 * Add a new event by extending this union — TypeScript will then require
 * every callsite of `emit`/`on` to handle the new type.
 */
export type MutationEvent =
  | { type: 'positions:changed'; reason: 'added' | 'updated' | 'deleted' | 'imported' }
  | { type: 'accounts:changed'; reason: 'added' | 'updated' | 'deleted' }
  | { type: 'profile:switched'; profileId: string }
  | { type: 'demo:toggled'; demoMode: boolean }
  | { type: 'plugin:changed'; reason: 'installed' | 'uninstalled' | 'enabled' | 'disabled' }
  | { type: 'prices:refreshed'; updated: number; failed: number }
  | { type: 'commentary:invalidated'; tab?: string }
  | { type: 'debts:open'; id: string };

/**
 * Convenience alias: every event type in the union.
 */
export type MutationEventType = MutationEvent['type'];

/**
 * Handler for a specific event type. Receives the narrowed payload.
 */
type Handler<T extends MutationEventType> = (event: Extract<MutationEvent, { type: T }>) => void;

/**
 * Internal store: `eventType -> Set<handler>`.
 *
 * Using `unknown` for the handler argument is a trade-off — we lose the
 * narrowed payload type at storage time but recover it at the subscribe site
 * via `on<T>`. This is the same pattern node's EventEmitter uses.
 */
const handlers: Map<MutationEventType, Set<(event: MutationEvent) => void>> = new Map();

/**
 * Emit a mutation event. All registered handlers for the event's `type` are
 * invoked synchronously, in subscription order. Handler exceptions are
 * caught and logged so one bad subscriber can't block the rest.
 */
export function emit(event: MutationEvent): void {
  const set = handlers.get(event.type);
  if (!set || set.size === 0) return;

  // Snapshot to avoid mutation-during-iteration issues if a handler unsubscribes.
  for (const handler of [...set]) {
    try {
      handler(event);
    } catch (error) {
      console.error(`[events] handler for ${event.type} threw:`, error);
    }
  }
}

/**
 * Subscribe to a specific mutation event type.
 *
 * @param type    Event type to listen for (compile-checked against the union).
 * @param handler Callback invoked with the narrowed event payload.
 * @returns       Unsubscribe function — call it to detach the handler.
 */
export function on<T extends MutationEventType>(type: T, handler: Handler<T>): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }

  // The cast is safe: the narrowed handler is contravariantly compatible with
  // the broader signature stored in the set.
  const wrapped = handler as (event: MutationEvent) => void;
  set.add(wrapped);

  return () => {
    handlers.get(type)?.delete(wrapped);
  };
}

/**
 * Test/teardown helper — clears every subscriber.
 *
 * Not exported through the main barrel; only call this from tests or page
 * teardown logic that knows what it's doing.
 */
export function _resetEventBus(): void {
  handlers.clear();
}
