/**
 * Tour visibility tests: #tour-overlay ships with the `hidden` class
 * (display: none !important), so startTour must remove it and endTour must
 * restore it, otherwise the tour never appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/api/client', () => ({ apiCall: vi.fn() }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/ui/loading', () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }));
vi.mock('@/ui/tabs', () => ({ showTab: vi.fn() }));
vi.mock('@/database/client-database', () => ({ clientDB: {} }));
vi.mock('@/api/dispatcher', () => ({ getLocalAPI: vi.fn() }));

import { endTour, startTour } from '@/features/onboarding';

beforeEach(() => {
  document.body.innerHTML = `
    <button data-tab="holdings" id="sidebar-holdings"></button>
    <div id="tour-overlay" class="tour-overlay hidden">
      <div id="tour-spotlight"></div>
      <div id="tour-card">
        <span id="tour-step-indicator"></span><span id="tour-icon"></span>
        <h3 id="tour-title"></h3><p id="tour-content"></p>
        <button id="tour-next-btn"></button>
      </div>
    </div>`;
});

describe('tour overlay visibility', () => {
  it('startTour reveals the overlay and endTour hides it again', () => {
    const overlay = document.getElementById('tour-overlay')!;
    startTour();
    expect(overlay.classList.contains('hidden')).toBe(false);
    expect(overlay.style.display).toBe('block');
    endTour();
    expect(overlay.classList.contains('hidden')).toBe(true);
  });
});
