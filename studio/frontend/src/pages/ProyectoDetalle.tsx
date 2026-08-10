import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Folder, Wrench, Settings as SettingsIcon, GitBranch, ExternalLink, Wand2, Loader2, CheckCircle2, Key, AlertCircle, Lightbulb, MessageSquare, Sparkles, ArrowRight } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import type { GithubStatus as GitBranchStatus, OnboardStatus, EnvInventoryResponse, ServiceMatch } from '../lib/api';
import {
  StudioTopBar, StudioBody, StudioButton, StudioPill, StudioMetricCard, type PillTone,
} from '../components/StudioShell';
import { api, type Project, type PipelineRun, type PhaseRecord } from '../lib/api';
import { DesignTab } from './DesignTab';
import { EjecutarTab } from './EjecutarTab';
import { useWebSocket } from '../hooks/useWebSocket';

interface Props {
  projectId: string;
  onBack: () => void;
  onGoNow: () => void;
  onNewJob: () => void;
  onOpenRun?: (runId: string) => void;
  onOpenArsenal?: () => void;
}

type ProjectStatus = 'active' | 'done' | 'paused' | 'pending';
type Tab = 'resumen' | 'trabajos' | 'diseno' | 'ejecutar' | 'acciones' | 'configuracion';

interface RunRow {
  id: string;
  shortId: string;
  status: PipelineRun['status'];
  stepsDone: number;
  totalSteps: number;
  cost: number;
  duration: string;
  when: string;
  whenIso: string;
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Trabajando ahora', done: 'Terminado', paused: 'Pausado', pending: 'Sin empezar',
};

const RESULT_TONE: Record<string, PillTone> = {
  passed: 'active', running: 'active', failed: 'error', cancelled: 'paused', pending: 'pending',
};
const RESULT_LABEL: Record<string, string> = {
  passed: 'Éxito', running: 'En vivo', failed: 'Error', cancelled: 'Detenido', pending: 'Sin empezar',
};

export function ProyectoDetalle({
  projectId, onBack, onGoNow, onNewJob, onOpenRun, onOpenArsenal,
}: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('resumen');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const refresh = async () => {
      try {
        const p = await api.projects.get(projectId);
        if (cancelled) return;
        setProject(p);

        const raw = await api.runs.forProject(projectId);
        const rows: RunRow[] = [];
        for (const r of raw) {
          let stepsDone = 0;
          let totalSteps = 7;
          try {
            const phases: PhaseRecord[] = await api.runs.phases(r.id);
            totalSteps = phases.length || 7;
            stepsDone = phases.filter((p) => p.status === 'passed').length;
          } catch { /* ignore */ }
          rows.push({
            id: r.id,
            shortId: r.id.slice(0, 6),
            status: r.status,
            stepsDone, totalSteps,
            cost: r.total_cost,
            duration: formatDuration(r.started_at, r.completed_at),
            when: relativeTime(r.started_at),
            whenIso: r.started_at,
          });
        }
        rows.sort((a, b) => b.whenIso.localeCompare(a.whenIso));
        if (!cancelled) setRuns(rows);
      } catch {
        /* keep nulls */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    refresh();
    // Poll while the page is open to reflect live pipeline progress.
    const timer = window.setInterval(refresh, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [projectId]);

  const derived = useMemo(() => {
    const totalRuns = runs.length;
    const successRuns = runs.filter((r) => r.status === 'passed').length;
    const totalCost = runs.reduce((s, r) => s + r.cost, 0);
    const successRate = totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 0;

    let status: ProjectStatus = 'pending';
    if (runs.some((r) => r.status === 'running')) status = 'active';
    else if (totalRuns > 0) {
      const latest = runs[0];
      if (latest.status === 'passed') status = 'done';
      else if (latest.status === 'failed' || latest.status === 'cancelled') status = 'paused';
    }

    const currentRun = runs.find((r) => r.status === 'running');
    const currentStep = currentRun
      ? `Trabajo #${currentRun.shortId} en curso`
      : runs[0] ? `Último trabajo: ${RESULT_LABEL[runs[0].status] ?? '—'}` : null;

    return { totalRuns, successRuns, totalCost, successRate, status, currentStep };
  }, [runs]);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: T.textDim, fontSize: 13 }}>
        Cargando…
      </div>
    );
  }

  if (!project) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: T.textDim, fontSize: 13 }}>
        Proyecto no encontrado. <button onClick={onBack} style={{ marginLeft: 8, color: T.text, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>← Volver</button>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'resumen', label: 'Resumen' },
    { id: 'trabajos', label: 'Trabajos', count: derived.totalRuns },
    { id: 'diseno', label: 'Diseño' },
    { id: 'ejecutar', label: 'Ejecutar' },
    { id: 'acciones', label: 'Acciones' },
    { id: 'configuracion', label: 'Configuración' },
  ];

  const subtitle = `${STATUS_LABEL[derived.status]}${runs[0] ? ` · Último uso ${runs[0].when}` : ''}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      {/* Breadcrumb */}
      <div style={{
        padding: '14px 32px 0', display: 'flex', gap: 6, fontSize: 12,
        color: T.textFaint, alignItems: 'center',
      }}>
        <span
          onClick={onBack}
          style={{ cursor: 'pointer', color: T.textDim }}
          onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
          onMouseLeave={(e) => (e.currentTarget.style.color = T.textDim)}
        >Proyectos</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span style={{ color: T.text, fontFamily: T.fontMono }}>{project.name}</span>
      </div>

      <StudioTopBar
        title={project.name}
        subtitle={subtitle}
        actions={
          <>
            <StudioButton>Abrir en terminal</StudioButton>
            {derived.status === 'active' ? (
              <StudioButton primary onClick={onGoNow}>Ver en Ahora →</StudioButton>
            ) : (
              <StudioButton primary onClick={onNewJob}>+ Nuevo trabajo</StudioButton>
            )}
          </>
        }
      />

      {/* Tabs */}
      <div style={{
        padding: '0 32px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', gap: 2, background: T.bg,
      }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            border: 'none', background: 'transparent',
            padding: '12px 14px 10px', fontFamily: 'inherit',
            fontSize: 13, fontWeight: tab === t.id ? 500 : 400,
            color: tab === t.id ? T.text : T.textDim,
            borderBottom: `2px solid ${tab === t.id ? T.ink : 'transparent'}`,
            marginBottom: -1, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 7,
          }}>
            {t.label}
            {t.count !== undefined && (
              <span style={{ fontSize: 11, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <StudioBody>
        {tab === 'resumen' && (
          <ResumenTab
            project={project}
            runs={runs}
            derived={derived}
            onOpenRun={onOpenRun}
            onGoToTrabajos={() => setTab('trabajos')}
            onGoToAhora={onGoNow}
          />
        )}
        {tab === 'trabajos' && (
          <TrabajosTab runs={runs} onOpenRun={onOpenRun} />
        )}
        {tab === 'diseno' && (
          <DesignTab projectId={project.id} projectName={project.name} />
        )}
        {tab === 'ejecutar' && (
          <EjecutarTab projectId={project.id} projectName={project.name} />
        )}
        {tab === 'acciones' && (
          <AccionesTab onOpenArsenal={onOpenArsenal} />
        )}
        {tab === 'configuracion' && (
          <ConfiguracionTab project={project} />
        )}
      </StudioBody>
    </div>
  );
}

// ── Resumen Tab ──

function ResumenTab({
  project, runs, derived, onOpenRun, onGoToTrabajos, onGoToAhora,
}: {
  project: Project;
  runs: RunRow[];
  derived: { totalRuns: number; successRuns: number; totalCost: number; successRate: number; status: ProjectStatus; currentStep: string | null };
  onOpenRun?: (id: string) => void;
  onGoToTrabajos: () => void;
  onGoToAhora?: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* SDD Onboarding (only shown when project is eligible) */}
      <OnboardingBanner projectId={project.id} />

      {/* Quick change request — always visible */}
      <ChangeRequestCard projectId={project.id} projectName={project.name} onStarted={onGoToAhora} />

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StudioMetricCard
          label="Estado"
          value={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {derived.status === 'active' && (
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: T.success, boxShadow: `0 0 0 4px ${T.successBg}` }} />
              )}
              <span style={{ fontSize: 18 }}>{STATUS_LABEL[derived.status]}</span>
            </div>
          }
          sub={derived.currentStep ?? '—'}
        />
        <StudioMetricCard label="Trabajos totales" mono value={derived.totalRuns}
          sub={`${derived.successRuns} exitosos`} />
        <StudioMetricCard
          label="Éxito" mono
          value={`${derived.successRate}%`}
          accent={derived.successRate >= 90 ? T.success : undefined}
          sub={derived.totalRuns > 0
            ? (derived.successRuns === derived.totalRuns ? 'Todo salió bien' : `${derived.totalRuns - derived.successRuns} necesitaron retomar`)
            : '—'}
        />
        <StudioMetricCard label="Gastado total" mono value={`$${derived.totalCost.toFixed(2)}`}
          sub="Desde el primer trabajo" />
      </div>

      {/* Two-column */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* Recent runs */}
        <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center' }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>Últimos trabajos</div>
            {runs.length > 0 && (
              <span onClick={onGoToTrabajos} style={{ fontSize: 12, color: T.textDim, cursor: 'pointer' }}>Ver todos →</span>
            )}
          </div>
          {runs.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: T.textFaint, fontSize: 13 }}>
              Este proyecto todavía no tiene trabajos guardados.
            </div>
          ) : runs.slice(0, 6).map((r, i, arr) => (
            <div key={r.id} className="studio-row"
              onClick={() => onOpenRun && onOpenRun(r.id)}
              style={{
                padding: '12px 18px',
                borderBottom: i < arr.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
                display: 'grid', gridTemplateColumns: '60px 1fr 90px 90px 70px',
                alignItems: 'center', gap: 14, fontSize: 12.5, cursor: 'pointer',
                transition: 'background .12s ease',
              }}>
              <span style={{ fontFamily: T.fontMono, color: T.textFaint, fontSize: 11 }}>#{r.shortId}</span>
              <div>
                <div style={{ color: T.text, fontWeight: 500, marginBottom: 2 }}>
                  Trabajo {RESULT_LABEL[r.status]?.toLowerCase() ?? 'pendiente'}
                </div>
                <div style={{ color: T.textFaint, fontSize: 11 }}>
                  {r.stepsDone}/{r.totalSteps} pasos · {r.when}
                </div>
              </div>
              <div>
                <StudioPill tone={RESULT_TONE[r.status] ?? 'neutral'} dot={r.status === 'running'}>
                  {RESULT_LABEL[r.status] ?? r.status}
                </StudioPill>
              </div>
              <span style={{ fontFamily: T.fontMono, color: T.textDim, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                {r.duration}
              </span>
              <span style={{ fontFamily: T.fontMono, color: T.text, fontSize: 11.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                ${r.cost.toFixed(2)}
              </span>
            </div>
          ))}
        </div>

        {/* Sidebar info */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SidebarCard title="Carpeta">
            <div style={{
              padding: '8px 10px', background: T.bgAlt, borderRadius: 6,
              fontFamily: T.fontMono, fontSize: 11.5, color: T.textDim,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{project.path}</div>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 10, lineHeight: 1.5 }}>
              {derived.totalRuns} trabajos desde que empezó
            </div>
          </SidebarCard>

          <SidebarCard title="Herramientas activas">
            <KV label="Editor" value={runs[0] ? prettyProvider(runs[0].id.length > 0 ? 'claude' : 'claude') : 'Claude Code'} />
            <KV label="Modelo por defecto" value="Sonnet 4.5" />
            <KV label="Controles de calidad" value="3 activos" />
          </SidebarCard>

          <SidebarCard title="Acciones">
            {['Rebobinar a un punto anterior', 'Exportar documentación viva', 'Archivar proyecto'].map((a) => (
              <div key={a}
                onMouseEnter={(e) => { e.currentTarget.style.background = T.bgAlt; e.currentTarget.style.color = T.text; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.textDim; }}
                style={{
                  padding: '8px 10px', borderRadius: 6, fontSize: 12.5,
                  color: T.textDim, cursor: 'pointer',
                  transition: 'background .12s ease, color .12s ease',
                }}>
                {a}
              </div>
            ))}
          </SidebarCard>
        </div>
      </div>
    </div>
  );
}

function SidebarCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, padding: '16px 18px' }}>
      <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 12 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
      <span style={{ color: T.textDim }}>{label}</span>
      <span style={{ color: T.text, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// ── Trabajos Tab ──

function TrabajosTab({ runs, onOpenRun }: { runs: RunRow[]; onOpenRun?: (id: string) => void }) {
  if (runs.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: T.textDim }}>
        <div style={{ fontSize: 14 }}>Este proyecto todavía no tiene trabajos.</div>
      </div>
    );
  }

  return (
    <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '60px 1fr 110px 100px 100px 90px',
        padding: '10px 20px', borderBottom: `1px solid ${T.border}`,
        fontSize: 10.5, color: T.textFaint, fontWeight: 500, letterSpacing: 0.4,
        textTransform: 'uppercase',
      }}>
        <div>#</div>
        <div>Resultado</div>
        <div>Pasos</div>
        <div style={{ textAlign: 'right' }}>Duración</div>
        <div style={{ textAlign: 'right' }}>Costo</div>
        <div style={{ textAlign: 'right' }}>Cuándo</div>
      </div>
      {runs.map((r, i) => (
        <div key={r.id} className="studio-row"
          onClick={() => onOpenRun && onOpenRun(r.id)}
          style={{
            display: 'grid', gridTemplateColumns: '60px 1fr 110px 100px 100px 90px',
            padding: '11px 20px', fontSize: 12.5, alignItems: 'center',
            borderBottom: i < runs.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
            cursor: 'pointer', transition: 'background .12s ease',
          }}>
          <span style={{ fontFamily: T.fontMono, color: T.textFaint }}>#{r.shortId}</span>
          <StudioPill tone={RESULT_TONE[r.status] ?? 'neutral'} dot={r.status === 'running'}>
            {RESULT_LABEL[r.status] ?? r.status}
          </StudioPill>
          <span style={{ color: T.textDim, fontSize: 11.5 }}>{r.stepsDone}/{r.totalSteps}</span>
          <span style={{ textAlign: 'right', fontFamily: T.fontMono, color: T.textDim, fontVariantNumeric: 'tabular-nums' }}>
            {r.duration}
          </span>
          <span style={{ textAlign: 'right', fontFamily: T.fontMono, color: T.text, fontVariantNumeric: 'tabular-nums' }}>
            ${r.cost.toFixed(2)}
          </span>
          <span style={{ textAlign: 'right', color: T.textDim, fontSize: 11.5 }}>{r.when}</span>
        </div>
      ))}
    </div>
  );
}

// ── Acciones Tab ──

interface ActionGroup {
  title: string;
  desc: string;
  items: { label: string; desc: string; command: string; cost: string; time: string }[];
}

const ACTION_GROUPS: ActionGroup[] = [
  {
    title: 'Consultas con expertos',
    desc: 'Convoca paneles virtuales para discutir un tema. Útil antes de tomar decisiones que cuesta deshacer.',
    items: [
      { label: 'Mesa Redonda', desc: 'Discusión exploratoria con CPO, Arquitecto, UX, Negocio, QA, Seguridad y DevOps.', command: '/dc:mesa-redonda', cost: '0.40', time: '~2 min' },
      { label: 'Mesa Técnica', desc: 'Panel de ingenieros senior (Tech Lead, Arquitecto, Backend, Frontend) para decisiones de implementación.', command: '/dc:mesa-tecnica', cost: '0.60', time: '~3 min' },
      { label: 'Estimar costo y tiempo', desc: 'Pronostica cuánto te va a costar y cuánto va a tardar antes de empezar.', command: 'agente: estimador', cost: '0.10', time: '~30 s' },
    ],
  },
  {
    title: 'Auditorías',
    desc: 'Revisión del estado actual del proyecto. Encuentran problemas antes de que crezcan.',
    items: [
      { label: 'Auditar seguridad', desc: 'Busca vulnerabilidades, secretos expuestos y riesgos OWASP en el código de hoy.', command: '/dc:auditar-seguridad', cost: '0.30', time: '~1 min' },
      { label: 'Revisar calidad actual', desc: 'Análisis del código tal como está, sin cambiarlo.', command: '/dc:revisar', cost: '0.35', time: '~1 min' },
      { label: 'Detectar relleno IA', desc: 'Identifica código de baja calidad típico de generación automática.', command: '/dc:slop-scan', cost: '0.20', time: '~45 s' },
    ],
  },
  {
    title: 'Mantenimiento',
    desc: 'Tareas para que el proyecto siga sano con el tiempo.',
    items: [
      { label: 'Diagnóstico del proyecto', desc: 'Chequeo general: ¿algo está mal configurado o desactualizado?', command: '/dc:doctor', cost: '0.15', time: '~30 s' },
      { label: 'Actualizar documentación', desc: 'Regenera la documentación a partir del código actual.', command: '/dc:documentacion-viva', cost: '0.50', time: '~2 min' },
      { label: 'Volver a clarificar', desc: 'Reabre el cuestionario de ambigüedades sobre los requisitos.', command: '/dc:clarificar', cost: '0.25', time: '~1 min' },
    ],
  },
];

function AccionesTab({ onOpenArsenal }: { onOpenArsenal?: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1080 }}>
      <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5, maxWidth: 640 }}>
        Cada botón le pide al asistente de IA que ejecute una tarea concreta sobre este proyecto.
        Se ejecutan al instante. El costo y el tiempo son estimaciones; podrás detener cualquier acción mientras corre.
      </div>
      {ACTION_GROUPS.map((g) => (
        <div key={g.title}>
          <div style={{ fontSize: 14, fontWeight: 500, color: T.text, marginBottom: 4 }}>{g.title}</div>
          <div style={{ fontSize: 12, color: T.textDim, marginBottom: 12, lineHeight: 1.5, maxWidth: 640 }}>{g.desc}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {g.items.map((it) => <ActionButton key={it.label} {...it} />)}
          </div>
        </div>
      ))}

      <div style={{
        marginTop: 4, padding: '14px 16px',
        background: T.bgAlt, borderRadius: 12,
        fontSize: 12.5, color: T.textDim, lineHeight: 1.5,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
      }}>
        <span>
          Hay muchos más comandos disponibles (181 en total).
          Los nueve de aquí son los más usados; los demás los encuentras en el <strong>Arsenal</strong>.
        </span>
        <StudioButton onClick={onOpenArsenal}>Abrir Arsenal →</StudioButton>
      </div>
    </div>
  );
}

function ActionButton({
  label, desc, command, cost, time,
}: { label: string; desc: string; command: string; cost: string; time: string }) {
  return (
    <button
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
      style={{
        textAlign: 'left',
        background: T.panel, borderRadius: 12,
        boxShadow: T.shadow,
        padding: '14px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        transition: 'transform .12s ease, box-shadow .12s ease',
        display: 'flex', flexDirection: 'column', gap: 6, minHeight: 110,
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 500, color: T.text }}>{label}</div>
      <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5 }}>{desc}</div>
      <div style={{
        marginTop: 'auto', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 8,
        paddingTop: 8, borderTop: `1px solid ${T.borderSoft}`,
      }}>
        <span style={{ fontFamily: T.fontMono, fontSize: 10.5, color: T.textFaint }}>{command}</span>
        <span style={{ fontFamily: T.fontMono, fontSize: 10.5, color: T.textDim, fontVariantNumeric: 'tabular-nums' }}>
          ~${cost} · {time}
        </span>
      </div>
    </button>
  );
}

// ── Configuración Tab ──

function ConfiguracionTab({ project }: { project: Project }) {
  const rows = [
    { icon: Folder, label: 'Carpeta', value: project.path },
    { icon: Wrench, label: 'Editor de IA', value: 'Claude Code' },
    { icon: SettingsIcon, label: 'Modelo por defecto', value: 'Claude Sonnet 4.5' },
    { icon: SettingsIcon, label: 'Presupuesto por trabajo', value: '$2.50' },
    { icon: SettingsIcon, label: 'Idioma', value: 'Español' },
  ];
  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, overflow: 'hidden' }}>
        {rows.map((r, i) => {
          const Icon = r.icon;
          return (
            <div key={r.label} style={{
              padding: '16px 20px',
              borderBottom: i < rows.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
              display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center', gap: 16,
            }}>
              <Icon size={16} color={T.textFaint} strokeWidth={1.8} />
              <div style={{ fontSize: 13.5, fontWeight: 500, color: T.text }}>{r.label}</div>
              <div style={{ fontSize: 12.5, color: T.textDim, fontFamily: T.fontMono, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.value}
              </div>
              <ChevronRight size={14} color={T.textFaint} />
            </div>
          );
        })}
      </div>

      <GitHubCard projectId={project.id} />

      <ServicesCard projectId={project.id} />

      <div style={{
        padding: '14px 16px',
        background: T.bgAlt, borderRadius: 10, border: `1px solid ${T.border}`,
        fontSize: 12.5, color: T.textDim, lineHeight: 1.55,
      }}>
        Configuración detallada (controles de calidad, reglas de desviación, mesas automáticas)
        está en la sección global <strong>Configuración</strong> del sidebar.
      </div>
    </div>
  );
}

function GitHubCard({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GitBranchStatus | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await api.github.status(projectId)); }
    catch { setStatus(null); }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleInit = async () => {
    setBusy(true); setError(null);
    try {
      await api.github.init(projectId, { visibility });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el repositorio');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div style={{
        background: T.panel, borderRadius: 12, boxShadow: T.shadow,
        padding: '14px 18px', fontSize: 12.5, color: T.textDim,
      }}>Cargando estado de GitHub…</div>
    );
  }

  // Linked
  if (status.has_repo && status.repo_url) {
    return (
      <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <GitBranch size={18} color={T.text} strokeWidth={1.6} />
          <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>Repositorio en GitHub</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 12, alignItems: 'center', fontSize: 12.5 }}>
          <span style={{ color: T.textDim }}>Repo</span>
          <a href={status.repo_url} target="_blank" rel="noreferrer" style={{
            fontFamily: T.fontMono, color: T.text, textDecoration: 'none',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{status.owner}/{status.name}</a>
          <a href={status.repo_url} target="_blank" rel="noreferrer" style={{
            fontSize: 12, color: T.text, textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '5px 10px', borderRadius: 6, background: T.bgAlt,
          }}>Abrir <ExternalLink size={11} /></a>

          <span style={{ color: T.textDim }}>Visibilidad</span>
          <span style={{ color: T.text }}>{status.visibility ?? '—'}</span>
          <span />

          {status.default_branch && (
            <>
              <span style={{ color: T.textDim }}>Rama por defecto</span>
              <span style={{ color: T.text, fontFamily: T.fontMono }}>{status.default_branch}</span>
              <span />
            </>
          )}
        </div>
      </div>
    );
  }

  // gh not authenticated
  if (!status.gh_authenticated) {
    return (
      <div style={{
        background: T.bgAlt, borderRadius: 12,
        padding: '14px 18px', border: `1px dashed ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 12, fontSize: 12.5, color: T.textDim,
      }}>
        <GitBranch size={16} color={T.textDim} strokeWidth={1.6} />
        <span>
          GitHub CLI no autenticado. Corre <code style={{ fontFamily: T.fontMono, fontSize: 11, padding: '1px 5px', background: T.panel, borderRadius: 3 }}>gh auth login</code> en tu terminal para conectar tu cuenta.
        </span>
      </div>
    );
  }

  // Authenticated, no repo yet → form
  return (
    <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <GitBranch size={18} color={T.text} strokeWidth={1.6} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: T.text }}>Crear repositorio en GitHub</div>
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 2, lineHeight: 1.5 }}>
            Inicializa un repo en{' '}
            <code style={{ fontFamily: T.fontMono, fontSize: 11, padding: '1px 5px', background: T.bgAlt, borderRadius: 3 }}>
              github.com/{status.authenticated_user ?? '...'}/{(status.name ?? '').toLowerCase() || '...'}
            </code>{' '}
            con un commit inicial.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {(['private', 'public'] as const).map((v) => (
          <label key={v} style={{
            flex: 1, padding: '9px 12px', borderRadius: 8,
            background: visibility === v ? T.successBg : T.bgAlt,
            border: `1px solid ${visibility === v ? T.success : T.border}`,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
          }}>
            <input type="radio" checked={visibility === v} onChange={() => setVisibility(v)} />
            <span>{v === 'private' ? 'Privado' : 'Público'}</span>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={handleInit} disabled={busy} style={{
          padding: '8px 14px', borderRadius: 8,
          background: busy ? T.bgAlt : T.ink, color: busy ? T.textFaint : '#fff',
          border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
          fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          <GitBranch size={13} strokeWidth={1.8} />
          {busy ? 'Creando repo…' : 'Crear repositorio'}
        </button>
        {status.authenticated_user && (
          <span style={{ fontSize: 11.5, color: T.textFaint }}>
            como <strong>{status.authenticated_user}</strong>
          </span>
        )}
      </div>

      {error && (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 6,
          background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)', fontSize: 12,
        }}>{error}</div>
      )}
    </div>
  );
}

// ── Helpers ──

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

function prettyProvider(p: string): string {
  switch (p.toLowerCase()) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'opencode': return 'OpenCode';
    default: return p.charAt(0).toUpperCase() + p.slice(1);
  }
}

// ── Services & API keys (env inventory) ────────────────────────────────────

function ServicesCard({ projectId }: { projectId: string }) {
  const [data, setData] = useState<EnvInventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.envInventory.get(projectId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, padding: '14px 18px', fontSize: 12.5, color: T.textDim }}>
        Cargando servicios y variables…
      </div>
    );
  }
  if (!data || (data.files.length === 0 && data.services_detected.length === 0)) {
    return (
      <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, padding: '14px 18px', fontSize: 12.5, color: T.textDim }}>
        No se encontraron archivos <code style={{ fontFamily: T.fontMono, fontSize: 11.5 }}>.env</code> en este proyecto.
      </div>
    );
  }

  const totalKeys = data.files.reduce((acc, f) => acc + f.keys.length, 0);

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Key size={14} color={T.text} />
          <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>
            Servicios y API keys
          </span>
          <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.fontMono }}>
            {data.services_detected.length} servicios · {totalKeys} variables · {data.files.length} archivos
          </span>
        </div>
        <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.55 }}>
          Detectado automáticamente leyendo tus archivos <code style={{ fontFamily: T.fontMono, fontSize: 11 }}>.env*</code> y <code style={{ fontFamily: T.fontMono, fontSize: 11 }}>local.properties</code>. Solo se muestran los nombres de las variables — los valores nunca salen del archivo.
        </div>
      </div>

      {/* Files scanned */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {data.files.map((f) => (
          <span key={f.path} style={{
            padding: '3px 9px', borderRadius: 999,
            background: T.bgAlt, color: T.textDim,
            fontSize: 11, fontFamily: T.fontMono, border: `1px solid ${T.border}`,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            {f.path}
            <span style={{ color: T.textFaint }}>· {f.keys.length} keys</span>
            {f.is_example && <span style={{ color: T.warn }}>(example)</span>}
          </span>
        ))}
      </div>

      {/* Services */}
      {data.services_detected.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.services_detected.map((s) => (
            <ServiceRow
              key={s.id}
              service={s}
              expanded={expanded.has(s.id)}
              onToggle={() => toggle(s.id)}
            />
          ))}
        </div>
      )}

      {/* Orphan keys */}
      {data.orphan_keys.length > 0 && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: T.warnBg, border: `1px solid ${T.warn}`,
          fontSize: 12, color: T.text, display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <AlertCircle size={13} color={T.warn} style={{ marginTop: 1, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, color: T.warn, marginBottom: 4 }}>
              {data.orphan_keys.length} variable{data.orphan_keys.length === 1 ? '' : 's'} sin servicio reconocido
            </div>
            <div style={{ fontSize: 11.5, color: T.textDim, marginBottom: 6 }}>
              No matchearon con ningún servicio conocido. Pueden ser typos o servicios custom.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {data.orphan_keys.map((k) => (
                <span key={k} style={{
                  padding: '2px 7px', borderRadius: 4,
                  background: T.panel, fontFamily: T.fontMono, fontSize: 10.5, color: T.text,
                }}>{k}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Suggestions */}
      {data.suggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Servicios sugeridos
          </div>
          {data.suggestions.map((s) => (
            <div key={s.id} style={{
              padding: '10px 12px', borderRadius: 8,
              background: T.bgAlt, border: `1px solid ${T.border}`,
              fontSize: 12, color: T.text,
              display: 'flex', gap: 8, alignItems: 'flex-start',
            }}>
              <Lightbulb size={13} color="oklch(50% 0.15 75)" style={{ marginTop: 1, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 500, color: T.text, marginBottom: 2 }}>{s.name}</div>
                <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5 }}>{s.reason}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ service, expanded, onToggle }: {
  service: ServiceMatch;
  expanded: boolean;
  onToggle: () => void;
}) {
  const totalExpected = service.expected_keys.length;
  const totalConfigured = service.configured_keys.length;
  const missing = service.missing_keys.length;
  const allMatching = service.expected_keys.length > 0
    ? new Set(service.expected_keys.map((k) => k.toLowerCase()))
    : null;

  return (
    <div style={{
      border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden',
    }}>
      <div
        onClick={onToggle}
        style={{
          padding: '10px 12px',
          display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 12,
          cursor: 'pointer', background: T.panel,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: T.text }}>
            {service.name}
            <span style={{ marginLeft: 8, fontSize: 11, color: T.textFaint, fontWeight: 400 }}>
              {service.category}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2 }}>
            Configurado en {service.stacks.length === 1 ? service.stacks[0] : `${service.stacks.length} stacks: ${service.stacks.join(', ')}`}
            {totalExpected > 0 && (
              <> · {totalConfigured}/{totalExpected} keys conocidas</>
            )}
          </div>
        </div>
        <div>
          {missing === 0 ? (
            <span style={{
              padding: '3px 9px', borderRadius: 999,
              background: T.successBg, color: T.success,
              fontSize: 10.5, fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <CheckCircle2 size={10} /> Completo
            </span>
          ) : (
            <span style={{
              padding: '3px 9px', borderRadius: 999,
              background: T.warnBg, color: T.warn,
              fontSize: 10.5, fontWeight: 500,
            }}>
              {missing} faltante{missing === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <ChevronRight
          size={14}
          color={T.textFaint}
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
        />
      </div>

      {expanded && (
        <div style={{ padding: '10px 12px', background: T.bgAlt, borderTop: `1px solid ${T.border}` }}>
          {service.expected_keys.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                Variables conocidas
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {service.expected_keys.map((k) => {
                  const present = service.configured_keys.some((c) => c.toLowerCase() === k.toLowerCase());
                  return (
                    <div key={k} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      fontSize: 11.5, fontFamily: T.fontMono,
                      color: present ? T.text : T.warn,
                    }}>
                      {present ? '✓' : '○'} {k}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Extra configured keys not in the canonical list */}
          {(() => {
            const extras = service.configured_keys.filter((k) => !allMatching?.has(k.toLowerCase()));
            return extras.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                  Variables adicionales detectadas
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {extras.map((k) => (
                    <div key={k} style={{
                      fontSize: 11.5, fontFamily: T.fontMono, color: T.textDim,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>✓ {k}</div>
                  ))}
                </div>
              </div>
            );
          })()}

          <div style={{ display: 'flex', gap: 12, fontSize: 11.5 }}>
            <a href={service.dashboard_url} target="_blank" rel="noopener noreferrer" style={{
              color: T.text, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <ExternalLink size={11} /> Dashboard
            </a>
            <a href={service.docs_url} target="_blank" rel="noopener noreferrer" style={{
              color: T.textDim, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <ExternalLink size={11} /> Docs
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Quick Change Request (pedir cambios) ───────────────────────────────────

function ChangeRequestCard({ projectId, projectName, onStarted }: {
  projectId: string; projectName: string; onStarted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        onClick={() => setOpen(true)}
        style={{
          background: T.panel,
          borderRadius: 12,
          boxShadow: T.shadow,
          padding: '16px 20px',
          border: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 14,
          cursor: 'pointer',
          transition: 'box-shadow .15s, transform .15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = T.shadowLg; e.currentTarget.style.transform = 'translateY(-1px)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = T.shadow; e.currentTarget.style.transform = 'none'; }}
      >
        <span style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'oklch(96% 0.05 220)', color: 'oklch(45% 0.18 220)',
          display: 'grid', placeItems: 'center', flexShrink: 0,
        }}>
          <MessageSquare size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: T.text, marginBottom: 2 }}>
            Pedir un cambio
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5 }}>
            Describí qué querés agregar, modificar o quitar — Don Cheli arma specs, plan y código.
          </div>
        </div>
        <ArrowRight size={16} color={T.textDim} />
      </div>

      {open && (
        <ChangeRequestModal
          projectId={projectId}
          projectName={projectName}
          onClose={() => setOpen(false)}
          onStarted={() => { setOpen(false); onStarted?.(); }}
        />
      )}
    </>
  );
}

const CHANGE_EXAMPLES: { title: string; prompt: string }[] = [
  {
    title: 'Login con Google (Firebase)',
    prompt: 'Quiero agregar autenticación con Google usando Firebase Auth. La pantalla de Login debe tener el botón "Continuar con Google" arriba del email/password actual. Después del login, persistir la sesión y redirigir al usuario al Command Center.',
  },
  {
    title: 'Modo oscuro/claro toggle',
    prompt: 'Agregar soporte para light mode y un toggle de tema en el header. Persistir la preferencia en localStorage. Asegurate de que todos los componentes respeten ambos modos (revisá los design tokens de tailwind.config).',
  },
  {
    title: 'Notificaciones push',
    prompt: 'Implementar push notifications via Firebase Cloud Messaging. Pedir permiso al usuario en onboarding, registrar el token en la colección users, y crear una Cloud Function que dispare una push cuando se crea un incidente cerca del usuario.',
  },
  {
    title: 'Internacionalización (es/en)',
    prompt: 'Agregar i18n con next-intl. Crear archivos de traducción para español (default) e inglés. Extraer todos los textos hardcoded a las claves de traducción y agregar un selector de idioma en Configuración.',
  },
];

function ChangeRequestModal({ projectId, projectName, onClose, onStarted }: {
  projectId: string; projectName: string; onClose: () => void; onStarted: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Autofocus on open
    const t = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, []);

  const handleSubmit = async () => {
    const task = text.trim();
    if (task.length < 10) {
      setError('La descripción es muy corta. Sé específico: qué, dónde y por qué.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.pipeline.start(projectId, task);
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar el trabajo');
      setBusy(false);
    }
  };

  const applyExample = (prompt: string) => {
    setText(prompt);
    textareaRef.current?.focus();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(17, 18, 22, 0.55)',
        display: 'grid', placeItems: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: T.panel, borderRadius: 12,
          boxShadow: T.shadowLg, padding: '22px 24px',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <MessageSquare size={16} color={T.text} />
            <div style={{ fontSize: 15, fontWeight: 500, color: T.text }}>
              Pedir cambios sobre <span style={{ fontFamily: T.fontMono }}>{projectName}</span>
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55 }}>
            Describí lo que querés. Don Cheli va a correr el pipeline completo:
            specs → clarify → plan → design → breakdown → implement → review.
            Sé específico — qué, dónde, con qué tecnología, qué casos cubrir.
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ej: Quiero agregar login con Google usando Firebase Auth. Mostrar el botón en la pantalla de Login arriba del formulario actual y persistir la sesión en localStorage."
          rows={7}
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.bgAlt,
            fontFamily: 'inherit',
            fontSize: 13,
            color: T.text,
            outline: 'none',
            resize: 'vertical',
            lineHeight: 1.55,
            boxSizing: 'border-box',
          }}
        />

        <div>
          <div style={{ fontSize: 11, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={11} /> Ejemplos (click para usar)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CHANGE_EXAMPLES.map((ex) => (
              <button
                key={ex.title}
                onClick={() => applyExample(ex.prompt)}
                style={{
                  padding: '5px 10px', borderRadius: 999,
                  background: T.bgAlt, color: T.text,
                  fontSize: 11.5, border: `1px solid ${T.border}`,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >{ex.title}</button>
            ))}
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: T.warn, padding: '8px 10px', borderRadius: 6, background: T.warnBg }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: T.textFaint, marginRight: 'auto' }}>
            {text.trim().length > 0 && `${text.trim().length} caracteres`}
          </span>
          <button onClick={onClose} disabled={busy} style={{
            padding: '8px 14px', borderRadius: 6,
            background: T.panel, color: T.textDim,
            border: 'none', boxShadow: T.shadow,
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 12.5, fontFamily: 'inherit',
          }}>Cancelar</button>
          <button onClick={handleSubmit} disabled={busy || text.trim().length < 10} style={{
            padding: '8px 14px', borderRadius: 6,
            background: (busy || text.trim().length < 10) ? T.bgAlt : T.ink,
            color: (busy || text.trim().length < 10) ? T.textFaint : '#fff',
            border: 'none',
            cursor: (busy || text.trim().length < 10) ? 'not-allowed' : 'pointer',
            fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />}
            {busy ? 'Iniciando…' : 'Enviar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SDD Onboarding ─────────────────────────────────────────────────────────

function OnboardingBanner({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<OnboardStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const { events } = useWebSocket(projectId);

  const refresh = useCallback(() => {
    api.onboard.status(projectId).then(setStatus).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 8000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const lastStatus = useMemo(() => {
    const filtered = events.filter((e) => e.type === 'sdd_onboarding');
    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
  }, [events]);

  const onboardingLogs = useMemo(() => events
    .filter((e) => e.type === 'sdd_onboarding_log')
    .map((e) => (e.data?.summary as string) || (e.data?.line as string) || '')
    .filter(Boolean),
    [events]);

  const runStatus = lastStatus?.data?.status as string | undefined;
  const isRunning = runStatus === 'starting';

  // Hide once the project is fully onboarded AND no run is active.
  if (status && !status.eligible && !isRunning) return null;
  if (!status) return null;

  return (
    <>
      <div style={{
        background: T.panel,
        borderRadius: 12, boxShadow: T.shadow,
        padding: '18px 20px',
        border: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'oklch(96% 0.04 270)', color: 'oklch(45% 0.18 270)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Wand2 size={18} />
            </span>
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 500, color: T.text, marginBottom: 4 }}>
                Onboardear este proyecto a SDD
              </div>
              <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55, maxWidth: 640 }}>
                Don Cheli lee el código actual y genera blueprint + spec + plan + tareas + auditoría de mejoras. Después podés iterar con el pipeline normal.
              </div>
            </div>
          </div>
          <button
            onClick={() => setModalOpen(true)}
            disabled={isRunning}
            style={{
              padding: '8px 16px', borderRadius: 8,
              background: isRunning ? T.bgAlt : T.ink,
              color: isRunning ? T.textFaint : '#fff',
              border: 'none', cursor: isRunning ? 'not-allowed' : 'pointer',
              fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              flexShrink: 0,
            }}
          >
            {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {isRunning ? 'Procesando…' : 'Generar SDD'}
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Check label="Blueprint completo" done={status.has_full_blueprint} />
          <Check label="Spec" done={status.has_spec} />
          <Check label="Plan" done={status.has_plan} />
          <Check label="Tareas" done={status.has_tasks} />
          <Check label="Auditoría" done={status.has_audit} />
          <Check label="Diseño existente" done={status.has_design} />
        </div>

        {/* Live activity — currently-doing line */}
        {isRunning && onboardingLogs.length > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 8,
            background: 'oklch(96% 0.04 270)',
            border: '1px solid oklch(88% 0.06 270)',
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            color: T.text,
          }}>
            <Loader2 size={12} className="animate-spin" color="oklch(45% 0.18 270)" />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {onboardingLogs[onboardingLogs.length - 1]}
            </span>
          </div>
        )}

        {onboardingLogs.length > 0 && (isRunning || runStatus === 'completed' || runStatus === 'failed') && (
          <div style={{
            maxHeight: 200, overflowY: 'auto',
            background: '#0f1114', color: '#cfd2d6',
            fontFamily: T.fontMono, fontSize: 10.5,
            padding: '8px 10px', borderRadius: 8,
            lineHeight: 1.55,
          }}>
            {onboardingLogs.slice(-100).map((line, i) => (
              <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line}</div>
            ))}
          </div>
        )}

        {runStatus === 'completed' && (
          <div style={{ fontSize: 12.5, color: T.success, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle2 size={13} /> SDD generado. Revisá los nuevos artifacts en <code style={{ fontFamily: T.fontMono, fontSize: 11.5 }}>.dc/</code>.
          </div>
        )}
      </div>

      {modalOpen && (
        <OnboardingModal
          projectId={projectId}
          onClose={() => setModalOpen(false)}
          onStarted={() => { setModalOpen(false); refresh(); }}
        />
      )}
    </>
  );
}

function Check({ label, done }: { label: string; done: boolean }) {
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 999,
      background: done ? T.successBg : T.bgAlt,
      color: done ? T.success : T.textDim,
      fontSize: 11, fontWeight: 500,
      border: `1px solid ${done ? T.success : T.border}`,
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      {done ? '✓' : '○'} {label}
    </span>
  );
}

function OnboardingModal({ projectId, onClose, onStarted }: {
  projectId: string; onClose: () => void; onStarted: () => void;
}) {
  const [includeImprovements, setIncludeImprovements] = useState(true);
  const [userGoal, setUserGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.onboard.start(projectId, {
        include_improvements: includeImprovements,
        user_goal: userGoal.trim() || undefined,
      });
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(17, 18, 22, 0.55)',
        display: 'grid', placeItems: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(540px, 92vw)',
          background: T.panel, borderRadius: 12,
          boxShadow: T.shadowLg, padding: '22px 24px',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: T.text, marginBottom: 4 }}>
            Generar SDD desde el código existente
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55 }}>
            Don Cheli va a leer el código actual y escribir blueprint, spec, plan, tareas y auditoría en <code style={{ fontFamily: T.fontMono, fontSize: 11 }}>.dc/</code>. No modifica código fuente. Tarda 5–10 minutos. Costo estimado: $3–8 USD.
          </div>
        </div>

        <label style={{ fontSize: 12.5, color: T.text, display: 'block' }}>
          <div style={{ marginBottom: 6 }}>Foco u objetivo (opcional)</div>
          <textarea
            value={userGoal}
            onChange={(e) => setUserGoal(e.target.value)}
            placeholder="Ej: Quiero terminar la app y lanzarla. Priorizá bugs y polish."
            rows={3}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${T.border}`, background: T.bgAlt,
              fontFamily: 'inherit', fontSize: 12.5, color: T.text,
              outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeImprovements}
            onChange={(e) => setIncludeImprovements(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontSize: 12.5, color: T.text, fontWeight: 500 }}>
              Incluir auditoría de mejoras
            </div>
            <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2, lineHeight: 1.5 }}>
              Análisis adicional de UX, performance, tests, seguridad y a11y. Agrega ~$1-2 USD pero rinde mucho.
            </div>
          </div>
        </label>

        {error && (
          <div style={{ fontSize: 12, color: T.warn }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{
            padding: '8px 14px', borderRadius: 6,
            background: T.panel, color: T.textDim,
            border: 'none', boxShadow: T.shadow,
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 12.5, fontFamily: 'inherit',
          }}>Cancelar</button>
          <button onClick={handleStart} disabled={busy} style={{
            padding: '8px 14px', borderRadius: 6,
            background: busy ? T.bgAlt : T.ink,
            color: busy ? T.textFaint : '#fff',
            border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {busy ? 'Iniciando…' : 'Generar SDD'}
          </button>
        </div>
      </div>
    </div>
  );
}
