import { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import {
  StudioTopBar, StudioBody, StudioPill, StudioMetricCard, StudioPillGroup, type PillTone,
} from '../components/StudioShell';
import { api, type PipelineRun, type PhaseRecord } from '../lib/api';

export type RunResult = 'success' | 'running' | 'error' | 'stopped' | 'paused';

export interface HistoryEntry {
  id: number | string;
  project: string;
  stepsDone: number;
  totalSteps: number;
  duration: string;
  cost: number;
  result: RunResult;
  when: string;
  whenIso?: string;
}

const MOCK_RUNS: HistoryEntry[] = [
  { id: 12, project: 'auth-jwt',      stepsDone: 4, totalSteps: 7, duration: '4:12',  cost: 0.82, result: 'running', when: 'hace 4 min' },
  { id: 11, project: 'cart-refactor', stepsDone: 3, totalSteps: 7, duration: '1:08',  cost: 0.21, result: 'running', when: 'hace 1 h' },
  { id: 10, project: 'onboarding-v2', stepsDone: 7, totalSteps: 7, duration: '12:46', cost: 0.82, result: 'success', when: 'hace 2 h' },
  { id: 9,  project: 'onboarding-v2', stepsDone: 7, totalSteps: 7, duration: '11:20', cost: 0.78, result: 'success', when: 'hace 3 h' },
  { id: 8,  project: 'payments',      stepsDone: 2, totalSteps: 7, duration: '2:14',  cost: 0.12, result: 'stopped', when: 'ayer' },
  { id: 7,  project: 'cart-refactor', stepsDone: 6, totalSteps: 7, duration: '18:50', cost: 4.29, result: 'error',   when: 'ayer' },
  { id: 6,  project: 'design-system', stepsDone: 4, totalSteps: 7, duration: '6:00',  cost: 1.50, result: 'paused',  when: 'hace 2 días' },
  { id: 5,  project: 'auth-jwt',      stepsDone: 7, totalSteps: 7, duration: '14:30', cost: 1.10, result: 'success', when: 'hace 3 días' },
  { id: 4,  project: 'landing-page',  stepsDone: 7, totalSteps: 7, duration: '9:15',  cost: 0.68, result: 'success', when: 'hace 5 días' },
];

const RESULT_TONE: Record<RunResult, PillTone> = {
  success: 'active', running: 'active', error: 'error', stopped: 'paused', paused: 'paused',
};
const RESULT_LABEL: Record<RunResult, string> = {
  success: 'Éxito', running: 'En vivo', error: 'Error', stopped: 'Detenido', paused: 'Pausado',
};

type Filter = 'all' | RunResult;
type Range = '24h' | '7d' | '30d' | 'all';

interface Props {
  runs?: HistoryEntry[];
  onOpenRun?: (id: string | number) => void;
}

export function Historial({ runs, onOpenRun }: Props) {
  const [remote, setRemote] = useState<HistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    if (runs) return;
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const [projects, todayRuns] = await Promise.all([
          api.projects.list(),
          api.runs.today().catch(() => [] as PipelineRun[]),
        ]);

        let allRuns: PipelineRun[] = [...todayRuns];
        for (const p of projects) {
          try {
            const projectRuns = await api.runs.forProject(p.id);
            allRuns = allRuns.concat(projectRuns.filter((r) => !allRuns.find((x) => x.id === r.id)));
          } catch { /* ignore */ }
        }
        allRuns.sort((a, b) => b.started_at.localeCompare(a.started_at));

        const projectName = new Map(projects.map((p) => [p.id, p.name]));
        const entries: HistoryEntry[] = [];
        for (const r of allRuns.slice(0, 50)) {
          let stepsDone = 0;
          let totalSteps = 7;
          try {
            const phases: PhaseRecord[] = await api.runs.phases(r.id);
            totalSteps = phases.length || 7;
            stepsDone = phases.filter((p) => p.status === 'passed').length;
          } catch { /* keep defaults */ }

          entries.push({
            id: r.id.slice(0, 6),
            project: projectName.get(r.project_id) ?? r.project_id.slice(0, 8),
            stepsDone, totalSteps,
            duration: formatDuration(r.started_at, r.completed_at),
            cost: r.total_cost,
            result: mapStatus(r.status),
            when: relativeTime(r.started_at),
            whenIso: r.started_at,
          });
        }

        if (cancelled) return;
        if (entries.length === 0) { setRemote(MOCK_RUNS); setUsingMock(true); }
        else { setRemote(entries); setUsingMock(false); }
      } catch {
        if (!cancelled) { setRemote(MOCK_RUNS); setUsingMock(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [runs]);

  const data = runs ?? remote ?? [];
  return <HistorialView runs={data} loading={loading && !runs} mockBanner={usingMock} onOpenRun={onOpenRun} />;
}

function mapStatus(status: string): RunResult {
  if (status === 'passed') return 'success';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'stopped';
  return 'paused';
}

function formatDuration(start: string, end?: string | null): string {
  try {
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : Date.now();
    const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  } catch { return '—'; }
}

function relativeTime(iso: string): string {
  try {
    const delta = (Date.now() - new Date(iso).getTime()) / 1000;
    if (delta < 60) return 'ahora';
    if (delta < 3600) return `hace ${Math.floor(delta / 60)} min`;
    if (delta < 86400) return `hace ${Math.floor(delta / 3600)} h`;
    const days = Math.floor(delta / 86400);
    if (days === 1) return 'ayer';
    if (days < 7) return `hace ${days} días`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `hace ${weeks} semana${weeks === 1 ? '' : 's'}`;
    const months = Math.floor(days / 30);
    return `hace ${months} mes${months === 1 ? '' : 'es'}`;
  } catch { return '—'; }
}

function HistorialView({
  runs, loading, mockBanner, onOpenRun,
}: { runs: HistoryEntry[]; loading?: boolean; mockBanner?: boolean; onOpenRun?: (id: string | number) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [range, setRange] = useState<Range>('7d');

  const counts = useMemo(() => ({
    all: runs.length,
    success: runs.filter((r) => r.result === 'success').length,
    error: runs.filter((r) => r.result === 'error').length,
    running: runs.filter((r) => r.result === 'running').length,
  }), [runs]);

  const filtered = useMemo(() => {
    let arr = runs.slice();
    if (filter !== 'all') arr = arr.filter((r) => r.result === filter);
    return arr;
  }, [filter, runs]);

  const byDay = useMemo(() => {
    const groups: Record<string, HistoryEntry[]> = {};
    filtered.forEach((r) => {
      const key = r.when.includes('min') || r.when.includes('h') || r.when === 'ahora'
        ? 'Hoy'
        : r.when === 'ayer' ? 'Ayer' : r.when;
      (groups[key] ??= []).push(r);
    });
    return groups;
  }, [filtered]);

  const spark = [3, 5, 2, 0, 0, 7, 4, 6, 2, 3, 5, 8, 4, 6];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <StudioTopBar
        title="Historial"
        subtitle={`${runs.length} trabajos · ${counts.success} exitosos · ${counts.error} con errores`}
      />

      {mockBanner && <MockBanner />}

      {/* Summary strip */}
      <div style={{
        padding: '16px 32px', display: 'grid',
        gridTemplateColumns: '1.5fr 1fr 1fr 1fr', gap: 14,
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 11.5, color: T.textFaint, fontWeight: 500, letterSpacing: 0.3, textTransform: 'uppercase' }}>Actividad · 14 días</div>
            <div style={{ fontSize: 11.5, color: T.textDim }}>
              <span style={{ color: T.text, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                {spark.reduce((a, b) => a + b, 0)}
              </span>{' '}trabajos
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 36 }}>
            {spark.map((v, i) => (
              <div key={i} style={{
                flex: 1,
                height: `${Math.max(4, (v / Math.max(...spark)) * 100)}%`,
                background: v === 0 ? T.bgAlt : T.ink,
                borderRadius: 2, minHeight: 3,
                opacity: v === 0 ? 0.5 : 1,
              }} />
            ))}
          </div>
        </div>

        <StudioMetricCard label="Exitosos" mono accent={T.success} value={counts.success}
          sub={counts.all > 0 ? `${Math.round((counts.success / counts.all) * 100)}% del total` : '—'} />
        <StudioMetricCard label="Con errores" mono value={counts.error} sub="Todos recuperables" />
        <StudioMetricCard label="En vivo" mono value={counts.running}
          sub={counts.running > 0 ? 'Ir a Ahora para ver' : 'Nada corriendo'} />
      </div>

      {/* Filter bar */}
      <div style={{
        padding: '12px 32px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <StudioPillGroup
          withCounts
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todos', count: counts.all },
            { value: 'success', label: 'Exitosos', count: counts.success },
            { value: 'error', label: 'Con errores', count: counts.error },
            { value: 'running', label: 'En vivo', count: counts.running },
          ]}
        />
        <div style={{ flex: 1 }} />
        <StudioPillGroup
          value={range}
          onChange={setRange}
          options={[
            { value: '24h', label: 'Hoy' },
            { value: '7d', label: '7 días' },
            { value: '30d', label: '30 días' },
            { value: 'all', label: 'Todo' },
          ]}
        />
      </div>

      <StudioBody>
        {loading ? (
          <div style={{ padding: 40, color: T.textDim, fontSize: 13 }}>Cargando…</div>
        ) : Object.keys(byDay).length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: T.textDim }}>
            <div style={{ fontSize: 14 }}>No hay trabajos con estos filtros</div>
          </div>
        ) : Object.entries(byDay).map(([day, items]) => (
          <div key={day} style={{ marginBottom: 20 }}>
            <div style={{
              fontSize: 11.5, color: T.textFaint, fontWeight: 500,
              letterSpacing: 0.4, textTransform: 'uppercase',
              marginBottom: 10, paddingLeft: 4,
            }}>{day}</div>
            <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, overflow: 'hidden' }}>
              {items.map((r, i) => (
                <div key={`${r.id}-${i}`} className="studio-row"
                  onClick={() => onOpenRun && onOpenRun(r.id)}
                  style={{
                    padding: '14px 20px',
                    borderBottom: i < items.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
                    display: 'grid', gridTemplateColumns: '60px 1.4fr 110px 1fr 90px 90px 24px',
                    alignItems: 'center', gap: 14, fontSize: 12.5,
                    cursor: 'pointer', transition: 'background .12s ease',
                  }}>
                  <span style={{ fontFamily: T.fontMono, color: T.textFaint }}>#{r.id}</span>
                  <div>
                    <div style={{ color: T.text, fontWeight: 500, marginBottom: 2 }}>{r.project}</div>
                    <div style={{ color: T.textFaint, fontSize: 11 }}>{r.when}</div>
                  </div>
                  <StudioPill tone={RESULT_TONE[r.result]} dot={r.result === 'running'}>
                    {RESULT_LABEL[r.result]}
                  </StudioPill>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    {Array.from({ length: r.totalSteps }).map((_, si) => {
                      const done = si < r.stepsDone;
                      const current = si === r.stepsDone && r.result === 'running';
                      return (
                        <div key={si} style={{
                          flex: 1, height: 4, borderRadius: 2,
                          background: done ? T.ink : current ? T.success : T.bgAlt,
                          animation: current ? 'studioPulse 1.8s ease-in-out infinite' : 'none',
                        }} />
                      );
                    })}
                  </div>
                  <span style={{ textAlign: 'right', fontFamily: T.fontMono, color: T.textDim, fontVariantNumeric: 'tabular-nums', fontSize: 11.5 }}>
                    {r.duration}
                  </span>
                  <span style={{ textAlign: 'right', fontFamily: T.fontMono, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
                    ${r.cost.toFixed(2)}
                  </span>
                  <ArrowRight size={13} color={T.textFaint} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </StudioBody>
    </div>
  );
}

function MockBanner() {
  return (
    <div style={{
      padding: '8px 32px', background: T.warnBg, color: T.warn,
      fontSize: 12, borderBottom: `1px solid ${T.border}`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ fontWeight: 500 }}>Vista previa con datos de ejemplo</span>
      <span style={{ color: T.textDim }}>· Aún no hay historial real registrado</span>
    </div>
  );
}
