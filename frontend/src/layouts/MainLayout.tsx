import React, { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Header from '@/components/layout/Header';
import Sidebar from '@/components/layout/Sidebar';
import Content from '@/components/layout/Content';
import { EmbeddingSyncProvider } from '@/contexts/EmbeddingSyncContext';

const PageFallback: React.FC = () => (
  <div
    className="flex h-full min-h-[240px] items-center justify-center text-sm"
    style={{ color: 'var(--hub-ink-3)' }}
  >
    Loading...
  </div>
);

// Below this width the expanded sidebar would leave the page too little room.
const NARROW_QUERY = '(max-width: 767px)';

const isNarrow = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY).matches
    : false;

// Reports the current narrow state, then every crossing; returns the unsubscribe.
export const followNarrowViewport = (onChange: (narrow: boolean) => void): (() => void) => {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(NARROW_QUERY);
  // The width may have crossed between the first render and this subscription.
  onChange(query.matches);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

const MainLayout: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(isNarrow);

  // Collapse when the window becomes narrow and expand when it widens again;
  // the menu button still overrides this until the next crossing.
  React.useEffect(() => followNarrowViewport(setSidebarCollapsed), []);

  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };

  return (
    <EmbeddingSyncProvider>
      <div className="flex h-screen" style={{ background: 'var(--hub-bg)', color: 'var(--hub-ink)' }}>
        <Sidebar collapsed={sidebarCollapsed} />
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          <Header onToggleSidebar={toggleSidebar} />
          <Content>
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </Content>
        </div>
      </div>
    </EmbeddingSyncProvider>
  );
};

export default MainLayout;
