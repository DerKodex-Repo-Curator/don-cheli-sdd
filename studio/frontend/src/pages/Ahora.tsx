import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Clock, ArrowRight, KeyRound, ExternalLink, BookOpen, X, Check, MessageCircleQuestion } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioBody } from '../components/StudioShell';
import { api, type PipelineRun, type PhaseInfo, type ServiceSpec, type QuestionWithAnswer } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

// ── Types matching the redesign mock ──

type StepStatus = 'done' | 'active' | 'pending';
type GateState = 'waiting' | 'active' | 'passed';
type LogKind = 'info' | 'think' | 'warn' | 'done' | 'error';
type Tone = 'success' | 'neutral';

interface AhoraStep {
  id: string;
  label: string;
  status: StepStatus;
  dur: string;
  cost: string;
  progress: number;
}
interface AhoraGate {
  id: string;
  label: string;
  state: GateState;
  hint: string;
}
interface AhoraLog {
  t: string;
  kind: LogKind;
  text: string;
}
interface AhoraScenario {
  chips: { tone: Tone; text: string }[];
  header: { title: string; badge: string; sub: string; meta: string };
  metrics: { label: string; value: string; sub: string; dot?: boolean; mono?: boolean }[];
  steps: AhoraStep[];
  gates: AhoraGate[];
  log: AhoraLog[];
  provider: string;
}

// ── Mock data (active scenario from B_SCENARIOS.activo) ──
const MOCK_ACTIVE: AhoraScenario = {
  chips: [
    { tone: 'success', text: 'Un trabajo en marcha' },
    { tone: 'neutral', text: 'Todo tranquilo' },
    { tone: 'neutral', text: 'Has gastado $12.40 de $100' },
    { tone: 'neutral', text: '3 trabajos hoy' },
  ],
  header: {
    title: 'auth-jwt',
    badge: 'Trabajo n.º 12',
    sub: 'Ahora mismo está diseñando la pantalla de inicio de sesión. Cuando termine, te va a pedir que apruebes el diseño.',
    meta: 'Empezó hace 4 minutos · faltan ~10 más',
  },
  metrics: [
    { label: 'Proyecto', value: 'auth-jwt', sub: 'copia de trabajo: run-12' },
    { label: 'En qué va', value: 'Diseñando', sub: 'paso 4 de 7', dot: true },
    { label: 'Lleva', value: '4:12', sub: 'de unos 14 minutos', mono: true },
    { label: 'Ha costado', value: '$0.82', sub: 'tope del trabajo $3.00', mono: true },
  ],
  steps: [
    { id: 'especificar', label: 'Especificar', status: 'done', dur: '30s', cost: '$0.05', progress: 100 },
    { id: 'aclarar', label: 'Aclarar', status: 'done', dur: '45s', cost: '$0.08', progress: 100 },
    { id: 'planificar', label: 'Planificar', status: 'done', dur: '1m', cost: '$0.18', progress: 100 },
    { id: 'disenar', label: 'Diseñar', status: 'active', dur: '2:14', cost: '$0.51', progress: 45 },
    { id: 'desglosar', label: 'Desglosar', status: 'pending', dur: '—', cost: '—', progress: 0 },
    { id: 'construir', label: 'Construir', status: 'pending', dur: '—', cost: '—', progress: 0 },
    { id: 'revisar', label: 'Revisar', status: 'pending', dur: '—', cost: '—', progress: 0 },
  ],
  gates: [
    { id: 'tests', label: 'Tests', state: 'waiting', hint: 'Se corren durante "Construir"' },
    { id: 'design', label: 'Diseño aprobado', state: 'active', hint: 'Esperando que lo revises' },
    { id: 'final', label: 'Aprobación final', state: 'waiting', hint: 'Se hace en "Revisar"' },
  ],
  log: [
    { t: '10:42:18', kind: 'info', text: 'Generando el mockup del flujo (correo + contraseña)' },
    { t: '10:42:15', kind: 'info', text: 'Leyendo las reglas de diseño de tu equipo' },
    { t: '10:42:11', kind: 'think', text: '«Tengo dos formas de organizar esto. Voy a probar la primera.»' },
    { t: '10:41:58', kind: 'info', text: 'Activada: habilidad "Varias opciones visuales"' },
    { t: '10:41:46', kind: 'warn', text: 'Falta decidir qué pasa si la cuenta no está verificada' },
    { t: '10:41:32', kind: 'info', text: 'Abriendo la especificación que escribiste' },
    { t: '10:41:20', kind: 'done', text: 'Listo: la planificación terminó · 4 entregables definidos' },
    { t: '10:41:18', kind: 'think', text: '«Antes de diseñar conviene fijar la tipografía del sistema.»' },
    { t: '10:40:55', kind: 'info', text: 'Abrí una copia aparte del proyecto: no toco tu código original' },
  ],
  provider: 'Claude Code',
};

// ── Helpers to translate backend phase names ──

const PHASE_LABEL: Record<string, string> = {
  specify: 'Especificar', clarify: 'Aclarar', plan: 'Planificar',
  design: 'Diseñar', breakdown: 'Desglosar', implement: 'Construir', review: 'Revisar',
};
const PHASE_GERUND: Record<string, string> = {
  specify: 'Especificando', clarify: 'Aclarando', plan: 'Planificando',
  design: 'Diseñando', breakdown: 'Desglosando', implement: 'Construyendo', review: 'Revisando',
};

function phaseToStep(p: PhaseInfo): AhoraStep {
  const status: StepStatus =
    p.status === 'passed' ? 'done' :
    p.status === 'running' ? 'active' : 'pending';
  return {
    id: p.name,
    label: PHASE_LABEL[p.name] ?? p.name,
    status,
    dur: p.duration_ms ? formatSeconds(p.duration_ms / 1000) : (status === 'active' ? '—' : '—'),
    cost: p.cost_usd ? `$${p.cost_usd.toFixed(2)}` : '—',
    progress: status === 'done' ? 100 : status === 'active' ? 45 : 0,
  };
}

function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function relTime(iso: string): string {
  try {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'hace unos segundos';
    if (d < 3600) return `hace ${Math.floor(d / 60)} minutos`;
    if (d < 86400) return `hace ${Math.floor(d / 3600)} horas`;
    return 'hace varios días';
  } catch { return ''; }
}

// ── Component ──

interface Props {
  /** Called when user clicks "Empezar algo nuevo". Should open BuildFlow / project picker. */
  onStartNew?: () => void;
  /** Called for the "Seguir donde estabas" card on the empty state. */
  onResume?: (projectId: string) => void;
  /** Called for "Ver lo que ya hiciste". */
  onOpenHistory?: () => void;
  /** Open the project detail page for the active run. */
  onOpenProject?: (projectId: string) => void;
  /** Forces a specific view, useful for storybook/testing. */
  forceMode?: 'empty' | 'active';
}

export function Ahora({ onStartNew, onResume, onOpenHistory, onOpenProject, forceMode }: Props) {
  const [activeRun, setActiveRun] = useState<PipelineRun | null>(null);
  const [phases, setPhases] = useState<PhaseInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastProjectId, setLastProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  // Fetch active runs once + every 4s while there's one running
  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const [active, projects] = await Promise.all([
          api.runs.active().catch(() => [] as PipelineRun[]),
          api.projects.list().catch(() => []),
        ]);

        if (cancelled) return;

        if (active.length > 0) {
          const run = active[0];
          setActiveRun(run);
          const project = projects.find((p) => p.id === run.project_id);
          setProjectName(project?.name ?? null);
          try {
            const ph = await api.pipeline.phases(run.project_id);
            if (!cancelled) setPhases(ph);
          } catch { /* ignore */ }
        } else {
          setActiveRun(null);
          setPhases(null);
        }
        setLoading(false);

        // Track last project for the "Resume" card
        if (projects.length > 0) {
          setLastProjectId(projects[0].id);
          if (!projectName) setProjectName(projects[0].name);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasActive = !forceMode
    ? !loading && activeRun !== null
    : forceMode === 'active';

  if (forceMode === 'empty' || (!loading && !hasActive)) {
    return <EmptyState lastProjectName={projectName} lastProjectId={lastProjectId}
                       onStartNew={onStartNew} onResume={onResume}
                       onOpenHistory={onOpenHistory} />;
  }

  if (loading && !forceMode) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: T.textDim, fontSize: 13 }}>
        Cargando…
      </div>
    );
  }

  return <ActiveDashboard
    run={activeRun}
    projectName={projectName}
    phases={phases}
    onStartNew={onStartNew}
    onOpenProject={onOpenProject}
  />;
}

// ─────────── EMPTY STATE ───────────

function EmptyState({
  lastProjectName, lastProjectId, onStartNew, onResume, onOpenHistory,
}: {
  lastProjectName: string | null;
  lastProjectId: string | null;
  onStartNew?: () => void;
  onResume?: (id: string) => void;
  onOpenHistory?: () => void;
}) {
  return (
    <div style={{
      flex: 1, display: 'grid', placeItems: 'center', padding: 40,
      background: T.bg, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)',
    }}>
      <div style={{ width: 720, textAlign: 'center' }}>
        <div style={{
          width: 64, height: 64, borderRadius: 16, margin: '0 auto 28px',
          background: T.panel, boxShadow: T.shadow,
          display: 'grid', placeItems: 'center',
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8, background: T.ink,
            display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 600, fontSize: 13,
          }}>dc</div>
        </div>
        <div style={{ fontSize: 34, letterSpacing: -1, fontWeight: 500, marginBottom: 10 }}>
          Aquí vas a ver tus trabajos
        </div>
        <div style={{
          color: T.textDim, fontSize: 15, lineHeight: 1.55, marginBottom: 36,
          maxWidth: 540, margin: '0 auto 36px',
        }}>
          Don Cheli te acompaña a construir software paso a paso. Tú le dices qué quieres, él te pregunta
          lo que falta, planifica, lo hace y te avisa. Siempre puedes pausar, revisar o volver atrás.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          <ActionCard primary
            title="Empezar algo nuevo"
            sub="Elige una carpeta y le cuentas qué quieres"
            icon={Plus}
            onClick={onStartNew}
          />
          <ActionCard
            title="Seguir donde estabas"
            sub={lastProjectName ? `${lastProjectName}${lastProjectId ? '' : ''}` : 'auth-jwt · hace 4 minutos'}
            icon={RotateCcw}
            disabled={!lastProjectId}
            onClick={() => lastProjectId && onResume && onResume(lastProjectId)}
          />
          <ActionCard
            title="Ver lo que ya hiciste"
            sub="Tu historial de trabajos"
            icon={Clock}
            onClick={onOpenHistory}
          />
        </div>

        <div style={{ marginTop: 30, fontSize: 12.5, color: T.textFaint }}>
          ¿Primera vez? <a style={linkStyle}>Hacer el recorrido (2 min)</a> ·{' '}
          <a style={linkStyle}>Abrir la Guía</a>
        </div>
      </div>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  color: T.text, borderBottom: `1px solid ${T.text}`,
  paddingBottom: 1, cursor: 'pointer',
};

function ActionCard({
  title, sub, icon: Icon, primary, disabled, onClick,
}: {
  title: string;
  sub: string;
  icon: typeof Plus;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={() => !disabled && onClick && onClick()}
      style={{
        padding: '22px 20px 24px', borderRadius: 14, textAlign: 'left',
        background: primary ? T.ink : T.panel,
        boxShadow: primary ? T.shadowLg : T.shadow,
        color: primary ? '#fff' : T.text,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        position: 'relative',
        transition: 'transform .12s ease',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.transform = 'translateY(-2px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, marginBottom: 18,
        background: primary ? 'rgba(255,255,255,0.12)' : T.bgAlt,
        color: primary ? '#fff' : T.text,
        display: 'grid', placeItems: 'center',
      }}>
        <Icon size={18} strokeWidth={1.8} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, letterSpacing: -0.2 }}>{title}</div>
      <div style={{
        color: primary ? 'rgba(255,255,255,0.7)' : T.textDim,
        fontSize: 12.5, marginTop: 5,
      }}>{sub}</div>
      <div style={{
        position: 'absolute', top: 22, right: 20,
        color: primary ? 'rgba(255,255,255,0.6)' : T.textFaint,
      }}>
        <ArrowRight size={14} />
      </div>
    </div>
  );
}

// ─────────── ACTIVE DASHBOARD ───────────

function ActiveDashboard({
  run, projectName, phases, onStartNew, onOpenProject,
}: {
  run: PipelineRun | null;
  projectName: string | null;
  phases: PipelineRun extends never ? never : PhaseInfo[] | null;
  onStartNew?: () => void;
  onOpenProject?: (projectId: string) => void;
}) {
  const ws = useWebSocket(run?.project_id ?? null);
  const [elapsed, setElapsed] = useState(0);
  const [designApproval, setDesignApproval] = useState<{ status: string; mockupCount: number } | null>(null);
  const [approving, setApproving] = useState(false);
  const [pendingServices, setPendingServices] = useState<ServiceSpec[]>([]);
  const [showServicesModal, setShowServicesModal] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionWithAnswer[]>([]);
  const [showQuestionsModal, setShowQuestionsModal] = useState(false);

  useEffect(() => {
    if (!run) return;
    const start = new Date(run.started_at).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [run]);

  // Poll services-from-context — show a banner when the blueprint/spec mentions
  // services whose API keys aren't yet configured in .env.local.
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const check = async () => {
      try {
        const ctx = await api.services.fromContext(run.project_id);
        if (cancelled) return;
        const filled = new Set(ctx.env_keys_filled);
        const stillMissing = ctx.services.filter((svc) =>
          !svc.env_keys.every((k) => filled.has(k.name))
        );
        setPendingServices(stillMissing);
      } catch { /* ignore */ }
    };
    check();
    const t = window.setInterval(check, 8000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [run]);

  // Poll runtime questions — open a banner + modal as soon as the runtime asks.
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const check = async () => {
      try {
        const r = await api.questions.pending(run.project_id);
        if (cancelled) return;
        setPendingQuestions(r.questions);
        // Auto-open the modal the first time blocking questions arrive
        if (r.blocking_count > 0 && pendingQuestions.length === 0) {
          setShowQuestionsModal(true);
        }
      } catch { /* ignore */ }
    };
    check();
    const t = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.project_id]);

  // Poll design approval state — show a banner if a mockup is waiting for review.
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const check = async () => {
      try {
        const d = await api.design.list(run.project_id);
        if (cancelled) return;
        if (d.approval && d.mockups.length > 0) {
          setDesignApproval({ status: d.approval.status, mockupCount: d.mockups.length });
        } else {
          setDesignApproval(null);
        }
      } catch { /* ignore */ }
    };
    check();
    const t = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [run]);

  const handleApproveDesign = async () => {
    if (!run || approving) return;
    setApproving(true);
    try {
      await api.design.approve(run.project_id, 'Studio user', 'Aprobado desde Ahora');
      setDesignApproval((d) => d ? { ...d, status: 'approved' } : null);
    } catch { /* ignore */ }
    setApproving(false);
  };

  const handleRejectDesign = async () => {
    if (!run || approving) return;
    setApproving(true);
    try {
      await api.design.reject(run.project_id, 'Studio user', 'Rechazado desde Ahora');
      setDesignApproval((d) => d ? { ...d, status: 'rejected' } : null);
    } catch { /* ignore */ }
    setApproving(false);
  };

  const scenario = useMemo<AhoraScenario>(() => {
    if (!run) return MOCK_ACTIVE;
    const steps: AhoraStep[] = (phases ?? []).map(phaseToStep);
    const completed = steps.filter((s) => s.status === 'done').length;
    const currentPhase = steps.find((s) => s.status === 'active');
    const totalSteps = steps.length || 7;
    // Prefer the authoritative run.total_cost (set by sync_run_state from state.json's
    // costUsd) over summing per-phase costs — state.json only tracks total cost, not
    // per-phase, so phases come back as 0 from /api/pipeline/{id}/phases.
    const phaseSum = (phases ?? []).reduce((s, p) => s + (p.cost_usd ?? 0), 0);
    const totalCost = Math.max(run.total_cost ?? 0, phaseSum);
    const title = projectName ?? run.project_id.slice(0, 8);
    const runNumber = run.id.slice(0, 4);
    const phaseGerund = currentPhase ? PHASE_GERUND[currentPhase.id] ?? currentPhase.label : 'Listo';

    return {
      chips: [
        { tone: 'success', text: 'Un trabajo en marcha' },
        { tone: 'neutral', text: relTime(run.started_at) },
        { tone: 'neutral', text: `Has gastado $${totalCost.toFixed(2)}` },
        { tone: 'neutral', text: `${completed}/${totalSteps} pasos` },
      ],
      header: {
        title,
        badge: `Trabajo ${runNumber}`,
        sub: currentPhase
          ? `Ahora mismo está ${phaseGerund.toLowerCase()}. Cuando termine, pasa al siguiente paso.`
          : 'Pipeline completado.',
        meta: `Empezó ${relTime(run.started_at)} · ${formatSeconds(elapsed)} transcurridos`,
      },
      metrics: [
        { label: 'Proyecto', value: title, sub: `copia de trabajo: run-${runNumber}` },
        { label: 'En qué va', value: phaseGerund, sub: currentPhase ? `paso ${steps.indexOf(currentPhase) + 1} de ${totalSteps}` : 'Listo', dot: !!currentPhase },
        { label: 'Lleva', value: formatSeconds(elapsed), sub: 'tiempo real', mono: true },
        { label: 'Ha costado', value: `$${totalCost.toFixed(2)}`, sub: 'sin presupuesto fijo', mono: true },
      ],
      steps: steps.length > 0 ? steps : MOCK_ACTIVE.steps,
      gates: deriveGates(steps, designApproval),
      log: hooksToLog(ws.hookEvents, ws.logs),
      provider: prettyProvider(run.provider),
    };
  }, [run, phases, elapsed, projectName, ws.hookEvents, ws.logs, designApproval]);

  const usingMock = !run;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1,
      animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)',
    }}>
      <AhoraTopBar chips={scenario.chips} provider={scenario.provider} />
      <AhoraHeader
        header={scenario.header}
        onStartNew={onStartNew}
        onOpenProject={run && onOpenProject ? () => onOpenProject(run.project_id) : undefined}
      />

      {usingMock && (
        <div style={{
          padding: '8px 32px', background: T.warnBg, color: T.warn,
          fontSize: 12, borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{ fontWeight: 500 }}>Vista previa con datos de ejemplo</span>
          <span style={{ color: T.textDim, marginLeft: 6 }}>· No hay trabajos corriendo ahora mismo</span>
        </div>
      )}

      {designApproval && designApproval.status === 'in_review' && run && (
        <DesignApprovalBanner
          mockupCount={designApproval.mockupCount}
          approving={approving}
          onOpenDesign={() => onOpenProject && onOpenProject(run.project_id)}
          onApprove={handleApproveDesign}
          onReject={handleRejectDesign}
        />
      )}

      {/* Layer 2: services detected from the plan/spec that aren't configured yet */}
      {pendingServices.length > 0 && run && (
        <ServicesPendingBanner
          services={pendingServices}
          onOpen={() => setShowServicesModal(true)}
        />
      )}

      {showServicesModal && run && (
        <ConfigureServicesModal
          projectId={run.project_id}
          services={pendingServices}
          onClose={() => setShowServicesModal(false)}
          onSaved={() => { /* the poll will refresh */ }}
        />
      )}

      {/* Layer 3: questions from the runtime — Claude asked something */}
      {pendingQuestions.length > 0 && run && (
        <QuestionsPendingBanner
          questions={pendingQuestions}
          onOpen={() => setShowQuestionsModal(true)}
        />
      )}

      {showQuestionsModal && run && (
        <QuestionsModal
          projectId={run.project_id}
          questions={pendingQuestions}
          onClose={() => setShowQuestionsModal(false)}
          onAnswered={() => { /* poll will refresh */ }}
        />
      )}

      <StudioBody padding="20px 28px 28px">
        <Metrics metrics={scenario.metrics} />
        <Timeline steps={scenario.steps} />
        <div style={{ display: 'flex', gap: 16, marginTop: 18 }}>
          <LogPanel log={scenario.log} />
          <GatesPanel gates={scenario.gates} />
        </div>
      </StudioBody>
    </div>
  );
}

// ─────────── Sub-components matching the redesign ───────────

function AhoraTopBar({ chips, provider }: { chips: AhoraScenario['chips']; provider: string }) {
  return (
    <div style={{
      height: 60, padding: '0 28px',
      borderBottom: `1px solid ${T.border}`,
      display: 'flex', alignItems: 'center', gap: 10,
      background: T.bg,
    }}>
      <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: -0.4 }}>Ahora</div>

      {chips.slice(0, 1).map((c, i) => (
        <div key={i} style={{
          marginLeft: 6, padding: '3px 10px', borderRadius: 999,
          background: c.tone === 'success' ? T.successBg : T.bgAlt,
          color: c.tone === 'success' ? T.success : T.text,
          fontSize: 11.5, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {c.tone === 'success' && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.success }} />
          )}
          {c.text}
        </div>
      ))}

      <div style={{ flex: 1 }} />

      {chips.slice(1).map((c, i) => (
        <div key={i} style={{ padding: '5px 11px', fontSize: 12, color: T.textDim }}>
          {c.text}
        </div>
      ))}

      <div style={{ width: 1, height: 20, background: T.border, margin: '0 6px' }} />

      <div style={{
        padding: '6px 12px', borderRadius: 8, background: T.panel,
        boxShadow: T.shadow, display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12.5, color: T.text,
      }}>
        <span style={{ color: T.textDim }}>◆</span>{provider}
        <span style={{ color: T.textFaint, fontSize: 10 }}>▾</span>
      </div>

      <div style={{
        width: 32, height: 32, borderRadius: '50%', background: T.bgAlt,
        display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 500,
      }}>J</div>
    </div>
  );
}

function AhoraHeader({
  header, onStartNew, onOpenProject,
}: { header: AhoraScenario['header']; onStartNew?: () => void; onOpenProject?: () => void }) {
  return (
    <div style={{
      padding: '26px 28px 20px',
      borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'nowrap', minWidth: 0 }}>
        <div style={{ fontSize: 26, letterSpacing: -0.8, fontWeight: 500, color: T.text, whiteSpace: 'nowrap' }}>
          {header.title}
        </div>
        <div style={{
          padding: '3px 10px', borderRadius: 6, background: T.panel,
          boxShadow: T.shadow, color: T.textDim, fontSize: 12, whiteSpace: 'nowrap',
        }}>{header.badge}</div>

        <div style={{
          color: T.textFaint, fontSize: 13,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
        }}>{header.meta}</div>
        <div style={{ flex: 1, minWidth: 8 }} />

        <button style={btnSecondary} onClick={onStartNew}>+ Nuevo</button>
        <button style={btnPrimary} onClick={onOpenProject}>Ver trabajo →</button>
      </div>
      <div style={{ color: T.textDim, fontSize: 13.5, maxWidth: 780 }}>
        {header.sub}
      </div>
    </div>
  );
}

function DesignApprovalBanner({
  mockupCount, approving, onOpenDesign, onApprove, onReject,
}: {
  mockupCount: number;
  approving: boolean;
  onOpenDesign: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div style={{
      margin: '14px 28px 0',
      padding: '16px 20px', borderRadius: 12,
      background: 'oklch(96% 0.06 75)', border: '1px solid oklch(80% 0.13 75)',
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 16, alignItems: 'center',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 9,
        background: 'oklch(85% 0.12 75)', color: '#5a3a00',
        display: 'grid', placeItems: 'center', fontSize: 18,
      }}>⚠</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#3a2400', marginBottom: 2 }}>
          Don Cheli necesita tu aprobación del diseño
        </div>
        <div style={{ fontSize: 12.5, color: '#5a3a00', lineHeight: 1.5 }}>
          El pipeline está pausado esperando que revises los <strong>{mockupCount} mockups</strong> generados.
          Abre los mockups antes de aprobar — el resto del trabajo (construir, revisar) depende de este diseño.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <button
          onClick={onOpenDesign}
          style={{
            padding: '9px 14px', borderRadius: 8,
            background: '#fff', border: '1px solid oklch(80% 0.13 75)',
            color: '#3a2400', fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >Ver mockups →</button>
        <button
          onClick={onReject}
          disabled={approving}
          style={{
            padding: '9px 14px', borderRadius: 8, background: '#fff',
            border: '1px solid oklch(85% 0.10 25)', color: 'oklch(50% 0.18 25)',
            fontSize: 12.5, fontFamily: 'inherit', cursor: approving ? 'not-allowed' : 'pointer',
            opacity: approving ? 0.5 : 1,
          }}
        >Rechazar</button>
        <button
          onClick={onApprove}
          disabled={approving}
          style={{
            padding: '9px 16px', borderRadius: 8, background: T.success,
            color: '#fff', border: 'none', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            cursor: approving ? 'not-allowed' : 'pointer',
            opacity: approving ? 0.5 : 1,
          }}
        >{approving ? 'Aprobando…' : '✓ Aprobar diseño'}</button>
      </div>
    </div>
  );
}

const btnSecondary: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 8, background: T.panel,
  boxShadow: T.shadow, border: 'none', fontSize: 12.5, color: T.text,
  cursor: 'pointer', fontFamily: 'inherit',
};
const btnPrimary: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 8, background: T.ink,
  color: '#fff', border: 'none', fontSize: 12.5, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit',
};

function Metrics({ metrics }: { metrics: AhoraScenario['metrics'] }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14,
    }}>
      {metrics.map((m) => (
        <div key={m.label} style={{
          background: T.panel, borderRadius: 12, boxShadow: T.shadow,
          padding: '16px 18px',
        }}>
          <div style={{ color: T.textFaint, fontSize: 11.5, fontWeight: 500, marginBottom: 6 }}>
            {m.label}
          </div>
          <div style={{
            color: T.text, fontSize: 26, fontWeight: 500, letterSpacing: -0.5,
            fontFamily: m.mono ? T.fontMono : T.fontSans,
            fontVariantNumeric: 'tabular-nums',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            {m.dot && (
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: T.success,
                boxShadow: `0 0 0 4px ${T.successBg}`,
              }} />
            )}
            {m.value}
          </div>
          <div style={{ color: T.textDim, fontSize: 12.5, marginTop: 4 }}>{m.sub}</div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ steps }: { steps: AhoraStep[] }) {
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const activeIdx = steps.findIndex((s) => s.status === 'active');
  const totalPct = activeIdx === -1
    ? (doneCount / steps.length) * 100
    : ((doneCount + (steps[activeIdx].progress / 100)) / steps.length) * 100;

  return (
    <div style={{
      marginTop: 18,
      padding: '22px 24px',
      background: T.panel, borderRadius: 14, boxShadow: T.shadow,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ color: T.text, fontSize: 15, fontWeight: 500, letterSpacing: -0.2 }}>
            Los 7 pasos del trabajo
          </div>
          <div style={{ color: T.textDim, fontSize: 12.5, marginTop: 2 }}>
            {activeIdx === -1
              ? `Los ${steps.length} pasos terminados`
              : `${doneCount} terminados · 1 en marcha · ${steps.length - doneCount - 1} por delante`}
          </div>
        </div>
        <div style={{
          fontSize: 12, color: T.textDim,
          fontFamily: T.fontMono, fontVariantNumeric: 'tabular-nums',
        }}>
          {Math.round(totalPct)}%
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, 1fr)`, gap: 10 }}>
        {steps.map((s, i) => {
          const done = s.status === 'done';
          const active = s.status === 'active';
          return (
            <div key={s.id}>
              <div style={{
                height: 4, borderRadius: 999,
                background: done ? T.ink : T.bgAlt,
                position: 'relative', marginBottom: 14, overflow: 'hidden',
              }}>
                {active && (
                  <div style={{
                    position: 'absolute', top: 0, left: 0, height: '100%',
                    width: `${s.progress}%`, background: T.ink, borderRadius: 999,
                  }} />
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: done ? T.ink : (active ? '#fff' : T.bgAlt),
                  border: active ? `1.5px solid ${T.ink}` : 'none',
                  color: done ? '#fff' : (active ? T.ink : T.textFaint),
                  fontSize: 10, fontWeight: 600,
                  display: 'grid', placeItems: 'center',
                }}>{done ? '✓' : i + 1}</span>
                <span style={{
                  fontSize: 13, color: T.text,
                  fontWeight: active ? 600 : (done ? 500 : 400), letterSpacing: -0.1,
                }}>{s.label}</span>
              </div>
              <div style={{
                fontSize: 11.5, color: T.textDim,
                fontFamily: T.fontMono, fontVariantNumeric: 'tabular-nums',
                marginLeft: 26,
              }}>
                {s.dur === '—' ? '—' : `${s.dur} · ${s.cost}`}
              </div>
              {active && (
                <div style={{
                  marginTop: 8, marginLeft: 26, padding: '3px 8px', borderRadius: 4,
                  background: T.successBg, color: T.success,
                  fontSize: 10.5, fontWeight: 500, letterSpacing: 0.2, display: 'inline-block',
                }}>AHORA</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LogPanel({ log }: { log: AhoraLog[] }) {
  const [filter, setFilter] = useState<'all' | 'think' | 'warn'>('all');
  const filtered = log.filter((e) => filter === 'all' ? true : e.kind === filter);

  return (
    <div style={{
      flex: 1.5, minWidth: 0,
      background: T.panel, borderRadius: 14, boxShadow: T.shadow,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        padding: '16px 20px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: -0.1 }}>Qué está haciendo ahora</div>
          <div style={{ color: T.textDim, fontSize: 12, marginTop: 1 }}>
            Se actualiza solo · pausa al pasar el mouse
          </div>
        </div>
        <div style={{ display: 'flex', gap: 3, fontSize: 11.5, background: T.bgAlt, padding: 3, borderRadius: 7 }}>
          {(['all', 'think', 'warn'] as const).map((f) => (
            <span key={f} onClick={() => setFilter(f)} style={{
              padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
              background: filter === f ? T.panel : 'transparent',
              color: filter === f ? T.text : T.textDim,
              boxShadow: filter === f ? T.shadow : 'none',
              fontWeight: filter === f ? 500 : 400,
            }}>
              {f === 'all' ? 'Todo' : f === 'think' ? 'Pensando' : 'Avisos'}
            </span>
          ))}
        </div>
      </div>
      <div style={{
        padding: '6px 20px 16px',
        fontSize: 12.5, lineHeight: 1.7,
        maxHeight: 420, overflow: 'auto',
      }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '20px 0', color: T.textFaint, textAlign: 'center', fontSize: 12 }}>
            Sin eventos para mostrar
          </div>
        ) : filtered.map((e, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '70px 18px 1fr', gap: 10,
            padding: '5px 0',
            borderBottom: i < filtered.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
          }}>
            <span style={{
              color: T.textFaint, fontFamily: T.fontMono,
              fontSize: 11, fontVariantNumeric: 'tabular-nums', paddingTop: 2,
            }}>{e.t}</span>
            <LogBadge kind={e.kind} />
            <span style={{
              color: e.kind === 'think' ? T.textDim : T.text,
              fontStyle: e.kind === 'think' ? 'italic' : 'normal',
            }}>{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogBadge({ kind }: { kind: LogKind }) {
  const bg: Record<LogKind, string> = {
    info: T.bgAlt, think: 'oklch(95% 0.04 290)',
    warn: T.warnBg, done: T.successBg, error: 'oklch(93% 0.06 25)',
  };
  const fg: Record<LogKind, string> = {
    info: T.textDim, think: 'oklch(50% 0.15 290)',
    warn: T.warn, done: T.success, error: 'oklch(55% 0.18 25)',
  };
  const glyph: Record<LogKind, string> = {
    info: 'i', think: '~', warn: '!', done: '✓', error: '×',
  };
  return (
    <span style={{
      width: 14, height: 14, borderRadius: 4, marginTop: 3,
      background: bg[kind], color: fg[kind],
      fontSize: 9.5, fontWeight: 600,
      display: 'grid', placeItems: 'center',
    }}>{glyph[kind]}</span>
  );
}

function GatesPanel({ gates }: { gates: AhoraGate[] }) {
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: T.panel, borderRadius: 14, boxShadow: T.shadow,
      padding: 20,
    }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: -0.1 }}>Controles de calidad</div>
        <div style={{ color: T.textDim, fontSize: 12, marginTop: 1 }}>
          Tres revisiones automáticas antes de cerrar
        </div>
      </div>

      {gates.map((g, i) => {
        const active = g.state === 'active';
        const passed = g.state === 'passed';
        const bg = active ? T.successBg : (passed ? T.successBg : T.bgAlt);
        const border = (active || passed) ? '1px solid oklch(90% 0.06 155)' : '1px solid transparent';
        return (
          <div key={g.id} style={{
            padding: 14, borderRadius: 10, marginBottom: 8,
            background: bg, border,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%',
                background: (active || passed) ? T.success : '#fff',
                border: (active || passed) ? 'none' : `1px solid ${T.border}`,
                display: 'grid', placeItems: 'center',
                fontSize: 10, color: (active || passed) ? '#fff' : T.textFaint, fontWeight: 600,
              }}>{passed ? '✓' : (active ? '●' : i + 1)}</span>
              <span style={{ fontSize: 13.5, fontWeight: (active || passed) ? 600 : 500 }}>{g.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{
                fontSize: 10.5, fontWeight: 500, letterSpacing: 0.3,
                color: (active || passed) ? T.success : T.textFaint,
                textTransform: 'uppercase',
              }}>{passed ? 'Pasó' : (active ? 'Revisando' : 'En espera')}</span>
            </div>
            <div style={{ color: T.textDim, fontSize: 12, marginTop: 6, paddingLeft: 30 }}>
              {g.hint}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────── Data derivation helpers ───────────

function deriveGates(
  steps: AhoraStep[],
  designApproval: { status: string; mockupCount: number } | null,
): AhoraGate[] {
  if (steps.length === 0) return MOCK_ACTIVE.gates;
  // The runtime tracks 6 phases in state.json; `design` runs out-of-band and
  // its status lives in approval.json, not in state.json. So we read approval
  // directly from the design endpoint (passed in here from the dashboard).
  const implementStep = steps.find((s) => s.id === 'implement');
  const reviewStep = steps.find((s) => s.id === 'review');

  let designState: GateState = 'waiting';
  let designHint = 'Pendiente';
  if (designApproval && designApproval.mockupCount > 0) {
    switch (designApproval.status) {
      case 'approved':
        designState = 'passed';
        designHint = `Aprobado · ${designApproval.mockupCount} mockups`;
        break;
      case 'rejected':
        designState = 'waiting';
        designHint = 'Rechazado — regenera o pide cambios';
        break;
      case 'in_review':
      case 'pending':
      default:
        designState = 'active';
        designHint = `Esperando tu revisión · ${designApproval.mockupCount} mockups listos`;
        break;
    }
  }

  return [
    {
      id: 'tests',
      label: 'Tests',
      state: implementStep?.status === 'done' ? 'passed' : implementStep?.status === 'active' ? 'active' : 'waiting',
      hint: 'Se corren durante "Construir"',
    },
    {
      id: 'design',
      label: 'Diseño aprobado',
      state: designState,
      hint: designHint,
    },
    {
      id: 'final',
      label: 'Aprobación final',
      state: reviewStep?.status === 'done' ? 'passed' : reviewStep?.status === 'active' ? 'active' : 'waiting',
      hint: 'Se hace en "Revisar"',
    },
  ];
}

interface HookEntryShape {
  provider: string;
  event: string;
  summary: string;
  timestamp: string;
}

interface LogEntryShape {
  line: string;
  timestamp: string;
  stream?: string;
}

function hooksToLog(hooks: HookEntryShape[], logs: LogEntryShape[]): AhoraLog[] {
  const fromHooks: AhoraLog[] = hooks.slice(-15).map((h) => ({
    t: formatTime(h.timestamp),
    kind: hookKind(h.event),
    text: h.summary || `[${h.provider}] ${h.event}`,
  }));

  const fromLogs: AhoraLog[] = logs.slice(-10).map((l) => ({
    t: formatTime(l.timestamp),
    kind: l.stream === 'stderr' ? 'error' : 'info',
    text: l.line,
  }));

  const merged = [...fromHooks, ...fromLogs].sort((a, b) => b.t.localeCompare(a.t));
  return merged.length > 0 ? merged : MOCK_ACTIVE.log;
}

function hookKind(event: string): LogKind {
  if (event.toLowerCase().includes('error')) return 'error';
  if (event.includes('Stop') || event.includes('end')) return 'done';
  if (event.toLowerCase().includes('warn') || event.toLowerCase().includes('notification')) return 'warn';
  if (event.includes('Prompt') || event.includes('think')) return 'think';
  return 'info';
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso.slice(11, 19); }
}

function prettyProvider(p: string): string {
  switch (p.toLowerCase()) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'opencode': return 'OpenCode';
    case 'gemini': return 'Gemini';
    default: return p.charAt(0).toUpperCase() + p.slice(1);
  }
}

// ─────────── Layer 3: runtime questions banner + modal ───────────

function QuestionsPendingBanner({
  questions, onOpen,
}: {
  questions: QuestionWithAnswer[];
  onOpen: () => void;
}) {
  const blocking = questions.filter((q) => q.urgency === 'blocking').length;
  const total = questions.length;
  return (
    <div style={{
      margin: '14px 28px 0',
      padding: '14px 18px', borderRadius: 12,
      background: 'oklch(96% 0.05 290)',
      border: '1px solid oklch(80% 0.13 290)',
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 16, alignItems: 'center',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: 'oklch(85% 0.13 290)', color: 'oklch(35% 0.20 290)',
        display: 'grid', placeItems: 'center',
      }}>
        <MessageCircleQuestion size={16} strokeWidth={1.8} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(25% 0.17 290)', marginBottom: 2 }}>
          Don Cheli te está preguntando algo
        </div>
        <div style={{ fontSize: 12, color: 'oklch(40% 0.12 290)', lineHeight: 1.5 }}>
          {blocking > 0
            ? `${blocking} pregunta${blocking === 1 ? '' : 's'} bloquea${blocking === 1 ? '' : 'n'} el pipeline${total > blocking ? ` (+${total - blocking} informativas)` : ''}. Responde para que continúe.`
            : `${total} pregunta${total === 1 ? '' : 's'} informativa${total === 1 ? '' : 's'} — el pipeline sigue corriendo en paralelo.`}
        </div>
      </div>
      <button onClick={onOpen} style={{
        padding: '9px 16px', borderRadius: 8,
        background: 'oklch(40% 0.20 290)', color: '#fff', border: 'none',
        fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}>
        Responder ahora →
      </button>
    </div>
  );
}

function QuestionsModal({
  projectId, questions, onClose, onAnswered,
}: {
  projectId: string;
  questions: QuestionWithAnswer[];
  onClose: () => void;
  onAnswered: () => void;
}) {
  // local state: id → text answer (or option selected)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) {
      if (q.default) init[q.id] = q.default;
      else if (q.kind === 'boolean') init[q.id] = '';
      else if (q.kind === 'choice' && q.options.length > 0) init[q.id] = q.options[0];
    }
    return init;
  });
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [submittedIds, setSubmittedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submitOne = async (q: QuestionWithAnswer, skipped: boolean) => {
    setBusyIds((p) => new Set([...p, q.id]));
    setError(null);
    try {
      const answer = skipped ? '' : (drafts[q.id] ?? '').trim();
      if (!skipped && answer.length === 0) {
        setError(`La pregunta "${q.question.slice(0, 40)}…" requiere una respuesta`);
        setBusyIds((p) => { const n = new Set(p); n.delete(q.id); return n; });
        return;
      }
      await api.questions.answer(projectId, q.id, answer, { skipped });
      setSubmittedIds((p) => new Set([...p, q.id]));
      onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo enviar');
    } finally {
      setBusyIds((p) => { const n = new Set(p); n.delete(q.id); return n; });
    }
  };

  const allDone = questions.every((q) => submittedIds.has(q.id));

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(15,17,20,0.55)',
      display: 'grid', placeItems: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.panel, borderRadius: 14, padding: '22px 26px',
        maxWidth: 720, width: '100%', maxHeight: '85vh', overflow: 'auto',
        boxShadow: T.shadowLg,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
              {questions.length === 1 ? 'Don Cheli te preguntó algo' : `${questions.length} preguntas de Don Cheli`}
            </div>
            <div style={{ fontSize: 12.5, color: T.textDim, maxWidth: 540, lineHeight: 1.5 }}>
              El pipeline está bloqueado esperando tu respuesta. Cuanto antes contestes, antes continúa.
            </div>
          </div>
          <button onClick={onClose} style={{
            padding: 6, background: 'transparent', border: 'none',
            cursor: 'pointer', color: T.textFaint, display: 'inline-flex',
          }}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              index={i + 1}
              total={questions.length}
              q={q}
              draft={drafts[q.id] ?? ''}
              onDraft={(v) => setDrafts((d) => ({ ...d, [q.id]: v }))}
              busy={busyIds.has(q.id)}
              submitted={submittedIds.has(q.id)}
              onSubmit={() => submitOne(q, false)}
              onSkip={() => submitOne(q, true)}
            />
          ))}
        </div>

        {error && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)', fontSize: 12.5,
          }}>{error}</div>
        )}

        <div style={{
          marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 12, color: T.textFaint }}>
            {submittedIds.size}/{questions.length} respondidas
          </span>
          <button onClick={onClose} style={{
            padding: '8px 14px', borderRadius: 8,
            background: allDone ? T.success : T.panel,
            color: allDone ? '#fff' : T.text,
            boxShadow: allDone ? 'none' : T.shadow,
            border: 'none', fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
            cursor: 'pointer',
          }}>{allDone ? '✓ Listo, cerrar' : 'Cerrar'}</button>
        </div>
      </div>
    </div>
  );
}

function QuestionCard({
  index, total, q, draft, onDraft, busy, submitted, onSubmit, onSkip,
}: {
  index: number;
  total: number;
  q: QuestionWithAnswer;
  draft: string;
  onDraft: (v: string) => void;
  busy: boolean;
  submitted: boolean;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  return (
    <div style={{
      background: submitted ? T.successBg : T.bgAlt,
      borderRadius: 10, padding: '14px 16px',
      border: submitted ? `1px solid ${T.success}` : '1px solid transparent',
      transition: 'background .15s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 11, fontFamily: T.fontMono, color: T.textFaint,
          padding: '1px 6px', background: T.panel, borderRadius: 4,
        }}>{index}/{total}</span>
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 3,
          background: q.urgency === 'blocking' ? 'oklch(96% 0.06 25)' : T.panel,
          color: q.urgency === 'blocking' ? 'oklch(50% 0.18 25)' : T.textDim,
          fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          {q.urgency === 'blocking' ? '🛑 Bloqueante' : '💬 Informativa'}
        </span>
        {q.phase && (
          <span style={{ fontSize: 10.5, color: T.textFaint }}>· fase: {q.phase}</span>
        )}
        {submitted && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: T.success, fontSize: 12, fontWeight: 500 }}>
            <Check size={13} strokeWidth={2.5} /> Enviada
          </span>
        )}
      </div>

      <div style={{ fontSize: 14, fontWeight: 500, color: T.text, marginBottom: 6, lineHeight: 1.5 }}>
        {q.question}
      </div>

      {q.context && (
        <div style={{
          fontSize: 11.5, color: T.textDim, marginBottom: 10, lineHeight: 1.55,
          fontStyle: 'italic',
        }}>
          {q.context}
        </div>
      )}

      {!submitted && (
        <>
          {q.kind === 'text' && (
            <textarea
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              placeholder={q.default ?? 'Escribe tu respuesta…'}
              rows={3}
              style={{
                width: '100%', padding: '8px 12px', borderRadius: 7,
                border: `1px solid ${T.border}`, background: T.panel,
                fontFamily: 'inherit', fontSize: 12.5, color: T.text,
                resize: 'vertical', outline: 'none',
              }}
            />
          )}

          {q.kind === 'choice' && q.options.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.options.map((opt) => (
                <label key={opt} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px', borderRadius: 7,
                  background: draft === opt ? T.successBg : T.panel,
                  border: `1px solid ${draft === opt ? T.success : T.border}`,
                  cursor: 'pointer', fontSize: 12.5,
                }}>
                  <input
                    type="radio"
                    name={q.id}
                    value={opt}
                    checked={draft === opt}
                    onChange={() => onDraft(opt)}
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          )}

          {q.kind === 'boolean' && (
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { value: 'yes', label: 'Sí' },
                { value: 'no', label: 'No' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onDraft(opt.value)}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 7,
                    background: draft === opt.value ? T.success : T.panel,
                    color: draft === opt.value ? '#fff' : T.text,
                    border: `1px solid ${draft === opt.value ? T.success : T.border}`,
                    fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}
                >{opt.label}</button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            {q.urgency === 'informative' && (
              <button onClick={onSkip} disabled={busy} style={{
                padding: '7px 14px', borderRadius: 7,
                background: 'transparent', border: 'none',
                cursor: busy ? 'not-allowed' : 'pointer',
                fontSize: 12, color: T.textDim, fontFamily: 'inherit',
              }}>Omitir</button>
            )}
            <button
              onClick={onSubmit}
              disabled={busy || (draft.trim().length === 0)}
              style={{
                padding: '7px 16px', borderRadius: 7,
                background: (busy || draft.trim().length === 0) ? T.bgAlt : T.ink,
                color: (busy || draft.trim().length === 0) ? T.textFaint : '#fff',
                border: 'none', cursor: (busy || draft.trim().length === 0) ? 'not-allowed' : 'pointer',
                fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
              }}
            >{busy ? 'Enviando…' : 'Responder'}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────── Layer 2: services pending banner + modal ───────────

function ServicesPendingBanner({
  services, onOpen,
}: {
  services: ServiceSpec[];
  onOpen: () => void;
}) {
  const totalKeys = services.reduce((s, svc) => s + svc.env_keys.length, 0);
  return (
    <div style={{
      margin: '14px 28px 0',
      padding: '14px 18px', borderRadius: 12,
      background: 'oklch(96% 0.04 240)',
      border: '1px solid oklch(80% 0.10 240)',
      display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 16, alignItems: 'center',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: 'oklch(85% 0.10 240)', color: 'oklch(35% 0.18 240)',
        display: 'grid', placeItems: 'center',
      }}>
        <KeyRound size={16} strokeWidth={1.8} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(25% 0.15 240)', marginBottom: 2 }}>
          Don Cheli detectó {services.length} servicio{services.length === 1 ? '' : 's'} sin configurar
        </div>
        <div style={{ fontSize: 12, color: 'oklch(40% 0.10 240)', lineHeight: 1.5 }}>
          {services.map((s) => s.name).join(' · ')} —
          {' '}configura las {totalKeys} API key{totalKeys === 1 ? '' : 's'} ahora para que la fase{' '}
          <strong>Construir</strong> use valores reales y no placeholders.
        </div>
      </div>
      <button onClick={onOpen} style={{
        padding: '9px 16px', borderRadius: 8,
        background: 'oklch(40% 0.18 240)', color: '#fff', border: 'none',
        fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}>
        ⚙ Configurar ahora
      </button>
    </div>
  );
}

function ConfigureServicesModal({
  projectId, services, onClose, onSaved,
}: {
  projectId: string;
  services: ServiceSpec[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalKeys = services.reduce((s, svc) => s + svc.env_keys.length, 0);
  const filledCount = Object.values(values).filter((v) => v.trim().length > 0).length;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleaned: Record<string, string> = {};
      for (const v of Object.entries(values)) {
        if (v[1].trim().length > 0) cleaned[v[0]] = v[1].trim();
      }
      if (Object.keys(cleaned).length === 0) {
        setError('Llena al menos una key antes de guardar');
        setSaving(false);
        return;
      }
      const res = await api.preview.writeEnv(projectId, cleaned);
      setSavedToast(`✓ ${res.written_keys.length} key${res.written_keys.length === 1 ? '' : 's'} guardadas`);
      setValues({});
      onSaved();
      window.setTimeout(() => onClose(), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(15,17,20,0.55)',
      display: 'grid', placeItems: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.panel, borderRadius: 14, padding: '20px 24px',
        maxWidth: 720, width: '100%', maxHeight: '85vh', overflow: 'auto',
        boxShadow: T.shadowLg,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
              Configurar API keys
            </div>
            <div style={{ fontSize: 12.5, color: T.textDim, maxWidth: 540, lineHeight: 1.5 }}>
              Llena los valores que tengas. Don Cheli guarda lo que llenes en{' '}
              <code style={{ fontFamily: T.fontMono, fontSize: 11, background: T.bgAlt, padding: '1px 5px', borderRadius: 3 }}>.env.local</code> de la app.
              Lo que dejes vacío se queda como placeholder para llenarlo después.
            </div>
          </div>
          <button onClick={onClose} style={{
            padding: 6, background: 'transparent', border: 'none',
            cursor: 'pointer', color: T.textFaint, display: 'inline-flex',
          }}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {services.map((svc) => (
            <div key={svc.id} style={{
              background: T.bgAlt, borderRadius: 10, padding: '14px 16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 7,
                  background: T.panel, display: 'grid', placeItems: 'center',
                  fontFamily: T.fontMono, fontSize: 12, fontWeight: 600, color: T.text,
                }}>{svc.name.charAt(0)}</div>
                <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>{svc.name}</span>
                <span style={{ fontSize: 11, color: T.textFaint }}>· {svc.category}</span>
                <div style={{ flex: 1 }} />
                <a href={svc.dashboard_url} target="_blank" rel="noreferrer" style={{
                  fontSize: 11, color: T.textDim, textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 5, background: T.panel,
                }}><ExternalLink size={10} /> Dashboard</a>
                <a href={svc.docs_url} target="_blank" rel="noreferrer" style={{
                  fontSize: 11, color: T.textDim, textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 5, background: T.panel,
                }}><BookOpen size={10} /> Docs</a>
              </div>

              {svc.instructions.length > 0 && (
                <details style={{ marginBottom: 10 }}>
                  <summary style={{
                    fontSize: 11.5, color: T.textDim, cursor: 'pointer',
                    fontWeight: 500, listStyle: 'none', userSelect: 'none',
                  }}>📖 Cómo obtenerlas paso a paso</summary>
                  <ol style={{ fontSize: 11.5, color: T.textDim, paddingLeft: 18, lineHeight: 1.6, marginTop: 6 }}>
                    {svc.instructions.map((s, i) => (
                      <li key={i}>{s.replace(/^\d+\.\s*/, '')}</li>
                    ))}
                  </ol>
                </details>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {svc.env_keys.map((k) => (
                  <div key={k.name}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <code style={{ fontFamily: T.fontMono, fontSize: 11.5, fontWeight: 600, color: T.text }}>
                        {k.name}
                      </code>
                      <span style={{
                        fontSize: 9.5, padding: '1px 5px', borderRadius: 3,
                        background: k.kind === 'public' ? T.panel : 'oklch(96% 0.06 25)',
                        color: k.kind === 'public' ? T.textDim : 'oklch(50% 0.18 25)',
                        textTransform: 'uppercase', letterSpacing: 0.3, fontWeight: 600,
                      }}>{k.kind}</span>
                    </div>
                    <input
                      type={k.kind === 'secret' ? 'password' : 'text'}
                      value={values[k.name] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [k.name]: e.target.value }))}
                      placeholder={k.example_prefix ?? 'Pega aquí tu valor'}
                      style={{
                        width: '100%', padding: '8px 12px', borderRadius: 7,
                        border: `1px solid ${T.border}`, background: T.panel,
                        fontFamily: T.fontMono, fontSize: 12, color: T.text,
                        outline: 'none',
                      }}
                    />
                    {k.description && (
                      <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 3, lineHeight: 1.45 }}>
                        {k.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {error && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)', fontSize: 12.5,
          }}>{error}</div>
        )}
        {savedToast && (
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: T.successBg, color: T.success, fontSize: 12.5,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}><Check size={13} /> {savedToast}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{
            padding: '10px 16px', borderRadius: 8, background: 'transparent',
            border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
            fontSize: 13, color: T.textDim, fontFamily: 'inherit',
          }}>Cancelar</button>
          <button
            onClick={handleSave}
            disabled={saving || filledCount === 0}
            style={{
              padding: '10px 18px', borderRadius: 8,
              background: filledCount === 0 || saving ? T.bgAlt : T.ink,
              color: filledCount === 0 || saving ? T.textFaint : '#fff',
              border: 'none', cursor: filledCount === 0 || saving ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            }}
          >
            {saving ? 'Guardando…' : `Guardar ${filledCount}/${totalKeys} keys`}
          </button>
        </div>
      </div>
    </div>
  );
}
