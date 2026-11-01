import React, { ReactNode, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

interface ContentProps {
  children: ReactNode;
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const Content: React.FC<ContentProps> = ({ children }) => {
  const { pathname } = useLocation();
  const pageRef = useRef<HTMLDivElement>(null);

  // Ease each new page in without remounting it, so in-page state is untouched. Opacity
  // only: a transform here would capture fixed-position modals the page opens on mount.
  useEffect(() => {
    const page = pageRef.current;
    if (!page || typeof page.animate !== 'function' || prefersReducedMotion()) return;
    const animation = page.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      easing: 'cubic-bezier(0.3, 0.8, 0.6, 1)',
    });
    return () => animation.cancel();
  }, [pathname]);

  return (
    <main className="flex-1 overflow-auto" style={{ background: 'var(--hub-bg)' }}>
      <div ref={pageRef} className="mx-auto w-full max-w-[1680px] px-4 pt-6 pb-16 sm:px-6 lg:px-8 xl:px-10">
        {children}
      </div>
    </main>
  );
};

export default Content;
