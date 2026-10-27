import { apiGet } from '../../frontend/src/utils/fetchInterceptor';

describe('apiRequest failure status', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('reports the HTTP status of a failed request so callers can tell 401 apart', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ success: false, message: 'Unauthorized' }),
    })) as unknown as typeof fetch;
    const result = await apiGet('/settings');
    expect(result).toMatchObject({ success: false, status: 401 });
  });

  it('leaves successful responses untouched', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, data: {} }),
    })) as unknown as typeof fetch;
    expect(await apiGet('/settings')).toEqual({ success: true, data: {} });
  });
});
