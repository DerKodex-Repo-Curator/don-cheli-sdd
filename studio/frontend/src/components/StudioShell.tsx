import type { ReactNode } from 'react';
import {
  Activity, Folder, History, DollarSign, Wrench, BookOpen, Settings,
} from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';

export type StudioRoute =
  | 'ahora'
  | 'proyectos'
  | 'historial'
  | 'gastos'
  | 'arsenal'
  | 'guia'
  | 'configuracion';

interface ShellProps {
  route: StudioRoute;
  onNav: (route: StudioRoute) => void;
  monthSpend?: number;
  monthBudget?: number;
  activeNowBadge?: number;
  children: ReactNode;
}

export function StudioShell({
  route, onNav, monthSpend = 0, monthBudget = 100, activeNowBadge, children,
}: ShellProps) {
  return (
    <div style={{
      width: '100%', minHeight: '100vh', display: 'flex',
      background: T.bg, color: T.text,
      fontFamily: T.fontSans,
      fontSize: 13.5,
    }}>
      <Sidebar route={route} onNav={onNav} monthSpend={monthSpend} monthBudget={monthBudget} activeNowBadge={activeNowBadge} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {children}
      </div>
      <GlobalCSS />
    </div>
  );
}

const WORK_ITEMS: { id: StudioRoute; label: string; icon: typeof Folder }[] = [
  { id: 'ahora', label: 'Ahora', icon: Activity },
  { id: 'proyectos', label: 'Proyectos', icon: Folder },
  { id: 'historial', label: 'Historial', icon: History },
  { id: 'gastos', label: 'Gastos', icon: DollarSign },
];

const CONSULT_ITEMS: { id: StudioRoute; label: string; icon: typeof Folder }[] = [
  { id: 'arsenal', label: 'Arsenal', icon: Wrench },
  { id: 'guia', label: 'Guía', icon: BookOpen },
  { id: 'configuracion', label: 'Configuración', icon: Settings },
];

interface SidebarProps {
  route: StudioRoute;
  onNav: (r: StudioRoute) => void;
  monthSpend: number;
  monthBudget: number;
  activeNowBadge?: number;
}

function Sidebar({ route, onNav, monthSpend, monthBudget, activeNowBadge }: SidebarProps) {
  const renderItem = (item: typeof WORK_ITEMS[number], badge?: number) => {
    const active = item.id === route;
    const Icon = item.icon;
    return (
      <div
        key={item.id}
        onClick={() => onNav(item.id)}
        onMouseEnter={(e) => {
          if (!active) {
            e.currentTarget.style.color = T.text;
            e.currentTarget.style.background = T.borderSoft;
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            e.currentTarget.style.color = T.textDim;
            e.currentTarget.style.background = 'transparent';
          }
        }}
        style={{
          margin: '1px 10px', padding: '8px 12px', borderRadius: 8,
          background: active ? T.panel : 'transparent',
          boxShadow: active ? T.shadow : 'none',
          color: active ? T.text : T.textDim,
          fontWeight: active ? 500 : 400,
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer', transition: 'background .12s ease, color .12s ease',
        }}
      >
        <span style={{ display: 'inline-flex', color: active ? T.text : T.textFaint }}>
          <Icon size={15} strokeWidth={1.8} />
        </span>
        <span style={{ flex: 1 }}>{item.label}</span>
        {badge !== undefined && badge > 0 && (
          <span style={{
            fontSize: 10.5, color: '#fff', background: T.success,
            borderRadius: 999, padding: '1px 7px', fontWeight: 500,
          }}>{badge}</span>
        )}
      </div>
    );
  };

  const pct = Math.min(100, (monthSpend / monthBudget) * 100);

  return (
    <aside style={{
      width: 220, background: T.bg, padding: '22px 0',
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${T.border}`,
      flexShrink: 0,
      minHeight: '100vh',
    }}>
      <div onClick={() => onNav('ahora')} style={{
        padding: '0 20px 26px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: 7, background: T.ink,
          display: 'grid', placeItems: 'center', color: '#fff', fontSize: 12, fontWeight: 600,
        }}>dc</div>
        <span style={{ color: T.text, fontWeight: 500, letterSpacing: -0.1 }}>Don Cheli</span>
        <span style={{ color: T.textFaint, fontSize: 11 }}>Studio</span>
      </div>

      <div style={{ padding: '0 22px 8px', color: T.textFaint, fontSize: 11, fontWeight: 500 }}>Trabajar</div>
      {WORK_ITEMS.map((i) => renderItem(i, i.id === 'ahora' ? activeNowBadge : undefined))}

      <div style={{ padding: '24px 22px 8px', color: T.textFaint, fontSize: 11, fontWeight: 500 }}>Consultar</div>
      {CONSULT_ITEMS.map((i) => renderItem(i))}

      <div style={{ flex: 1 }} />

      <div style={{
        margin: '12px 14px 8px', padding: '14px 14px',
        background: T.panel, boxShadow: T.shadow, borderRadius: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{
            width: 22, height: 22, borderRadius: 6, background: T.bgAlt,
            display: 'grid', placeItems: 'center', color: T.text, fontSize: 11,
          }}>$</div>
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>Este mes</span>
        </div>
        <div style={{ height: 6, background: T.bgAlt, borderRadius: 999, marginBottom: 6 }}>
          <div style={{
            height: '100%', width: `${pct}%`,
            background: T.ink, borderRadius: 999,
          }} />
        </div>
        <div style={{ fontSize: 11.5, color: T.textDim }}>
          <span style={{ color: T.text, fontWeight: 500 }}>${monthSpend.toFixed(2)}</span>
          {' '}de ${monthBudget}
        </div>
      </div>
    </aside>
  );
}

// Page header (sub-title + actions)
export function StudioTopBar({
  title, subtitle, actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div style={{
      padding: '24px 32px 18px',
      borderBottom: `1px solid ${T.border}`,
      background: T.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 28, letterSpacing: -0.8,
            fontWeight: 500, color: T.text,
          }}>{title}</div>
          {subtitle && (
            <div style={{ color: T.textDim, fontSize: 13.5, marginTop: 4 }}>{subtitle}</div>
          )}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
      </div>
    </div>
  );
}

// Primary / secondary button matching the redesign
export function StudioButton({
  children, primary, onClick, disabled,
}: {
  children: ReactNode;
  primary?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.transform = 'translateY(0)';
      }}
      style={{
        padding: '7px 14px', borderRadius: 8, border: 'none',
        background: primary ? T.ink : T.panel,
        color: primary ? '#fff' : T.text,
        fontFamily: 'inherit', fontSize: 12.5,
        fontWeight: primary ? 500 : 400,
        boxShadow: primary ? 'none' : T.shadow,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'transform .12s ease, box-shadow .12s ease',
      }}
    >
      {children}
    </button>
  );
}

// Status pill matching the redesign
export type PillTone = 'neutral' | 'active' | 'done' | 'warn' | 'error' | 'paused' | 'pending';

const PILL_TONES: Record<PillTone, { bg: string; c: string; dotC: string; border?: string }> = {
  neutral: { bg: T.bgAlt, c: T.textDim, dotC: T.textFaint },
  active: { bg: T.successBg, c: T.success, dotC: T.success },
  done: { bg: T.bgAlt, c: T.textDim, dotC: T.textFaint },
  warn: { bg: T.warnBg, c: T.warn, dotC: T.warn },
  error: { bg: 'oklch(96% 0.06 25)', c: 'oklch(55% 0.18 25)', dotC: 'oklch(55% 0.18 25)' },
  paused: { bg: T.bgAlt, c: T.textDim, dotC: T.textFaint },
  pending: { bg: 'transparent', c: T.textFaint, dotC: T.textFaint, border: T.border },
};

export function StudioPill({
  tone = 'neutral', dot, children,
}: {
  tone?: PillTone;
  dot?: boolean;
  children: ReactNode;
}) {
  const t = PILL_TONES[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 9px', borderRadius: 999, background: t.bg, color: t.c,
      fontSize: 11, fontWeight: 500, letterSpacing: 0.1,
      border: t.border ? `1px solid ${t.border}` : 'none',
    }}>
      {dot && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: t.dotC,
          animation: tone === 'active' ? 'studioPulse 1.8s ease-in-out infinite' : 'none',
        }} />
      )}
      {children}
    </span>
  );
}

// Scroll container for page bodies
export function StudioBody({ children, padding = '20px 32px 32px' }: { children: ReactNode; padding?: string }) {
  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: 'auto',
      padding,
    }}>{children}</div>
  );
}

// Compact metric card (used in Historial, Gastos)
export function StudioMetricCard({
  label, value, sub, mono, accent, big,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
  accent?: string;
  big?: boolean;
}) {
  return (
    <div style={{
      background: T.panel, borderRadius: 12, boxShadow: T.shadow,
      padding: big ? '20px 22px' : '14px 16px',
    }}>
      <div style={{
        color: T.textFaint, fontSize: 11.5, fontWeight: 500,
        letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 6,
      }}>{label}</div>
      <div style={{
        color: accent || T.text,
        fontSize: big ? 34 : 22, fontWeight: 500, letterSpacing: -0.6,
        fontFamily: mono ? T.fontMono : T.fontSans,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
      }}>{value}</div>
      {sub && <div style={{ color: T.textDim, fontSize: 12.5, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// Generic pill-style filter group (used everywhere)
export function StudioPillGroup<V extends string>({
  value, options, onChange, withCounts,
}: {
  value: V;
  options: ReadonlyArray<{ value: V; label: string; count?: number }>;
  onChange: (v: V) => void;
  withCounts?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, background: T.bgAlt, borderRadius: 8 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            border: 'none', background: value === o.value ? T.panel : 'transparent',
            padding: '5px 11px', borderRadius: 5,
            color: value === o.value ? T.text : T.textDim,
            fontSize: 12, fontFamily: 'inherit',
            fontWeight: value === o.value ? 500 : 400, cursor: 'pointer',
            boxShadow: value === o.value ? T.shadow : 'none',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {o.label}
          {withCounts && o.count !== undefined && (
            <span style={{
              fontSize: 10.5, color: T.textFaint,
              fontVariantNumeric: 'tabular-nums',
            }}>{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function GlobalCSS() {
  return (
    <style>{`
      @keyframes studioPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%      { opacity: 0.35; transform: scale(1.35); }
      }
      @keyframes studioFadeIn {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .studio-card {
        transition: transform .15s ease, box-shadow .15s ease;
      }
      .studio-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 14px -8px rgba(17,18,22,0.14), 0 12px 32px -12px rgba(17,18,22,0.15);
      }
      .studio-row:hover { background: #f7f7f2 !important; }
    `}</style>
  );
}
