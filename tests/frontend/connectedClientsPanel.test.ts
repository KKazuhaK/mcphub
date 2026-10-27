import fs from 'fs';
import path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectedClientsPanel from '../../frontend/src/components/workspace/ConnectedClientsPanel';

const readLocale = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales', `${name}.json`), 'utf8'));
const en = readLocale('en');

const lookup = (tree: any, key: string): string =>
  key.split('.').reduce((node, part) => node?.[part], tree);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      (lookup(en, key) ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? ''),
  }),
}));
jest.mock('../../frontend/src/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}));
jest.mock('../../frontend/src/services/workspaceService', () => ({
  fetchWorkspaceClients: jest.fn(),
  revokeWorkspaceClient: jest.fn(),
  revokeAllWorkspaceClients: jest.fn(),
}));

const client = {
  id: 'c1',
  kind: 'oauth',
  name: 'Claude Desktop',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  idle: true,
};

// Renders the panel with its state slots preset: clients, loading, error, busy, revoking, revokingAll.
const renderWithState = (state: unknown[]) => {
  const React = jest.requireActual<typeof import('react')>('react');
  let call = 0;
  const spy = jest
    .spyOn(React, 'useState')
    .mockImplementation(() => [state[call++ % state.length], jest.fn()] as never);
  try {
    return renderToStaticMarkup(createElement(ConnectedClientsPanel));
  } finally {
    spy.mockRestore();
  }
};

describe('ConnectedClientsPanel', () => {
  it('lists clients with an idle badge and a labelled revoke button', () => {
    const html = renderWithState([[client], false, '', false, null, false]);
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('Idle');
    expect(html).toContain('OAuth app');
    expect(html).toContain('aria-label="Revoke Claude Desktop"');
    expect(html).not.toContain('role="dialog"');
  });

  it('asks for confirmation before revoking all, spelling out the consequences', () => {
    const html = renderWithState([[client], false, '', false, null, true]);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Revoke all clients?');
    expect(html).toContain('Your endpoint URL stays the same');
    expect(html).toContain('must re-authorize');
  });

  it('confirms revoking a single client by name', () => {
    const html = renderWithState([[client], false, '', false, client, false]);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Revoke Claude Desktop?');
    expect(html).toContain('endpoint URL are not affected');
  });
});

describe('workspace locale strings', () => {
  it('ships the workspace page strings in every locale', () => {
    const keys = ['nav', 'banner.partial_other', 'endpoint.authNote', 'clients.revokeAllMessage', 'status.error'];
    for (const locale of ['en', 'es', 'fr', 'tr', 'vi', 'zh']) {
      const tree = readLocale(locale).workspacePage;
      for (const key of keys) expect(lookup(tree, key)).toBeTruthy();
    }
  });

  it('mentions the unchanged URL and re-authorization in the revoke-all warning', () => {
    expect(readLocale('zh').workspacePage.clients.revokeAllMessage).toContain('端点 URL 保持不变');
  });
});
