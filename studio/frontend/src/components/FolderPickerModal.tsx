import { useEffect, useState } from 'react';
import { X, Home, ArrowUp, FolderPlus, ChevronRight } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { api, type DirEntry } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the absolute path of the chosen folder. */
  onSelect: (path: string) => void;
  /** Optional starting path. Defaults to $HOME. */
  initialPath?: string;
}

export function FolderPickerModal({ open, onClose, onSelect, initialPath }: Props) {
  const [path, setPath] = useState<string>('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  // Load directory whenever path changes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.filesystem.browse(path || initialPath)
      .then((res) => {
        if (cancelled) return;
        setPath(res.current);
        setParent(res.parent);
        setEntries(res.entries.filter((e) => e.is_dir));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [path, open, initialPath]);

  // Reset state when reopened
  useEffect(() => {
    if (open) {
      setCreating(false);
      setNewName('');
      setError(null);
      // Trigger fresh load with initialPath
      setPath(initialPath ?? '');
    }
  }, [open, initialPath]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const newPath = path.endsWith('/') ? path + name : `${path}/${name}`;
    try {
      await api.filesystem.mkdir(newPath);
      onSelect(newPath);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear la carpeta');
    }
  };

  if (!open) return null;

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
          width: 'min(560px, 92vw)',
          maxHeight: '78vh',
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
              Selecciona la carpeta del proyecto
            </div>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 2, maxWidth: 440, lineHeight: 1.5 }}>
              Don Cheli va a trabajar sobre la carpeta que elijas. Tus archivos no se modifican hasta que pasen los controles de calidad.
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

        {/* Breadcrumb */}
        <div style={{
          padding: '10px 16px', borderBottom: `1px solid ${T.border}`,
          background: T.bgAlt, display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <NavButton title="Home" onClick={() => setPath('')} icon={Home} />
          <NavButton title="Subir" disabled={!parent} onClick={() => parent && setPath(parent)} icon={ArrowUp} />
          <div style={{
            flex: 1, padding: '5px 10px', background: T.panel, borderRadius: 6,
            fontFamily: T.fontMono, fontSize: 11.5, color: T.textDim,
            border: `1px solid ${T.border}`,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{path || '…'}</div>
          <button
            onClick={() => { onSelect(path); onClose(); }}
            disabled={!path}
            style={{
              border: 'none',
              background: path ? T.ink : T.bgAlt,
              color: path ? '#fff' : T.textFaint,
              padding: '6px 12px', borderRadius: 6, fontFamily: 'inherit',
              fontSize: 12, fontWeight: 500,
              cursor: path ? 'pointer' : 'not-allowed',
            }}
          >Elegir esta</button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 240 }}>
          {error ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: T.warn, fontSize: 12.5 }}>
              {error}
            </div>
          ) : loading ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: T.textFaint, fontSize: 12.5 }}>
              Cargando…
            </div>
          ) : entries.length === 0 ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: T.textFaint, fontSize: 12.5 }}>
              No hay carpetas en este nivel.
            </div>
          ) : entries.map((e, i) => (
            <div
              key={e.path}
              onClick={() => setPath(e.path)}
              onDoubleClick={() => { onSelect(e.path); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
                background: 'transparent',
                border: e.is_git ? `1px solid ${T.border}` : '1px solid transparent',
                transition: 'background .12s ease',
                animation: `studioFadeIn 0.18s ${i * 0.015}s cubic-bezier(.22,1,.36,1) both`,
              }}
              onMouseEnter={(ev) => { ev.currentTarget.style.background = T.bgAlt; }}
              onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{
                width: 28, height: 28, borderRadius: 6,
                background: e.is_git ? 'oklch(96% 0.02 270)' : T.bgAlt,
                color: e.is_git ? 'oklch(45% 0.18 270)' : T.textDim,
                display: 'grid', placeItems: 'center', fontSize: 13, flexShrink: 0,
              }}>{e.is_git ? '⌥' : '▢'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: e.is_git ? 500 : 400, color: T.text }}>
                  {e.name}
                </div>
                {e.is_git && (
                  <div style={{
                    fontSize: 11, color: T.textFaint,
                    fontFamily: T.fontMono, marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {e.path}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                {e.has_package_json && (
                  <Tag bg="oklch(96% 0.04 60)" color="oklch(50% 0.15 60)">npm</Tag>
                )}
                {e.is_git && (
                  <Tag bg="oklch(96% 0.04 270)" color="oklch(50% 0.18 270)">git</Tag>
                )}
                <ChevronRight size={14} color={T.textFaint} />
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px', borderTop: `1px solid ${T.border}`,
          background: T.bgAlt,
        }}>
          {creating ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) handleCreate();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
                placeholder="Nombre de la carpeta nueva"
                style={{
                  flex: 1, padding: '6px 10px', borderRadius: 6,
                  border: `1px solid ${T.border}`, background: T.panel,
                  fontFamily: 'inherit', fontSize: 12.5, color: T.text,
                  outline: 'none',
                }}
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                style={{
                  border: 'none', background: T.ink, color: '#fff',
                  padding: '6px 12px', borderRadius: 6, fontFamily: 'inherit',
                  fontSize: 12, fontWeight: 500,
                  cursor: newName.trim() ? 'pointer' : 'not-allowed',
                  opacity: newName.trim() ? 1 : 0.4,
                }}
              >Crear y elegir</button>
              <button
                onClick={() => { setCreating(false); setNewName(''); }}
                style={{
                  border: 'none', background: T.panel, color: T.textDim,
                  padding: '6px 12px', borderRadius: 6, fontFamily: 'inherit',
                  fontSize: 12, cursor: 'pointer', boxShadow: T.shadow,
                }}
              >Cancelar</button>
            </div>
          ) : (
            <span
              onClick={() => setCreating(true)}
              style={{
                fontSize: 12.5, color: T.textDim, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
              onMouseLeave={(e) => (e.currentTarget.style.color = T.textDim)}
            >
              <FolderPlus size={13} strokeWidth={1.8} />
              Crear una carpeta nueva aquí
            </span>
          )}
        </div>
      </div>
    </div>
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
