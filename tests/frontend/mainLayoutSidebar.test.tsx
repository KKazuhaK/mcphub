import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MainLayout, { followNarrowViewport } from '../../frontend/src/layouts/MainLayout';

jest.mock('react-router-dom', () => ({ Outlet: () => null }));
jest.mock('../../frontend/src/components/layout/Header', () => () => null);
jest.mock('../../frontend/src/components/layout/Content', () => ({ children }: any) => children);
jest.mock('../../frontend/src/components/layout/Sidebar', () => ({ collapsed }: any) =>
  `sidebar:${collapsed ? 'collapsed' : 'expanded'}`,
);
jest.mock('../../frontend/src/contexts/EmbeddingSyncContext', () => ({
  EmbeddingSyncProvider: ({ children }: any) => children,
}));

const withViewport = (narrow: boolean | null, run: () => void) => {
  const previous = (globalThis as any).window;
  (globalThis as any).window =
    narrow === null ? {} : { matchMedia: (query: string) => ({ matches: narrow, media: query }) };
  try {
    run();
  } finally {
    (globalThis as any).window = previous;
  }
};

const render = () => renderToStaticMarkup(createElement(MainLayout));

describe('MainLayout sidebar on narrow screens', () => {
  it('starts collapsed when the viewport is narrow', () => {
    withViewport(true, () => expect(render()).toContain('sidebar:collapsed'));
  });

  it('starts expanded on a wide viewport', () => {
    withViewport(false, () => expect(render()).toContain('sidebar:expanded'));
  });

  it('starts expanded when matchMedia is unavailable', () => {
    withViewport(null, () => expect(render()).toContain('sidebar:expanded'));
  });
});

describe('followNarrowViewport', () => {
  const fakeQuery = (matches: boolean) => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    return {
      matches,
      listeners,
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
        listeners.delete(listener),
      fire: (next: boolean) => listeners.forEach((listener) => listener({ matches: next })),
    };
  };

  const withQuery = (query: ReturnType<typeof fakeQuery>, run: () => void) => {
    const previous = (globalThis as any).window;
    (globalThis as any).window = { matchMedia: () => query };
    try {
      run();
    } finally {
      (globalThis as any).window = previous;
    }
  };

  it('reports the current state, then each crossing, until unsubscribed', () => {
    const query = fakeQuery(false);
    withQuery(query, () => {
      const seen: boolean[] = [];
      const unsubscribe = followNarrowViewport((narrow) => seen.push(narrow));
      query.fire(true);
      query.fire(false);
      expect(seen).toEqual([false, true, false]);

      unsubscribe();
      expect(query.listeners.size).toBe(0);
      query.fire(true);
      expect(seen).toEqual([false, true, false]);
    });
  });

  it('does nothing when matchMedia is unavailable', () => {
    const previous = (globalThis as any).window;
    (globalThis as any).window = {};
    try {
      const onChange = jest.fn();
      followNarrowViewport(onChange)();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).window = previous;
    }
  });
});
