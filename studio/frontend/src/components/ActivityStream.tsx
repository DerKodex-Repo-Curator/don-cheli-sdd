import { useMemo, useState } from 'react';
import type { HookEntry } from '../hooks/useWebSocket';

interface Props {
  events: HookEntry[];
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#E8C547',
  codex: '#60A5FA',
  opencode: '#4ADE80',
};

export function ActivityStream({ events }: Props) {
  const [filter, setFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<number | null>(null);

  const providers = useMemo(() => {
    const set = new Set(events.map((e) => e.provider));
    return Array.from(set);
  }, [events]);

  const filtered = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((e) => e.provider === filter);
  }, [events, filter]);

  const reversed = useMemo(() => [...filtered].reverse(), [filtered]);

  if (events.length === 0) {
    return (
      <div
        style={{
          padding: '16px',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-mono)',
          border: '1px dashed var(--border-default)',
          borderRadius: '4px',
        }}
      >
        Waiting for hook events… Run any compatible CLI (Claude, Codex, OpenCode) to see activity.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Filters */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <FilterChip
          label={`All · ${events.length}`}
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        {providers.map((p) => (
          <FilterChip
            key={p}
            label={`${PROVIDER_LABELS[p] || p} · ${events.filter((e) => e.provider === p).length}`}
            active={filter === p}
            color={PROVIDER_COLORS[p]}
            onClick={() => setFilter(p)}
          />
        ))}
      </div>

      {/* Stream */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          border: '1px solid var(--border-default)',
          borderRadius: '4px',
          background: 'var(--bg-raised)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-sm)',
        }}
      >
        {reversed.map((event, idx) => {
          const originalIdx = events.length - 1 - idx;
          const isExpanded = expanded === originalIdx;
          const color = PROVIDER_COLORS[event.provider] || '#8E8E96';
          return (
            <div
              key={originalIdx}
              onClick={() => setExpanded(isExpanded ? null : originalIdx)}
              style={{
                padding: '6px 12px',
                borderBottom: '1px solid var(--border-subtle)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-muted)',
                    minWidth: '60px',
                  }}
                >
                  {formatTime(event.timestamp)}
                </span>
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    color,
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    minWidth: '70px',
                  }}
                >
                  {PROVIDER_LABELS[event.provider] || event.provider}
                </span>
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    minWidth: '120px',
                  }}
                >
                  {event.event}
                </span>
                <span style={{ color: 'var(--text-primary)', flex: 1 }}>
                  {event.summary || '—'}
                </span>
              </div>
              {isExpanded && event.payload && (
                <pre
                  style={{
                    background: 'var(--bg-base)',
                    padding: '8px',
                    borderRadius: '3px',
                    margin: '4px 0 0 68px',
                    color: 'var(--text-secondary)',
                    fontSize: 'var(--text-xs)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: '300px',
                    overflow: 'auto',
                  }}
                >
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        background: active ? 'var(--color-accent-dim)' : 'var(--bg-raised)',
        border: `1px solid ${active ? color || 'var(--color-accent)' : 'var(--border-default)'}`,
        borderRadius: '3px',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 'var(--text-xs)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}
