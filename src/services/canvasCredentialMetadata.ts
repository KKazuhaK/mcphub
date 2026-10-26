/** Stored inside the existing authenticated credential ciphertext, never config exports. */
export const CANVAS_METADATA = '__mcphub_canvas_reminder_v1';
export interface CanvasReminder {
  enabled: boolean;
  days: number;
  source: 'unknown' | 'canvas' | 'manual';
  expiresAt: string | null;
  checkedAt?: string;
  notified?: string[];
  lease?: { stage: string; until: number };
  delivery?: 'sent' | 'failed';
}
export const isCanvasBinding = (values: Record<string, string>): boolean =>
  !!values['env.CANVAS_API_URL'] && !!values['env.CANVAS_API_TOKEN'];
export const readCanvasReminder = (values: Record<string, string>): CanvasReminder => {
  try {
    const value = JSON.parse(values[CANVAS_METADATA] || 'null') as CanvasReminder | null;
    if (
      value &&
      typeof value.enabled === 'boolean' &&
      Number.isInteger(value.days) &&
      value.days >= 1 &&
      value.days <= 90 &&
      ['unknown', 'canvas', 'manual'].includes(value.source) &&
      (value.expiresAt === null || Number.isFinite(Date.parse(value.expiresAt)))
    )
      return value;
  } catch {
    /* Missing or malformed internal metadata is not a credential failure. */
  }
  return { enabled: false, days: 7, source: 'unknown', expiresAt: null };
};
export const publicCanvasReminder = (values: Record<string, string>) => {
  if (!isCanvasBinding(values)) return undefined;
  const { enabled, days, source, expiresAt, checkedAt, delivery } = readCanvasReminder(values);
  return { enabled, days, source, expiresAt, checkedAt, delivery };
};
