import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('@/api/client', () => ({ apiCall, uploadFile: vi.fn(), getBaseUrl: () => '' }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/state/session', () => ({
  isSigningRequired: vi.fn().mockReturnValue(false),
  generateSignatureHeaders: vi.fn().mockResolvedValue({}),
}));

import { loadPluginSecurity } from '@/features/plugins';

function plugin(id: string, requested: Record<string, unknown>): Record<string, unknown> {
  return {
    plugin_id: id,
    name: id,
    is_builtin: true,
    requested: { file_read: false, file_write: false, network: false, database: 'none', ...requested },
    approved: null,
    status: 'builtin',
  };
}

describe('Plugin Security permissions cell', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="plugin-security-container"></div><div id="security-audit-container"></div>';
    apiCall.mockImplementation(async (url: string) =>
      url.includes('permissions')
        ? {
            pending_count: 0,
            plugins: [
              plugin('a', { file_read: true, network: true, database: 'read_only' }),
              plugin('b', {}),
              plugin('c', { file_write: true }),
            ],
          }
        : { entries: [] }
    );
  });

  it('renders warnings as elements, not escaped markup', async () => {
    await loadPluginSecurity();
    const cells = Array.from(document.querySelectorAll('#plugin-security-container tbody tr')).map(
      (tr) => tr.children[2] as HTMLElement
    );
    expect(cells[0].textContent).toBe('file_read, network, db:read_only');
    expect(cells[0].querySelector('.text-warning')!.textContent).toBe('network');
    expect(cells[1].textContent).toBe('None');
    expect(cells[2].querySelector('.text-warning')!.textContent).toBe('file_write');
    for (const c of cells) expect(c.textContent).not.toContain('<span');
  });
});
