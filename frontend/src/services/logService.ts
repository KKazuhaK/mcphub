import { useEffect, useState } from 'react';
import { apiGet, apiDelete } from '../utils/fetchInterceptor';
import { getApiUrl } from '../utils/runtime';
import { getToken } from '../utils/interceptors';

export interface LogEntry {
  timestamp: number;
  type: 'info' | 'error' | 'warn' | 'debug';
  source: string;
  message: string;
  processId?: string;
}

// Fetch all logs
export const fetchLogs = async (): Promise<LogEntry[]> => {
  try {
    const response = await apiGet<{ success: boolean; data: LogEntry[]; error?: string }>('/logs');

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch logs');
    }

    return response.data;
  } catch (error) {
    console.error('Error fetching logs', { error });
    throw error;
  }
};

// Clear all logs
export const clearLogs = async (): Promise<void> => {
  try {
    const response = await apiDelete<{ success: boolean; error?: string }>('/logs');

    if (!response.success) {
      throw new Error(response.error || 'Failed to clear logs');
    }
  } catch (error) {
    console.error('Error clearing logs', { error });
    throw error;
  }
};

/**
 * Singleton SSE connection manager.  Maintains a single stream shared across all subscribers so
 * that multiple components (e.g. the Logs page and the embedding-sync alert listener) reuse one
 * HTTP connection.
 *
 * The stream is read with fetch, not EventSource: EventSource cannot send headers, which would
 * put the session token in the URL (browser history, proxy logs) and break entirely once the
 * server refuses credentials in URLs. The token always travels in a header.
 */
class LogStreamManager {
  private streamAbort: AbortController | null = null;
  private subscribers = new Set<(event: MessageEvent) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openAttempts = 0;
  // Set when the server answered 401 (or there is no token): retrying cannot help until the
  // user signs in again, so no timer runs. `resume()` clears it.
  private authBlocked = false;

  /** Subscribe to incoming SSE messages.  Returns an unsubscribe callback. */
  subscribe(callback: (event: MessageEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.subscribers.size === 1) {
      // Reset attempts when first subscriber added
      this.openAttempts = 0;
      this.authBlocked = false;
      void this.open();
    }
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.close();
      }
    };
  }

  /** Call after a (re-)authentication: reconnects a stream that stopped on 401. */
  resume() {
    if (!this.authBlocked || this.subscribers.size === 0) return;
    this.authBlocked = false;
    this.openAttempts = 0;
    void this.open();
  }

  private async open() {
    this.closeStream();
    const token = getToken();

    if (!token) {
      // Nothing to authenticate with; wait for resume() instead of polling.
      this.authBlocked = true;
      return;
    }

    const abort = new AbortController();
    this.streamAbort = abort;
    try {
      const response = await fetch(getApiUrl('/logs/stream'), {
        headers: { 'x-auth-token': token, Accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (response.status === 401) {
        console.warn('[LogStreamManager] Log stream unauthorized; waiting for sign-in');
        this.authBlocked = true;
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Log stream failed: ${response.status}`);
      // Reset attempts only once the connection is actually established, so the backoff keeps
      // growing while the stream keeps failing.
      this.openAttempts = 0;
      console.log('[LogStreamManager] Log stream opened successfully');
      await this.read(response.body.getReader());
      throw new Error('Log stream closed');
    } catch {
      if (abort.signal.aborted || this.authBlocked) return;
      console.warn('[LogStreamManager] Log stream error, attempting reconnect...');
      this.streamAbort = null;
      if (this.subscribers.size > 0) this.scheduleReconnect();
    }
  }

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          const event = new MessageEvent('message', { data });
          this.subscribers.forEach((cb) => cb(event));
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  private closeStream() {
    if (this.streamAbort) {
      this.streamAbort.abort();
      this.streamAbort = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;

    // Exponential backoff: 1s, 2s, 4s, 8s max
    const delayMs = Math.min(1000 * Math.pow(2, this.openAttempts), 8000);
    this.openAttempts++;

    console.log(
      `[LogStreamManager] Scheduling reconnect in ${delayMs}ms (attempt ${this.openAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0) {
        void this.open();
      }
    }, delayMs);
  }

  private close() {
    this.closeStream();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const logStreamManager = new LogStreamManager();

// Hook to use logs with SSE streaming
export const useLogs = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    // Fetch initial logs
    const loadInitialLogs = async () => {
      try {
        const initialLogs = await fetchLogs();
        if (mounted) {
          setLogs(initialLogs);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error('Failed to fetch logs'));
          setLoading(false);
        }
      }
    };

    loadInitialLogs();

    // Subscribe to SSE stream for new logs
    const handleMessage = (event: MessageEvent) => {
      if (!mounted) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'initial') {
          // Skip initial event, we already have logs from fetchLogs()
          return;
        }
        if (data.type === 'log') {
          setLogs((prevLogs) => [...prevLogs, data.log]);
        }
      } catch (err) {
        console.error('Error parsing SSE message', { err });
      }
    };

    const unsubscribe = logStreamManager.subscribe(handleMessage);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const clearAllLogs = async () => {
    try {
      await clearLogs();
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to clear logs'));
    }
  };

  return { logs, loading, error, clearLogs: clearAllLogs };
};
