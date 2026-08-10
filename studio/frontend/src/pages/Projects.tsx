import { useEffect, useMemo, useState } from 'react';
import { Search, X, LayoutGrid, List as ListIcon, ArrowRight } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import {
  StudioTopBar, StudioButton, StudioPill, StudioBody, type PillTone,
} from '../components/StudioShell';
import { api, type ProjectSummary } from '../lib/api';

// ── Types ──
export type ProjectStatus = 'active' | 'done' | 'paused' | 'pending';

export interface ProjectCard {
  id: string;          // slug/display name (shown in the card, used for search)
  realId?: string;     // backend UUID — passed to onOpenProject when present
  step: string;        // current step in Spanish (Diseñando, Construyendo, etc.)
  status: ProjectStatus;
  cost: number;        // total $ spent
  lastUsed: string;    // human-readable "hace 4 minutos"
  lastRaw: number;     // unix ms for sorting
  editor: string;      // Claude Code, Cursor, Gemini, OpenCode, Codex
  runs: number;        // total runs
  success: number;     // successful runs
}

// ── Mock data — mirrors B_PROJECTS from the redesign ──
const MOCK_PROJECTS: ProjectCard[] = [
  { id: 'auth-jwt',       step: 'Diseñando',     status: 'active',  cost: 2.10, lastUsed: 'hace 4 minutos', lastRaw: Date.now() - 4 * 60 * 1000,           editor: 'Claude Code', runs: 12, success: 10 },
  { id: 'onboarding-v2',  step: 'Terminado',     status: 'done',    cost: 8.90, lastUsed: 'hace 2 horas',   lastRaw: Date.now() - 2 * 60 * 60 * 1000,       editor: 'Claude Code', runs: 8,  success: 8  },
  { id: 'cart-refactor',  step: 'Construyendo',  status: 'active',  cost: 4.50, lastUsed: 'ayer',           lastRaw: Date.now() - 26 * 60 * 60 * 1000,      editor: 'Cursor',      runs: 6,  success: 5  },
  { id: 'payments',       step: 'Especificando', status: 'pending', cost: 0.12, lastUsed: 'hace 3 días',    lastRaw: Date.now() - 3 * 24 * 60 * 60 * 1000,  editor: 'Claude Code', runs: 2,  success: 1  },
  { id: 'design-system',  step: 'Diseñando',     status: 'paused',  cost: 6.20, lastUsed: 'hace 1 semana',  lastRaw: Date.now() - 7 * 24 * 60 * 60 * 1000,  editor: 'Gemini',      runs: 4,  success: 3  },
  { id: 'landing-page',   step: 'Terminado',     status: 'done',    cost: 3.40, lastUsed: 'hace 2 semanas', lastRaw: Date.now() - 14 * 24 * 60 * 60 * 1000, editor: 'OpenCode',    runs: 5,  success: 5  },
  { id: 'api-gateway',    step: 'Planificando',  status: 'pending', cost: 0.40, lastUsed: 'hace 3 semanas', lastRaw: Date.now() - 21 * 24 * 60 * 60 * 1000, editor: 'Codex',       runs: 1,  success: 0  },
  { id: 'blog-migration', step: 'Revisando',     status: 'active',  cost: 1.80, lastUsed: 'hace 1 mes',     lastRaw: Date.now() - 30 * 24 * 60 * 60 * 1000, editor: 'Claude Code', runs: 3,  success: 3  },
];

const STATUS_TONE: Record<ProjectStatus, PillTone> = {
  active: 'active', done: 'done', paused: 'paused', pending: 'pending',
};
const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Trabajando', done: 'Terminado', paused: 'Pausado', pending: 'Sin empezar',
};

type Filter = 'all' | ProjectStatus;
type Sort = 'recent' | 'cost' | 'name';
type View = 'grid' | 'list';

interface Props {
  /** When provided, overrides everything — useful for tests/stories. */
  projects?: ProjectCard[];
  /** Force using the bundled mock data instead of hitting the API. */
  useMock?: boolean;
  onNewProject?: () => void;
  onImportProject?: () => void;
  onOpenProject?: (id: string) => void;
  onGoNow?: () => void;
}

function summaryToCard(s: ProjectSummary): ProjectCard {
  return {
    id: s.name || s.id.slice(0, 12),  // display
    realId: s.id,                     // backend UUID — used for navigation
    step: s.current_step || '—',
    status: s.status,
    cost: s.total_cost,
    lastUsed: s.last_used_human,
    lastRaw: s.last_used_iso ? new Date(s.last_used_iso).getTime() : 0,
    editor: s.editor,
    runs: s.total_runs,
    success: s.success_runs,
  };
}

export function Projects({
  projects, useMock = false, onNewProject, onImportProject, onOpenProject, onGoNow,
}: Props) {
  const [remote, setRemote] = useState<ProjectCard[] | null>(null);
  // Starts true so the effect never has to flip it synchronously on mount.
  const [loading, setLoading] = useState(() => !projects && !useMock);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    if (projects || useMock) return;
    let cancelled = false;

    const fetchOnce = () => api.projects.summary()
      .then((data) => {
        if (cancelled) return;
        if (data.length === 0) {
          setRemote(MOCK_PROJECTS);
          setUsingMock(true);
        } else {
          setRemote(data.map(summaryToCard));
          setUsingMock(false);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setRemote(MOCK_PROJECTS);
        setUsingMock(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    fetchOnce();
    const timer = window.setInterval(fetchOnce, 6000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [projects, useMock]);

  const effectiveProjects = projects ?? remote ?? (useMock ? MOCK_PROJECTS : []);
  const showMockBanner = !projects && (useMock || usingMock);

  return (
    <ProjectsView
      projects={effectiveProjects}
      loading={loading && !projects}
      mockBanner={showMockBanner}
      onNewProject={onNewProject}
      onImportProject={onImportProject}
      onOpenProject={onOpenProject}
      onGoNow={onGoNow}
    />
  );
}

interface ViewProps {
  projects: ProjectCard[];
  loading?: boolean;
  mockBanner?: boolean;
  onNewProject?: () => void;
  onImportProject?: () => void;
  onOpenProject?: (id: string) => void;
  onGoNow?: () => void;
}

function ProjectsView({
  projects, loading, mockBanner, onNewProject, onImportProject, onOpenProject, onGoNow,
}: ViewProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [view, setView] = useState<View>('grid');

  const counts = useMemo(() => ({
    all: projects.length,
    active: projects.filter((p) => p.status === 'active').length,
    done: projects.filter((p) => p.status === 'done').length,
    paused: projects.filter((p) => p.status === 'paused').length,
    pending: projects.filter((p) => p.status === 'pending').length,
  }), [projects]);

  const filtered = useMemo(() => {
    let arr = projects.slice();
    if (filter !== 'all') arr = arr.filter((p) => p.status === filter);
    if (query) arr = arr.filter((p) => p.id.toLowerCase().includes(query.toLowerCase()));
    if (sort === 'recent') arr.sort((a, b) => b.lastRaw - a.lastRaw);
    if (sort === 'cost') arr.sort((a, b) => b.cost - a.cost);
    if (sort === 'name') arr.sort((a, b) => a.id.localeCompare(b.id));
    return arr;
  }, [filter, query, sort, projects]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <StudioTopBar
        title="Proyectos"
        subtitle={`${projects.length} proyectos · ${counts.active} con trabajo en marcha`}
        actions={
          <>
            <StudioButton onClick={onGoNow}>Ir a Ahora</StudioButton>
            <StudioButton onClick={onImportProject}>↓ Importar proyecto</StudioButton>
            <StudioButton primary onClick={onNewProject}>+ Nuevo proyecto</StudioButton>
          </>
        }
      />

      {/* Filters bar */}
      <div style={{
        padding: '14px 32px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        {/* Search */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 8, background: T.panel, boxShadow: T.shadow,
          minWidth: 280,
        }}>
          <Search size={13} color={T.textFaint} strokeWidth={1.8} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar proyecto…"
            style={{
              border: 'none', outline: 'none', fontSize: 13,
              fontFamily: 'inherit', color: T.text, background: 'transparent',
              width: '100%',
            }}
          />
          {query && (
            <span onClick={() => setQuery('')} style={{ display: 'inline-flex', cursor: 'pointer' }}>
              <X size={12} color={T.textFaint} />
            </span>
          )}
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 4, padding: 3, background: T.bgAlt, borderRadius: 8 }}>
          {([
            ['all', 'Todos', counts.all],
            ['active', 'Trabajando', counts.active],
            ['done', 'Terminados', counts.done],
            ['paused', 'Pausados', counts.paused],
          ] as const).map(([v, label, count]) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              style={{
                border: 'none',
                background: filter === v ? T.panel : 'transparent',
                padding: '5px 11px', borderRadius: 5,
                color: filter === v ? T.text : T.textDim,
                fontSize: 12, fontFamily: 'inherit', fontWeight: filter === v ? 500 : 400,
                cursor: 'pointer',
                boxShadow: filter === v ? T.shadow : 'none',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {label}
              <span style={{
                fontSize: 10.5, color: T.textFaint,
                fontVariantNumeric: 'tabular-nums',
              }}>{count}</span>
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Sort */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textDim }}>
          Ordenar:
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            style={{
              border: 'none', background: T.panel, boxShadow: T.shadow,
              borderRadius: 6, padding: '5px 8px', fontSize: 12,
              fontFamily: 'inherit', color: T.text, outline: 'none',
            }}
          >
            <option value="recent">Más reciente</option>
            <option value="cost">Costo</option>
            <option value="name">Nombre</option>
          </select>
        </div>

        {/* View toggle */}
        <div style={{ display: 'flex', gap: 2, padding: 3, background: T.bgAlt, borderRadius: 7 }}>
          {([['grid', LayoutGrid], ['list', ListIcon]] as const).map(([v, Icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                border: 'none', background: view === v ? T.panel : 'transparent',
                width: 28, height: 24, borderRadius: 5,
                color: view === v ? T.text : T.textDim, cursor: 'pointer',
                boxShadow: view === v ? T.shadow : 'none',
                display: 'grid', placeItems: 'center',
              }}
            >
              <Icon size={13} strokeWidth={1.8} />
            </button>
          ))}
        </div>
      </div>

      {mockBanner && (
        <div style={{
          padding: '8px 32px', background: T.warnBg, color: T.warn,
          fontSize: 12, borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontWeight: 500 }}>Vista previa con datos de ejemplo</span>
          <span style={{ color: T.textDim }}>· Aún no hay proyectos reales en Don Cheli</span>
        </div>
      )}

      <StudioBody>
        {loading ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <EmptyState />
        ) : view === 'grid' ? (
          <GridView projects={filtered} onOpen={onOpenProject} />
        ) : (
          <ListView projects={filtered} onOpen={onOpenProject} />
        )}
      </StudioBody>
    </div>
  );
}

// ── Empty state ──
function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '80px 20px', color: T.textDim }}>
      <div style={{ fontSize: 14, marginBottom: 4 }}>No hay proyectos que coincidan</div>
      <div style={{ fontSize: 12, color: T.textFaint }}>Probá cambiar los filtros o la búsqueda</div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14,
    }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} style={{
          background: T.panel, borderRadius: 12, boxShadow: T.shadow,
          padding: 18, height: 140, opacity: 0.6,
          animation: 'studioFadeIn 0.3s cubic-bezier(.22,1,.36,1)',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, background: T.bgAlt, marginBottom: 14,
          }} />
          <div style={{ width: '60%', height: 12, background: T.bgAlt, borderRadius: 4, marginBottom: 8 }} />
          <div style={{ width: '40%', height: 10, background: T.bgAlt, borderRadius: 4 }} />
        </div>
      ))}
    </div>
  );
}

// ── Grid view ──
function GridView({ projects, onOpen }: { projects: ProjectCard[]; onOpen?: (id: string) => void }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
      gap: 14,
    }}>
      {projects.map((p, i) => (
        <div
          key={p.id}
          className="studio-card"
          onClick={() => onOpen && onOpen(p.realId ?? p.id)}
          style={{
            background: T.panel, borderRadius: 12, boxShadow: T.shadow,
            padding: 18, cursor: 'pointer',
            animation: `studioFadeIn 0.3s ${i * 0.03}s cubic-bezier(.22,1,.36,1) both`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: T.bgAlt,
              display: 'grid', placeItems: 'center',
              fontFamily: T.fontMono, fontSize: 13, color: T.text, fontWeight: 500,
            }}>{p.id.slice(0, 2)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: -0.2 }}>{p.id}</div>
              <div style={{ fontSize: 11.5, color: T.textFaint }}>{p.editor}</div>
            </div>
            <StudioPill tone={STATUS_TONE[p.status]} dot={p.status === 'active'}>
              {STATUS_LABEL[p.status]}
            </StudioPill>
          </div>

          <div style={{
            padding: '10px 12px', background: T.bgAlt, borderRadius: 8,
            fontSize: 12, color: T.textDim, marginBottom: 14,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ color: T.textFaint, fontSize: 11 }}>Paso:</span>
            <span style={{ color: T.text, fontWeight: 500 }}>{p.step}</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.textDim }}>
            <ColLabel label="CORRIDAS" value={`${p.success}/${p.runs}`} mono />
            <ColLabel label="GASTADO" value={`$${p.cost.toFixed(2)}`} mono />
            <ColLabel label="ÚLTIMO USO" value={p.lastUsed} align="right" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ColLabel({
  label, value, mono, align,
}: { label: string; value: string; mono?: boolean; align?: 'left' | 'right' }) {
  return (
    <div style={{ textAlign: align ?? 'left' }}>
      <div style={{
        color: T.textFaint, fontSize: 10.5, fontWeight: 500, marginBottom: 2,
        textTransform: 'uppercase', letterSpacing: 0.4,
      }}>{label}</div>
      <div style={{
        color: T.text,
        fontFamily: mono ? T.fontMono : 'inherit',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  );
}

// ── List view ──
function ListView({ projects, onOpen }: { projects: ProjectCard[]; onOpen?: (id: string) => void }) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 1fr 1fr 90px 100px 30px',
        padding: '10px 20px', borderBottom: `1px solid ${T.border}`,
        fontSize: 10.5, color: T.textFaint, fontWeight: 500, letterSpacing: 0.4,
      }}>
        <div>PROYECTO</div>
        <div>ESTADO</div>
        <div>PASO</div>
        <div style={{ textAlign: 'right' }}>CORRIDAS</div>
        <div style={{ textAlign: 'right' }}>GASTADO</div>
        <div />
      </div>
      {projects.map((p, i) => (
        <div
          key={p.id}
          className="studio-row"
          onClick={() => onOpen && onOpen(p.realId ?? p.id)}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr 1fr 90px 100px 30px',
            padding: '12px 20px',
            borderBottom: i < projects.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
            fontSize: 13, alignItems: 'center', cursor: 'pointer',
            transition: 'background .12s ease',
            animation: `studioFadeIn 0.25s ${i * 0.02}s cubic-bezier(.22,1,.36,1) both`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 6, background: T.bgAlt,
              display: 'grid', placeItems: 'center',
              fontFamily: T.fontMono, fontSize: 11, fontWeight: 500,
            }}>{p.id.slice(0, 2)}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                color: T.text, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{p.id}</div>
              <div style={{ color: T.textFaint, fontSize: 11 }}>{p.editor} · {p.lastUsed}</div>
            </div>
          </div>
          <div>
            <StudioPill tone={STATUS_TONE[p.status]} dot={p.status === 'active'}>
              {STATUS_LABEL[p.status]}
            </StudioPill>
          </div>
          <div style={{ color: T.textDim }}>{p.step}</div>
          <div style={{
            textAlign: 'right', fontFamily: T.fontMono,
            fontVariantNumeric: 'tabular-nums', color: T.textDim,
          }}>
            {p.success}/{p.runs}
          </div>
          <div style={{
            textAlign: 'right', fontFamily: T.fontMono,
            fontVariantNumeric: 'tabular-nums', color: T.text,
          }}>
            ${p.cost.toFixed(2)}
          </div>
          <div style={{ textAlign: 'right' }}>
            <ArrowRight size={13} color={T.textFaint} />
          </div>
        </div>
      ))}
    </div>
  );
}
