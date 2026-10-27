import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceServer } from '../../frontend/src/types';
import WorkspaceServiceRow from '../../frontend/src/components/workspace/WorkspaceServiceRow';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${options.count}` : key,
  }),
}));

const server = (extra: Partial<WorkspaceServer> = {}): WorkspaceServer => ({
  name: 'notes',
  selected: true,
  enabled: true,
  toolCount: 4,
  riskCeiling: 'read',
  riskCeilingIsDefault: false,
  riskCounts: { read: 4, write: 3, external: 2 },
  maxAllowedRisk: 'external',
  annotationsTrusted: true,
  requiresPersonalCredential: false,
  credentialConfigured: true,
  status: { code: 'available', message: 'ok', action: null },
  ...extra,
});

const render = (workspaceServer: WorkspaceServer) =>
  renderToStaticMarkup(
    createElement(WorkspaceServiceRow, {
      server: workspaceServer,
      credentialServers: null,
      busy: false,
      onToggle: jest.fn(),
      onRiskChange: jest.fn(),
      onAction: jest.fn(),
      onCopyEndpoint: jest.fn(),
    }),
  );

const radios = (html: string) =>
  [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((match) => match[0]);

describe('the tool risk control on a workspace service row', () => {
  it('offers three options with the number of tools at each level', () => {
    const html = render(server());
    const options = radios(html);
    expect(options).toHaveLength(3);
    expect(options.map((tag) => /data-risk-level="(\w+)"/.exec(tag)![1])).toEqual([
      'read',
      'write',
      'external',
    ]);
    expect(html).toContain('workspacePage.risk.level.read.label');
    expect(html).toContain('workspacePage.risk.level.write.label');
    expect(html).toContain('workspacePage.risk.level.external.label');
    for (const count of ['4', '3', '2'])
      expect(html).toContain(`workspacePage.services.toolCount:${count}`);
  });

  it('marks the chosen level and reads read only by default', () => {
    const options = radios(render(server()));
    expect(options.map((tag) => tag.includes('aria-checked="true"'))).toEqual([true, false, false]);
    expect(
      radios(render(server({ riskCeiling: 'external' }))).map((tag) =>
        tag.includes('aria-checked="true"'),
      ),
    ).toEqual([false, false, true]);
  });

  it('disables the options above the administrator’s cap and says why', () => {
    const html = render(server({ maxAllowedRisk: 'write' }));
    expect(radios(html).map((tag) => tag.includes('disabled'))).toEqual([false, false, true]);
    expect(html).toContain('title="workspacePage.risk.aboveCap"');
  });

  it('explains the control and tells the user how many tools their choice hides', () => {
    const html = render(server());
    expect(html).toContain('workspacePage.risk.explanation');
    expect(html).toContain('workspacePage.risk.hiddenNotice:5');
    expect(render(server({ riskCeiling: 'external' }))).not.toContain(
      'workspacePage.risk.hiddenNotice',
    );
  });

  it('is shown only for a service in the workspace', () => {
    expect(radios(render(server({ selected: false })))).toHaveLength(0);
  });

  it('keeps the existing tool count, which now counts only what the ceiling allows', () => {
    expect(render(server())).toContain('workspacePage.services.toolCount:4');
  });

  it('says to connect, rather than showing zero tools, when the tools are not known', () => {
    const html = render(server({ toolCount: null, riskCounts: null }));
    expect(html).toContain('workspacePage.risk.unknownTools');
    expect(html).toContain('workspacePage.risk.connectToSee');
    expect(html).not.toContain('workspacePage.services.toolCount');
    expect(html).not.toContain('workspacePage.risk.hiddenNotice');
    expect(radios(html)).toHaveLength(3);
  });

  it('tells the user when a level is only the administrator’s default', () => {
    expect(render(server({ riskCeilingIsDefault: true }))).toContain(
      'workspacePage.risk.defaultNote',
    );
    expect(render(server())).not.toContain('workspacePage.risk.defaultNote');
  });

  it('warns that tools of a service a non-admin runs are not verified', () => {
    expect(render(server({ annotationsTrusted: false }))).toContain(
      'workspacePage.risk.untrustedHint',
    );
    expect(render(server())).not.toContain('workspacePage.risk.untrustedHint');
  });
});
