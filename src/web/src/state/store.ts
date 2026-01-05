/**
 * Simple state management for the application.
 * Uses a centralized store with typed accessors.
 */

import type {
  DashboardPosition,
  SnapshotHistory,
  Profile,
  PortfolioView,
  AccountResponse,
} from '@/types/api';

/**
 * Sort configuration for tables.
 */
export interface SortConfig {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Application state interface.
 */
export interface AppState {
  // Portfolio data
  currentPositions: DashboardPosition[];
  portfolioHistory: SnapshotHistory[];
  accounts: AccountResponse[];

  // UI state
  currentSort: SortConfig;
  selectedAccounts: Set<string>;
  currentViewId: string | null;
  availableViews: PortfolioView[];
  currentHistoryDays: number;

  // Profile state
  profiles: Profile[];
  activeProfileId: string | null;

  // Session state
  sessionHmacKey: string | null;
  sessionSigningRequired: boolean;

  // Mode state
  demoMode: boolean;
  isLoading: boolean;
  loadingMessage: string;
}

/**
 * Initial application state.
 */
const initialState: AppState = {
  // Portfolio data
  currentPositions: [],
  portfolioHistory: [],
  accounts: [],

  // UI state
  currentSort: { field: 'value', direction: 'desc' },
  selectedAccounts: new Set(),
  currentViewId: localStorage.getItem('portfolioViewId'),
  availableViews: [],
  currentHistoryDays: 30,

  // Profile state
  profiles: [],
  activeProfileId: null,

  // Session state
  sessionHmacKey: null,
  sessionSigningRequired: false,

  // Mode state
  demoMode: false,
  isLoading: false,
  loadingMessage: 'Loading...',
};

/**
 * The application state store.
 */
let state: AppState = { ...initialState };

/**
 * Listeners for state changes.
 */
type StateListener<K extends keyof AppState> = (value: AppState[K], prevValue: AppState[K]) => void;
const listeners: Map<keyof AppState, Set<StateListener<keyof AppState>>> = new Map();

/**
 * Get a copy of the current state.
 * @returns Copy of state
 */
export function getState(): Readonly<AppState> {
  return { ...state };
}

/**
 * Get a specific state value.
 * @param key - State key
 * @returns State value
 */
export function get<K extends keyof AppState>(key: K): AppState[K] {
  return state[key];
}

/**
 * Set a state value and notify listeners.
 * @param key - State key
 * @param value - New value
 */
export function set<K extends keyof AppState>(key: K, value: AppState[K]): void {
  const prevValue = state[key];
  state[key] = value;

  // Notify listeners
  const keyListeners = listeners.get(key);
  if (keyListeners) {
    keyListeners.forEach((listener) => {
      (listener as StateListener<K>)(value, prevValue);
    });
  }
}

/**
 * Update multiple state values at once.
 * @param updates - Partial state updates
 */
export function update(updates: Partial<AppState>): void {
  Object.entries(updates).forEach(([key, value]) => {
    set(key as keyof AppState, value as AppState[keyof AppState]);
  });
}

/**
 * Subscribe to state changes for a specific key.
 * @param key - State key to watch
 * @param listener - Callback when value changes
 * @returns Unsubscribe function
 */
export function subscribe<K extends keyof AppState>(
  key: K,
  listener: StateListener<K>
): () => void {
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  listeners.get(key)!.add(listener as StateListener<keyof AppState>);

  return () => {
    listeners.get(key)?.delete(listener as StateListener<keyof AppState>);
  };
}

/**
 * Reset state to initial values.
 */
export function resetState(): void {
  state = {
    ...initialState,
    // Preserve localStorage-based values
    currentViewId: localStorage.getItem('portfolioViewId'),
  };
}

// Export named store object for convenient access
export const store = {
  get,
  set,
  update,
  subscribe,
  getState,
  resetState,
};
