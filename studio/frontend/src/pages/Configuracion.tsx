import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, ExternalLink, Copy, RefreshCw, Plug, Settings as SettingsIcon, Trash2, Download, Loader2 } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioTopBar, StudioBody, StudioButton } from '../components/StudioShell';
import { api, type SystemInfo, type McpListResponse, type McpServer, type McpSuggestion } from '../lib/api';

interface SettingRow {
  label: string;
  desc: string;
  value: string;
  action?: string;
}

type Tab = 'general' | 'mcps';

function buildRows(info: SystemInfo | null): SettingRow[] {
  const hooks = info?.hooks_installed;
  const installed = hooks && (hooks.claude || hooks.codex || hooks.opencode);
  const hookValue = installed
    ? `Claude ${hooks?.claude ? '✓' : '✗'} · Codex ${hooks?.codex ? '✓' : '✗'} · OpenCode ${hooks?.opencode ? '✓' : '✗'}`
    : 'No instalados';

  return [
    { label: 'Idioma',              desc: 'Idioma de Don Cheli Studio y los comandos.',                    value: 'Español',       action: 'Cambiar' },
    { label: 'Editor por defecto',  desc: 'El editor IA que se usa cuando creas un proyecto nuevo.',      value: 'Claude Code',   action: 'Cambiar' },
    { label: 'Presupuesto mensual', desc: 'Tope de gasto que Don Cheli no debe sobrepasar este mes.',     value: '$100.00 USD',   action: 'Cambiar' },
    { label: 'Carpeta de proyectos',desc: 'Dónde guardar los proyectos creados desde Studio.',            value: '~/Documents/Proyectos', action: 'Cambiar' },
    { label: 'Hooks de proveedor',  desc: 'Eventos de Claude, Codex y OpenCode se reportan al Studio.',   value: hookValue,       action: installed ? 'Reinstalar' : 'Instalar' },
    { label: 'Auto-actualización',  desc: 'Verificar actualizaciones del framework al iniciar sesión.',   value: 'Activada',      action: 'Cambiar' },
    { label: 'Telemetría',          desc: 'Compartir uso anónimo para mejorar Don Cheli.',                value: 'Desactivada',   action: 'Cambiar' },
  ];
}

export function Configuracion() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [tab, setTab] = useState<Tab>('general');

  useEffect(() => {
    let cancelled = false;
    api.system.info()
      .then((d) => { if (!cancelled) setInfo(d); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  const ROWS = buildRows(info);
  const version = info?.framework_version ?? '—';
  const root = info?.framework_root ?? '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <StudioTopBar title="Configuración" subtitle="Preferencias generales del Studio" />

      <StudioBody>
        <div style={{ maxWidth: 820 }}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `1px solid ${T.border}` }}>
            <TabBtn active={tab === 'general'} onClick={() => setTab('general')} icon={<SettingsIcon size={13} />}>General</TabBtn>
            <TabBtn active={tab === 'mcps'} onClick={() => setTab('mcps')} icon={<Plug size={13} />}>MCPs</TabBtn>
          </div>

          {tab === 'general' && (
            <>
              <div style={{
                background: T.panel, borderRadius: 12, boxShadow: T.shadow, overflow: 'hidden',
              }}>
                {ROWS.map((row, i) => (
                  <div key={row.label} style={{
                    padding: '16px 20px',
                    borderBottom: i < ROWS.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
                    display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 24,
                  }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: T.text, marginBottom: 3 }}>
                        {row.label}
                      </div>
                      <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5 }}>
                        {row.desc}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12.5, color: T.textDim, fontFamily: T.fontMono }}>{row.value}</span>
                      {row.action && <StudioButton>{row.action}</StudioButton>}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{
                marginTop: 16, padding: '14px 16px',
                background: T.bgAlt, borderRadius: 10, border: `1px solid ${T.border}`,
                fontSize: 12.5, color: T.textDim, lineHeight: 1.55,
              }}>
                Framework v{version} · Studio en <code style={{ fontFamily: T.fontMono }}>{root}</code>
              </div>
            </>
          )}

          {tab === 'mcps' && <McpsPanel />}
        </div>
      </StudioBody>
    </div>
  );
}

function TabBtn({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        padding: '8px 14px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        color: active ? T.text : T.textDim,
        fontWeight: active ? 500 : 400,
        borderBottom: active ? `2px solid ${T.ink}` : '2px solid transparent',
        marginBottom: -1,
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function McpsPanel() {
  const [data, setData] = useState<McpListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ kind: 'install' | 'uninstall' | 'toggle'; key: string } | null>(null);
  const [opMessage, setOpMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api.mcps.list()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const flashOp = (tone: 'ok' | 'err', text: string) => {
    setOpMessage({ tone, text });
    window.setTimeout(() => setOpMessage(null), 4500);
  };

  const handleInstall = async (s: McpSuggestion) => {
    setBusy({ kind: 'install', key: s.id });
    try {
      const r = await api.mcps.install(s.id);
      if (r.status === 'installed') {
        flashOp('ok', `${s.name} instalado.`);
        refresh();
      } else {
        flashOp('err', r.message + (r.stderr ? ` — ${r.stderr.slice(0, 120)}` : ''));
      }
    } catch (e) {
      flashOp('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleUninstall = async (name: string) => {
    setBusy({ kind: 'uninstall', key: name });
    try {
      const r = await api.mcps.uninstall(name);
      if (r.status === 'uninstalled') {
        flashOp('ok', `${name} desinstalado.`);
        refresh();
      } else {
        flashOp('err', r.message + (r.stderr ? ` — ${r.stderr.slice(0, 120)}` : ''));
      }
    } catch (e) {
      flashOp('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirmDelete(null);
    }
  };

  const handleToggle = async (server: McpServer) => {
    setBusy({ kind: 'toggle', key: server.name });
    try {
      const r = server.enabled
        ? await api.mcps.disable(server.name)
        : await api.mcps.enable(server.name);
      if (r.status === 'enabled' || r.status === 'disabled') {
        flashOp('ok', r.message);
        refresh();
      } else {
        flashOp('err', r.message);
      }
    } catch (e) {
      flashOp('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const isInstalledByName = (name: string) =>
    !!data?.installed.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const isInstalledBySuggestionId = (s: McpSuggestion) =>
    isInstalledByName(s.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header card */}
      <div style={{
        padding: '14px 16px', borderRadius: 10,
        background: T.bgAlt, border: `1px solid ${T.border}`,
        fontSize: 12.5, color: T.textDim, lineHeight: 1.55,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          Los MCPs (Model Context Protocol) le dan a Don Cheli y a los sub-Claudes acceso a tus herramientas externas.
          Se configuran en <code style={{ fontFamily: T.fontMono }}>~/.claude.json</code> y los hereda cualquier Claude que se invoque desde aquí.
        </div>
        <button
          onClick={refresh}
          title="Refrescar estado"
          style={{
            border: 'none', background: T.panel, color: T.textDim,
            padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
            boxShadow: T.shadow, display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          <RefreshCw size={12} /> Refrescar
        </button>
      </div>

      {opMessage && (
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: opMessage.tone === 'ok' ? T.successBg : T.warnBg,
          color: opMessage.tone === 'ok' ? T.success : T.warn,
          fontSize: 12.5,
          border: `1px solid ${opMessage.tone === 'ok' ? T.success : T.warn}`,
        }}>
          {opMessage.text}
        </div>
      )}

      {/* Installed */}
      <section>
        <h3 style={sectionTitle}>Conectados</h3>
        {error ? (
          <div style={{ padding: 14, color: T.warn, fontSize: 12.5 }}>
            <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
            {error}
          </div>
        ) : loading ? (
          <div style={{ padding: 14, color: T.textFaint, fontSize: 12.5 }}>Cargando…</div>
        ) : !data?.installed.length ? (
          <div style={{ padding: 14, color: T.textFaint, fontSize: 12.5 }}>
            No hay MCPs configurados todavía. Mira la lista de sugerencias abajo.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {data.installed.map((s) => (
              <InstalledMcp
                key={`${s.scope}:${s.name}`}
                server={s}
                mobbinAuthCmd={data.mobbin_auth_command}
                onToggle={() => handleToggle(s)}
                onUninstallClick={() => setConfirmDelete(s.name)}
                busy={busy?.key === s.name}
              />
            ))}
          </div>
        )}
      </section>

      {/* Suggestions */}
      <section>
        <h3 style={sectionTitle}>Sugerencias útiles</h3>
        {!data?.suggestions.length ? null : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {data.suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                item={s}
                alreadyInstalled={isInstalledBySuggestionId(s)}
                onInstall={() => handleInstall(s)}
                busy={busy?.kind === 'install' && busy.key === s.id}
              />
            ))}
          </div>
        )}
      </section>

      {confirmDelete && (
        <ConfirmDeleteModal
          name={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleUninstall(confirmDelete)}
          busy={busy?.kind === 'uninstall' && busy.key === confirmDelete}
        />
      )}
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 500, color: T.textFaint,
  textTransform: 'uppercase', letterSpacing: 0.4,
  margin: '0 0 10px 4px',
};

function InstalledMcp({
  server, mobbinAuthCmd, onToggle, onUninstallClick, busy,
}: {
  server: McpServer;
  mobbinAuthCmd: string;
  onToggle: () => void;
  onUninstallClick: () => void;
  busy: boolean;
}) {
  const isMobbin = server.name.toLowerCase() === 'mobbin';
  const statusColor =
    server.status === 'connected' ? T.success :
    server.status === 'needs_auth' ? T.warn :
    server.status === 'disabled' ? T.textFaint :
    T.textFaint;
  const statusBg =
    server.status === 'connected' ? T.successBg :
    server.status === 'needs_auth' ? T.warnBg :
    T.bgAlt;
  const statusLabel =
    server.status === 'connected' ? 'Conectado' :
    server.status === 'needs_auth' ? 'Requiere autenticación' :
    server.status === 'disabled' ? 'Deshabilitado' :
    'Estado desconocido';

  const StatusIcon = server.status === 'connected' ? CheckCircle2 : AlertTriangle;

  const opacity = server.enabled ? 1 : 0.55;

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      background: T.panel, border: `1px solid ${T.border}`,
      boxShadow: T.shadow,
      display: 'flex', flexDirection: 'column', gap: 8,
      opacity,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, color: T.text, textTransform: 'capitalize' }}>{server.name}</span>
        <span style={{
          padding: '2px 8px', borderRadius: 999,
          background: statusBg, color: statusColor,
          fontSize: 10.5, fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <StatusIcon size={10} />
          {statusLabel}
        </span>
        <span style={{ fontSize: 10.5, color: T.textFaint, fontFamily: T.fontMono }}>
          {server.transport}{server.scope === 'user' ? ' · user' : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <ToggleSwitch checked={server.enabled} onChange={onToggle} disabled={busy} />
          <button
            onClick={onUninstallClick}
            disabled={busy}
            title="Desinstalar"
            aria-label="Desinstalar"
            style={{
              border: 'none', background: 'transparent',
              color: busy ? T.textFaint : T.warn,
              cursor: busy ? 'not-allowed' : 'pointer',
              padding: 4, display: 'inline-flex',
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {server.url && (
        <div style={{ fontSize: 11.5, color: T.textDim, fontFamily: T.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {server.url}
        </div>
      )}
      {server.command && (
        <div style={{ fontSize: 11.5, color: T.textDim, fontFamily: T.fontMono }}>
          $ {server.command}
        </div>
      )}

      {isMobbin && server.status === 'needs_auth' && (
        <div style={{
          marginTop: 4, padding: '10px 12px', borderRadius: 8,
          background: T.warnBg, color: T.warn, fontSize: 12.5,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div>
            Mobbin usa OAuth: abre Claude Code en terminal y autentica desde el menú interactivo.
          </div>
          <CopyableCommand text={mobbinAuthCmd} />
          <div style={{ fontSize: 11.5, color: T.textDim }}>
            Tras autenticar, Mobbin queda disponible para Don Cheli en todos los proyectos.
          </div>
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  item, alreadyInstalled, onInstall, busy,
}: {
  item: McpSuggestion;
  alreadyInstalled: boolean;
  onInstall: () => void;
  busy: boolean;
}) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      background: T.panel, border: `1px solid ${T.border}`,
      boxShadow: T.shadow,
      display: 'flex', flexDirection: 'column', gap: 8,
      minHeight: 180,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: T.text }}>{item.name}</span>
        <span style={{
          padding: '2px 7px', borderRadius: 999,
          background: T.bgAlt, color: T.textDim, fontSize: 10, fontWeight: 500,
        }}>{item.category}</span>
      </div>
      <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5, flex: 1 }}>
        {item.description}
      </div>
      <CopyableCommand text={item.install_hint} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {item.docs_url ? (
          <a
            href={item.docs_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11.5, color: T.textDim, textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <ExternalLink size={11} /> Docs
          </a>
        ) : <span />}

        {alreadyInstalled ? (
          <span style={{
            padding: '5px 10px', borderRadius: 6,
            background: T.successBg, color: T.success,
            fontSize: 11.5, fontWeight: 500,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <CheckCircle2 size={11} /> Instalado
          </span>
        ) : (
          <button
            onClick={onInstall}
            disabled={busy}
            style={{
              padding: '6px 12px', borderRadius: 6,
              background: busy ? T.bgAlt : T.ink,
              color: busy ? T.textFaint : '#fff',
              border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: 11.5, fontWeight: 500, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            {busy ? 'Instalando…' : 'Instalar'}
          </button>
        )}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled }: {
  checked: boolean; onChange: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      title={checked ? 'Deshabilitar' : 'Habilitar'}
      style={{
        width: 32, height: 18, borderRadius: 999,
        background: checked ? T.success : T.bgAlt,
        border: `1px solid ${checked ? T.success : T.border}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', padding: 0,
        transition: 'background .15s ease',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 1, left: checked ? 15 : 1,
        width: 14, height: 14, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
        transition: 'left .15s ease',
      }} />
    </button>
  );
}

function ConfirmDeleteModal({ name, onCancel, onConfirm, busy }: {
  name: string; onCancel: () => void; onConfirm: () => void; busy: boolean;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(17, 18, 22, 0.55)',
        display: 'grid', placeItems: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 92vw)',
          background: T.panel, borderRadius: 12,
          boxShadow: T.shadowLg, padding: '20px 22px',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ fontSize: 14.5, fontWeight: 500, color: T.text }}>
          Desinstalar <span style={{ fontFamily: T.fontMono }}>{name}</span>?
        </div>
        <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55 }}>
          Esto elimina la configuración del MCP en <code style={{ fontFamily: T.fontMono, fontSize: 11.5 }}>~/.claude.json</code>. Si era un MCP con OAuth (como Mobbin), también perderás la autenticación y vas a tener que volver a hacer login. Si solo querés desactivarlo temporalmente, usa el switch en su lugar.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '7px 14px', borderRadius: 6,
              background: T.panel, color: T.textDim,
              border: 'none', boxShadow: T.shadow,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: 12.5, fontFamily: 'inherit',
            }}
          >Cancelar</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: '7px 14px', borderRadius: 6,
              background: busy ? T.bgAlt : T.warn,
              color: busy ? T.textFaint : '#fff',
              border: 'none',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            {busy ? 'Desinstalando…' : 'Sí, desinstalar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyableCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* noop */ }
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: T.bgAlt, borderRadius: 6, padding: '6px 8px',
      border: `1px solid ${T.border}`,
    }}>
      <code style={{
        flex: 1, fontFamily: T.fontMono, fontSize: 11, color: T.textDim,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{text}</code>
      <button
        onClick={onCopy}
        title="Copiar"
        style={{
          border: 'none', background: 'transparent', color: copied ? T.success : T.textFaint,
          cursor: 'pointer', padding: 2, display: 'inline-flex',
        }}
      >
        {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}
