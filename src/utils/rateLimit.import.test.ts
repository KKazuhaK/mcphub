describe('rateLimit module', () => {
  it('logs no error or warning when imported (no key generator validation noise)', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;
    jest.resetModules();
    try {
      const mod = await import('./rateLimit.js');
      expect(mod.activityHistoryRateLimiter).toBeDefined();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
