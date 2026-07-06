/**
 * Regression tests for F8: commentary streaming.
 *
 * - Local mode (dataMode === 'local') must stream via a fetch POST to
 *   /api/v2/commentary/{elementId}/stream (body {data, user_context}) using
 *   a streaming reader, instead of EventSource+query-string GET (EventSource
 *   can't send a request body).
 * - Server mode keeps the v1 EventSource path exactly as before.
 * - Both modes: a stream that drops mid-response (after some text already
 *   rendered) must remove the `.streaming` class and show a visible
 *   "connection lost" footer, instead of leaving the partial text stuck
 *   with no indication anything went wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { store } from '@/state/store';

vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/state/session', () => ({
  isSigningRequired: vi.fn().mockReturnValue(false),
  generateSignatureHeaders: vi.fn().mockResolvedValue({}),
}));

const { mockLocalAPI } = vi.hoisted(() => ({
  mockLocalAPI: {
    getConfigSection: vi.fn().mockReturnValue(null),
  },
}));
vi.mock('@/api/dispatcher', () => ({
  getLocalAPI: () => mockLocalAPI,
}));

import { showAICommentary, clearCommentaryCache } from '@/features/commentary';

/** Minimal spec-shaped EventSource mock so we can drive onmessage/onerror by hand. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function buildStreamingResponse(chunks: string[]): Response {
  let index = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
  } as unknown as Response;
}

function buildPopoverButton(elementId: string): HTMLButtonElement {
  document.body.replaceChildren();
  const button = document.createElement('button');
  button.dataset.elementId = elementId;
  document.body.appendChild(button);
  return button;
}

describe('commentary streaming (F8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.resetState();
    mockLocalAPI.getConfigSection.mockReturnValue(null);
    MockEventSource.instances = [];
    (global as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
    // commentaryCache is module-level state that persists across tests in
    // this file; without clearing it, a cached response from an earlier
    // test using the same elementId short-circuits showAICommentary()
    // before it ever reaches the network.
    clearCommentaryCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('server mode: unchanged EventSource path', () => {
    it('uses EventSource (GET, query string), not fetch', async () => {
      store.set('dataMode', 'server');
      global.fetch = vi.fn();
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0]!.url).toContain('/api/commentary/dashboard.total_value/stream');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('connection lost after partial text: removes .streaming and shows a visible footer with Refresh', async () => {
      store.set('dataMode', 'server');
      global.fetch = vi.fn();
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);
      const es = MockEventSource.instances[0]!;

      es.onmessage!({ data: JSON.stringify({ type: 'chunk', text: 'Partial insight' }) } as MessageEvent);

      const popover = document.querySelector('.ai-commentary-popover')!;
      const contentDiv = popover.querySelector('.commentary-content')!;
      expect(contentDiv.classList.contains('streaming')).toBe(true);

      es.onerror!(new Event('error'));

      expect(contentDiv.classList.contains('streaming')).toBe(false);
      const lostFooter = popover.querySelector('.commentary-connection-lost');
      expect(lostFooter).not.toBeNull();
      expect(lostFooter!.textContent).toContain('connection lost');
      expect(lostFooter!.querySelector('button')).not.toBeNull();
    });
  });

  describe('local mode: fetch-POST streaming', () => {
    it('POSTs to /api/v2/commentary/{elementId}/stream with a JSON body, not EventSource', async () => {
      store.set('dataMode', 'local');
      global.fetch = vi.fn().mockResolvedValue(buildStreamingResponse(['data: {"type":"complete","commentary":"Done","age_hours":0}\n\n']));
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);

      expect(MockEventSource.instances).toHaveLength(0);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(url).toBe('/api/v2/commentary/dashboard.total_value/stream');
      expect(init.method).toBe('POST');
      const parsedBody = JSON.parse(init.body);
      expect(parsedBody).toHaveProperty('data');
      expect(parsedBody.user_context).toBeUndefined();
    });

    it('includes user_context (age/retirement_age) when local personal settings are saved', async () => {
      store.set('dataMode', 'local');
      mockLocalAPI.getConfigSection.mockImplementation((section: string) => {
        if (section === 'personal') {
          return { personal: { dob: '1980-01-01', retirement_age: 65 } };
        }
        return null;
      });
      global.fetch = vi.fn().mockResolvedValue(
        buildStreamingResponse(['data: {"type":"complete","commentary":"Done","age_hours":0}\n\n'])
      );
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const parsedBody = JSON.parse(init.body);
      expect(parsedBody.user_context.retirement_age).toBe(65);
      expect(typeof parsedBody.user_context.age).toBe('number');
    });

    it('renders streamed chunks and the final commentary content', async () => {
      store.set('dataMode', 'local');
      global.fetch = vi.fn().mockResolvedValue(
        buildStreamingResponse([
          'data: {"type":"chunk","text":"Hello "}\n\n',
          'data: {"type":"chunk","text":"world"}\n\n',
          'data: {"type":"complete","commentary":"Hello world","age_hours":0}\n\n',
        ])
      );
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);

      const popover = document.querySelector('.ai-commentary-popover')!;
      const contentDiv = popover.querySelector('.commentary-content')!;
      expect(contentDiv.textContent).toContain('Hello world');
      expect(contentDiv.classList.contains('streaming')).toBe(false);
    });

    it('surfaces a non-OK response as a visible error, not an empty bubble', async () => {
      store.set('dataMode', 'local');
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, body: null });
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);

      const popover = document.querySelector('.ai-commentary-popover')!;
      expect(popover.querySelector('.commentary-error')).not.toBeNull();
    });

    it('connection lost mid-stream after partial text: removes .streaming and shows a visible footer', async () => {
      store.set('dataMode', 'local');
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"chunk","text":"Partial"}\n\n'));
        },
        pull(controller) {
          controller.error(new Error('simulated connection drop'));
        },
      });
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream });
      const button = buildPopoverButton('dashboard.total_value');

      await showAICommentary(button);

      const popover = document.querySelector('.ai-commentary-popover')!;
      const contentDiv = popover.querySelector('.commentary-content');
      expect(contentDiv?.classList.contains('streaming')).toBe(false);
      expect(popover.querySelector('.commentary-connection-lost')).not.toBeNull();
    });
  });
});
