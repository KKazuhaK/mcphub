jest.mock('../../frontend/src/utils/fetchInterceptor', () => ({
  apiGet: jest.fn(),
  apiDelete: jest.fn(),
}));

jest.mock('../../frontend/src/utils/runtime', () => ({
  getApiUrl: (path: string) => `http://localhost:3000/api${path}`,
}));

let mockToken: string | null = 'test-token';
jest.mock('../../frontend/src/utils/interceptors', () => ({
  getToken: () => mockToken,
}));

type FetchCall = { url: string; init: RequestInit };

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('LogStreamManager (header-based stream)', () => {
  let calls: FetchCall[];
  let respond: () => Promise<unknown>;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    mockToken = 'test-token';
    calls = [];
    respond = async () => ({ ok: false, status: 500, body: null });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond();
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (global as unknown as { fetch?: unknown }).fetch;
  });

  it('never puts the token in the URL; it travels in a header', async () => {
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const unsubscribe = logStreamManager.subscribe(() => {});
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:3000/api/logs/stream');
    expect(calls[0].url).not.toContain('test-token');
    expect((calls[0].init.headers as Record<string, string>)['x-auth-token']).toBe('test-token');
    unsubscribe();
  });

  it('backs off exponentially when the stream never opens', async () => {
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const unsubscribe = logStreamManager.subscribe(() => {});
    await flush();
    expect(calls).toHaveLength(1);

    // First failure: reconnect after 1s.
    jest.advanceTimersByTime(999);
    await flush();
    expect(calls).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(calls).toHaveLength(2);

    // Second failure: the delay grows to 2s rather than staying at 1s.
    jest.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(2);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(3);

    unsubscribe();
  });

  it('stops on 401 instead of looping, and resumes after re-authentication', async () => {
    respond = async () => ({ ok: false, status: 401, body: null });
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const unsubscribe = logStreamManager.subscribe(() => {});
    await flush();
    expect(calls).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(calls).toHaveLength(1);

    respond = async () => ({ ok: false, status: 500, body: null });
    logStreamManager.resume();
    await flush();
    expect(calls).toHaveLength(2);
    unsubscribe();
  });

  it('does not poll without a token and starts once resumed', async () => {
    mockToken = null;
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const unsubscribe = logStreamManager.subscribe(() => {});
    await flush();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(calls).toHaveLength(0);

    mockToken = 'late-token';
    logStreamManager.resume();
    await flush();
    expect(calls).toHaveLength(1);
    unsubscribe();
  });

  it('delivers parsed SSE frames to subscribers', async () => {
    const chunks = [
      new TextEncoder().encode('data: {"type":"log"}\n\ndata: {"a"'),
      new TextEncoder().encode(':1}\n\n'),
    ];
    respond = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            chunks.length ? { done: false, value: chunks.shift() } : { done: true },
        }),
      },
    });
    (global as unknown as { MessageEvent: unknown }).MessageEvent ??= class {
      constructor(
        public type: string,
        public init: { data: string },
      ) {}
      get data() {
        return this.init.data;
      }
    };
    const { logStreamManager } = await import('../../frontend/src/services/logService');
    const seen: string[] = [];
    const unsubscribe = logStreamManager.subscribe((event) => seen.push(event.data));
    await flush();
    await flush();

    expect(seen).toEqual(['{"type":"log"}', '{"a":1}']);
    unsubscribe();
  });
});
