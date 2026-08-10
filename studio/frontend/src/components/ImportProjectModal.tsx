import { useEffect, useState } from 'react';
import { X, Home, ArrowUp, ChevronRight, FolderOpen, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { api, type DirEntry, type ProjectScanResult } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import. Receives the new project id. */
  onImported: (projectId: string) => void;
  initialPath?: string;
}

export function ImportProjectModal({ open, onClose, onImported, initialPath }: Props) {
  const [path, setPath] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  const [scan, setScan] = useState<ProjectScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [generateBlueprint, setGenerateBlueprint] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingDir(true);
    setDirError(null);

    api.filesystem.browse(path || initialPath)
      .then((res) => {
        if (cancelled) return;
        setPath(res.current);
        setParent(res.parent);
        setEntries(res.entries.filter((e) => e.is_dir));
      })
      .catch((e) => {
        if (!cancelled) setDirError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoadingDir(false); });

    return () => { cancelled = true; };
  }, [path, open, initialPath]);

  useEffect(() => {
    if (open) {
      setPath(initialPath ?? '');
      setScan(null);
      setScanError(null);
      setImportError(null);
      setName('');
    }
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Scan whenever path changes (debounced)
  useEffect(() => {
    if (!open || !path) {
      setScan(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setScanning(true);
      setScanError(null);
      api.projects.scan(path)
        .then((r) => {
          if (cancelled) return;
          setScan(r);
          setName(r.suggested_name || path.split('/').filter(Boolean).pop() || 'project');
        })
        .catch((e) => {
          if (!cancelled) setScanError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => { if (!cancelled) setScanning(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [path, open]);

  const handleImport = async () => {
    if (!path || !name.trim() || !scan) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await api.projects.import(name.trim(), path, generateBlueprint);
      onImported(res.project.id);
      onClose();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'No se pudo importar el proyecto');
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  const canImport = !!scan && scan.exists && scan.is_directory && !scan.already_imported && name.trim().length > 0;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(17, 18, 22, 0.55)',
        display: 'grid', placeItems: 'center',
        animation: 'studioFadeIn 0.2s cubic-bezier(.22,1,.36,1)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(940px, 94vw)',
          maxHeight: '82vh',
          background: T.panel,
          borderRadius: 14,
          boxShadow: T.shadowLg,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: T.fontSans,
          animation: 'studioFadeIn 0.24s cubic-bezier(.22,1,.36,1)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 500, color: T.text, letterSpacing: -0.2 }}>
              Importar proyecto existente
            </div>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 2, maxWidth: 640, lineHeight: 1.5 }}>
              Don Cheli detecta tu stack y crea un blueprint para que pueda iterar sobre el código actual, no generar desde cero.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              cursor: 'pointer', color: T.textFaint, padding: 4,
              marginLeft: 12, background: 'transparent', border: 'none',
              display: 'inline-flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: two-column layout */}
        <div style={{ display: 'flex', flex: 1, minHeight: 360, overflow: 'hidden' }}>
          {/* Left: picker */}
          <div style={{ width: 380, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
              background: T.bgAlt, display: 'flex', gap: 8, alignItems: 'center',
            }}>
              <NavButton title="Home" onClick={() => setPath('')} icon={Home} />
              <NavButton title="Subir" disabled={!parent} onClick={() => parent && setPath(parent)} icon={ArrowUp} />
              <div style={{
                flex: 1, padding: '5px 10px', background: T.panel, borderRadius: 6,
                fontFamily: T.fontMono, fontSize: 11, color: T.textDim,
                border: `1px solid ${T.border}`,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{path || '…'}</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
              {dirError ? (
                <div style={{ padding: '20px 14px', color: T.warn, fontSize: 12 }}>{dirError}</div>
              ) : loadingDir ? (
                <div style={{ padding: '20px 14px', color: T.textFaint, fontSize: 12 }}>Cargando…</div>
              ) : entries.length === 0 ? (
                <div style={{ padding: '20px 14px', color: T.textFaint, fontSize: 12 }}>Vacío.</div>
              ) : entries.map((e) => (
                <div
                  key={e.path}
                  onClick={() => setPath(e.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                    background: path === e.path ? T.bgAlt : 'transparent',
                  }}
                  onMouseEnter={(ev) => { if (path !== e.path) ev.currentTarget.style.background = T.bgAlt; }}
                  onMouseLeave={(ev) => { if (path !== e.path) ev.currentTarget.style.background = 'transparent'; }}
                >
                  <FolderOpen size={13} color={e.is_git ? 'oklch(45% 0.18 270)' : T.textDim} />
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.name}
                  </div>
                  {e.is_git && <Tag bg="oklch(96% 0.04 270)" color="oklch(50% 0.18 270)">git</Tag>}
                  <ChevronRight size={12} color={T.textFaint} />
                </div>
              ))}
            </div>
          </div>

          {/* Right: preview */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
            {!path ? (
              <EmptyHint text="Elige una carpeta de la izquierda para escanearla." />
            ) : scanning ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.textDim, fontSize: 12.5 }}>
                <Loader2 size={14} className="animate-spin" /> Escaneando…
              </div>
            ) : scanError ? (
              <div style={{ color: T.warn, fontSize: 12.5 }}>
                <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                {scanError}
              </div>
            ) : scan ? (
              <ScanPreview
                scan={scan}
                name={name}
                onNameChange={setName}
                generateBlueprint={generateBlueprint}
                onGenerateBlueprintChange={setGenerateBlueprint}
              />
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px', borderTop: `1px solid ${T.border}`,
          background: T.bgAlt,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ fontSize: 11.5, color: T.textFaint }}>
            {scan?.already_imported
              ? `Ya importado como "${scan.already_imported_as ?? ''}".`
              : 'Don Cheli no modificará archivos hasta que apruebes el diseño.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {importError && (
              <span style={{ color: T.warn, fontSize: 12, alignSelf: 'center' }}>{importError}</span>
            )}
            <button
              onClick={onClose}
              style={{
                border: 'none', background: T.panel, color: T.textDim,
                padding: '7px 14px', borderRadius: 6, fontFamily: 'inherit',
                fontSize: 12.5, cursor: 'pointer', boxShadow: T.shadow,
              }}
            >Cancelar</button>
            <button
              onClick={handleImport}
              disabled={!canImport || importing}
              style={{
                border: 'none',
                background: canImport && !importing ? T.ink : T.bgAlt,
                color: canImport && !importing ? '#fff' : T.textFaint,
                padding: '7px 14px', borderRadius: 6, fontFamily: 'inherit',
                fontSize: 12.5, fontWeight: 500,
                cursor: canImport && !importing ? 'pointer' : 'not-allowed',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {importing ? <Loader2 size={13} className="animate-spin" /> : null}
              Importar proyecto
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScanPreview({
  scan, name, onNameChange, generateBlueprint, onGenerateBlueprintChange,
}: {
  scan: ProjectScanResult;
  name: string;
  onNameChange: (v: string) => void;
  generateBlueprint: boolean;
  onGenerateBlueprintChange: (v: boolean) => void;
}) {
  if (!scan.exists || !scan.is_directory) {
    return <EmptyHint text="La ruta no existe o no es una carpeta." warn />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {scan.already_imported && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: T.warnBg, color: T.warn, fontSize: 12.5,
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          <div>
            Esta carpeta ya fue importada como <b>{scan.already_imported_as}</b>. Abre el proyecto existente en lugar de duplicarlo.
          </div>
        </div>
      )}

      {/* Name */}
      <Field label="Nombre del proyecto">
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          disabled={scan.already_imported}
          style={{
            width: '100%', padding: '7px 10px', borderRadius: 6,
            border: `1px solid ${T.border}`, background: T.panel,
            fontFamily: 'inherit', fontSize: 13, color: T.text,
            outline: 'none',
          }}
        />
      </Field>

      {/* Detected stack */}
      <Field label="Stack detectado">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <StackChip label={scan.framework ?? 'Sin framework'} />
          {scan.package_manager && <StackChip label={scan.package_manager} />}
          {scan.has_git && <StackChip label="git" subtle />}
          {scan.has_dc_artifacts && <StackChip label="dc artifacts" subtle />}
          <StackChip label={`${scan.file_count.toLocaleString()} archivos`} subtle />
        </div>
      </Field>

      {/* Services */}
      {scan.services_detected.length > 0 && (
        <Field label={`Servicios externos (${scan.services_detected.length})`}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {scan.services_detected.map((s) => (
              <StackChip key={s.id} label={s.name} />
            ))}
          </div>
        </Field>
      )}

      {/* Dependencies (subset) */}
      {scan.dependencies.length > 0 && (
        <Field label={`Dependencias principales (${scan.dependencies.length})`}>
          <div style={{
            fontFamily: T.fontMono, fontSize: 11.5, color: T.textDim,
            lineHeight: 1.6, maxHeight: 80, overflowY: 'auto',
          }}>
            {scan.dependencies.slice(0, 30).join(' · ')}
            {scan.dependencies.length > 30 && ' …'}
          </div>
        </Field>
      )}

      {/* Git remote */}
      {scan.git_remote && (
        <Field label="Remote git">
          <div style={{ fontFamily: T.fontMono, fontSize: 11.5, color: T.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {scan.git_remote}
          </div>
        </Field>
      )}

      {/* README excerpt */}
      {scan.readme_excerpt && (
        <Field label="README">
          <div style={{
            fontSize: 12, color: T.textDim, lineHeight: 1.55,
            background: T.bgAlt, padding: '8px 10px', borderRadius: 6,
            maxHeight: 90, overflowY: 'auto', whiteSpace: 'pre-wrap',
          }}>
            {scan.readme_excerpt}
          </div>
        </Field>
      )}

      {/* Generate blueprint toggle */}
      <label style={{
        display: 'flex', gap: 8, alignItems: 'flex-start',
        padding: '10px 12px', borderRadius: 8, background: T.bgAlt,
        cursor: 'pointer',
      }}>
        <input
          type="checkbox"
          checked={generateBlueprint}
          onChange={(e) => onGenerateBlueprintChange(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <div>
          <div style={{ fontSize: 12.5, color: T.text, fontWeight: 500 }}>
            Generar blueprint (recomendado)
          </div>
          <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2, lineHeight: 1.5 }}>
            Escribe <code style={{ fontFamily: T.fontMono, fontSize: 11 }}>.dc/blueprints/imported.md</code> describiendo el stack actual para que Don Cheli itere en lugar de generar desde cero.
          </div>
        </div>
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.success, fontSize: 12 }}>
        <CheckCircle2 size={13} /> Carpeta válida para importar.
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: T.textFaint, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function StackChip({ label, subtle }: { label: string; subtle?: boolean }) {
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 999,
      background: subtle ? T.bgAlt : 'oklch(96% 0.04 270)',
      color: subtle ? T.textDim : 'oklch(45% 0.18 270)',
      fontSize: 11, fontWeight: 500,
      border: `1px solid ${T.border}`,
    }}>{label}</span>
  );
}

function EmptyHint({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <div style={{
      padding: '40px 12px', textAlign: 'center',
      color: warn ? T.warn : T.textFaint, fontSize: 12.5,
    }}>{text}</div>
  );
}

function NavButton({
  title, onClick, disabled, icon: Icon,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  icon: typeof Home;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        border: 'none',
        background: disabled ? 'transparent' : T.panel,
        padding: '5px 9px', borderRadius: 6,
        fontFamily: 'inherit', fontSize: 12,
        color: disabled ? T.textFaint : T.textDim,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: disabled ? 'none' : T.shadow,
        display: 'inline-flex', alignItems: 'center',
      }}
    >
      <Icon size={13} strokeWidth={1.8} />
    </button>
  );
}

function Tag({ bg, color, children }: { bg: string; color: string; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 7px', borderRadius: 999,
      background: bg, color, fontSize: 10, fontWeight: 500,
    }}>{children}</span>
  );
}
