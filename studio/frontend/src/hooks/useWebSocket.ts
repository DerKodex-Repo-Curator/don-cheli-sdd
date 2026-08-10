import { useEffect, useState, useCallback } from 'react';

const IS_TAURI = !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

export interface WsEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface LogEntry {
  line: string;
  timestamp: string;
  stream?: string;
  phase?: string;
}

export interface HookEntry {
  provider: string;
  event: string;
  summary: string;
  timestamp: string;
  project_id?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export function useWebSocket(projectId: string | null) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pipelineState, setPipelineState] = useState<Record<string, unknown> | null>(null);
  const [hookEvents, setHookEvents] = useState<HookEntry[]>([]);

  useEffect(() => {
    const handleHook = (data: Record<string, unknown>) => {
      setHookEvents(prev => [...prev.slice(-300), {
        provider: (data.provider as string) || 'unknown',
        event: (data.event as string) || 'event',
        summary: (data.summary as string) || '',
        timestamp: (data.timestamp as string) || new Date().toISOString(),
        project_id: data.project_id as string | undefined,
        session_id: data.session_id as string | undefined,
        payload: data.payload as Record<string, unknown> | undefined,
      }]);
    };

    if (IS_TAURI) {
      // Tauri mode: listen to events
      let unlisten: (() => void) | null = null;
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen<{ event_type: string; data: Record<string, unknown> }>('pipeline-event', (event) => {
          const msg = event.payload;
          setEvents(prev => [...prev.slice(-500), { type: msg.event_type, data: msg.data }]);
          if (msg.event_type === 'log' || msg.data.line || msg.data.message) {
            setLogs(prev => [...prev.slice(-1000), {
              line: (msg.data.line as string) || (msg.data.message as string) || msg.event_type,
              timestamp: (msg.data.timestamp as string) || new Date().toISOString(),
              stream: (msg.data.stream as string) || 'stdout',
            }]);
          }
          if (msg.event_type === 'state_update') setPipelineState(msg.data);
          if (msg.event_type === 'hook_event') handleHook(msg.data);
        }).then(fn => { unlisten = fn; });
      });
      setConnected(true);
      return () => { unlisten?.(); };
    }

    // Web mode: WebSocket
    if (!projectId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/${projectId}`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(() => {}, 3000); // reconnect handled by React re-render
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsEvent;
        setEvents(prev => [...prev.slice(-500), msg]);
        if (msg.type === 'log') setLogs(prev => [...prev.slice(-1000), msg.data as unknown as LogEntry]);
        if (msg.type === 'state_update') setPipelineState(msg.data);
        if (msg.type === 'hook_event') handleHook(msg.data);
      } catch { /* ignore malformed frames */ }
    };

    return () => { ws.close(); };
  }, [projectId]);

  const clearLogs = useCallback(() => { setLogs([]); setEvents([]); setHookEvents([]); }, []);

  return { connected, events, logs, pipelineState, hookEvents, clearLogs };
}
