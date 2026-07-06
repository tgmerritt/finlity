/**
 * Regression tests for F9: chat streaming must check response.ok.
 *
 * fetch() only rejects on network failure — a 4xx/5xx response still
 * resolves. Both sendStreamingChatMessageV2 and the legacy
 * sendStreamingChatMessage previously skipped straight to
 * response.body.getReader() without checking response.ok, so an error
 * response got streamed through the `data:`-line parser, found no chunks,
 * and rendered a silently empty assistant bubble. Now a non-OK response
 * must show the error (from the JSON `detail` field, or status text) in the
 * chat UI, in both dataMode branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { store } from '@/state/store';

vi.mock('@/state/session', () => ({
  isSigningRequired: vi.fn().mockReturnValue(false),
  generateSignatureHeaders: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/api/dispatcher', () => ({
  buildPortfolioPayload: vi.fn().mockReturnValue({ accounts: [] }),
}));

import { sendStreamingChatMessageV2, sendStreamingChatMessage } from '@/pages/analysis';

function setUpChatDom(): { containerId: string; inputId: string } {
  document.body.replaceChildren();
  const container = document.createElement('div');
  container.id = 'chat-container';
  const input = document.createElement('input');
  input.id = 'chat-input';
  input.value = 'What should I do with my portfolio?';
  document.body.appendChild(container);
  document.body.appendChild(input);
  return { containerId: 'chat-container', inputId: 'chat-input' };
}

function assistantBubbleText(containerId: string): string {
  const container = document.getElementById(containerId)!;
  const bubbles = container.querySelectorAll('.chat-message.assistant .chat-message-content');
  return bubbles[bubbles.length - 1]?.textContent ?? '';
}

describe('chat streaming response.ok handling (F9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.resetState();
  });

  describe('sendStreamingChatMessageV2', () => {
    it('server mode: a 500 response with a JSON detail body shows the error in the chat UI, not an empty bubble', async () => {
      store.set('dataMode', 'server');
      const { containerId, inputId } = setUpChatDom();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'Claude API rate limit exceeded' }),
      });

      await sendStreamingChatMessageV2(containerId, inputId);

      expect(assistantBubbleText(containerId)).toContain('Claude API rate limit exceeded');
      expect(assistantBubbleText(containerId)).not.toBe('');
    });

    it('local mode: a 429 response with a JSON detail body shows the error in the chat UI', async () => {
      store.set('dataMode', 'local');
      const { containerId, inputId } = setUpChatDom();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ detail: 'Too many requests' }),
      });

      await sendStreamingChatMessageV2(containerId, inputId);

      expect(assistantBubbleText(containerId)).toContain('Too many requests');
    });

    it('falls back to status text when the error body is not JSON', async () => {
      store.set('dataMode', 'server');
      const { containerId, inputId } = setUpChatDom();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('not json');
        },
      });

      await sendStreamingChatMessageV2(containerId, inputId);

      expect(assistantBubbleText(containerId)).toContain('Bad Gateway');
    });

    it('a successful response still streams normally (no regression)', async () => {
      store.set('dataMode', 'server');
      const { containerId, inputId } = setUpChatDom();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"type":"text","content":"Hello"}\n\n')
          );
          controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
          controller.close();
        },
      });
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream });

      await sendStreamingChatMessageV2(containerId, inputId);

      expect(assistantBubbleText(containerId)).toContain('Hello');
    });
  });

  describe('sendStreamingChatMessage (legacy V1 format)', () => {
    it('server mode: a non-OK response shows the error instead of an empty bubble', async () => {
      store.set('dataMode', 'server');
      const { containerId, inputId } = setUpChatDom();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ detail: 'Unauthorized' }),
      });

      await sendStreamingChatMessage(containerId, inputId);

      expect(assistantBubbleText(containerId)).toContain('Unauthorized');
    });

    it('local mode: a non-OK response shows the error instead of an empty bubble', async () => {
      store.set('dataMode', 'local');
      const { containerId, inputId } = setUpChatDom();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'Internal error' }),
      });

      await sendStreamingChatMessage(containerId, inputId);

      expect(assistantBubbleText(containerId)).toContain('Internal error');
    });
  });
});
