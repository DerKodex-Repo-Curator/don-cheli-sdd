import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, X, Sparkles, Copy, ExternalLink, RefreshCw, Maximize2, Code2, Loader2, Image as ImageIcon, Trash2,
} from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioButton, StudioPill, StudioPillGroup, type PillTone } from '../components/StudioShell';
import { api, type MockupInfo, type ApprovalState, type DesignListResponse, type StitchScreen, type ScreenPreview } from '../lib/api';
import { useWebSocket, type WsEvent } from '../hooks/useWebSocket';

interface Props {
  projectId: string;
  projectName: string;
}

export function DesignTab({ projectId, projectName }: Props) {
  const [data, setData] = useState<DesignListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const [showCopiedToast, setShowCopiedToast] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('all');

  const refresh = useCallback(async () => {
    try {
      const d = await api.design.list(projectId);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      await api.design.generate(projectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar la generación');
      setGenerating(false);
    }
  };

  // Stop "generating" state once new mockups appear or 30s pass
  useEffect(() => {
    if (!generating) return;
    const start = data?.mockups.length ?? 0;
    const t = window.setInterval(() => {
      if ((data?.mockups.length ?? 0) > start) setGenerating(false);
    }, 2000);
    const fallback = window.setTimeout(() => setGenerating(false), 120_000);
    return () => { window.clearInterval(t); window.clearTimeout(fallback); };
  }, [generating, data]);

  const [busyAction, setBusyAction] = useState<null | 'approve' | 'reject' | 'reset'>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [changesModalOpen, setChangesModalOpen] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  };

  const handleApprove = async () => {
    setBusyAction('approve');
    setError(null);
    try {
      await api.design.approve(projectId, 'Studio user', undefined);
      await refresh();
      showToast('✓ Diseño aprobado — el pipeline va a continuar en máximo 5 segundos.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aprobar');
    } finally {
      setBusyAction(null);
    }
  };

  const handleReject = async () => {
    setBusyAction('reject');
    setError(null);
    try {
      await api.design.reject(projectId, 'Studio user', undefined);
      await refresh();
      showToast('Diseño rechazado. Regenera o pide cambios para continuar.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo rechazar');
    } finally {
      setBusyAction(null);
    }
  };

  /** Reopen review: flip approval back to in_review so the user (or the gate) blocks again. */
  const handleResetApproval = async () => {
    setBusyAction('reset');
    setError(null);
    try {
      await api.design.reject(projectId, 'Studio user', 'Reabriendo revisión para iterar el diseño');
      await refresh();
      showToast('Diseño reabierto para revisión.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo reabrir');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequestChanges = async (instructions: string) => {
    setBusyAction('reset');
    setError(null);
    try {
      // Regenerate with extra instructions injected into the design prompt.
      await api.design.generate(projectId, instructions);
      showToast('Regenerando mockups con tus cambios. ~1–3 min.');
      setGenerating(true);
      setChangesModalOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo solicitar cambios');
    } finally {
      setBusyAction(null);
    }
  };

  const copyPrompt = (target: 'stitch' | 'figma') => {
    const prompt = buildExternalPrompt(target, projectName, data?.tokens ?? null);
    navigator.clipboard.writeText(prompt).then(() => {
      setShowCopiedToast(target);
      window.setTimeout(() => setShowCopiedToast(null), 2000);
    });
  };

  // ── All hooks must run BEFORE any conditional return (Rules of Hooks). ──
  const mockups = data?.mockups ?? [];
  const approval = data?.approval;
  const hasStitch = !!data?.stitch_url && !!data?.stitch_project_id;
  const hasDesigns = mockups.length > 0 || hasStitch;

  const categories = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of mockups) counts[m.category] = (counts[m.category] ?? 0) + 1;
    return counts;
  }, [mockups]);

  const filteredMockups = useMemo(
    () => (category === 'all' ? mockups : mockups.filter((m) => m.category === category)),
    [mockups, category],
  );

  if (loading) {
    return <div style={{ padding: 40, color: T.textDim, fontSize: 13 }}>Cargando diseños…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200 }}>
      <ApprovalHeader
        approval={approval}
        hasDesigns={hasDesigns}
        generating={generating}
        busyAction={busyAction}
        onGenerate={handleGenerate}
        onApprove={handleApprove}
        onReject={handleReject}
        onReopen={handleResetApproval}
        onRequestChanges={() => setChangesModalOpen(true)}
        onRefresh={refresh}
      />

      {toast && (
        <div style={{
          padding: '12px 16px', borderRadius: 10,
          background: T.successBg, color: T.text,
          fontSize: 13, border: `1px solid ${T.success}`,
        }}>
          {toast}
        </div>
      )}

      {changesModalOpen && (
        <RequestChangesModal
          onCancel={() => setChangesModalOpen(false)}
          onSubmit={handleRequestChanges}
          busy={busyAction === 'reset'}
        />
      )}

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)',
          fontSize: 12.5, border: '1px solid oklch(90% 0.08 25)',
        }}>
          {error}
        </div>
      )}

      {!hasDesigns && !generating && (
        <EmptyState onGenerate={handleGenerate} />
      )}

      {generating && !hasDesigns && <GeneratingState />}

      {/* When a regen is in flight but legacy HTML is still on disk, surface
          progress so the user does not think the old grid is the result. */}
      <RegenerationBanner projectId={projectId} hasStitch={hasStitch} mobbinCount={data?.mobbin_refs.length ?? 0} />


      {/* Stitch is the source of truth for the design when the new flow ran. */}
      {hasStitch && data && (
        <StitchDesignPanel
          projectId={projectId}
          stitchUrl={data.stitch_url!}
          screens={data.stitch_screens}
          designBrief={data.design_brief}
          mobbinCount={data.mobbin_refs.length}
          onRefresh={refresh}
        />
      )}

      {/* After approval, the Stitch → code regen kicks off (or already ran). */}
      {hasStitch && approval?.status === 'approved' && (
        <CodeRegenerationPanel
          projectId={projectId}
        />
      )}

      {hasDesigns && (
        <>
          {/* Mobbin references panel — always show if we have research */}
          {data?.mobbin_refs && data.mobbin_refs.length > 0 && (
            <McpOutputsBar
              stitchUrl={hasStitch ? null : data.stitch_url ?? null /* avoid dupe with StitchDesignPanel */}
              mobbinRefs={data.mobbin_refs}
            />
          )}

          {/* Legacy HTML grid — only when the old flow ran (HTML written locally)
              AND we don't have the new Stitch source. When Stitch is the source
              of truth, the local HTML mockups are stale references — hide them. */}
          {mockups.length > 0 && !hasStitch && (
            <>
              {Object.keys(categories).length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 12, color: T.textDim }}>Filtrar:</span>
                  <StudioPillGroup
                    withCounts
                    value={category}
                    onChange={setCategory}
                    options={[
                      { value: 'all', label: 'Todos', count: mockups.length },
                      ...['pages', 'organisms', 'molecules', 'atoms', 'root']
                        .filter((c) => categories[c])
                        .map((c) => ({
                          value: c,
                          label: prettyCategory(c),
                          count: categories[c],
                        })),
                    ]}
                  />
                </div>
              )}

              <MockupGrid
                projectId={projectId}
                mockups={filteredMockups}
                onOpenFullscreen={setFullscreen}
              />
            </>
          )}

          {!hasStitch && (
            <ExternalToolsBar
              onCopyPrompt={copyPrompt}
              copiedToast={showCopiedToast}
              projectName={projectName}
            />
          )}

          {data?.tokens && <TokensCard tokens={data.tokens} />}
        </>
      )}

      {fullscreen && (
        <FullscreenViewer
          projectId={projectId}
          filename={fullscreen}
          mockups={mockups}
          onClose={() => setFullscreen(null)}
        />
      )}
    </div>
  );
}

// ─────────── Approval header ───────────

function ApprovalHeader({
  approval, hasDesigns, generating, busyAction,
  onGenerate, onApprove, onReject, onReopen, onRequestChanges, onRefresh,
}: {
  approval: ApprovalState | null | undefined;
  hasDesigns: boolean;
  generating: boolean;
  busyAction: null | 'approve' | 'reject' | 'reset';
  onGenerate: () => void;
  onApprove: () => void;
  onReject: () => void;
  onReopen: () => void;
  onRequestChanges: () => void;
  onRefresh: () => void;
}) {
  const status = approval?.status ?? 'pending';
  const tone: PillTone =
    status === 'approved' ? 'active' :
    status === 'rejected' ? 'error' :
    hasDesigns ? 'warn' : 'pending';

  const label =
    status === 'approved' ? 'Aprobado' :
    status === 'rejected' ? 'Rechazado' :
    hasDesigns ? 'Esperando tu revisión' : 'Sin diseños';

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '16px 20px',
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 500, color: T.text }}>Diseño del proyecto</span>
          <StudioPill tone={tone} dot={status === 'approved' || tone === 'warn'}>{label}</StudioPill>
        </div>
        <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5, maxWidth: 640 }}>
          {!hasDesigns
            ? 'Don Cheli aún no ha generado mockups para este proyecto. Genéralos a partir del spec y plan.'
            : status === 'approved'
              ? `Aprobado${approval?.signer ? ` por ${approval.signer}` : ''} · ${formatTime(approval?.at ?? '')}. Puedes pedir cambios o regenerar en cualquier momento.`
              : status === 'rejected'
                ? `Rechazado${approval?.signer ? ` por ${approval.signer}` : ''}. Pide cambios o regenera para volver a aprobar.`
                : 'Revisa los mockups abajo. Aprobar desbloquea el siguiente paso del pipeline.'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={onRefresh}
          aria-label="Refrescar"
          style={{
            padding: 8, borderRadius: 8, background: T.panel,
            boxShadow: T.shadow, border: 'none', cursor: 'pointer',
            color: T.textDim, display: 'inline-flex',
          }}
        ><RefreshCw size={13} strokeWidth={1.8} /></button>

        {/* Always-available iteration buttons */}
        {hasDesigns && (
          <>
            <button onClick={onRequestChanges} disabled={generating || busyAction !== null} style={{
              padding: '8px 14px', borderRadius: 8,
              background: T.panel, boxShadow: T.shadow, border: 'none',
              cursor: (generating || busyAction !== null) ? 'not-allowed' : 'pointer',
              fontSize: 12.5, color: T.text, fontFamily: 'inherit',
              opacity: (generating || busyAction !== null) ? 0.5 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>💬 Pedir cambios</button>
          </>
        )}

        {/* Approval flow buttons */}
        {hasDesigns && status !== 'approved' && (
          <>
            <button
              onClick={onReject}
              disabled={busyAction !== null}
              style={{
                padding: '8px 14px', borderRadius: 8,
                background: T.panel, boxShadow: T.shadow,
                border: 'none', cursor: busyAction ? 'not-allowed' : 'pointer',
                fontSize: 12.5, color: 'oklch(50% 0.18 25)', fontFamily: 'inherit',
                opacity: busyAction ? 0.5 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              <X size={13} strokeWidth={2} /> {busyAction === 'reject' ? 'Rechazando…' : 'Rechazar'}
            </button>

            <button
              onClick={onApprove}
              disabled={busyAction !== null}
              style={{
                padding: '8px 14px', borderRadius: 8,
                background: T.success, color: '#fff', border: 'none',
                cursor: busyAction ? 'not-allowed' : 'pointer',
                fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
                opacity: busyAction ? 0.7 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              {busyAction === 'approve' ? (
                <>
                  <span style={{
                    width: 12, height: 12, borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: '#fff', animation: 'spin 0.7s linear infinite',
                  }} />
                  Aprobando…
                </>
              ) : (
                <><Check size={13} strokeWidth={2.5} /> Aprobar diseño</>
              )}
            </button>
          </>
        )}

        {/* When already approved, allow re-opening review (e.g., to change design later) */}
        {hasDesigns && status === 'approved' && (
          <button
            onClick={onReopen}
            disabled={busyAction !== null}
            style={{
              padding: '8px 14px', borderRadius: 8,
              background: T.panel, boxShadow: T.shadow, border: 'none',
              cursor: busyAction ? 'not-allowed' : 'pointer',
              fontSize: 12.5, color: T.text, fontFamily: 'inherit',
              opacity: busyAction ? 0.5 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>↻ Reabrir revisión</button>
        )}

        <StudioButton onClick={onGenerate} disabled={generating || busyAction !== null}>
          {generating ? 'Regenerando…' : hasDesigns ? '↻ Regenerar todo' : '+ Generar mockups'}
        </StudioButton>
      </div>
    </div>
  );
}

// ─────────── Empty / Generating ───────────

function EmptyState({ onGenerate }: { onGenerate: () => void }) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '48px 24px', textAlign: 'center',
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12, background: T.bgAlt,
        display: 'grid', placeItems: 'center', margin: '0 auto 16px',
        color: T.textDim,
      }}>
        <Sparkles size={20} strokeWidth={1.8} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>
        Aún no hay diseño generado
      </div>
      <div style={{ fontSize: 13, color: T.textDim, marginBottom: 18, maxWidth: 520, margin: '0 auto 18px' }}>
        Don Cheli busca referencias reales en <b>Mobbin</b>, genera el diseño visual en <b>Google Stitch</b> y, cuando lo apruebes, traduce las pantallas a código React+Tailwind.
      </div>
      <button onClick={onGenerate} style={{
        padding: '9px 18px', borderRadius: 8, background: T.ink, color: '#fff',
        border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
        display: 'inline-flex', alignItems: 'center', gap: 8,
      }}>
        <Sparkles size={14} strokeWidth={1.8} /> Generar diseño
      </button>
    </div>
  );
}

function GeneratingState() {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '40px 24px', textAlign: 'center',
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12, background: T.successBg,
        display: 'grid', placeItems: 'center', margin: '0 auto 16px',
        color: T.success,
        animation: 'studioPulse 1.6s ease-in-out infinite',
      }}>
        <Sparkles size={20} strokeWidth={1.8} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
        Generando mockups…
      </div>
      <div style={{ fontSize: 12.5, color: T.textDim }}>
        Don Cheli está leyendo el spec, plan y código existente. Suele tomar 1–3 min.
      </div>
    </div>
  );
}

// ─────────── Mockup grid ───────────

function MockupGrid({
  projectId, mockups, onOpenFullscreen,
}: {
  projectId: string;
  mockups: MockupInfo[];
  onOpenFullscreen: (filename: string) => void;
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
      gap: 16,
    }}>
      {mockups.map((m) => (
        <div key={m.name} style={{
          background: T.panel, borderRadius: 12, boxShadow: T.shadow,
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: `1px solid ${T.borderSoft}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.title}
              </div>
              <div style={{ fontSize: 11, color: T.textFaint, fontFamily: T.fontMono }}>
                {m.name} · {(m.size_bytes / 1024).toFixed(1)} KB
              </div>
            </div>
            <button onClick={() => onOpenFullscreen(m.name)}
              aria-label="Pantalla completa"
              style={{
                padding: 5, background: 'transparent', border: 'none',
                cursor: 'pointer', color: T.textDim, display: 'inline-flex',
              }}>
              <Maximize2 size={13} strokeWidth={1.8} />
            </button>
          </div>
          <iframe
            src={api.design.fileUrl(projectId, m.name)}
            sandbox="allow-same-origin"
            title={m.title}
            style={{
              width: '100%', height: 360, border: 'none',
              background: '#fff', display: 'block',
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ─────────── External tools bar ───────────

function ExternalToolsBar({
  onCopyPrompt, copiedToast, projectName,
}: {
  onCopyPrompt: (t: 'stitch' | 'figma') => void;
  copiedToast: string | null;
  projectName: string;
}) {
  return (
    <div style={{
      background: T.bgAlt, borderRadius: 12,
      padding: '14px 18px',
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      border: `1px solid ${T.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: T.text, marginBottom: 2 }}>
          ¿Quieres refinar visualmente?
        </div>
        <div style={{ fontSize: 12, color: T.textDim }}>
          Copia un prompt pre-construido con los tokens y el spec de {projectName} para Google Stitch o Figma Make.
        </div>
      </div>

      <button onClick={() => onCopyPrompt('stitch')} style={extBtnStyle}>
        {copiedToast === 'stitch' ? <Check size={13} /> : <Copy size={13} strokeWidth={1.8} />}
        {copiedToast === 'stitch' ? '¡Copiado!' : 'Prompt para Stitch'}
      </button>
      <a href="https://stitch.withgoogle.com" target="_blank" rel="noreferrer" style={extLinkStyle}>
        <ExternalLink size={11} strokeWidth={1.8} /> Stitch
      </a>

      <button onClick={() => onCopyPrompt('figma')} style={extBtnStyle}>
        {copiedToast === 'figma' ? <Check size={13} /> : <Copy size={13} strokeWidth={1.8} />}
        {copiedToast === 'figma' ? '¡Copiado!' : 'Prompt para Figma Make'}
      </button>
      <a href="https://www.figma.com/make" target="_blank" rel="noreferrer" style={extLinkStyle}>
        <ExternalLink size={11} strokeWidth={1.8} /> Figma
      </a>
    </div>
  );
}

const extBtnStyle: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 7, background: T.panel,
  boxShadow: T.shadow, border: 'none', cursor: 'pointer',
  fontSize: 12, fontFamily: 'inherit', color: T.text,
  display: 'inline-flex', alignItems: 'center', gap: 6,
};

const extLinkStyle: React.CSSProperties = {
  padding: '4px 8px', fontSize: 11, color: T.textDim,
  textDecoration: 'none',
  display: 'inline-flex', alignItems: 'center', gap: 4,
};

// ─────────── Tokens card ───────────

// ─────────── MCP outputs (Stitch + Mobbin) ───────────

function McpOutputsBar({
  stitchUrl, mobbinRefs,
}: {
  stitchUrl: string | null;
  mobbinRefs: Array<{ screen: string; query: string; refs: string[]; takeaways: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: 'oklch(96% 0.04 280)',
      border: '1px solid oklch(80% 0.10 280)',
      borderRadius: 12, padding: '12px 18px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Sparkles size={14} color="oklch(40% 0.18 280)" strokeWidth={1.8} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'oklch(25% 0.18 280)' }}>
          Diseño potenciado con MCPs
        </span>

        {stitchUrl && (
          <a
            href={stitchUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '7px 14px', borderRadius: 8,
              background: 'oklch(40% 0.20 280)', color: '#fff',
              textDecoration: 'none', fontSize: 12.5, fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <ExternalLink size={12} /> Ver en Stitch
          </a>
        )}

        {mobbinRefs.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              padding: '7px 12px', borderRadius: 8,
              background: T.panel, boxShadow: T.shadow,
              border: 'none', cursor: 'pointer',
              fontSize: 12.5, color: T.text, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            📚 {mobbinRefs.length} referencia{mobbinRefs.length === 1 ? '' : 's'} de Mobbin {open ? '▴' : '▾'}
          </button>
        )}

        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'oklch(40% 0.10 280)' }}>
          {stitchUrl && mobbinRefs.length > 0
            ? 'Stitch hosting + Mobbin research'
            : stitchUrl ? 'Hosted en Google Stitch'
            : 'Inspiración de productos shipped'}
        </span>
      </div>

      {open && mobbinRefs.length > 0 && (
        <div style={{
          background: T.panel, borderRadius: 10,
          padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {mobbinRefs.map((r, i) => (
            <div key={i} style={{
              paddingBottom: i < mobbinRefs.length - 1 ? 10 : 0,
              borderBottom: i < mobbinRefs.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: T.bgAlt, color: T.text, fontWeight: 500,
                  fontFamily: T.fontMono,
                }}>{r.screen}</span>
                {r.query && (
                  <span style={{ fontSize: 11, color: T.textFaint }}>
                    búsqueda: <em>"{r.query}"</em>
                  </span>
                )}
              </div>
              {r.takeaways && (
                <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5, marginBottom: 6 }}>
                  {r.takeaways}
                </div>
              )}
              {r.refs.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {r.refs.map((url, j) => (
                    <a key={j} href={url} target="_blank" rel="noreferrer" style={{
                      fontSize: 11, color: T.textDim, textDecoration: 'none',
                      padding: '3px 8px', borderRadius: 5, background: T.bgAlt,
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}>
                      <ExternalLink size={10} /> ref {j + 1}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TokensCard({ tokens }: { tokens: Record<string, unknown> }) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '16px 20px',
    }}>
      <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 10 }}>Design tokens</div>
      <pre style={{
        fontSize: 11.5, fontFamily: T.fontMono, color: T.textDim,
        background: T.bg, padding: 12, borderRadius: 8, overflow: 'auto',
        maxHeight: 260, margin: 0,
      }}>{JSON.stringify(tokens, null, 2)}</pre>
    </div>
  );
}

// ─────────── Fullscreen viewer ───────────

function FullscreenViewer({
  projectId, filename, mockups, onClose,
}: {
  projectId: string;
  filename: string;
  mockups: MockupInfo[];
  onClose: () => void;
}) {
  const current = mockups.find((m) => m.name === filename);
  const idx = mockups.findIndex((m) => m.name === filename);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(15,17,20,0.85)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12,
        background: T.panel, borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: T.text }}>
            {current?.title ?? filename}
          </div>
          <div style={{ fontSize: 11, color: T.textFaint, fontFamily: T.fontMono }}>
            {filename} · {idx + 1} de {mockups.length}
          </div>
        </div>
        <button onClick={onClose} style={{
          padding: '6px 12px', borderRadius: 6, border: 'none',
          background: T.bgAlt, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', color: T.text,
        }}>Cerrar (ESC)</button>
      </div>
      <iframe
        src={api.design.fileUrl(projectId, filename)}
        sandbox="allow-same-origin"
        title={current?.title ?? filename}
        style={{ flex: 1, border: 'none', background: '#fff' }}
      />
    </div>
  );
}

// ─────────── Helpers ───────────

function buildExternalPrompt(
  target: 'stitch' | 'figma',
  projectName: string,
  tokens: Record<string, unknown> | null,
): string {
  const tokensBlock = tokens
    ? `\n\nDesign tokens to use:\n\`\`\`json\n${JSON.stringify(tokens, null, 2)}\n\`\`\``
    : '';

  const intro = target === 'stitch'
    ? `Generate a UI for the ${projectName} project on Google Stitch.`
    : `Generate UI mockups for the ${projectName} project on Figma Make.`;

  return [
    intro,
    '',
    `The project's HTML mockups are already drafted in Don Cheli Studio. Refine them visually for production handoff: cleaner spacing, consistent typography, accessible color contrast, and component reusability.`,
    '',
    `Target screens:`,
    `- Auth (login + register)`,
    `- Main dashboard / map view`,
    `- Detail / inspector panels`,
    `- Modal / form for primary action`,
    `- Empty / loading / error states`,
    '',
    `Style direction: read it from the design tokens below — match the palette, typography scale, spacing and corner radii exactly. Don't reinvent.`,
    tokensBlock,
    '',
    `Deliver: a single Figma file (or Stitch project) with the screens above, organized in pages, with components extracted to a Library page.`,
  ].join('\n');
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

// ─────────── Request changes modal ───────────

function RequestChangesModal({
  onCancel, onSubmit, busy,
}: {
  onCancel: () => void;
  onSubmit: (instructions: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState('');

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,17,20,0.55)',
        display: 'grid', placeItems: 'center', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.panel, borderRadius: 14,
          padding: '20px 22px', maxWidth: 580, width: '100%',
          boxShadow: T.shadowLg,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>
          Pedir cambios al diseño
        </div>
        <div style={{ fontSize: 12.5, color: T.textDim, marginBottom: 14, lineHeight: 1.55 }}>
          Describe qué quieres cambiar. Don Cheli va a regenerar los mockups aplicando
          tus instrucciones. Los anteriores se sobreescriben. Si el pipeline está corriendo
          en otra fase, no se interrumpe — pero los próximos pasos usarán los nuevos mockups
          una vez los apruebes.
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ejemplos:&#10;- Cambia la paleta a tonos más cálidos (naranja/ámbar como acento principal)&#10;- El sidebar es muy oscuro, hazlo gris medio&#10;- Agrega una vista de perfil de usuario&#10;- El modal de reporte necesita un selector de fecha/hora"
          rows={6}
          style={{
            width: '100%', padding: '12px 14px', borderRadius: 10,
            border: `1px solid ${T.border}`, background: T.bg,
            fontFamily: 'inherit', fontSize: 13, color: T.text,
            lineHeight: 1.55, resize: 'vertical', outline: 'none',
          }}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy} style={{
            padding: '9px 16px', borderRadius: 8, background: 'transparent',
            border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 12.5, color: T.textDim, fontFamily: 'inherit',
          }}>Cancelar</button>
          <button
            onClick={() => onSubmit(text.trim())}
            disabled={text.trim().length < 5 || busy}
            style={{
              padding: '9px 16px', borderRadius: 8,
              background: text.trim().length < 5 || busy ? T.bgAlt : T.ink,
              color: text.trim().length < 5 || busy ? T.textFaint : '#fff',
              border: 'none', cursor: text.trim().length < 5 || busy ? 'not-allowed' : 'pointer',
              fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
            }}
          >{busy ? 'Aplicando…' : 'Aplicar cambios'}</button>
        </div>
      </div>
    </div>
  );
}

// Inject spin keyframe once for the loading spinner used in the Approve button
if (typeof document !== 'undefined' && !document.getElementById('studio-spin-keyframes')) {
  const style = document.createElement('style');
  style.id = 'studio-spin-keyframes';
  style.textContent = '@keyframes spin { to { transform: rotate(360deg) } }';
  document.head.appendChild(style);
}

function prettyCategory(c: string): string {
  switch (c) {
    case 'pages': return 'Pantallas';
    case 'organisms': return 'Organismos';
    case 'molecules': return 'Moléculas';
    case 'atoms': return 'Átomos';
    case 'root': return 'Otros';
    default: return c;
  }
}

// ─────────── Banner: regeneration in flight ───────────

function RegenerationBanner({
  projectId, hasStitch, mobbinCount,
}: {
  projectId: string;
  hasStitch: boolean;
  mobbinCount: number;
}) {
  const { events } = useWebSocket(projectId);

  const lastDesignGen = useMemo(() => {
    const filtered = events.filter((e) => e.type === 'design_generation');
    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
  }, [events]);

  const lastLog = useMemo(() => {
    const filtered = events.filter((e) => e.type === 'design_log');
    return filtered.length > 0 ? (filtered[filtered.length - 1].data?.line as string) ?? '' : '';
  }, [events]);

  const status = lastDesignGen?.data?.status as string | undefined;
  const isStarting = status === 'starting';
  const isFailed = status === 'failed';

  // Once Stitch metadata lands, the StitchDesignPanel takes over.
  if (hasStitch) return null;

  // Only show if we have evidence of an in-flight regen.
  if (!isStarting && mobbinCount === 0) return null;

  return (
    <div style={{
      background: 'oklch(98% 0.02 270)',
      border: '1px solid oklch(88% 0.06 270)',
      borderRadius: 12, padding: '14px 18px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Loader2 size={14} className="animate-spin" color="oklch(45% 0.18 270)" />
        <span style={{ fontSize: 13.5, fontWeight: 500, color: T.text }}>
          {isFailed
            ? 'La regeneración falló'
            : mobbinCount > 0 && !isStarting
              ? `Regeneración en curso — ${mobbinCount} pantalla${mobbinCount === 1 ? '' : 's'} con refs de Mobbin recopiladas`
              : 'Regenerando diseño en Stitch…'}
        </span>
      </div>
      <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.55 }}>
        Don Cheli está buscando referencias en <b>Mobbin</b> y creando el proyecto en <b>Google Stitch</b>.
        Mientras tanto verás el diseño anterior abajo. En 2–5 min aparecerá el panel "Diseño en Stitch" con el link.
      </div>
      {lastLog && (
        <div style={{
          fontFamily: T.fontMono, fontSize: 10.5, color: T.textFaint,
          background: 'rgba(0,0,0,0.04)', padding: '6px 8px', borderRadius: 6,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {lastLog}
        </div>
      )}
    </div>
  );
}

// ─────────── Stitch as source of truth (new flow) ───────────

function StitchDesignPanel({
  projectId, stitchUrl, screens, designBrief, mobbinCount, onRefresh,
}: {
  projectId: string;
  stitchUrl: string;
  screens: StitchScreen[];
  designBrief: string | null;
  mobbinCount: number;
  onRefresh: () => void;
}) {
  const [addScreensOpen, setAddScreensOpen] = useState(false);

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              padding: '3px 9px', borderRadius: 999,
              background: 'oklch(96% 0.04 270)', color: 'oklch(45% 0.18 270)',
              fontSize: 10.5, fontWeight: 500,
            }}>Source of truth</span>
            <span style={{ fontSize: 14.5, fontWeight: 500, color: T.text }}>
              Diseño en Google Stitch
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55, maxWidth: 640 }}>
            El diseño vive en Stitch — revisalo ahí, comentá o iterá. Cuando apruebes, Don Cheli baja el código de cada pantalla y regenera los componentes React.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => setAddScreensOpen(true)}
            style={{
              padding: '8px 14px', borderRadius: 8,
              background: T.panel, color: T.text,
              boxShadow: T.shadow, border: 'none',
              cursor: 'pointer',
              fontSize: 12.5, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >+ Agregar pantallas</button>
          <a
            href={stitchUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '8px 14px', borderRadius: 8,
              background: T.ink, color: '#fff',
              fontSize: 12.5, fontWeight: 500, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <ExternalLink size={13} strokeWidth={2} /> Abrir en Stitch
          </a>
        </div>
      </div>

      {addScreensOpen && (
        <AddScreensModal
          projectId={projectId}
          existingScreens={screens}
          onClose={() => setAddScreensOpen(false)}
          onStarted={() => { setAddScreensOpen(false); onRefresh(); }}
        />
      )}

      {designBrief && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: T.bgAlt, fontSize: 12.5, color: T.textDim,
          lineHeight: 1.55, whiteSpace: 'pre-wrap',
        }}>
          {designBrief}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <Stat label="Pantallas" value={String(screens.length || '—')} />
        <Stat label="Refs Mobbin" value={String(mobbinCount || '—')} />
      </div>

      <LogoSlot projectId={projectId} />

      {screens.length > 0 && (
        <ScreenPreviewsGrid
          projectId={projectId}
          stitchUrl={stitchUrl}
          fallbackScreens={screens}
        />
      )}
    </div>
  );
}

function ScreenPreviewsGrid({
  projectId, stitchUrl, fallbackScreens,
}: {
  projectId: string;
  stitchUrl: string;
  fallbackScreens: StitchScreen[];
}) {
  const [previews, setPreviews] = useState<ScreenPreview[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.design.screenPreviews(projectId)
      .then((r) => { if (!cancelled) setPreviews(r.previews); })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Pantallas generadas ({fallbackScreens.length})
        </span>
        {loading && (
          <span style={{ fontSize: 11, color: T.textFaint, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Loader2 size={11} className="animate-spin" /> Cargando miniaturas…
          </span>
        )}
      </div>

      {error ? (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: T.bgAlt, fontSize: 12, color: T.textDim, lineHeight: 1.5,
        }}>
          No pude cargar las miniaturas (puede tardar la primera vez). Reintenta en unos segundos o abrí el proyecto en Stitch.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}>
          {(previews ?? fallbackScreens.map((s): ScreenPreview => ({
            id: s.id, name: s.name, slug: s.slug, screenshot_url: null, width: null, height: null,
          }))).map((p) => (
            <a
              key={p.id}
              href={stitchUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                textDecoration: 'none', color: 'inherit',
                border: `1px solid ${T.border}`, borderRadius: 10,
                overflow: 'hidden', background: T.panel,
                display: 'flex', flexDirection: 'column',
                transition: 'transform .15s, box-shadow .15s',
                boxShadow: T.shadow,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = T.shadowLg; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = T.shadow; }}
            >
              <div style={{
                width: '100%', aspectRatio: '9 / 19',
                background: '#0A0E17',
                display: 'grid', placeItems: 'center',
                overflow: 'hidden',
              }}>
                {p.screenshot_url ? (
                  <img
                    src={p.screenshot_url}
                    alt={p.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    loading="lazy"
                  />
                ) : (
                  <div style={{ color: T.textFaint, fontSize: 11, padding: 12, textAlign: 'center' }}>
                    {loading ? 'Generando…' : 'Sin preview'}
                  </div>
                )}
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: T.text, lineHeight: 1.3, marginBottom: 2 }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 10.5, fontFamily: T.fontMono, color: T.textFaint }}>
                  {p.slug}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function AddScreensModal({
  projectId, existingScreens, onClose, onStarted,
}: {
  projectId: string;
  existingScreens: StitchScreen[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const [count, setCount] = useState(4);
  const [screensText, setScreensText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const screens = screensText
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await api.design.addScreens(projectId, { count, screens });
      if (r.status === 'started') {
        onStarted();
      } else {
        setError(`${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
        setBusy(false);
      }
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
            Agregar pantallas al diseño
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55 }}>
            Don Cheli va a crear más pantallas en el proyecto Stitch existente, sin tocar las {existingScreens.length} que ya hay. Toma como guía el blueprint, el audit y los Mobbin refs ya recopilados.
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11.5, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
            Pantallas existentes
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {existingScreens.map((s) => (
              <span key={s.id} style={{
                padding: '2px 8px', borderRadius: 999,
                background: T.bgAlt, color: T.textDim,
                fontSize: 11, border: `1px solid ${T.border}`,
              }}>{s.name || s.slug || s.id}</span>
            ))}
          </div>
        </div>

        <label style={{ fontSize: 12.5, color: T.text }}>
          <div style={{ marginBottom: 6 }}>Cuántas pantallas nuevas (1–6)</div>
          <input
            type="number"
            min={1}
            max={6}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(6, parseInt(e.target.value) || 4)))}
            style={{
              width: 80, padding: '7px 10px', borderRadius: 6,
              border: `1px solid ${T.border}`, background: T.panel,
              fontFamily: T.fontMono, fontSize: 13, color: T.text, outline: 'none',
            }}
          />
        </label>

        <label style={{ fontSize: 12.5, color: T.text }}>
          <div style={{ marginBottom: 6 }}>Nombres específicos (opcional — separados por coma o nueva línea)</div>
          <textarea
            value={screensText}
            onChange={(e) => setScreensText(e.target.value)}
            placeholder="Ej: garage, sos, convoys, premium"
            rows={3}
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${T.border}`, background: T.bgAlt,
              fontFamily: 'inherit', fontSize: 12.5, color: T.text,
              outline: 'none', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
          <div style={{ fontSize: 11, color: T.textFaint, marginTop: 4, lineHeight: 1.5 }}>
            Dejalo vacío y Don Cheli elige las más impactantes del journey según el blueprint y el audit.
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
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            {busy ? 'Iniciando…' : `Crear ${count} pantallas más`}
          </button>
        </div>
      </div>
    </div>
  );
}

function LogoSlot({ projectId }: { projectId: string }) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.design.listAssets(projectId);
      const logo = r.assets.find((a) => a.name === 'logo');
      // Bust the cache when refreshing after upload so the <img> reloads.
      setLogoUrl(logo ? `${logo.url}?t=${Date.now()}` : null);
    } catch {
      setLogoUrl(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleFile = async (file: File) => {
    const allowed = ['png', 'jpg', 'jpeg', 'svg', 'webp'];
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!allowed.includes(ext)) {
      setError('Formato no soportado. Usa png, jpg, svg o webp.');
      window.setTimeout(() => setError(null), 4000);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Logo demasiado grande (máx 5 MB).');
      window.setTimeout(() => setError(null), 4000);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = window.btoa(binary);
      await api.design.uploadAsset(projectId, { name: 'logo', ext, data_base64: b64 });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo subir el logo');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDelete = async () => {
    if (!logoUrl) return;
    if (!window.confirm('¿Quitar el logo? La próxima generación de diseño no lo incluirá.')) return;
    setBusy(true);
    try {
      // logoUrl is like /api/.../asset/logo.png?t=... — extract just filename
      const m = logoUrl.match(/\/asset\/([^?]+)/);
      if (m) await api.design.deleteAsset(projectId, m[1]);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      background: T.bgAlt, border: `1px solid ${T.border}`,
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 10,
        background: T.panel, border: `1px solid ${T.border}`,
        display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0,
      }}>
        {loading ? (
          <Loader2 size={16} color={T.textFaint} className="animate-spin" />
        ) : logoUrl ? (
          <img src={logoUrl} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <ImageIcon size={20} color={T.textFaint} />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: T.text, marginBottom: 2 }}>
          {logoUrl ? 'Logo del proyecto' : 'Subí el logo del proyecto'}
        </div>
        <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.5 }}>
          {logoUrl
            ? 'La próxima generación de pantallas en Stitch va a incluirlo en todas las screens (header, splash, etc.).'
            : 'Si tu app tiene un logo, lo describimos a Stitch para que aparezca consistente en todas las pantallas. Opcional. Formatos: png, jpg, svg, webp.'}
        </div>
        {error && (
          <div style={{ fontSize: 11, color: T.warn, marginTop: 4 }}>{error}</div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          style={{
            padding: '7px 14px', borderRadius: 6,
            background: T.ink, color: '#fff', border: 'none',
            fontSize: 12, fontFamily: 'inherit', fontWeight: 500,
            cursor: busy ? 'wait' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
          {busy ? 'Subiendo…' : logoUrl ? 'Reemplazar' : 'Subir logo'}
        </button>
        {logoUrl && (
          <button
            onClick={handleDelete}
            disabled={busy}
            style={{
              padding: '4px 10px', borderRadius: 6,
              background: 'transparent', color: T.textFaint, border: 'none',
              fontSize: 11, fontFamily: 'inherit',
              cursor: busy ? 'wait' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'center',
            }}
          >
            <Trash2 size={10} /> Quitar
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: T.textFaint, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 500, color: T.text, fontFamily: T.fontMono }}>{value}</div>
    </div>
  );
}

// ─────────── Code regeneration (step 6: Stitch → React/Next) ───────────

type VerifStatus =
  | 'starting' | 'stack_selected' | 'installing' | 'building'
  | 'smoke_testing' | 'security_scanning' | 'fixing'
  | 'passed' | 'blocked' | 'failed' | 'skipped';

interface StepState {
  state: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
  detail?: string;
}

function deriveSteps(verifEvents: WsEvent[], codeStatus: string | undefined): Record<string, StepState> {
  const steps: Record<string, StepState> = {
    code: { state: 'pending' },
    install: { state: 'pending' },
    build: { state: 'pending' },
    smoke: { state: 'pending' },
    security: { state: 'pending' },
  };

  // Code generation step
  if (codeStatus === 'starting') steps.code.state = 'running';
  else if (codeStatus === 'failed') steps.code.state = 'failed';
  else if (codeStatus === 'code_written' || codeStatus === 'completed') steps.code.state = 'passed';

  for (const ev of verifEvents) {
    const status = (ev.data?.status as VerifStatus | undefined) ?? undefined;
    const details = (ev.data?.details as Record<string, unknown> | undefined) ?? {};
    const step = (details.step as string | undefined) ?? '';
    switch (status) {
      case 'installing': steps.install.state = 'running'; break;
      case 'building':
        if (steps.install.state === 'running') steps.install.state = 'passed';
        steps.build.state = 'running';
        break;
      case 'smoke_testing':
        if (steps.build.state === 'running') steps.build.state = 'passed';
        steps.smoke.state = 'running';
        break;
      case 'security_scanning':
        if (steps.smoke.state === 'running') steps.smoke.state = 'passed';
        steps.security.state = 'running';
        break;
      case 'fixing':
        if (step === 'build' && steps.build.state === 'running') steps.build.detail = 'auto-fix en curso';
        if (step === 'smoke' && steps.smoke.state === 'running') steps.smoke.detail = 'auto-fix en curso';
        break;
      case 'failed':
        if (step === 'install') steps.install.state = 'failed';
        else if (step === 'build') steps.build.state = 'failed';
        else if (step === 'smoke') steps.smoke.state = 'failed';
        else if (step === 'security') steps.security.state = 'failed';
        break;
      case 'blocked':
        if (step === 'security') {
          steps.security.state = 'blocked';
          const sec = details.security as Record<string, unknown> | undefined;
          if (sec) {
            const crit = (sec.critical as number) ?? 0;
            const high = (sec.high as number) ?? 0;
            steps.security.detail = `${crit} críticos · ${high} altos`;
          }
        }
        break;
      case 'passed': {
        // Promote any earlier "running" to "passed".
        for (const k of Object.keys(steps)) {
          if (steps[k].state === 'running') steps[k].state = 'passed';
        }
        // Security passed: annotate with findings count.
        const sec = details.security as Record<string, unknown> | undefined;
        if (sec) {
          const skipped = sec.skipped as string | undefined;
          if (skipped) {
            steps.security.state = 'skipped';
            steps.security.detail = skipped.slice(0, 40);
          } else {
            steps.security.state = 'passed';
            const high = (sec.high as number) ?? 0;
            const med = (sec.medium as number) ?? 0;
            steps.security.detail = `0 críticos · ${high} altos · ${med} medios`;
          }
        }
        break;
      }
      case 'skipped':
        steps.install.state = 'skipped';
        steps.build.state = 'skipped';
        steps.smoke.state = 'skipped';
        steps.security.state = 'skipped';
        break;
      default:
        break;
    }
  }
  return steps;
}

function CodeRegenerationPanel({ projectId }: { projectId: string }) {
  const { events } = useWebSocket(projectId);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryToast, setRetryToast] = useState<string | null>(null);

  const regenEvents = useMemo(
    () => events.filter((e) => e.type === 'code_regeneration'),
    [events],
  );
  const verifEvents = useMemo(
    () => events.filter((e) => e.type === 'code_verification'),
    [events],
  );
  const regenLogs = useMemo(
    () => events
      .filter((e) => e.type === 'code_regeneration_log' || e.type === 'code_verification_log')
      .map((e) => {
        // New format (stream-json): events have a `summary` field with a
        // human-friendly emoji-prefixed line. Legacy format uses `line`.
        const summary = (e.data?.summary as string) ?? '';
        const line = (e.data?.line as string) ?? '';
        const text = summary || line;
        const step = (e.data?.step as string) ?? '';
        return step ? `[${step}] ${text}` : text;
      })
      .filter(Boolean),
    [events],
  );

  const latestStatus = regenEvents.length > 0
    ? (regenEvents[regenEvents.length - 1].data?.status as string | undefined)
    : undefined;
  const latestVerif = verifEvents.length > 0
    ? (verifEvents[verifEvents.length - 1].data?.status as VerifStatus | undefined)
    : undefined;

  const steps = useMemo(
    () => deriveSteps(verifEvents, latestStatus),
    [verifEvents, latestStatus],
  );

  const isRunning = latestStatus === 'starting' || latestStatus === 'code_written'
    || (latestVerif && !['passed', 'blocked', 'failed', 'skipped'].includes(latestVerif));
  const isBlocked = latestVerif === 'blocked';
  const isComplete = latestStatus === 'completed' && !isBlocked;
  const isFailed = latestStatus === 'failed' || latestVerif === 'failed';

  const handleRetry = async () => {
    setRetryBusy(true);
    setRetryError(null);
    try {
      const res = await api.design.applyToCode(projectId);
      if (res.status === 'started') {
        setRetryToast('Regenerando código desde Stitch…');
      } else {
        setRetryToast(`Estado: ${res.status}${res.reason ? ` — ${res.reason}` : ''}`);
      }
      window.setTimeout(() => setRetryToast(null), 4000);
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : 'No se pudo iniciar la regeneración');
    } finally {
      setRetryBusy(false);
    }
  };

  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Code2 size={14} color={T.text} />
            <span style={{ fontSize: 14.5, fontWeight: 500, color: T.text }}>
              Regeneración de código + verificación
            </span>
            {isRunning && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Loader2 size={12} className="animate-spin" color={T.textDim} />
                <span style={{ fontSize: 11, color: T.textDim }}>{labelForVerif(latestVerif) || 'En curso…'}</span>
              </span>
            )}
            {isComplete && (
              <span style={{
                padding: '2px 8px', borderRadius: 999,
                background: T.successBg, color: T.success,
                fontSize: 10.5, fontWeight: 500,
              }}>✓ Listo para producción</span>
            )}
            {isBlocked && (
              <span style={{
                padding: '2px 8px', borderRadius: 999,
                background: T.warnBg, color: T.warn,
                fontSize: 10.5, fontWeight: 500,
              }}>⚠ Bloqueado por seguridad</span>
            )}
            {isFailed && !isBlocked && (
              <span style={{
                padding: '2px 8px', borderRadius: 999,
                background: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)',
                fontSize: 10.5, fontWeight: 500,
              }}>✗ Falló</span>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55, maxWidth: 640 }}>
            Al aprobar, Don Cheli traduce las pantallas Stitch a código, instala dependencias, hace build, smoke-test (arranca el dev server) y un audit OWASP Top 10 antes de marcar listo.
          </div>
        </div>
        <button
          onClick={handleRetry}
          disabled={retryBusy || isRunning}
          style={{
            padding: '8px 14px', borderRadius: 8,
            background: (retryBusy || isRunning) ? T.bgAlt : T.panel,
            color: (retryBusy || isRunning) ? T.textFaint : T.text,
            boxShadow: T.shadow, border: 'none',
            cursor: (retryBusy || isRunning) ? 'not-allowed' : 'pointer',
            fontSize: 12.5, fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <RefreshCw size={13} />
          {isRunning ? 'En curso…' : 'Regenerar código'}
        </button>
      </div>

      {/* Stepper */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 8,
      }}>
        <StepChip name="Código" state={steps.code.state} detail={steps.code.detail} />
        <StepChip name="Install" state={steps.install.state} detail={steps.install.detail} />
        <StepChip name="Build" state={steps.build.state} detail={steps.build.detail} />
        <StepChip name="Smoke test" state={steps.smoke.state} detail={steps.smoke.detail} />
        <StepChip name="Seguridad" state={steps.security.state} detail={steps.security.detail} />
      </div>

      {retryToast && (
        <div style={{ fontSize: 12, color: T.textDim }}>{retryToast}</div>
      )}
      {retryError && (
        <div style={{ fontSize: 12, color: 'oklch(50% 0.18 25)' }}>{retryError}</div>
      )}

      {/* Live activity banner — shows the most recent action of the agent so
          the user always sees the framework is "doing something". */}
      {isRunning && regenLogs.length > 0 && (
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'oklch(96% 0.04 270)',
          border: '1px solid oklch(88% 0.06 270)',
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
          color: T.text,
        }}>
          <Loader2 size={12} className="animate-spin" color="oklch(45% 0.18 270)" />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {regenLogs[regenLogs.length - 1]}
          </span>
        </div>
      )}

      {regenLogs.length > 0 && (
        <div style={{
          maxHeight: 240, overflowY: 'auto',
          background: '#0f1114', color: '#cfd2d6',
          fontFamily: T.fontMono, fontSize: 11,
          padding: '10px 12px', borderRadius: 8,
          lineHeight: 1.5,
        }}>
          {regenLogs.slice(-200).map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function labelForVerif(s: VerifStatus | undefined): string | null {
  switch (s) {
    case 'installing': return 'Instalando dependencias…';
    case 'building': return 'Compilando…';
    case 'smoke_testing': return 'Probando la app en vivo…';
    case 'security_scanning': return 'Auditando OWASP Top 10…';
    case 'fixing': return 'Auto-fix en curso…';
    case 'stack_selected': return 'Detectando stack…';
    case 'starting': return 'Iniciando verificación…';
    default: return null;
  }
}

function StepChip({ name, state, detail }: { name: string; state: StepState['state']; detail?: string }) {
  const config: Record<StepState['state'], { bg: string; color: string; icon: string }> = {
    pending:  { bg: T.bgAlt,    color: T.textFaint,                  icon: '○' },
    running:  { bg: 'oklch(96% 0.04 270)', color: 'oklch(45% 0.18 270)', icon: '◐' },
    passed:   { bg: T.successBg, color: T.success,                   icon: '✓' },
    failed:   { bg: 'oklch(96% 0.06 25)', color: 'oklch(50% 0.18 25)', icon: '✗' },
    blocked:  { bg: T.warnBg,   color: T.warn,                       icon: '⚠' },
    skipped:  { bg: T.bgAlt,    color: T.textFaint,                  icon: '—' },
  };
  const c = config[state];
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 8,
      background: c.bg, color: c.color,
      fontSize: 11.5,
      display: 'flex', flexDirection: 'column', gap: 2,
      border: `1px solid ${T.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
        <span style={{ fontSize: 12 }}>{c.icon}</span>
        {name}
      </div>
      {detail && (
        <div style={{ fontSize: 10.5, color: c.color, opacity: 0.85, lineHeight: 1.3 }}>
          {detail}
        </div>
      )}
    </div>
  );
}
