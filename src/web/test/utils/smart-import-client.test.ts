import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isSigningRequired, generateSignatureHeaders } = vi.hoisted(() => ({
  isSigningRequired: vi.fn(),
  generateSignatureHeaders: vi.fn(),
}));
vi.mock('@/state/session', () => ({ isSigningRequired, generateSignatureHeaders }));

import { uploadFileWithContext, ApiError } from '@/api/client';

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('uploadFileWithContext', () => {
  beforeEach(() => {
    isSigningRequired.mockReturnValue(false);
    generateSignatureHeaders.mockResolvedValue({});
    global.fetch = vi.fn().mockResolvedValue(okResponse({ status: 'ok', statements: [] }));
  });

  it('posts the file and the JSON context as multipart fields', async () => {
    const file = new File(['a,b'], 'x.csv', { type: 'text/csv' });
    const context = { rules: [], origin: 'sample' };

    const result = await uploadFileWithContext('/api/v2/smart-import/analyze', file, context);

    expect(result).toEqual({ status: 'ok', statements: [] });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/v2/smart-import/analyze');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('x.csv');
    expect(JSON.parse(form.get('context') as string)).toEqual(context);
    expect(init.headers).toEqual({});
    // The browser must set the multipart boundary itself.
    expect(Object.keys(init.headers as object)).not.toContain('Content-Type');
  });

  it('signs the request when signing is required', async () => {
    isSigningRequired.mockReturnValue(true);
    generateSignatureHeaders.mockResolvedValue({ 'X-Request-Nonce': 'n1' });

    await uploadFileWithContext('/api/v2/smart-import/analyze', new File(['x'], 'a.csv'), {});

    expect(generateSignatureHeaders).toHaveBeenCalledWith('POST', '/api/v2/smart-import/analyze');
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.headers).toEqual({ 'X-Request-Nonce': 'n1' });
  });

  it('does not sign when signing is not required', async () => {
    await uploadFileWithContext('/api/v2/smart-import/analyze', new File(['x'], 'a.csv'), {});
    expect(generateSignatureHeaders).not.toHaveBeenCalled();
  });

  it('exposes the error body (error_type) on the ApiError', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: 'x',
      json: async () => ({ error_type: 'encrypted_pdf', detail: 'The PDF is password protected.' }),
    } as unknown as Response);
    await expect(
      uploadFileWithContext('/api/v2/smart-import/analyze', new File(['x'], 'a.pdf'), {})
    ).rejects.toMatchObject({ status: 422, data: { error_type: 'encrypted_pdf' } });
  });

  it('throws an ApiError with the status on a failed upload', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 413,
      statusText: 'Too Large',
      json: async () => ({ error_type: 'file_too_large', detail: 'File too large' }),
    });

    await expect(
      uploadFileWithContext('/api/v2/smart-import/analyze', new File(['x'], 'a.csv'), {})
    ).rejects.toMatchObject({ name: 'ApiError', status: 413 });
    await expect(
      uploadFileWithContext('/api/v2/smart-import/analyze', new File(['x'], 'a.csv'), {})
    ).rejects.toBeInstanceOf(ApiError);
  });
});
