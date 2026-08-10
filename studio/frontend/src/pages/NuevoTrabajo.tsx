import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileText, X, Sparkles, ExternalLink, BookOpen, GitBranch } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioTopBar, StudioBody } from '../components/StudioShell';
import { api, type Project, type ServiceSpec, type GithubStatus as GitBranchStatus } from '../lib/api';

interface Props {
  projectId: string;
  onBack: () => void;
  /** Called after the pipeline has been started successfully. */
  onStarted: () => void;
}

interface AttachedFile {
  name: string;
  size: number;
  content: string;
}

interface ApiKeyEntry {
  id: string;
  key: string;
  value: string;
  description: string;
}

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', model: 'sonnet', cost: 'Token cost' },
  { id: 'codex', label: 'Codex (OpenAI)', model: 'gpt-5', cost: 'Token cost' },
  { id: 'opencode', label: 'OpenCode', model: 'sonnet', cost: 'Token cost' },
] as const;

type ProviderId = typeof PROVIDERS[number]['id'];

const EXAMPLES = [
  'Agregar autenticación con JWT y refresh tokens HTTP-only al backend existente',
  'Crear un panel de administración para gestionar usuarios y permisos',
  'Migrar el sistema de pagos de Stripe a MercadoPago manteniendo retrocompatibilidad',
  'Construir un endpoint de exportación de datos en CSV y XLSX con paginación',
];

export function NuevoTrabajo({ projectId, onBack, onStarted }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [task, setTask] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [detectedServices, setDetectedServices] = useState<ServiceSpec[]>([]);
  const [dismissedServices, setDismissedServices] = useState<Set<string>>(new Set());
  const [github, setGitBranch] = useState<GitBranchStatus | null>(null);
  const [createRepo, setCreateRepo] = useState(false);
  const [repoVisibility, setRepoVisibility] = useState<'public' | 'private'>('private');
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addApiKey = () => {
    setApiKeys((prev) => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      key: '', value: '', description: '',
    }]);
  };
  const updateApiKey = (id: string, patch: Partial<ApiKeyEntry>) => {
    setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  };
  const removeApiKey = (id: string) => {
    setApiKeys((prev) => prev.filter((k) => k.id !== id));
  };

  // Debounced service detection from the task description
  useEffect(() => {
    const combined = [task, ...files.map((f) => f.content)].join('\n');
    if (combined.trim().length < 10) {
      setDetectedServices([]);
      return;
    }
    const handle = window.setTimeout(() => {
      api.services.detect(combined)
        .then((r) => setDetectedServices(r.services))
        .catch(() => { /* silent */ });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [task, files]);

  // Filter out services the user already pre-configured or dismissed
  const suggestedServices = useMemo(() => {
    const configuredKeys = new Set(
      apiKeys.filter((k) => k.key.trim()).map((k) => k.key.trim().toUpperCase())
    );
    return detectedServices.filter((svc) => {
      if (dismissedServices.has(svc.id)) return false;
      const allFilled = svc.env_keys.every((k) => configuredKeys.has(k.name));
      return !allFilled;
    });
  }, [detectedServices, apiKeys, dismissedServices]);

  const addServiceKeys = (svc: ServiceSpec) => {
    setApiKeys((prev) => {
      const existing = new Set(prev.map((k) => k.key.trim().toUpperCase()));
      const newEntries: ApiKeyEntry[] = svc.env_keys
        .filter((k) => !existing.has(k.name))
        .map((k) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${k.name}`,
          key: k.name,
          value: '',
          description: k.description || `${svc.name} — ${k.label}`,
        }));
      return [...prev, ...newEntries];
    });
  };

  const dismissService = (id: string) => {
    setDismissedServices((prev) => new Set([...prev, id]));
  };

  useEffect(() => {
    let cancelled = false;
    api.projects.get(projectId)
      .then((p) => { if (!cancelled) setProject(p); })
      .catch(() => { /* ignore */ });
    api.github.status(projectId)
      .then((s) => { if (!cancelled) setGitBranch(s); })
      .catch(() => { /* ignore — gh may not be installed */ });
    return () => { cancelled = true; };
  }, [projectId]);

  const handleFileSelect = useCallback(async (selected: FileList | null) => {
    if (!selected) return;
    const newFiles: AttachedFile[] = [];
    for (const file of Array.from(selected)) {
      if (file.size > 2 * 1024 * 1024) {
        setError(`${file.name} es muy grande (>2MB)`);
        continue;
      }
      try {
        const content = await file.text();
        newFiles.push({ name: file.name, size: file.size, content });
      } catch {
        setError(`No se pudo leer ${file.name}`);
      }
    }
    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const totalChars = task.length + files.reduce((s, f) => s + f.content.length, 0);
  const canStart = task.trim().length > 10 && !submitting;

  const handleStart = async () => {
    if (!canStart) return;
    setSubmitting(true);
    setError(null);

    // Combine task description with attached files
    let fullTask = task.trim();
    if (files.length > 0) {
      fullTask += '\n\n--- ARCHIVOS ADJUNTOS ---\n';
      for (const f of files) {
        fullTask += `\n### ${f.name}\n${f.content}\n`;
      }
    }

    // Inject API keys as explicit context so Claude uses real values in .env
    // instead of placeholders, AND knows that the user already configured them.
    const validKeys = apiKeys.filter((k) => k.key.trim().length > 0);
    if (validKeys.length > 0) {
      fullTask += '\n\n--- VARIABLES DE ENTORNO / API KEYS PROVISTAS ---\n';
      fullTask += 'The user has already configured these env vars. Use these VALUES in the .env.local file you generate. Do NOT use placeholders like "your-key-here" — use the real values below.\n\n';
      for (const k of validKeys) {
        fullTask += `${k.key}=${k.value}`;
        if (k.description) fullTask += `   # ${k.description}`;
        fullTask += '\n';
      }
    }

    // Create the GitHub repo BEFORE starting the pipeline, so the initial commit
    // (and any later push) lands on a real remote. Failure is non-blocking: we
    // surface the error but still start the pipeline.
    if (createRepo && github && !github.has_repo) {
      setRepoBusy(true);
      try {
        const r = await api.github.init(projectId, {
          visibility: repoVisibility,
          description: `${project?.name ?? 'Don Cheli project'} — ${task.slice(0, 80)}`,
        });
        setGitBranch({
          has_repo: true,
          repo_url: r.repo_url,
          owner: r.owner,
          name: r.name,
          visibility: r.visibility,
          default_branch: null,
          gh_authenticated: true,
          authenticated_user: github.authenticated_user,
        });
      } catch (e) {
        setRepoError(
          e instanceof Error
            ? `No se pudo crear el repo: ${e.message}. Voy a iniciar el trabajo igual.`
            : 'No se pudo crear el repo. Voy a iniciar el trabajo igual.'
        );
      } finally {
        setRepoBusy(false);
      }
    }

    try {
      await api.pipeline.start(projectId, fullTask, {
        provider,
        model: PROVIDERS.find((p) => p.id === provider)?.model ?? 'sonnet',
      });

      // Also write a .env.local to the project root for the future Run tab,
      // so the user doesn't have to re-paste keys when they want to preview.
      if (validKeys.length > 0) {
        try {
          const vars: Record<string, string> = {};
          for (const k of validKeys) vars[k.key.trim()] = k.value;
          await api.preview.writeEnv(projectId, vars);
        } catch { /* non-fatal; the keys are also in the task itself */ }
      }

      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar el trabajo');
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <div style={{
        padding: '14px 32px 0', display: 'flex', gap: 6, fontSize: 12,
        color: T.textFaint, alignItems: 'center',
      }}>
        <span onClick={onBack} style={{ cursor: 'pointer', color: T.textDim }}>Proyectos</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span onClick={onBack} style={{ cursor: 'pointer', color: T.textDim }}>{project?.name ?? '...'}</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span style={{ color: T.text }}>Nuevo trabajo</span>
      </div>

      <StudioTopBar
        title="Nuevo trabajo"
        subtitle={project ? `Sobre ${project.name} · Don Cheli va a seguir los 7 pasos del flujo` : 'Cargando proyecto…'}
      />

      <StudioBody>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, maxWidth: 1180 }}>
          {/* Left column: task input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Section
              title="¿Qué quieres construir?"
              desc="Describe el trabajo en lenguaje natural. Don Cheli va a especificar, planificar, diseñar y construir desde aquí. Sé específico sobre el alcance y los criterios de éxito."
            >
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Ejemplo: Agregar autenticación con JWT al backend, soportando registro, login y refresh tokens. Incluir validación de email y rate limiting básico..."
                style={{
                  width: '100%', minHeight: 220, resize: 'vertical',
                  padding: '14px 16px', borderRadius: 10,
                  border: `1px solid ${T.border}`, background: T.bg,
                  fontFamily: 'inherit', fontSize: 14, lineHeight: 1.55,
                  color: T.text, outline: 'none',
                  transition: 'border-color .12s ease',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = T.ink; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = T.border; }}
              />
              <div style={{
                marginTop: 8, fontSize: 11.5, color: T.textFaint,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{task.trim().length < 10 ? 'Mínimo 10 caracteres' : `${task.trim().length} caracteres`}</span>
                <span>{totalChars > 0 ? `~${Math.round(totalChars / 4)} tokens estimados` : ''}</span>
              </div>

              {/* Examples */}
              {task.length === 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 11.5, color: T.textFaint, fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Ejemplos
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {EXAMPLES.map((ex) => (
                      <button key={ex}
                        onClick={() => setTask(ex)}
                        style={{
                          padding: '8px 12px', borderRadius: 8, textAlign: 'left',
                          background: T.bgAlt, border: 'none',
                          fontFamily: 'inherit', fontSize: 12.5, color: T.textDim,
                          cursor: 'pointer', transition: 'background .12s ease, color .12s ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = T.borderSoft; e.currentTarget.style.color = T.text; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = T.bgAlt; e.currentTarget.style.color = T.textDim; }}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Section>

            <Section
              title="Adjuntar contexto"
              desc="Sube el PRD, RFC, especificación previa, mockups en texto o cualquier documento que ayude a Don Cheli a entender el problema. Se acepta .md, .txt, .pdf, .feature, .json y otros."
            >
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: '24px 16px',
                  border: `2px dashed ${T.border}`,
                  borderRadius: 10,
                  background: T.bg,
                  textAlign: 'center', cursor: 'pointer',
                  transition: 'border-color .12s ease, background .12s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.ink; e.currentTarget.style.background = T.bgAlt; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bg; }}
              >
                <Upload size={20} color={T.textDim} strokeWidth={1.8} style={{ marginBottom: 8 }} />
                <div style={{ fontSize: 13, color: T.text, fontWeight: 500, marginBottom: 2 }}>
                  Arrastra archivos aquí o haz clic para subir
                </div>
                <div style={{ fontSize: 12, color: T.textDim }}>
                  PRD, RFC, especificaciones, mockups · hasta 2 MB por archivo
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  accept=".md,.txt,.json,.yaml,.yml,.feature,.html,.csv"
                  onChange={(e) => handleFileSelect(e.target.files)}
                />
              </div>

              {files.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {files.map((f, i) => (
                    <div key={`${f.name}-${i}`} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', borderRadius: 8,
                      background: T.bgAlt,
                    }}>
                      <FileText size={14} color={T.textDim} strokeWidth={1.8} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: T.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.name}
                        </div>
                        <div style={{ fontSize: 11, color: T.textFaint, fontFamily: T.fontMono }}>
                          {(f.size / 1024).toFixed(1)} KB · {f.content.length.toLocaleString()} chars
                        </div>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: T.textFaint, padding: 4, display: 'inline-flex',
                        }}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* GitHub repo creation — only when we have a status and no repo yet */}
            {github && (
              <GitHubInitCard
                status={github}
                checked={createRepo}
                onChecked={setCreateRepo}
                visibility={repoVisibility}
                onVisibility={setRepoVisibility}
                busy={repoBusy}
                error={repoError}
              />
            )}

            {/* Detected services — Layer 1 of interactivity */}
            {suggestedServices.length > 0 && (
              <DetectedServicesPanel
                services={suggestedServices}
                onAdd={addServiceKeys}
                onDismiss={dismissService}
              />
            )}

            {/* API Keys / env vars */}
            <Section
              title="¿La app va a necesitar API keys o variables de entorno?"
              desc="Si tu app usa servicios externos (Mapbox, Supabase, Stripe, etc.), agrégalos aquí. Don Cheli los va a poner directamente en el .env.local — no usará placeholders. Si no estás seguro, déjalo vacío: lo podrás llenar después en la pestaña Ejecutar."
            >
              {apiKeys.length === 0 ? (
                <button
                  onClick={addApiKey}
                  style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: T.bgAlt, border: `1px dashed ${T.border}`,
                    fontSize: 12.5, color: T.textDim, cursor: 'pointer',
                    fontFamily: 'inherit', width: '100%',
                  }}
                >+ Agregar primera variable</button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {apiKeys.map((k) => (
                    <div key={k.id} style={{
                      padding: '12px 14px', background: T.bgAlt, borderRadius: 8,
                      display: 'grid', gridTemplateColumns: '1fr 1.5fr auto', gap: 10,
                      alignItems: 'flex-start',
                    }}>
                      <input
                        value={k.key}
                        onChange={(e) => updateApiKey(k.id, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                        placeholder="NEXT_PUBLIC_MAPBOX_TOKEN"
                        style={{
                          padding: '7px 10px', borderRadius: 6,
                          border: `1px solid ${T.border}`, background: T.panel,
                          fontFamily: T.fontMono, fontSize: 12, color: T.text,
                          outline: 'none',
                        }}
                      />
                      <input
                        type="password"
                        value={k.value}
                        onChange={(e) => updateApiKey(k.id, { value: e.target.value })}
                        placeholder="pk.eyJ1IjoiYWxleC..."
                        style={{
                          padding: '7px 10px', borderRadius: 6,
                          border: `1px solid ${T.border}`, background: T.panel,
                          fontFamily: T.fontMono, fontSize: 12, color: T.text,
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => removeApiKey(k.id)}
                        style={{
                          padding: 6, background: 'transparent', border: 'none',
                          cursor: 'pointer', color: T.textFaint, display: 'inline-flex',
                        }}
                      ><X size={14} /></button>
                    </div>
                  ))}
                  <button
                    onClick={addApiKey}
                    style={{
                      padding: '7px 12px', borderRadius: 7,
                      background: 'transparent', border: `1px dashed ${T.border}`,
                      fontSize: 12, color: T.textDim, cursor: 'pointer',
                      fontFamily: 'inherit', alignSelf: 'flex-start',
                    }}
                  >+ Agregar otra</button>
                </div>
              )}

              <div style={{ marginTop: 10, fontSize: 11, color: T.textFaint, lineHeight: 1.55 }}>
                💡 Ejemplos comunes:{' '}
                <span style={{ fontFamily: T.fontMono }}>NEXT_PUBLIC_MAPBOX_TOKEN</span> ·{' '}
                <span style={{ fontFamily: T.fontMono }}>NEXT_PUBLIC_SUPABASE_URL</span> ·{' '}
                <span style={{ fontFamily: T.fontMono }}>NEXT_PUBLIC_SUPABASE_ANON_KEY</span> ·{' '}
                <span style={{ fontFamily: T.fontMono }}>OPENAI_API_KEY</span>
              </div>
            </Section>

            {/* Advanced */}
            <div>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: T.textDim, fontSize: 12.5, fontFamily: 'inherit',
                  padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
                onMouseLeave={(e) => (e.currentTarget.style.color = T.textDim)}
              >
                {showAdvanced ? '−' : '+'} Opciones avanzadas
              </button>

              {showAdvanced && (
                <Section title="Editor y modelo" desc="Qué herramienta de IA va a ejecutar el trabajo.">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {PROVIDERS.map((p) => (
                      <label key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '12px 14px', borderRadius: 10,
                        background: provider === p.id ? T.successBg : T.bg,
                        border: `1px solid ${provider === p.id ? T.success : T.border}`,
                        cursor: 'pointer',
                        transition: 'border-color .12s ease, background .12s ease',
                      }}>
                        <input type="radio" name="provider"
                          checked={provider === p.id}
                          onChange={() => setProvider(p.id)}
                          style={{ accentColor: T.ink }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: T.text }}>{p.label}</div>
                          <div style={{ fontSize: 11.5, color: T.textDim, fontFamily: T.fontMono }}>{p.model}</div>
                        </div>
                        <span style={{ fontSize: 11, color: T.textFaint }}>{p.cost}</span>
                      </label>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </div>

          {/* Right column: summary */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{
              background: T.panel, borderRadius: 12, boxShadow: T.shadow,
              padding: '18px 20px',
              position: 'sticky', top: 16,
            }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 14 }}>
                Resumen del trabajo
              </div>
              <Row label="Proyecto" value={project?.name ?? '—'} />
              <Row label="Editor" value={PROVIDERS.find((p) => p.id === provider)?.label ?? '—'} />
              <Row label="Modelo" value={PROVIDERS.find((p) => p.id === provider)?.model ?? '—'} mono />
              <Row label="Archivos" value={files.length === 0 ? '—' : `${files.length}`} />
              <Row label="Pasos" value="7" />

              <div style={{
                margin: '14px 0', height: 1, background: T.borderSoft,
              }} />

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.textDim, marginBottom: 14 }}>
                <Sparkles size={13} strokeWidth={1.8} />
                <span>Costo y tiempo estimados al arrancar</span>
              </div>

              {error && (
                <div style={{
                  padding: '10px 12px', borderRadius: 8,
                  background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)',
                  fontSize: 12, marginBottom: 12,
                }}>
                  {error}
                </div>
              )}

              <button
                onClick={handleStart}
                disabled={!canStart}
                style={{
                  width: '100%', padding: '10px 16px', borderRadius: 8,
                  background: canStart ? T.ink : T.bgAlt,
                  color: canStart ? '#fff' : T.textFaint,
                  border: 'none', fontSize: 13, fontWeight: 500,
                  cursor: canStart ? 'pointer' : 'not-allowed',
                  fontFamily: 'inherit',
                  transition: 'transform .12s ease',
                }}
                onMouseEnter={(e) => { if (canStart) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                {submitting ? 'Iniciando…' : 'Empezar trabajo →'}
              </button>

              <button
                onClick={onBack}
                disabled={submitting}
                style={{
                  width: '100%', marginTop: 8,
                  padding: '8px 14px', borderRadius: 8,
                  background: 'transparent', color: T.textDim,
                  border: 'none', fontSize: 12.5,
                  cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </StudioBody>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '18px 20px',
    }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: T.text, marginBottom: 4 }}>{title}</div>
      {desc && (
        <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55, marginBottom: 14 }}>{desc}</div>
      )}
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12.5 }}>
      <span style={{ color: T.textDim }}>{label}</span>
      <span style={{
        color: T.text, fontWeight: 500,
        fontFamily: mono ? T.fontMono : 'inherit',
        maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
    </div>
  );
}

// ─────────── GitHub init card ───────────

function GitHubInitCard({
  status, checked, onChecked, visibility, onVisibility, busy, error,
}: {
  status: GitBranchStatus;
  checked: boolean;
  onChecked: (v: boolean) => void;
  visibility: 'public' | 'private';
  onVisibility: (v: 'public' | 'private') => void;
  busy: boolean;
  error: string | null;
}) {
  // Already linked → show the existing repo and don't offer to recreate.
  if (status.has_repo && status.repo_url) {
    return (
      <div style={{
        background: T.panel, borderRadius: 12, boxShadow: T.shadow,
        padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <GitBranch size={18} color={T.text} strokeWidth={1.6} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: T.text }}>
            Repo conectado
          </div>
          <a href={status.repo_url} target="_blank" rel="noreferrer" style={{
            fontSize: 12, color: T.textDim, fontFamily: T.fontMono,
            textDecoration: 'none',
          }}>
            {status.owner}/{status.name}
            {status.visibility ? ` · ${status.visibility}` : ''}
          </a>
        </div>
        <a href={status.repo_url} target="_blank" rel="noreferrer" style={{
          fontSize: 12, color: T.text, textDecoration: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '5px 10px', borderRadius: 6, background: T.bgAlt,
        }}>
          Abrir <ExternalLink size={11} />
        </a>
      </div>
    );
  }

  // gh CLI not authenticated → explain instead of offering
  if (!status.gh_authenticated) {
    return (
      <div style={{
        background: T.bgAlt, borderRadius: 12,
        padding: '14px 18px', border: `1px dashed ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <GitBranch size={18} color={T.textDim} strokeWidth={1.6} />
        <div style={{ flex: 1, fontSize: 12, color: T.textDim, lineHeight: 1.5 }}>
          GitHub disponible pero <code style={{ fontFamily: T.fontMono, fontSize: 11, padding: '1px 5px', background: T.panel, borderRadius: 3 }}>gh auth login</code> no ejecutado.
          Corre eso desde tu terminal para poder versionar este trabajo en GitHub.
        </div>
      </div>
    );
  }

  // gh OK but no repo yet → offer to create
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '16px 18px',
    }}>
      <label style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
      }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChecked(e.target.checked)}
          style={{ marginTop: 3, accentColor: T.ink }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <GitBranch size={15} color={T.text} strokeWidth={1.6} />
            <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>
              Crear repositorio en GitHub para este proyecto
            </span>
          </div>
          <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5 }}>
            Don Cheli va a inicializar git (si no está), crear un commit inicial con README,
            crear el repo en{' '}
            <code style={{ fontFamily: T.fontMono, fontSize: 11, padding: '1px 5px', background: T.bgAlt, borderRadius: 3 }}>
              github.com/{status.authenticated_user ?? '(tu cuenta)'}/...
            </code>{' '}
            y hacer push. Después tú decides cuándo pushear los commits del pipeline.
          </div>
        </div>
      </label>

      {checked && (
        <div style={{
          marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}`,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ fontSize: 12, color: T.textDim }}>Visibilidad:</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['private', 'public'] as const).map((v) => (
              <label key={v} style={{
                flex: 1, padding: '10px 14px', borderRadius: 8,
                background: visibility === v ? T.successBg : T.bgAlt,
                border: `1px solid ${visibility === v ? T.success : T.border}`,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13,
              }}>
                <input
                  type="radio" name="repo-visibility" value={v}
                  checked={visibility === v}
                  onChange={() => onVisibility(v)}
                />
                <div>
                  <div style={{ fontWeight: 500, color: T.text }}>
                    {v === 'private' ? 'Privado' : 'Público'}
                  </div>
                  <div style={{ fontSize: 11, color: T.textFaint }}>
                    {v === 'private'
                      ? 'Solo tú y los colaboradores que invites'
                      : 'Visible para cualquiera en GitHub'}
                  </div>
                </div>
              </label>
            ))}
          </div>
          {busy && (
            <div style={{ fontSize: 12, color: T.textDim, fontStyle: 'italic' }}>
              Creando repositorio…
            </div>
          )}
          {error && (
            <div style={{
              fontSize: 12, color: 'oklch(50% 0.18 25)',
              padding: '8px 10px', background: 'oklch(96% 0.06 25)', borderRadius: 6,
            }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────── Layer 1: detected services panel ───────────

function DetectedServicesPanel({
  services, onAdd, onDismiss,
}: {
  services: ServiceSpec[];
  onAdd: (svc: ServiceSpec) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div style={{
      background: 'oklch(96% 0.04 240)',
      border: '1px solid oklch(80% 0.10 240)',
      borderRadius: 12, padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Sparkles size={14} color="oklch(45% 0.18 240)" strokeWidth={1.8} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(25% 0.15 240)' }}>
          Detectamos {services.length} servicio{services.length === 1 ? '' : 's'} que va{services.length === 1 ? '' : 'n'} a necesitar API keys
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'oklch(40% 0.10 240)', marginBottom: 14, lineHeight: 1.5 }}>
        Don Cheli los va a usar al construir la app. Pre-configura las keys ahora y se
        guardan directamente en el <code style={{ fontFamily: T.fontMono, fontSize: 11, background: 'rgba(255,255,255,0.5)', padding: '1px 5px', borderRadius: 3 }}>.env.local</code> antes de empezar.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {services.map((svc) => (
          <div key={svc.id} style={{
            background: T.panel, borderRadius: 10,
            padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: T.bgAlt, display: 'grid', placeItems: 'center',
                fontFamily: T.fontMono, fontSize: 13, fontWeight: 600,
                color: T.text, flexShrink: 0,
              }}>{svc.name.charAt(0)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: T.text }}>{svc.name}</span>
                  <span style={{ fontSize: 10.5, color: T.textFaint }}>· {svc.category}</span>
                </div>
                <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5, marginTop: 2 }}>
                  {svc.description}
                </div>
              </div>
              <button onClick={() => onDismiss(svc.id)} aria-label="Descartar" style={{
                padding: 4, background: 'transparent', border: 'none',
                cursor: 'pointer', color: T.textFaint, display: 'inline-flex',
                flexShrink: 0,
              }}><X size={13} /></button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {svc.env_keys.map((k) => (
                <span key={k.name} style={{
                  fontFamily: T.fontMono, fontSize: 10, padding: '2px 6px',
                  background: T.bgAlt, color: T.textDim, borderRadius: 4,
                }}>{k.name}</span>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <button
                onClick={() => onAdd(svc)}
                style={{
                  padding: '6px 12px', borderRadius: 7,
                  background: T.ink, color: '#fff', border: 'none',
                  fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit',
                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
                }}
              >+ Agregar {svc.env_keys.length} key{svc.env_keys.length === 1 ? '' : 's'}</button>
              <a href={svc.dashboard_url} target="_blank" rel="noreferrer" style={{
                fontSize: 11, color: T.textDim, textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}><ExternalLink size={10} /> Dashboard</a>
              <a href={svc.docs_url} target="_blank" rel="noreferrer" style={{
                fontSize: 11, color: T.textDim, textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}><BookOpen size={10} /> Docs</a>
            </div>

            {svc.free_tier && (
              <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: -2 }}>
                💰 {svc.free_tier}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
