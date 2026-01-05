/**
 * Vitest test setup file.
 * Configures the test environment before tests run.
 */

import { vi } from 'vitest';

// Mock browser APIs not available in jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock fetch
global.fetch = vi.fn();

// Mock crypto.subtle for HMAC signing tests
Object.defineProperty(global, 'crypto', {
  value: {
    subtle: {
      importKey: vi.fn(),
      sign: vi.fn(),
    },
    randomUUID: vi.fn(() => 'test-uuid-1234'),
  },
});

// Mock Plotly (loaded via CDN)
(global as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  relayout: vi.fn(),
  purge: vi.fn(),
};

// Mock marked (loaded via CDN)
(global as Record<string, unknown>).marked = {
  parse: vi.fn((text: string) => text),
};

// Mock sql.js (loaded via CDN)
(global as Record<string, unknown>).initSqlJs = vi.fn();
