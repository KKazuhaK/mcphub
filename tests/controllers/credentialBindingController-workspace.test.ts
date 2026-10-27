import express from 'express';
import request from 'supertest';

let workspaceConfig: Record<string, unknown> | null;
const mockNotifyUserListsChanged = jest.fn();
const mockSaveCredentialBinding = jest.fn();
const mockDeleteCredentialBindings = jest.fn();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findById: async (name: string) =>
      name === 'keyed'
        ? { name, owner: 'admin', visibility: 'public', credentialTemplate: [] }
        : null,
    findAll: async () => [],
  }),
  getUserServerSelectionDao: jest.fn(),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => workspaceConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/services/mcpService.js', () => ({
  notifyUserListsChanged: (...args: unknown[]) => mockNotifyUserListsChanged(...args),
}));
jest.mock('../../src/services/credentialBindingService.js', () => ({
  saveCredentialBinding: (...args: unknown[]) => mockSaveCredentialBinding(...args),
  deleteCredentialBindings: (...args: unknown[]) => mockDeleteCredentialBindings(...args),
  getCredentialBindingStatus: jest.fn(),
}));
jest.mock('../../src/services/authorizationService.js', () => ({
  authorizationService: { can: () => true },
}));

import { updateMyCredential } from '../../src/controllers/credentialBindingController.js';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const header = req.headers['x-test-user'];
  if (typeof header === 'string') (req as any).user = JSON.parse(header);
  next();
});
app.put('/api/credentials/:name', updateMyCredential);
app.delete('/api/credentials/:name', updateMyCredential);

const alice = JSON.stringify({ username: 'alice', isAdmin: false });

describe('credential binding notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workspaceConfig = { workspace: { enabled: true } };
  });

  it('notifies only the saving user under Workspace Mode', async () => {
    await request(app)
      .put('/api/credentials/keyed')
      .set('x-test-user', alice)
      .send({ values: { 'env.KEY': 'v' } })
      .expect(200);

    expect(mockSaveCredentialBinding).toHaveBeenCalledTimes(1);
    expect(mockNotifyUserListsChanged).toHaveBeenCalledTimes(1);
    expect(mockNotifyUserListsChanged).toHaveBeenCalledWith('alice');
  });

  it('notifies the user who deleted a binding', async () => {
    await request(app).delete('/api/credentials/keyed').set('x-test-user', alice).expect(200);

    expect(mockDeleteCredentialBindings).toHaveBeenCalledWith({
      serverName: 'keyed',
      username: 'alice',
    });
    expect(mockNotifyUserListsChanged).toHaveBeenCalledWith('alice');
  });

  it.each([{}, { workspace: { enabled: false } }, null])(
    'sends nothing when the setting is %j',
    async (config) => {
      workspaceConfig = config;
      await request(app)
        .put('/api/credentials/keyed')
        .set('x-test-user', alice)
        .send({ values: {} })
        .expect(200);
      await request(app).delete('/api/credentials/keyed').set('x-test-user', alice).expect(200);

      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    },
  );

  it('does not notify when the save fails', async () => {
    mockSaveCredentialBinding.mockRejectedValueOnce(new Error('boom'));
    await request(app)
      .put('/api/credentials/keyed')
      .set('x-test-user', alice)
      .send({ values: {} })
      .expect(500);

    expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
  });
});
