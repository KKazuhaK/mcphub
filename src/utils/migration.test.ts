import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';

// Mocks must be defined before importing the module under test.

const initializeDatabaseMock = jest.fn(async () => undefined);
jest.mock('../db/connection.js', () => ({
  initializeDatabase: initializeDatabaseMock,
}));

const setDaoFactoryMock = jest.fn();
jest.mock('../dao/DaoFactory.js', () => ({
  setDaoFactory: setDaoFactoryMock,
}));

jest.mock('../dao/DatabaseDaoFactory.js', () => ({
  DatabaseDaoFactory: {
    getInstance: jest.fn(() => ({
      /* noop */
    })),
  },
}));

const loadOriginalSettingsMock = jest.fn(() => ({ users: [] }));
jest.mock('../config/index.js', () => ({
  loadOriginalSettings: loadOriginalSettingsMock,
}));

const userRepoCountMock = jest.fn<() => Promise<number>>();
jest.mock('../db/repositories/UserRepository.js', () => ({
  UserRepository: jest.fn().mockImplementation(() => ({
    count: userRepoCountMock,
  })),
}));

const bearerKeyCountMock = jest.fn<() => Promise<number>>();
const bearerKeyCreateMock =
  jest.fn<
    (data: {
      name: string;
      token: null;
      tokenHash: string;
      tokenPrefix: string;
      enabled: boolean;
      accessType: string;
      allowedGroups: string[];
      allowedServers: string[];
    }) => Promise<unknown>
  >();
jest.mock('../db/repositories/BearerKeyRepository.js', () => ({
  BearerKeyRepository: jest.fn().mockImplementation(() => ({
    count: bearerKeyCountMock,
    create: bearerKeyCreateMock,
  })),
}));

const systemConfigGetMock = jest.fn<() => Promise<any>>();
const systemConfigUpdateMock = jest.fn<(data: any) => Promise<unknown>>();
jest.mock('../db/repositories/SystemConfigRepository.js', () => ({
  SystemConfigRepository: jest.fn().mockImplementation(() => ({
    get: systemConfigGetMock,
    update: systemConfigUpdateMock,
  })),
}));

describe('initializeDatabaseMode legacy bearer auth migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips legacy migration when bearerKeys table already has data', async () => {
    userRepoCountMock.mockResolvedValue(1);
    bearerKeyCountMock.mockResolvedValue(2);
    systemConfigGetMock.mockResolvedValue({
      routing: { enableBearerAuth: true, bearerAuthKey: 'db-key' },
    });

    const { initializeDatabaseMode } = await import('./migration.js');
    const ok = await initializeDatabaseMode();

    expect(ok).toBe(true);
    expect(initializeDatabaseMock).toHaveBeenCalled();
    expect(loadOriginalSettingsMock).not.toHaveBeenCalled();
    expect(bearerKeyCreateMock).not.toHaveBeenCalled();
    // The superseded legacy plaintext key is cleared, not migrated again.
    expect(systemConfigUpdateMock).toHaveBeenCalledWith({
      routing: { enableBearerAuth: true, bearerAuthKey: '' },
    });
  });

  it('migrates legacy routing bearerAuthKey into bearerKeys when users exist and keys table is empty', async () => {
    userRepoCountMock.mockResolvedValue(3);
    bearerKeyCountMock.mockResolvedValue(0);
    systemConfigGetMock.mockResolvedValue({
      routing: { enableBearerAuth: true, bearerAuthKey: 'db-key' },
    });

    const { initializeDatabaseMode } = await import('./migration.js');
    const ok = await initializeDatabaseMode();

    expect(ok).toBe(true);
    expect(loadOriginalSettingsMock).not.toHaveBeenCalled();
    expect(systemConfigGetMock).toHaveBeenCalledTimes(1);
    expect(bearerKeyCreateMock).toHaveBeenCalledTimes(1);
    expect(bearerKeyCreateMock).toHaveBeenCalledWith({
      name: 'default',
      token: null,
      tokenHash: createHash('sha256').update('db-key').digest('hex'),
      tokenPrefix: 'db',
      enabled: true,
      kind: 'system',
      accessType: 'all',
      allowedGroups: [],
      allowedServers: [],
    });
    // Nothing is left behind in plaintext.
    expect(systemConfigUpdateMock).toHaveBeenCalledWith({
      routing: { enableBearerAuth: true, bearerAuthKey: '' },
    });
  });

  it('does not migrate when routing has no bearerAuthKey', async () => {
    userRepoCountMock.mockResolvedValue(1);
    bearerKeyCountMock.mockResolvedValue(0);
    systemConfigGetMock.mockResolvedValue({
      routing: { enableBearerAuth: true, bearerAuthKey: '   ' },
    });

    const { initializeDatabaseMode } = await import('./migration.js');
    const ok = await initializeDatabaseMode();

    expect(ok).toBe(true);
    expect(loadOriginalSettingsMock).not.toHaveBeenCalled();
    expect(systemConfigGetMock).toHaveBeenCalledTimes(1);
    expect(bearerKeyCreateMock).not.toHaveBeenCalled();
    expect(systemConfigUpdateMock).not.toHaveBeenCalled();
  });
});
