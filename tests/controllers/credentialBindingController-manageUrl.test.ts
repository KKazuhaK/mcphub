import express from 'express';
import request from 'supertest';

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findAll: async () => [
      {
        name: 'ubc-personal',
        type: 'stdio',
        command: 'uvx',
        owner: 'admin',
        visibility: 'public',
        manageUrl: 'https://mcp.kazuhahub.com/ubc/',
        credentialTemplate: [{ target: 'env', name: 'READ_TOKEN' }],
      },
      {
        name: 'no-link',
        type: 'stdio',
        command: 'uvx',
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [{ target: 'env', name: 'API_KEY' }],
      },
    ],
  }),
}));
jest.mock('../../src/services/credentialBindingService.js', () => ({
  saveCredentialBinding: jest.fn(),
  deleteCredentialBindings: jest.fn(),
  getCredentialBindingStatus: async () => ({
    configured: false,
    configuredSlots: [],
    updatedAt: null,
  }),
}));
jest.mock('../../src/services/authorizationService.js', () => ({
  authorizationService: { can: () => true },
}));

import { listMyCredentials } from '../../src/controllers/credentialBindingController.js';

const app = express();
app.use((req, _res, next) => {
  (req as any).user = { username: 'alice', isAdmin: false };
  next();
});
app.get('/api/credentials', listMyCredentials);

describe('GET /credentials', () => {
  it('includes the management link of each binding for a non-admin user', async () => {
    const response = await request(app).get('/api/credentials').expect(200);

    const byName = Object.fromEntries(
      response.body.data.map((item: { serverName: string }) => [item.serverName, item]),
    );
    expect(byName['ubc-personal'].manageUrl).toBe('https://mcp.kazuhahub.com/ubc/');
    expect(byName['no-link'].manageUrl).toBeUndefined();
  });
});
