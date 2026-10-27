import type { ServerFormData } from '../../frontend/src/types';
import {
  buildServerPayload,
  getAvailabilityEdits,
  getToolRiskEdit,
  getDefaultUserRiskEdit,
} from '../../frontend/src/utils/serverFormPayload';

describe('buildServerPayload', () => {
  it('preserves args credential targets and placeholders when editing stdio servers', () => {
    const credentialTemplate: ServerFormData['credentialTemplate'] = [
      { target: 'env', name: 'ENV_KEY' },
      { target: 'args', name: 'API_KEY' },
    ];
    const payload = buildServerPayload({
      formData: {
        name: 'cli',
        url: '',
        command: 'node',
        arguments: '',
        args: ['--key={{args.API_KEY}}'],
        env: [],
        headers: [],
        credentialTemplate,
      },
      serverType: 'stdio',
      envVars: [],
      headerVars: [],
    });
    expect(payload.config.credentialTemplate).toEqual(credentialTemplate);
    expect(payload.config.args).toEqual(['--key={{args.API_KEY}}']);
  });
  it('preserves stdio argument boundaries, empty values, and literal shell syntax', () => {
    const args = [
      '-c',
      'exec cli --api-key "$my_api_key"',
      '/path with spaces',
      '',
      '  padded  ',
      'a"b\\c',
    ];
    const payload = buildServerPayload({
      formData: {
        name: 'wrapped',
        url: '',
        command: 'sh',
        arguments: '',
        args,
        env: [],
        headers: [],
      },
      serverType: 'stdio',
      envVars: [],
      headerVars: [],
    });
    expect(payload.config.args).toEqual(args);
  });

  it('keeps empty headers and env payloads explicit for SSE servers', () => {
    const payload = buildServerPayload({
      formData: {
        name: 'remote-server',
        description: '',
        url: 'https://example.com/sse',
        command: '',
        arguments: '',
        args: [],
        env: [],
        headers: [],
        passthroughHeaders: '',
        options: {
          timeout: 60000,
          resetTimeoutOnProgress: false,
          maxTotalTimeout: undefined,
        },
        keepAlive: {
          enabled: false,
          interval: 60000,
        },
        oauth: {
          clientId: '',
          clientSecret: '',
          scopes: '',
          accessToken: '',
          refreshToken: '',
          authorizationEndpoint: '',
          tokenEndpoint: '',
          resource: '',
        },
        openapi: {
          inputMode: 'url',
          url: '',
          schema: '',
          version: '3.1.0',
          securityType: 'none',
          passthroughHeaders: '',
        },
      },
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });

    expect(payload.name).toBe('remote-server');
    expect(payload.config).toMatchObject({
      type: 'sse',
      url: 'https://example.com/sse',
      env: {},
      headers: {},
      passthroughHeaders: [],
      oauth: {},
      options: {
        resetTimeoutOnProgress: false,
      },
      enableKeepAlive: false,
      description: '',
    });
    expect(payload.config).toHaveProperty('keepAliveInterval', undefined);
  });

  it('keeps keep-alive disabled by default for remote server payloads', () => {
    const payload = buildServerPayload({
      formData: {
        name: 'remote-server',
        description: '',
        url: 'https://example.com/mcp',
        command: '',
        arguments: '',
        args: [],
        env: [],
        headers: [],
        passthroughHeaders: '',
        options: {},
        oauth: {},
        openapi: {
          inputMode: 'url',
          url: '',
          schema: '',
          version: '3.1.0',
          securityType: 'none',
          passthroughHeaders: '',
        },
      },
      serverType: 'streamable-http',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config).toMatchObject({
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      enableKeepAlive: false,
    });
    expect(payload.config).toHaveProperty('keepAliveInterval', undefined);
  });

  it('persists explicit user sharing only for group visibility', () => {
    const payload = buildServerPayload({
      formData: {
        name: 'shared-server',
        description: '',
        url: 'https://example.com/mcp',
        command: '',
        arguments: '',
        args: [],
        env: [],
        headers: [],
        visibility: 'group',
        sharedWithUsers: [' alice ', 'bob', 'alice', ''],
        options: {},
        oauth: {},
        openapi: {
          inputMode: 'url',
          url: '',
          schema: '',
          version: '3.1.0',
          securityType: 'none',
          passthroughHeaders: '',
        },
      },
      serverType: 'streamable-http',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config).toMatchObject({
      visibility: 'group',
      sharedWithUsers: ['alice', 'bob'],
    });
  });

  it('clears remote-only fields when switching to stdio', () => {
    const payload = buildServerPayload({
      formData: {
        name: '  stdio-server  ',
        credentialTemplate: [{ target: 'env', name: 'PERSONAL_KEY' }],
        idleTimeoutMs: 12000,
        description: 'local command server',
        url: 'https://example.com/previous-sse',
        command: 'npx',
        arguments: '-y demo-server',
        args: ['-y', 'demo-server'],
        env: [],
        headers: [],
        passthroughHeaders: 'Authorization',
        options: {
          timeout: 60000,
          resetTimeoutOnProgress: false,
          maxTotalTimeout: undefined,
        },
        keepAlive: {
          enabled: true,
          interval: 15000,
        },
        oauth: {
          clientId: 'client-id',
          clientSecret: 'secret',
          scopes: 'openid profile',
          accessToken: 'token',
          refreshToken: 'refresh',
          authorizationEndpoint: 'https://example.com/auth',
          tokenEndpoint: 'https://example.com/token',
          resource: 'https://example.com/mcp',
        },
        openapi: {
          inputMode: 'url',
          url: 'https://example.com/openapi.json',
          schema: '',
          version: '3.1.0',
          securityType: 'none',
          passthroughHeaders: 'Authorization',
        },
      },
      serverType: 'stdio',
      envVars: [],
      headerVars: [],
    });

    expect(payload.name).toBe('stdio-server');
    expect(payload.config.credentialTemplate).toEqual([{ target: 'env', name: 'PERSONAL_KEY' }]);
    expect(payload.config.idleTimeoutMs).toBe(12000);
    expect(payload.config).toMatchObject({
      type: 'stdio',
      description: 'local command server',
      command: 'npx',
      args: ['-y', 'demo-server'],
      env: {},
      options: {},
    });
    expect(payload.config).not.toHaveProperty('url');
    expect(payload.config).not.toHaveProperty('openapi');
    expect(payload.config).not.toHaveProperty('headers');
    expect(payload.config).not.toHaveProperty('passthroughHeaders');
    expect(payload.config).not.toHaveProperty('oauth');
  });

  // ── #F1 OAuth sub-field round-trip ────────────────────────────────────────
  // The form has no in-form editor for dynamicRegistration/revocationEndpoint/
  // redirectUri, so they must be carried through the edit/duplicate → submit
  // round-trip instead of being silently dropped.
  const dynamicRegistration = {
    enabled: true,
    issuer: 'https://auth.example.com',
    registrationEndpoint: 'https://auth.example.com/register',
    metadata: {
      client_name: 'MCPHub',
      client_uri: 'https://mcphub.example.com',
      logo_uri: 'https://mcphub.example.com/logo.png',
      scope: 'openid profile',
      redirect_uris: ['https://mcphub.example.com/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      contacts: ['admin@example.com'],
      software_id: 'mcphub',
      software_version: '1.0.0',
    },
    initialAccessToken: 'reg-token',
  };

  const buildSseForm = (oauth: ServerFormData['oauth']): ServerFormData => ({
    name: 'oauth-server',
    description: '',
    url: 'https://example.com/mcp',
    command: '',
    arguments: '',
    args: [],
    env: [],
    headers: [],
    passthroughHeaders: '',
    options: {
      timeout: 60000,
      resetTimeoutOnProgress: false,
      maxTotalTimeout: undefined,
    },
    keepAlive: {
      enabled: false,
      interval: 60000,
    },
    oauth,
    openapi: {
      inputMode: 'url',
      url: '',
      schema: '',
      version: '3.1.0',
      securityType: 'none',
      passthroughHeaders: '',
    },
  });

  it('preserves a full dynamicRegistration sub-object verbatim (deep equal)', () => {
    const payload = buildServerPayload({
      formData: buildSseForm({
        clientId: 'static-client',
        clientSecret: 'secret',
        scopes: 'openid',
        accessToken: 'tok',
        refreshToken: 'refresh',
        authorizationEndpoint: 'https://example.com/auth',
        tokenEndpoint: 'https://example.com/token',
        resource: 'https://example.com/mcp',
        dynamicRegistration,
      }),
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config.oauth?.dynamicRegistration).toEqual(dynamicRegistration);
    expect(payload.config.oauth?.dynamicRegistration).toBe(dynamicRegistration);
    // Static OAuth fields are still normalized/emitted as before.
    expect(payload.config.oauth).toMatchObject({
      clientId: 'static-client',
      clientSecret: 'secret',
      scopes: ['openid'],
      accessToken: 'tok',
      refreshToken: 'refresh',
      authorizationEndpoint: 'https://example.com/auth',
      tokenEndpoint: 'https://example.com/token',
      resource: 'https://example.com/mcp',
    });
  });

  it('does not emit a dynamicRegistration key when the source lacks it', () => {
    const payload = buildServerPayload({
      formData: buildSseForm({
        clientId: 'static-client',
        clientSecret: 'secret',
        scopes: 'openid',
        accessToken: 'tok',
        refreshToken: 'refresh',
        authorizationEndpoint: 'https://example.com/auth',
        tokenEndpoint: 'https://example.com/token',
        resource: 'https://example.com/mcp',
      }),
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config.oauth).not.toHaveProperty('dynamicRegistration');
    expect(payload.config.oauth).toMatchObject({
      clientId: 'static-client',
      clientSecret: 'secret',
      scopes: ['openid'],
      accessToken: 'tok',
      refreshToken: 'refresh',
    });
  });

  it('keeps static OAuth field behavior unchanged when no carry fields are present', () => {
    // Regression protection: an oauth object with only static fields must not
    // gain a dynamicRegistration/revocationEndpoint key, and an entirely empty
    // oauth must still produce `oauth: {}`.
    const payload = buildServerPayload({
      formData: buildSseForm({
        clientId: 'c',
        clientSecret: 's',
        scopes: 'a b',
      }),
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config.oauth).toEqual({
      clientId: 'c',
      clientSecret: 's',
      scopes: ['a', 'b'],
    });
    expect(payload.config.oauth).not.toHaveProperty('dynamicRegistration');
    expect(payload.config.oauth).not.toHaveProperty('revocationEndpoint');
  });

  it('round-trips explicit authorization server metadata through a form save', () => {
    const authorizationServerMetadata = {
      issuer: 'https://as.example.com',
      authorization_endpoint: 'https://as.example.com/authorize',
      token_endpoint: 'https://as.example.com/token',
      response_types_supported: ['code'],
    };
    const payload = buildServerPayload({
      formData: buildSseForm({ authorizationServerMetadata }),
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });
    expect(payload.config.oauth?.authorizationServerMetadata).toEqual(authorizationServerMetadata);
  });

  it('preserves revocationEndpoint, redirectUri and dynamicRegistration together (deep equal)', () => {
    const payload = buildServerPayload({
      formData: buildSseForm({
        clientId: 'static-client',
        scopes: 'openid',
        revocationEndpoint: 'https://auth.example.com/revoke',
        redirectUri: 'https://mcphub.example.com/oauth/callback',
        dynamicRegistration,
      }),
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config.oauth?.dynamicRegistration).toEqual(dynamicRegistration);
    expect(payload.config.oauth?.revocationEndpoint).toEqual('https://auth.example.com/revoke');
    expect(payload.config.oauth?.redirectUri).toEqual('https://mcphub.example.com/oauth/callback');
    // Static OAuth fields keep their existing normalization alongside the
    // carry-over fields.
    expect(payload.config.oauth).toMatchObject({
      clientId: 'static-client',
      scopes: ['openid'],
    });
  });

  it('does not emit revocationEndpoint, redirectUri or dynamicRegistration keys when absent', () => {
    const payload = buildServerPayload({
      formData: buildSseForm({
        clientId: 'static-client',
        scopes: 'openid',
      }),
      serverType: 'sse',
      envVars: [],
      headerVars: [],
    });

    expect(payload.config.oauth).toBeDefined();
    expect(payload.config.oauth).not.toHaveProperty('dynamicRegistration');
    expect(payload.config.oauth).not.toHaveProperty('revocationEndpoint');
    expect(payload.config.oauth).not.toHaveProperty('redirectUri');
    expect(Object.keys(payload.config.oauth ?? {})).toEqual(['clientId', 'scopes']);
  });
});

describe('stdio buffer form payload', () => {
  const payload = (maxBufferSize?: number) =>
    buildServerPayload({
      formData: {
        name: 'big',
        command: 'node',
        url: '',
        arguments: '',
        args: [],
        env: [],
        headers: [],
        options: { maxBufferSize },
      },
      serverType: 'stdio',
      envVars: [],
      headerVars: [],
    });
  it('preserves an explicit limit and omits an unset limit', () => {
    expect(payload(268435456).config.options).toEqual({ maxBufferSize: 268435456 });
    expect(payload().config.options).toEqual({});
  });
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid limits %s', (size) => {
    expect(() => payload(size)).toThrow('positive safe integer');
  });
});

it.each([undefined, false, true])('round-trips HTTP OAuth exception=%s from the form', (value) => {
  const payload = buildServerPayload({
    formData: {
      name: 'gitlab',
      url: 'http://gitlab.example/mcp',
      command: '',
      arguments: '',
      env: [],
      headers: [],
      oauth: { allowInsecureTokenEndpoint: value },
    },
    serverType: 'streamable-http',
    envVars: [],
    headerVars: [],
  });
  expect(payload.config.oauth?.allowInsecureTokenEndpoint).toBe(value);
});

test('preserves personal OAuth mode in an HTTP server form payload', () => {
  const result = buildServerPayload({
    formData: { name: 'gitlab', url: 'https://gitlab.example/mcp', command: '', arguments: '', args: [], env: [], headers: [], oauth: { identityMode: 'personal', clientId: 'client', scopes: 'mcp' } },
    serverType: 'streamable-http', envVars: [], headerVars: [],
  });
  expect(result.config.oauth).toMatchObject({ identityMode: 'personal', clientId: 'client', scopes: ['mcp'] });
});

test('switching a shared OAuth server to personal mode removes shared tokens from the form payload', () => {
  const result = buildServerPayload({ formData: { name: 'gitlab', url: 'https://gitlab.example/mcp', command: '', arguments: '', args: [], env: [], headers: [], oauth: { identityMode: 'personal', accessToken: 'old-shared', refreshToken: 'old-refresh' } }, serverType: 'streamable-http', envVars: [], headerVars: [] });
  expect(result.config.oauth).toEqual({ identityMode: 'personal' });
});

describe('upstream protocol config in dashboard payloads', () => {
  it.each(['auto', 'legacy'] as const)(
    'preserves %s when editing or duplicating HTTP servers',
    (mode) => {
      const input = {
        formData: {
          name: 'remote',
          url: 'https://example.com/mcp',
          command: '',
          arguments: '',
          env: [],
          headers: [],
          protocolNegotiation: mode,
        },
        envVars: [],
        headerVars: [],
      };
      expect(
        buildServerPayload({ ...input, serverType: 'streamable-http' }).config.protocolNegotiation,
      ).toBe(mode);
      expect(
        buildServerPayload({ ...input, serverType: 'stdio' }).config.protocolNegotiation,
      ).toBeUndefined();
    },
  );
});

describe('admin availability fields in dashboard payloads', () => {
  const stored = {
    pausedUsers: ['bob'],
    maintenance: { enabled: true, until: '2999-01-01T00:00:00.000Z', message: 'Upgrading.' },
  };
  const form = (overrides: Partial<ServerFormData> = {}): ServerFormData => ({
    name: 'remote',
    url: 'https://example.com/mcp',
    command: '',
    arguments: '',
    env: [],
    headers: [],
    ...stored,
    ...overrides,
  });
  const build = (
    formData: ServerFormData,
    availabilityEdits?: Parameters<typeof buildServerPayload>[0]['availabilityEdits'],
  ) =>
    buildServerPayload({
      formData,
      serverType: 'streamable-http',
      envVars: [],
      headerVars: [],
      availabilityEdits,
    }).config;

  it('omits both keys when nothing was edited, hidden or not', () => {
    const edits = getAvailabilityEdits(form(), stored);
    expect(edits).toEqual({ pausedUsers: false, maintenance: false });

    for (const config of [build(form(), edits), build(form())]) {
      expect(config).not.toHaveProperty('pausedUsers');
      expect(config).not.toHaveProperty('maintenance');
    }
  });

  it('sends only the field the admin changed', () => {
    const edits = getAvailabilityEdits(form({ pausedUsers: ['bob', 'carol'] }), stored);
    expect(edits).toEqual({ pausedUsers: true, maintenance: false });

    const config = build(form({ pausedUsers: ['bob', 'carol'] }), edits);
    expect(config.pausedUsers).toEqual(['bob', 'carol']);
    expect(config).not.toHaveProperty('maintenance');
  });

  it('is not fooled by reordering or duplicates in the pause list', () => {
    expect(getAvailabilityEdits(form({ pausedUsers: ['bob', 'bob'] }), stored).pausedUsers).toBe(
      false,
    );
  });

  it('sends null to clear a window the admin switched off, even a malformed stored one', () => {
    const malformed = { ...stored, maintenance: { enabled: true, until: 'garbage', message: '' } };
    const cleared = form({ maintenance: { enabled: false, until: 'garbage', message: '' } });
    const edits = getAvailabilityEdits(cleared, malformed);
    expect(edits.maintenance).toBe(true);

    expect(build(cleared, edits).maintenance).toBeNull();
  });

  it('sends an edited window with its zone-qualified end time', () => {
    const edited = form({ maintenance: { ...stored.maintenance, message: 'New text' } });
    const config = build(edited, getAvailabilityEdits(edited, stored));
    expect(config.maintenance).toEqual({
      until: '2999-01-01T00:00:00.000Z',
      message: 'New text',
    });
  });

  it('never sends the keys for a form that does not carry them (non-admins)', () => {
    const plain = form({ pausedUsers: undefined, maintenance: undefined });
    const config = build(plain, getAvailabilityEdits(plain, stored));
    expect(config).not.toHaveProperty('pausedUsers');
    expect(config).not.toHaveProperty('maintenance');
  });
});

describe('maximum tool risk in the server payload', () => {
  const form = (maxToolRisk?: ServerFormData['maxToolRisk']): ServerFormData => ({
    name: 'remote',
    url: 'https://example.com/mcp',
    command: '',
    arguments: '',
    env: [],
    headers: [],
    ...(maxToolRisk ? { maxToolRisk } : {}),
  });
  const build = (formData: ServerFormData, toolRiskEdited?: boolean) =>
    buildServerPayload({
      formData,
      serverType: 'streamable-http',
      envVars: [],
      headerVars: [],
      toolRiskEdited,
    }).config as Record<string, unknown>;

  it('detects only a change the admin made', () => {
    expect(getToolRiskEdit(form('external'), form('external'))).toBe(false);
    expect(getToolRiskEdit(form('read'), form('external'))).toBe(true);
    expect(getToolRiskEdit(form('external'), form('read'))).toBe(true);
    // A form that does not carry the field (non-admins) never edits it.
    expect(getToolRiskEdit(form(), form('read'))).toBe(false);
  });

  it('sends the cap only when it was edited', () => {
    expect(build(form('read'), true).maxToolRisk).toBe('read');
    expect(build(form('write'), true).maxToolRisk).toBe('write');
    expect(build(form('read'), false)).not.toHaveProperty('maxToolRisk');
    expect(build(form('read'))).not.toHaveProperty('maxToolRisk');
  });

  it('sends null for "external" so the stored cap is cleared', () => {
    expect(build(form('external'), true).maxToolRisk).toBeNull();
  });

  it('never sends the cap for a form that does not carry it', () => {
    expect(build(form(), true)).not.toHaveProperty('maxToolRisk');
  });

  it('never carries the per-tool overrides, which are saved one tool at a time', () => {
    expect(build(form('read'), true)).not.toHaveProperty('toolRiskOverrides');
  });

  describe('default level for users', () => {
    const buildDefault = (formData: ServerFormData, defaultRiskEdited?: boolean) =>
      buildServerPayload({
        formData,
        serverType: 'streamable-http',
        envVars: [],
        headerVars: [],
        defaultRiskEdited,
      }).config as Record<string, unknown>;
    const withDefault = (defaultUserRisk?: ServerFormData['defaultUserRisk']): ServerFormData => ({
      ...form(),
      ...(defaultUserRisk ? { defaultUserRisk } : {}),
    });

    it('detects only a change the admin made, and never for a form without the field', () => {
      expect(getDefaultUserRiskEdit(withDefault('read'), withDefault('read'))).toBe(false);
      expect(getDefaultUserRiskEdit(withDefault('write'), withDefault('read'))).toBe(true);
      expect(getDefaultUserRiskEdit(withDefault(), withDefault('write'))).toBe(false);
    });

    it('sends it only when edited, with read as null so the stored one is cleared', () => {
      expect(buildDefault(withDefault('write'), true).defaultUserRisk).toBe('write');
      expect(buildDefault(withDefault('read'), true).defaultUserRisk).toBeNull();
      expect(buildDefault(withDefault('write'), false)).not.toHaveProperty('defaultUserRisk');
      expect(buildDefault(withDefault(), true)).not.toHaveProperty('defaultUserRisk');
    });
  });
});
