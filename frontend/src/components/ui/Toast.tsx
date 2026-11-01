import React, { useEffect } from 'react';
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
}

const Toast: React.FC<ToastProps> = ({
  message,
  type = 'info',
  duration = 3000,
  onClose,
  visible,
}) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => {
        onClose();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [visible, duration, onClose]);

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
        {visible ? message : ''}
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
