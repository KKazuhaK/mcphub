import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/utils/cn';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
  visible: boolean;
  // Changes with every toast shown, so a repeated message is announced again.
  announceId?: number;
}

const Toast: React.FC<ToastProps> = ({
  message,
  type = 'info',
  duration = 3000,
  onClose,
  visible,
  announceId,
}) => {
  const { t } = useTranslation();
  const [announcement, setAnnouncement] = useState('');

  // Empty the live region first, then fill it: screen readers skip text that did not change.
  useEffect(() => {
    setAnnouncement('');
    if (!visible) return;
    const timer = setTimeout(() => setAnnouncement(message), 50);
    return () => clearTimeout(timer);
  }, [visible, message, announceId]);

  useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => {
        onClose();
      }, duration);

      return () => clearTimeout(timer);
    }
    // A new toast restarts the timer, so it gets its full duration.
  }, [visible, duration, onClose, announceId]);

  const Icon = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle }[type];
  const tone = {
    success: 'var(--hub-ok)',
    error: 'var(--hub-err)',
    info: 'var(--hub-accent)',
    warning: 'var(--hub-warn)',
  }[type];

  return (
    <>
      {/* Always mounted, so screen readers announce each message as it arrives. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <div className={cn('hub-toast', visible && 'visible')} aria-hidden={!visible}>
        <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: tone }} aria-hidden />
        <p className="min-w-0 flex-1 break-words font-medium">{message}</p>
        <button
          type="button"
          onClick={onClose}
          className="hub-icon-btn sm -my-1 shrink-0"
          tabIndex={visible ? 0 : -1}
        >
          <span className="sr-only">{t('common.dismiss')}</span>
          <X className="h-4 w-4" />
        </button>
      </div>
    </>
  );
};

export default Toast;
