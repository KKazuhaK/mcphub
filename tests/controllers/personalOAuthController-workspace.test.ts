import express from 'express';
import request from 'supertest';

let workspaceConfig: Record<string, unknown> | null;
const mockNotifyUserListsChanged = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findById: async (name: string) => ({
      name,
      owner: 'admin',
      visibility: 'public',
      oauth: { identityMode: 'personal' },
    }),
  }),
  getUserServerSelectionDao: jest.fn(),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => workspaceConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/services/mcpService.js', () => ({
  createTransportFromConfig: jest.fn(),
  notifyUserListsChanged: (...args: unknown[]) => mockNotifyUserListsChanged(...args),
}));
jest.mock('../../src/services/credentialBindingService.js', () => ({
  credentialBindingEvents: { emit: jest.fn() },
  getCredentialBindingStatus: jest.fn(),
}));
jest.mock('../../src/services/authorizationService.js', () => ({
  authorizationService: { can: () => true },
}));
jest.mock('../../src/services/personalOAuthService.js', () => ({
  hasPersonalOAuth: () => true,
  findPersonalOAuthFlow: jest.fn(),
  disconnectPersonalOAuth: (...args: unknown[]) => mockDisconnect(...args),
  PersonalOAuthContext: {
    load: async () => ({ config: { oauth: {} }, authorizationUrl: undefined }),
  },
}));

import { managePersonalOAuth } from '../../src/controllers/personalOAuthController.js';

const app = express();
app.use((req, _res, next) => {
  const header = req.headers['x-test-user'];
  if (typeof header === 'string') (req as any).user = JSON.parse(header);
  next();
});
app.delete('/api/oauth/:name', managePersonalOAuth);

const alice = JSON.stringify({ username: 'alice', isAdmin: false });

describe('personal OAuth notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workspaceConfig = { workspace: { enabled: true } };
  });

  it('notifies the user who disconnected under Workspace Mode', async () => {
    await request(app).delete('/api/oauth/remote').set('x-test-user', alice).expect(200);

    expect(mockDisconnect).toHaveBeenCalledWith('remote', 'alice');
    expect(mockNotifyUserListsChanged).toHaveBeenCalledTimes(1);
    expect(mockNotifyUserListsChanged).toHaveBeenCalledWith('alice');
  });

  it('sends nothing when the setting is off', async () => {
    workspaceConfig = { workspace: { enabled: false } };
    await request(app).delete('/api/oauth/remote').set('x-test-user', alice).expect(200);

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
  });
});
