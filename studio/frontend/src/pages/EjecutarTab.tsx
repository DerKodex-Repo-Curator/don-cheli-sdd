import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Square, ExternalLink, Copy, Check, Terminal,
  FolderOpen, KeyRound, Sparkles, BookOpen,
  ChevronRight, ChevronDown,
} from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioButton, StudioPill, type PillTone } from '../components/StudioShell';
import {
  api, type PreviewInfo, type PreviewStatus, type ServiceSpec,
} from '../lib/api';

interface Props {
  projectId: string;
  projectName: string;
}

interface LogLine { line: string; stream: 'stdout' | 'stderr' }

// ─────────── Top-level component (wizard router) ───────────

export function EjecutarTab({ projectId, projectName }: Props) {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [i, s] = await Promise.all([
        api.preview.info(projectId),
        api.preview.status(projectId),
      ]);
      setInfo(i);
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Live preview logs via WS
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/${projectId}`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'preview_log' && msg.data?.project_id === projectId) {
          setLogs((prev) => [...prev, {
            line: msg.data.line as string,
            stream: (msg.data.stream as 'stdout'|'stderr') ?? 'stdout',
          }].slice(-300));
          if (msg.data.url) setStatus((s) => s ? { ...s, url: msg.data.url } : s);
        } else if (msg.type === 'preview_stopped' && msg.data?.project_id === projectId) {
          setStatus({ running: false, url: null, started_at: null, last_line: null, error: null });
        }
      } catch { /* ignore */ }
    };
    return () => { ws.close(); };
  }, [projectId]);

  const handleStart = async (withInstall: boolean) => {
    setStarting(true); setError(null); setLogs([]);
    try {
      const s = await api.preview.start(projectId, withInstall);
      setStatus(s);
      if (s.error) setError(s.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar');
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    try { setStatus(await api.preview.stop(projectId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo detener'); }
  };

  // ── Hooks must run unconditionally BEFORE any early return (Rules of Hooks). ──
  const allKeysFilled = useMemo(() => {
    if (!info) return false;
    const required = info.services.flatMap((s) => s.env_keys.map((k) => k.name));
    if (required.length === 0) return true;
    return required.every((n) => info.env_keys_filled.includes(n));
  }, [info]);

  if (loading) {
    return <div style={{ padding: 40, color: T.textDim, fontSize: 13 }}>Detectando…</div>;
  }
  if (!info) {
    return <div style={{ padding: 40, color: T.textDim }}>No se pudo cargar la información.</div>;
  }

  // ── Decide which step of the wizard to show ──
  const running = status?.running ?? false;

  const step: 'not-detected' | 'configure' | 'ready' | 'running' =
    !info.detected ? 'not-detected'
    : running ? 'running'
    : !allKeysFilled && info.services.length > 0 ? 'configure'
    : 'ready';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <WizardHeader step={step} info={info} projectName={projectName} url={status?.url ?? null} />

      {step === 'not-detected' && (
        <NotDetectedState onRefresh={refresh} />
      )}

      {step === 'configure' && (
        <ConfigureServicesStep
          info={info}
          projectId={projectId}
          onSaved={refresh}
        />
      )}

      {step === 'ready' && (
        <ReadyToRunStep
          info={info}
          starting={starting}
          onStart={handleStart}
        />
      )}

      {step === 'running' && (
        <RunningStep
          info={info}
          status={status!}
          logs={logs}
          onStop={handleStop}
        />
      )}

      {/* Always-visible: terminal commands fallback */}
      {info.detected && (
        <CommandsCard info={info} />
      )}

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)',
          fontSize: 12.5,
        }}>{error}</div>
      )}
    </div>
  );
}

// ─────────── Wizard header ───────────

function WizardHeader({
  step, info, projectName, url,
}: {
  step: 'not-detected' | 'configure' | 'ready' | 'running';
  info: PreviewInfo;
  projectName: string;
  url: string | null;
}) {
  const stepLabels = {
    'not-detected': { tone: 'pending' as PillTone, label: 'Esperando código' },
    'configure': { tone: 'warn' as PillTone, label: 'Configurar servicios' },
    'ready': { tone: 'neutral' as PillTone, label: 'Listo para probar' },
    'running': { tone: 'active' as PillTone, label: 'Corriendo' },
  };
  const cur = stepLabels[step];

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '18px 20px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: T.text }}>
          {info.detected ? `${info.framework} · ${projectName}` : 'Esperando que termine el run'}
        </span>
        <StudioPill tone={cur.tone} dot={step === 'running'}>{cur.label}</StudioPill>
      </div>
      <Stepper step={step} />
      {step === 'running' && url && (
        <div style={{
          marginTop: 14, padding: '10px 14px',
          background: T.successBg, borderRadius: 10,
          display: 'flex', alignItems: 'center', gap: 12,
          border: `1px solid ${T.success}`,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', background: T.success,
            animation: 'studioPulse 1.8s ease-in-out infinite',
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: T.text, fontWeight: 500 }}>
              La app está corriendo en
            </div>
            <a href={url} target="_blank" rel="noreferrer" style={{
              fontSize: 13, fontFamily: T.fontMono, color: T.text,
              textDecoration: 'none', fontWeight: 600,
            }}>{url}</a>
          </div>
          <a href={url} target="_blank" rel="noreferrer" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8,
            background: T.ink, color: '#fff', textDecoration: 'none',
            fontSize: 13, fontWeight: 500,
          }}>
            Abrir app <ExternalLink size={13} strokeWidth={2} />
          </a>
        </div>
      )}
    </div>
  );
}

function Stepper({ step }: { step: 'not-detected' | 'configure' | 'ready' | 'running' }) {
  const steps: { id: string; label: string }[] = [
    { id: 'detect', label: 'Detectar app' },
    { id: 'configure', label: 'Configurar servicios' },
    { id: 'ready', label: 'Probar' },
    { id: 'running', label: 'Abrir' },
  ];
  const activeIdx =
    step === 'not-detected' ? -1 :
    step === 'configure' ? 1 :
    step === 'ready' ? 2 :
    step === 'running' ? 3 : 0;

  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 18, height: 18, borderRadius: '50%',
            background: i < activeIdx ? T.ink : i === activeIdx ? T.success : T.bgAlt,
            color: i <= activeIdx ? '#fff' : T.textFaint,
            fontSize: 10, fontWeight: 600,
            display: 'inline-grid', placeItems: 'center',
          }}>{i < activeIdx ? '✓' : i + 1}</span>
          <span style={{
            fontSize: 12, fontWeight: i === activeIdx ? 600 : 400,
            color: i <= activeIdx ? T.text : T.textDim,
          }}>{s.label}</span>
          {i < steps.length - 1 && (
            <ChevronRight size={12} color={T.textFaint} style={{ margin: '0 4px' }} />
          )}
        </span>
      ))}
    </div>
  );
}

// ─────────── Step: Not detected ───────────

function NotDetectedState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '32px 24px', textAlign: 'center',
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12, background: T.bgAlt,
        display: 'grid', placeItems: 'center', margin: '0 auto 12px',
        color: T.textDim,
      }}>
        <FolderOpen size={20} strokeWidth={1.8} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
        Don Cheli aún no ha generado la app
      </div>
      <div style={{ fontSize: 12.5, color: T.textDim, marginBottom: 16, maxWidth: 480, margin: '0 auto 16px' }}>
        Una vez que termine el pipeline (fase implement), esta pestaña detectará
        automáticamente el framework, los servicios externos y te guiará para configurar las API keys.
      </div>
      <StudioButton onClick={onRefresh}>↻ Revisar de nuevo</StudioButton>
    </div>
  );
}

// ─────────── Step: Configure services ───────────

function ConfigureServicesStep({
  info, projectId, onSaved,
}: {
  info: PreviewInfo;
  projectId: string;
  onSaved: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        background: T.warnBg, border: `1px solid ${T.warn}`, borderRadius: 12,
        padding: '14px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <KeyRound size={15} color={T.warn} strokeWidth={1.8} />
          <div style={{ fontSize: 14, fontWeight: 500, color: T.text }}>
            Tu app necesita configurar {info.services.length} servicio{info.services.length === 1 ? '' : 's'}
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55 }}>
          Cada tarjeta de abajo te dice cómo crear cuenta y obtener las API keys. Pega los valores
          y guarda — Don Cheli escribe el <code style={codeInline}>.env.local</code> por ti.
          Una vez listas todas las keys, puedes probar la app.
        </div>
      </div>

      {info.services.map((svc) => (
        <ServiceCard
          key={svc.id}
          svc={svc}
          filled={info.env_keys_filled}
          projectId={projectId}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

function ServiceCard({
  svc, filled, projectId, onSaved,
}: {
  svc: ServiceSpec;
  filled: string[];
  projectId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(() =>
    !svc.env_keys.every((k) => filled.includes(k.name))
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const allFilled = svc.env_keys.every((k) => filled.includes(k.name));
  const filledCount = svc.env_keys.filter((k) => filled.includes(k.name)).length;
  const hasNewInput = Object.values(values).some((v) => v.trim().length > 0);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const cleaned: Record<string, string> = {};
      for (const k of svc.env_keys) {
        const v = (values[k.name] ?? '').trim();
        if (v.length > 0) cleaned[k.name] = v;
      }
      await api.preview.writeEnv(projectId, cleaned);
      setValues({});
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      overflow: 'hidden',
    }}>
      {/* Header (always visible, clickable to expand) */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '16px 20px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 9,
          background: allFilled ? T.successBg : T.bgAlt,
          color: allFilled ? T.success : T.text,
          display: 'grid', placeItems: 'center',
          fontFamily: T.fontMono, fontSize: 13, fontWeight: 600,
        }}>
          {allFilled ? '✓' : svc.name.charAt(0)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{svc.name}</span>
            <span style={{ fontSize: 11, color: T.textFaint, fontWeight: 500 }}>· {svc.category}</span>
            {allFilled ? (
              <StudioPill tone="active" dot>Configurado</StudioPill>
            ) : (
              <StudioPill tone="warn">{filledCount}/{svc.env_keys.length} keys</StudioPill>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 2 }}>{svc.description}</div>
        </div>
        {open ? <ChevronDown size={16} color={T.textDim} /> : <ChevronRight size={16} color={T.textDim} />}
      </div>

      {/* Expanded body */}
      {open && (
        <div style={{ padding: '0 20px 20px', borderTop: `1px solid ${T.borderSoft}` }}>
          {/* Instructions */}
          <div style={{
            background: T.bgAlt, padding: '14px 16px', borderRadius: 10,
            marginTop: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <BookOpen size={13} color={T.textDim} strokeWidth={1.8} />
              <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Cómo obtener las keys
              </div>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, color: T.textDim, lineHeight: 1.7 }}>
              {svc.instructions.map((s, i) => <li key={i}>{s.replace(/^\d+\.\s*/, '')}</li>)}
            </ol>
            <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
              <a href={svc.dashboard_url} target="_blank" rel="noreferrer" style={extLink}>
                <ExternalLink size={11} /> Abrir dashboard
              </a>
              <a href={svc.docs_url} target="_blank" rel="noreferrer" style={extLink}>
                <BookOpen size={11} /> Documentación
              </a>
              <span style={{ fontSize: 11.5, color: T.textFaint }}>
                💰 {svc.free_tier}
              </span>
            </div>
          </div>

          {/* Inputs */}
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {svc.env_keys.map((k) => {
              const isFilled = filled.includes(k.name);
              return (
                <div key={k.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <code style={{ fontFamily: T.fontMono, fontSize: 11.5, fontWeight: 600, color: T.text }}>
                      {k.name}
                    </code>
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 4,
                      background: k.kind === 'public' ? T.bgAlt : 'oklch(96% 0.06 25)',
                      color: k.kind === 'public' ? T.textDim : 'oklch(50% 0.18 25)',
                      fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3,
                    }}>{k.kind === 'public' ? 'Public' : 'Secret'}</span>
                    {isFilled && (
                      <span style={{ fontSize: 10.5, color: T.success, fontWeight: 500 }}>
                        ✓ Guardada
                      </span>
                    )}
                  </div>
                  {k.description && (
                    <div style={{ fontSize: 11.5, color: T.textFaint, marginBottom: 5, lineHeight: 1.5 }}>
                      {k.description}
                    </div>
                  )}
                  <input
                    type={k.kind === 'secret' ? 'password' : 'text'}
                    value={values[k.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [k.name]: e.target.value }))}
                    placeholder={isFilled ? '(ya configurada — pega para sobreescribir)' : k.example_prefix ?? 'Pega aquí tu valor'}
                    style={{
                      width: '100%', padding: '9px 12px', borderRadius: 7,
                      border: `1px solid ${T.border}`, background: T.bg,
                      fontFamily: T.fontMono, fontSize: 12, color: T.text,
                      outline: 'none',
                    }}
                    onFocus={(ev) => (ev.currentTarget.style.borderColor = T.ink)}
                    onBlur={(ev) => (ev.currentTarget.style.borderColor = T.border)}
                  />
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            <button
              onClick={handleSave}
              disabled={!hasNewInput || saving}
              style={{
                padding: '8px 14px', borderRadius: 7,
                background: hasNewInput ? T.ink : T.bgAlt,
                color: hasNewInput ? '#fff' : T.textFaint,
                border: 'none', cursor: hasNewInput ? 'pointer' : 'not-allowed',
                fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
              }}
            >
              {saving ? 'Guardando…' : `Guardar keys de ${svc.name}`}
            </button>
            {saveError && (
              <span style={{ fontSize: 11.5, color: 'oklch(50% 0.18 25)' }}>{saveError}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────── Step: Ready to run ───────────

function ReadyToRunStep({
  info, starting, onStart,
}: {
  info: PreviewInfo;
  starting: boolean;
  onStart: (withInstall: boolean) => void;
}) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '24px 24px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 9, background: T.successBg,
          color: T.success, display: 'grid', placeItems: 'center',
        }}>
          <Check size={18} strokeWidth={2.5} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Todo listo para probar</div>
          <div style={{ fontSize: 12.5, color: T.textDim }}>
            {info.services.length > 0
              ? `${info.services.length} servicio${info.services.length === 1 ? '' : 's'} configurado${info.services.length === 1 ? '' : 's'}. Don Cheli va a instalar dependencias y levantar la app.`
              : 'No se detectaron servicios externos. Don Cheli va a instalar dependencias y levantar la app.'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button
          onClick={() => onStart(true)}
          disabled={starting}
          style={{
            padding: '12px 24px', borderRadius: 10, background: T.ink, color: '#fff',
            border: 'none', cursor: starting ? 'not-allowed' : 'pointer',
            fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
            opacity: starting ? 0.6 : 1,
            display: 'inline-flex', alignItems: 'center', gap: 10,
          }}
        >
          <Sparkles size={16} strokeWidth={2} />
          {starting ? 'Iniciando…' : 'Probar la app'}
        </button>
        <button
          onClick={() => onStart(false)}
          disabled={starting}
          style={{
            padding: '12px 18px', borderRadius: 10,
            background: T.panel, boxShadow: T.shadow,
            border: 'none', cursor: starting ? 'not-allowed' : 'pointer',
            fontSize: 13, color: T.text, fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}
        >
          <Play size={13} strokeWidth={2} />
          Solo ejecutar (sin instalar)
        </button>
      </div>

      <div style={{ marginTop: 14, fontSize: 11.5, color: T.textFaint, lineHeight: 1.6 }}>
        <strong style={{ color: T.textDim }}>Probar la app</strong> ejecuta{' '}
        <code style={codeInline}>{info.install_cmd}</code> y luego{' '}
        <code style={codeInline}>{info.dev_cmd}</code>. La primera vez tarda ~30–90 s.
      </div>
    </div>
  );
}

// ─────────── Step: Running ───────────

function RunningStep({
  info, status, logs, onStop,
}: {
  info: PreviewInfo;
  status: PreviewStatus;
  logs: LogLine[];
  onStop: () => void;
}) {
  return (
    <>
      <div style={{
        background: T.panel, borderRadius: 12, boxShadow: T.shadow,
        padding: '18px 20px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Tu app está corriendo</div>
            <div style={{ fontSize: 12.5, color: T.textDim }}>
              {info.framework} · puerto {info.default_port ?? '?'} · presiona Detener cuando termines.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {status.url && (
              <a href={status.url} target="_blank" rel="noreferrer" style={{
                padding: '9px 16px', borderRadius: 8, background: T.ink, color: '#fff',
                textDecoration: 'none', fontSize: 13, fontWeight: 500,
                display: 'inline-flex', alignItems: 'center', gap: 8,
              }}>
                Abrir en navegador <ExternalLink size={13} strokeWidth={2} />
              </a>
            )}
            <button onClick={onStop} style={{
              padding: '9px 16px', borderRadius: 8,
              background: T.panel, boxShadow: T.shadow, border: 'none',
              color: 'oklch(50% 0.18 25)', fontSize: 13, cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}>
              <Square size={12} strokeWidth={2} fill="currentColor" /> Detener
            </button>
          </div>
        </div>
      </div>

      <LogsCard logs={logs} running={status.running} />
    </>
  );
}

// ─────────── Logs (reused across steps) ───────────

function LogsCard({ logs, running }: { logs: LogLine[]; running: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs]);

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '14px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Terminal size={13} color={T.textDim} strokeWidth={1.8} />
        <div style={{ fontSize: 13, fontWeight: 500 }}>Logs en vivo</div>
        {running && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: T.success,
            animation: 'studioPulse 1.8s ease-in-out infinite',
          }} />
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.fontMono }}>
          {logs.length} líneas
        </span>
      </div>
      <div ref={scrollRef} style={{
        height: 240, overflow: 'auto', background: T.bg, borderRadius: 8,
        padding: '10px 12px', border: `1px solid ${T.border}`,
        fontFamily: T.fontMono, fontSize: 11.5, lineHeight: 1.55,
      }}>
        {logs.length === 0 ? (
          <div style={{ color: T.textFaint, fontStyle: 'italic' }}>
            Esperando salida del proceso…
          </div>
        ) : logs.map((l, i) => (
          <div key={i} style={{
            color: l.stream === 'stderr' ? 'oklch(55% 0.18 25)' : T.textDim,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>{stripAnsi(l.line)}</div>
        ))}
      </div>
    </div>
  );
}

// ─────────── Commands (collapsed by default) ───────────

function CommandsCard({ info }: { info: PreviewInfo }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1800);
    });
  };

  const rows = [
    { label: 'Ir a la carpeta', cmd: `cd "${info.root}"`, key: 'cd' },
    { label: 'Instalar', cmd: info.install_cmd ?? '', key: 'install' },
    { label: 'Levantar', cmd: info.dev_cmd ?? '', key: 'dev' },
  ];

  return (
    <div style={{
      background: T.bgAlt, borderRadius: 12, border: `1px solid ${T.border}`,
      padding: '14px 18px',
    }}>
      <div onClick={() => setOpen((v) => !v)} style={{
        display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
      }}>
        <Terminal size={13} color={T.textDim} strokeWidth={1.8} />
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          ¿Prefieres correrlo en tu terminal? Mira los comandos
        </div>
        <div style={{ flex: 1 }} />
        {open ? <ChevronDown size={14} color={T.textDim} /> : <ChevronRight size={14} color={T.textDim} />}
      </div>
      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={r.key} style={{
              display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 10,
              alignItems: 'center', padding: '8px 10px',
              background: T.panel, borderRadius: 7, border: `1px solid ${T.border}`,
            }}>
              <div style={{ fontSize: 11.5, color: T.textDim }}>{r.label}</div>
              <code style={{
                fontFamily: T.fontMono, fontSize: 12, color: T.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.cmd}</code>
              <button onClick={() => copy(r.cmd, r.key)} style={{
                padding: '5px 9px', borderRadius: 6,
                background: copied === r.key ? T.successBg : T.bgAlt,
                color: copied === r.key ? T.success : T.text,
                border: 'none', cursor: 'pointer', fontSize: 11.5, fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                {copied === r.key ? <Check size={11} /> : <Copy size={11} />}
                {copied === r.key ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────── Helpers ───────────

const codeInline: React.CSSProperties = {
  fontFamily: T.fontMono, fontSize: 11, color: T.text,
  background: T.bgAlt, padding: '1px 5px', borderRadius: 3,
};

const extLink: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '4px 10px', borderRadius: 6,
  background: T.panel, color: T.text, textDecoration: 'none',
  fontSize: 11.5, fontWeight: 500, border: `1px solid ${T.border}`,
};

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
