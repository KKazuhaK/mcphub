import axios from 'axios';
import { canvasApiBase, discoverCanvasExpiry } from '../../src/services/canvasExpiryService.js';
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: jest.fn().mockResolvedValue(undefined),
  createSafeLookup: () => undefined,
}));
const get = jest.mocked(axios.get);
const token = '123~abcde12345678901234567890';
const values = {
  'env.CANVAS_API_URL': 'https://canvas.example.edu',
  'env.CANVAS_API_TOKEN': token,
};
beforeEach(() => {
  process.env.MCPHUB_CANVAS_ORIGINS = 'https://canvas.example.edu';
  get.mockReset();
});
afterEach(() => {
  delete process.env.MCPHUB_CANVAS_ORIGINS;
});
test.each(['https://canvas.example.edu', 'https://canvas.example.edu/api/v1/'])(
  'normalizes approved institution %s',
  (url) => {
    expect(canvasApiBase(url)).toBe('https://canvas.example.edu/api/v1');
  },
);
test.each([
  'http://canvas.example.edu',
  'https://attacker.example',
  'https://user:pass@canvas.example.edu',
  'https://canvas.example.edu/other',
  'https://canvas.example.edu?key=x',
  'https://canvas.example.edu#x',
])('refuses unsafe/unapproved %s before sending credentials', async (url) => {
  expect(await discoverCanvasExpiry({ ...values, 'env.CANVAS_API_URL': url })).toEqual({
    source: 'unknown',
    expiresAt: null,
  });
  expect(get).not.toHaveBeenCalled();
});
test.each([
  { token_hint: 'abcde' },
  { visible_token: 'abcde...' },
  { visible_token: '123~abcde...' },
])('checks user and exact token identifiers %j', async (identifiers) => {
  get.mockResolvedValueOnce({ data: { id: 42 } }).mockResolvedValueOnce({
    data: { user_id: 42, ...identifiers, expires_at: '2027-01-01T00:00:00Z' },
  });
  expect(await discoverCanvasExpiry(values)).toEqual({
    source: 'canvas',
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  expect(get).toHaveBeenLastCalledWith(
    'https://canvas.example.edu/api/v1/users/self/tokens/abcde',
    expect.objectContaining({ maxRedirects: 0, maxContentLength: 16384 }),
  );
});
test.each([
  { user_id: 9, token_hint: 'abcde', expires_at: null },
  { user_id: 42, token_hint: 'wrong', expires_at: null },
  { user_id: 42, token_hint: 'abcde', visible_token: 'wrong...', expires_at: null },
  { user_id: 42, expires_at: null },
  { user_id: 42, token_hint: 'abcde', expires_at: '2027-01-01T00:00:00' },
  { user_id: 42, token_hint: 'abcde' },
])('fails closed for unproven metadata %j', async (metadata) => {
  get.mockResolvedValueOnce({ data: { id: 42 } }).mockResolvedValueOnce({ data: metadata });
  expect(await discoverCanvasExpiry(values)).toEqual({ source: 'unknown', expiresAt: null });
});
test('distinguishes explicitly non-expiring tokens from unknown metadata', async () => {
  get
    .mockResolvedValueOnce({ data: { id: 42 } })
    .mockResolvedValueOnce({ data: { user_id: 42, token_hint: 'abcde', expires_at: null } });
  expect(await discoverCanvasExpiry(values)).toEqual({ source: 'canvas', expiresAt: null });
});
test('does not expose tokens or axios request details on failure', async () => {
  get.mockRejectedValue({ config: { headers: { Authorization: token } }, message: token });
  expect(JSON.stringify(await discoverCanvasExpiry(values))).not.toContain(token);
});
