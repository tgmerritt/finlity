/**
 * Tests for withApiCall wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    apiCall: vi.fn(),
  };
});

vi.mock('@/ui/loading', () => ({
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

vi.mock('@/ui/toast', () => ({
  showError: vi.fn(),
}));

import { apiCall, ApiError } from '@/api/client';
import { showLoading, hideLoading } from '@/ui/loading';
import { showError } from '@/ui/toast';
import { withApiCall } from '@/api/with-api-call';

const mockedApiCall = apiCall as unknown as ReturnType<typeof vi.fn>;
const mockedShowLoading = showLoading as unknown as ReturnType<typeof vi.fn>;
const mockedHideLoading = hideLoading as unknown as ReturnType<typeof vi.fn>;
const mockedShowError = showError as unknown as ReturnType<typeof vi.fn>;

describe('withApiCall', () => {
  beforeEach(() => {
    mockedApiCall.mockReset();
    mockedShowLoading.mockReset();
    mockedHideLoading.mockReset();
    mockedShowError.mockReset();
  });

  it('returns the parsed body and invokes onSuccess', async () => {
    mockedApiCall.mockResolvedValue({ ok: true });
    const onSuccess = vi.fn();

    const result = await withApiCall<{ ok: boolean }>('/api/ping', {
      onSuccess,
    });

    expect(result).toEqual({ ok: true });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
  });

  it('toggles loading UI when loadingMessage provided', async () => {
    mockedApiCall.mockResolvedValue({});
    await withApiCall('/api/x', { loadingMessage: 'Working...' });

    expect(mockedShowLoading).toHaveBeenCalledWith('Working...');
    expect(mockedHideLoading).toHaveBeenCalled();
  });

  it('does not toggle loading UI when loadingMessage omitted', async () => {
    mockedApiCall.mockResolvedValue({});
    await withApiCall('/api/x');

    expect(mockedShowLoading).not.toHaveBeenCalled();
    expect(mockedHideLoading).not.toHaveBeenCalled();
  });

  it('surfaces ApiError message via showError and returns null', async () => {
    mockedApiCall.mockRejectedValue(new ApiError(500, 'Boom', {}));
    const result = await withApiCall('/api/x');
    expect(result).toBeNull();
    expect(mockedShowError).toHaveBeenCalledWith('Boom');
  });

  it('uses errorMessage override when provided', async () => {
    mockedApiCall.mockRejectedValue(new ApiError(500, 'Boom', {}));
    await withApiCall('/api/x', { errorMessage: 'Could not save' });
    expect(mockedShowError).toHaveBeenCalledWith('Could not save');
  });

  it('stays silent when silentErrors is true', async () => {
    mockedApiCall.mockRejectedValue(new ApiError(500, 'Boom', {}));
    await withApiCall('/api/x', { silentErrors: true });
    expect(mockedShowError).not.toHaveBeenCalled();
  });
});
