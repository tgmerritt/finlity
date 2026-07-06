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
  Plugin,
  IncomeSource,
  Expense,
  Deduction,
  AIProvider,
  DuplicateGroup,
  ImportParseResult,
  CommentaryEntry,
  Trigger,
  Entity,
} from '@/types/api';

/**
 * Sort configuration for tables.
 */
export interface SortConfig {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Storage mode for data persistence.
 *
 * @deprecated Legacy cosmetic toggle from the Settings "Data Storage" card
 * (localStorage 'storageMode', badge text, radio buttons). Superseded by
 * `dataMode` below, which is resolved from the server's `multi_user_mode`
 * flag and actually drives request routing. Kept only so the existing
 * Settings card continues to render unchanged in server mode.
 */
export type StorageMode = 'server' | 'local' | 'indexeddb';

/**
 * Data routing mode, resolved once at boot from `/api/session/init`'s
 * `multi_user_mode` flag (see src/state/session.ts initSession()):
 * - 'server': v1 behavior, unchanged. All requests hit the FastAPI server.
 * - 'local': hosted/multi-user mode. All user data lives in the browser
 *   SQLite DB (src/database/client-database.ts); CRUD is served by
 *   LocalAPI and analysis/projection calls are POSTed to the stateless
 *   /api/v2 endpoints. See src/api/dispatcher.ts.
 *
 * Defaults to 'server' until session init resolves, so anything that reads
 * this before boot completes gets today's behavior.
 */
export type DataMode = 'server' | 'local';

/**
 * Allocation tab options.
 */
export type AllocationTab = 'asset-class' | 'sector' | 'account-type';

/**
 * Application state interface.
 */
export interface AppState {
  // Portfolio data
  currentPositions: DashboardPosition[];
  portfolioHistory: SnapshotHistory[];
  fullHistoryData: SnapshotHistory[];
  accounts: AccountResponse[];
  duplicates: DuplicateGroup[];

  // UI state
  currentSort: SortConfig;
  selectedAccounts: Set<string>;
  currentViewId: string | null;
  availableViews: PortfolioView[];
  currentHistoryDays: number;
  currentAllocationTab: AllocationTab;

  // Profile state
  profiles: Profile[];
  activeProfileId: string | null;

  // Entity state (for multi-person household tracking)
  entities: Entity[];
  currentEntityId: string | null; // null = household/combined view

  // Session state
  sessionHmacKey: string | null;
  sessionSigningRequired: boolean;
  multiUserMode: boolean;

  // Mode state
  demoMode: boolean;
  isLoading: boolean;
  loadingMessage: string;
  storageMode: StorageMode;
  dataMode: DataMode;

  // Plugin state
  plugins: Plugin[];

  // Budget state
  incomeSources: IncomeSource[];
  expenses: Expense[];
  deductions: Deduction[];
  selectedPaycheckIncomeIndex: number;

  // Analysis state
  currentAnalysisTicker: string | null;
  aiProviders: AIProvider[];
  triggers: Trigger[];

  // Import state
  pendingImportData: ImportParseResult | null;

  // Commentary state
  commentaryCache: Record<string, CommentaryEntry>;

  // Tour state
  currentTourStep: number;
}

/**
 * Initial application state.
 */
const initialState: AppState = {
  // Portfolio data
  currentPositions: [],
  portfolioHistory: [],
  fullHistoryData: [],
  accounts: [],
  duplicates: [],

  // UI state
  currentSort: { field: 'value', direction: 'desc' },
  selectedAccounts: new Set(),
  currentViewId: localStorage.getItem('portfolioViewId'),
  availableViews: [],
  currentHistoryDays: 30,
  currentAllocationTab: 'asset-class',

  // Profile state
  profiles: [],
  activeProfileId: null,

  // Entity state
  entities: [],
  currentEntityId: localStorage.getItem('currentEntityId'),

  // Session state
  sessionHmacKey: null,
  sessionSigningRequired: false,
  multiUserMode: false,

  // Mode state
  demoMode: false,
  isLoading: false,
  loadingMessage: 'Loading...',
  storageMode: 'server',
  dataMode: 'server',

  // Plugin state
  plugins: [],

  // Budget state
  incomeSources: [],
  expenses: [],
  deductions: [],
  selectedPaycheckIncomeIndex: 0,

  // Analysis state
  currentAnalysisTicker: null,
  aiProviders: [],
  triggers: [],

  // Import state
  pendingImportData: null,

  // Commentary state
  commentaryCache: {},

  // Tour state
  currentTourStep: 0,
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
 * Preserves localStorage-based values and creates fresh Set/object instances.
 */
export function resetState(): void {
  state = {
    ...initialState,
    // Preserve localStorage-based values
    currentViewId: localStorage.getItem('portfolioViewId'),
    currentEntityId: localStorage.getItem('currentEntityId'),
    // Create fresh instances for mutable types
    selectedAccounts: new Set(),
    commentaryCache: {},
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
