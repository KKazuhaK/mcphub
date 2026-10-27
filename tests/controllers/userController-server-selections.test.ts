import type { Request, Response } from 'express';

const mockDeleteUser = jest.fn();
const mockDeleteCredentialBindings = jest.fn();
const mockDeleteUserServerSelections = jest.fn();

jest.mock('../../src/services/userService.js', () => ({
  deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
}));
jest.mock('../../src/services/credentialBindingService.js', () => ({
  deleteCredentialBindings: (...args: unknown[]) => mockDeleteCredentialBindings(...args),
}));
jest.mock('../../src/services/userServerSelectionService.js', () => ({
  deleteUserServerSelections: (...args: unknown[]) => mockDeleteUserServerSelections(...args),
}));

import { deleteExistingUser } from '../../src/controllers/userController.js';

const run = async () => {
  const json = jest.fn();
  const res = { json, status: jest.fn(() => ({ json })) } as unknown as Response;
  await deleteExistingUser(
    {
      params: { username: 'alice' },
      user: { username: 'admin', isAdmin: true },
    } as unknown as Request,
    res,
  );
  return res;
};

describe('deleting a user', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes that user’s server selections', async () => {
    mockDeleteUser.mockResolvedValue(true);

    await run();

    expect(mockDeleteCredentialBindings).toHaveBeenCalledWith({ username: 'alice' });
    expect(mockDeleteUserServerSelections).toHaveBeenCalledWith({ username: 'alice' });
  });

  it('keeps the selections when the user could not be deleted', async () => {
    mockDeleteUser.mockResolvedValue(false);

    await run();

    expect(mockDeleteUserServerSelections).not.toHaveBeenCalled();
  });
});
