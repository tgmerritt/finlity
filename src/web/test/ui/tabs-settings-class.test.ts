import { describe, it, expect, beforeEach } from 'vitest';
import { showTab } from '@/ui/tabs';

describe('showTab body class', () => {
  beforeEach(() => {
    document.body.className = '';
    document.body.innerHTML = '<div class="tab-content" id="tab-settings"></div><div class="tab-content" id="tab-taxes"></div>';
  });

  it('marks the body while Settings is shown and clears it elsewhere', () => {
    showTab('settings');
    expect(document.body.classList.contains('on-settings')).toBe(true);
    showTab('taxes');
    expect(document.body.classList.contains('on-settings')).toBe(false);
  });
});
