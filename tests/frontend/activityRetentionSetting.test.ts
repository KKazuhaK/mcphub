import fs from 'fs';
import path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivityRetentionSetting, {
  parseRetentionDays,
} from '../../frontend/src/components/ActivityRetentionSetting';

const readLocale = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales', `${name}.json`), 'utf8'));
const en = readLocale('en');
const lookup = (tree: any, key: string): string =>
  key.split('.').reduce((node, part) => node?.[part], tree);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      (lookup(en, key) ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, n: string) =>
        String(options?.[n] ?? ''),
      ),
  }),
}));

describe('parseRetentionDays', () => {
  it('treats empty as keep-forever and accepts whole days from 1 to 3650', () => {
    expect(parseRetentionDays('')).toBeNull();
    expect(parseRetentionDays('  ')).toBeNull();
    expect(parseRetentionDays('1')).toBe(1);
    expect(parseRetentionDays('3650')).toBe(3650);
  });

  it.each(['0', '3651', '-5', '1.5', 'abc', '1e3', '30 days'])('rejects %s', (text) => {
    expect(parseRetentionDays(text)).toBe('invalid');
  });
});

describe('ActivityRetentionSetting', () => {
  const render = (value: number | null) =>
    renderToStaticMarkup(
      createElement(ActivityRetentionSetting, { value, onSave: async () => true }),
    );

  it('warns that older activity is permanently deleted and shows the current value', () => {
    const html = render(45);
    expect(html).toContain('permanently deleted');
    expect(html).toContain('value="45"');
    expect(html).toContain('Activity retention (days)');
  });

  it('shows an empty field when activity is kept forever', () => {
    const html = render(null);
    expect(html).toContain('value=""');
    expect(html).toContain('placeholder="Keep forever"');
  });
});

describe('retention locale strings', () => {
  it.each(['en', 'es', 'fr', 'tr', 'vi', 'zh'])('%s ships them all', (locale) => {
    const settings = readLocale(locale).settings;
    for (const key of [
      'activityRetention',
      'activityRetentionDescription',
      'activityRetentionWarning',
      'activityRetentionPlaceholder',
      'activityRetentionInvalid',
      'activityRetentionConfirmTitle',
      'activityRetentionConfirmMessage',
      'activityRetentionConfirm',
      'activityRetentionUpdateFailed',
    ]) {
      expect(settings[key]).toBeTruthy();
    }
    expect(settings.activityRetentionConfirmMessage).toContain('{{days}}');
    expect(settings.activityRetentionConfirmMessage).toContain('{{entered}}');
    expect(settings.activityRetentionDescription).not.toMatch(/90/);
  });
});
