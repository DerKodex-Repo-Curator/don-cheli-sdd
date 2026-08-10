import { useEffect, useMemo, useState } from 'react';
import { studioTokens as T } from '../lib/studioTokens';
import {
  StudioTopBar, StudioBody, StudioButton, StudioMetricCard, StudioPillGroup,
} from '../components/StudioShell';
import { api, type AggregatedCosts } from '../lib/api';

export interface ExpenseData {
  thisMonth: number;
  budget: number;
  estimatedEnd: number;
  lastMonth: number;
  daily: { d: number; v: number }[];
  byProject: { id: string; cost: number; pct: number }[];
  byModel: { id: string; cost: number; pct: number; tone?: string }[];
  byStep: { id: string; cost: number; pct?: number }[];
  jobsThisMonth?: number;
}

const MOCK_EXPENSES: ExpenseData = {
  thisMonth: 12.40,
  budget: 100,
  estimatedEnd: 41,
  lastMonth: 38.20,
  jobsThisMonth: 47,
  daily: Array.from({ length: 30 }, (_, i) => ({
    d: i + 1,
    v: [0.40, 0, 2.10, 0.80, 0, 0, 1.20, 0.60, 3.20, 0.40, 0, 0, 1.80, 0.90, 0, 0, 0, 0, 0, 0, 0.40, 0.60, 0, 0, 0, 0, 0, 0, 0, 0][i] ?? 0,
  })),
  byProject: [
    { id: 'onboarding-v2', cost: 8.90, pct: 72 },
    { id: 'cart-refactor', cost: 2.30, pct: 19 },
    { id: 'auth-jwt',      cost: 0.82, pct: 7 },
    { id: 'payments',      cost: 0.38, pct: 3 },
  ],
  byModel: [
    { id: 'Claude Sonnet 4.5', cost: 9.20, pct: 74, tone: '#0f1114' },
    { id: 'Claude Haiku 4.5',  cost: 2.80, pct: 23, tone: '#65666b' },
    { id: 'Claude Opus 4.1',   cost: 0.40, pct: 3,  tone: '#9a9a9e' },
  ],
  byStep: [
    { id: 'Diseñar',     cost: 5.40 },
    { id: 'Construir',   cost: 3.10 },
    { id: 'Planificar',  cost: 1.80 },
    { id: 'Revisar',     cost: 1.20 },
    { id: 'Especificar', cost: 0.50 },
    { id: 'Aclarar',     cost: 0.30 },
    { id: 'Desglosar',   cost: 0.10 },
  ],
};

type Grouping = 'project' | 'model' | 'step';
type Range = 'week' | 'month' | 'year';

interface Props {
  data?: ExpenseData;
  onOpenProject?: (id: string) => void;
}

function fromApi(d: AggregatedCosts): ExpenseData {
  return {
    thisMonth: d.this_month,
    budget: d.budget,
    estimatedEnd: d.estimated_end,
    lastMonth: d.last_month,
    jobsThisMonth: d.jobs_this_month,
    daily: d.daily,
    byProject: d.by_project,
    byModel: d.by_model,
    byStep: d.by_step,
  };
}

export function Gastos({ data: dataProp, onOpenProject }: Props) {
  const [range, setRange] = useState<Range>('month');
  const [grouping, setGrouping] = useState<Grouping>('project');
  const [remote, setRemote] = useState<ExpenseData | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    if (dataProp) return;
    let cancelled = false;
    api.costs.aggregated()
      .then((d) => {
        if (cancelled) return;
        const converted = fromApi(d);
        const empty = converted.thisMonth === 0 && converted.lastMonth === 0
          && converted.byProject.length === 0;
        if (empty) {
          setRemote(MOCK_EXPENSES);
          setUsingMock(true);
        } else {
          setRemote(converted);
          setUsingMock(false);
        }
      })
      .catch(() => {
        if (!cancelled) { setRemote(MOCK_EXPENSES); setUsingMock(true); }
      });
    return () => { cancelled = true; };
  }, [dataProp]);

  const data = dataProp ?? remote ?? MOCK_EXPENSES;
  const pct = (data.thisMonth / data.budget) * 100;
  const projectedPct = (data.estimatedEnd / data.budget) * 100;
  const delta = data.thisMonth - data.lastMonth;
  const maxDaily = Math.max(0.01, ...data.daily.map((d) => normalizeZero(d.v)));
  const today = new Date().getDate();

  const groups = useMemo(() => {
    const project = data.byProject.map((x) => ({ ...x, label: x.id }));
    const model = data.byModel.map((x) => ({ ...x, label: x.id }));
    const total = data.byStep.reduce((s, x) => s + x.cost, 0) || data.thisMonth || 1;
    const step = data.byStep.map((x) => ({
      ...x, label: x.id, pct: x.pct ?? Math.round((x.cost / total) * 100),
    }));
    return { project, model, step };
  }, [data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <StudioTopBar
        title="Gastos"
        subtitle="Cuánto se llevó este mes y en qué se fue"
        actions={
          <>
            <StudioButton>Exportar CSV</StudioButton>
            <StudioButton primary>Cambiar presupuesto</StudioButton>
          </>
        }
      />

      {usingMock && (
        <div style={{
          padding: '8px 32px', background: T.warnBg, color: T.warn,
          fontSize: 12, borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{ fontWeight: 500 }}>Vista previa con datos de ejemplo</span>
          <span style={{ color: T.textDim, marginLeft: 6 }}>· El detalle de gastos reales aparece cuando hay corridas registradas</span>
        </div>
      )}

      <StudioBody>
        {/* Hero */}
        <div style={{
          background: T.panel, borderRadius: 14, boxShadow: T.shadow,
          padding: '24px 28px', marginBottom: 16,
          display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 28,
        }}>
          <div>
            <div style={{ fontSize: 11.5, color: T.textFaint, fontWeight: 500, letterSpacing: 0.3, marginBottom: 8, textTransform: 'uppercase' }}>Este mes</div>
            <div style={{
              fontSize: 48, fontWeight: 500, letterSpacing: -1.5, color: T.text,
              fontFamily: T.fontMono, fontVariantNumeric: 'tabular-nums', lineHeight: 1,
            }}>
              ${normalizeZero(data.thisMonth).toFixed(2)}
            </div>
            <div style={{ fontSize: 13, color: T.textDim, marginTop: 10 }}>
              de <span style={{ color: T.text, fontWeight: 500 }}>${data.budget.toFixed(0)}</span> de presupuesto
              {delta < 0 ? (
                <span style={{ color: T.success, marginLeft: 10 }}>
                  ↓ ${Math.abs(delta).toFixed(2)} vs mes pasado
                </span>
              ) : (
                <span style={{ color: T.textDim, marginLeft: 10 }}>
                  ↑ ${delta.toFixed(2)} vs mes pasado
                </span>
              )}
            </div>

            <div style={{
              marginTop: 22, height: 10, background: T.bgAlt,
              borderRadius: 999, overflow: 'hidden', position: 'relative',
            }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${projectedPct}%`, background: T.borderSoft,
                borderRadius: 999,
              }} />
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${pct}%`, background: T.ink,
                borderRadius: 999,
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: T.textDim }}>
              <span><span style={{ color: T.text, fontWeight: 500 }}>{pct.toFixed(0)}%</span> usado</span>
              <span>Proyección fin de mes: <span style={{ color: T.text, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>${data.estimatedEnd}</span></span>
              <span>${data.budget} →</span>
            </div>
          </div>

          <StudioMetricCard big mono label="Mes pasado" value={`$${data.lastMonth.toFixed(2)}`} sub="Mes calendario completo" />
          <StudioMetricCard big mono label="Trabajos este mes" value={data.jobsThisMonth ?? '—'}
            sub={data.jobsThisMonth ? `$${(data.thisMonth / data.jobsThisMonth).toFixed(2)} promedio por trabajo` : '—'} />
        </div>

        {/* Daily chart */}
        <div style={{ background: T.panel, borderRadius: 14, boxShadow: T.shadow, padding: '20px 24px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: -0.1 }}>Día por día</div>
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>Gasto diario este mes</div>
            </div>
            <StudioPillGroup
              value={range}
              onChange={setRange}
              options={[
                { value: 'week', label: 'Semana' },
                { value: 'month', label: 'Mes' },
                { value: 'year', label: 'Año' },
              ]}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, marginBottom: 10 }}>
            {data.daily.map((d, i) => {
              const dv = normalizeZero(d.v);
              const h = (dv / maxDaily) * 100;
              const isPast = d.d < today;
              const isToday = d.d === today;
              const isFuture = d.d > today;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{
                    width: '100%', height: 120,
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                  }}>
                    {dv > 0 ? (
                      <div title={`${d.d} · $${dv.toFixed(2)}`} style={{
                        width: '100%', height: `${Math.max(3, h)}%`,
                        background: isToday ? T.success : isPast ? T.ink : T.bgAlt,
                        borderRadius: 3,
                      }} />
                    ) : (
                      <div style={{
                        width: '100%', height: 3, borderRadius: 2,
                        background: isFuture ? 'transparent' : T.bgAlt,
                        borderBottom: isFuture ? `1px dashed ${T.border}` : 'none',
                      }} />
                    )}
                  </div>
                  <div style={{
                    fontSize: 10, color: isToday ? T.text : T.textFaint,
                    fontWeight: isToday ? 600 : 400,
                    fontFamily: T.fontMono, marginTop: 6,
                  }}>{d.d}</div>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 18, fontSize: 11.5, color: T.textDim, paddingLeft: 2 }}>
            <LegendDot color={T.ink} label="Días pasados" />
            <LegendDot color={T.success} label="Hoy" />
            <LegendDot color={T.bgAlt} label="Sin gasto" />
          </div>
        </div>

        {/* Breakdown */}
        <div style={{ background: T.panel, borderRadius: 14, boxShadow: T.shadow, padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: -0.1 }}>En qué se fue</div>
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                Top {groups[grouping].length} {grouping === 'project' ? 'proyectos' : grouping === 'model' ? 'modelos' : 'pasos'}
              </div>
            </div>
            <StudioPillGroup
              value={grouping}
              onChange={setGrouping}
              options={[
                { value: 'project', label: 'Proyecto' },
                { value: 'model', label: 'Modelo' },
                { value: 'step', label: 'Paso' },
              ]}
            />
          </div>

          <div style={{
            height: 10, background: T.bgAlt, borderRadius: 999,
            overflow: 'hidden', display: 'flex', marginBottom: 18,
          }}>
            {groups[grouping].map((g, i) => {
              const shade = ['#0f1114', '#3a3a3e', '#65666b', '#9a9a9e', '#c9c9c4'];
              return (
                <div key={g.label} style={{
                  height: '100%',
                  width: `${g.pct}%`,
                  background: ('tone' in g && g.tone) || shade[i % shade.length],
                  marginRight: i < groups[grouping].length - 1 ? 2 : 0,
                }} title={`${g.label}: $${g.cost.toFixed(2)}`} />
              );
            })}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {groups[grouping].map((g, i) => {
              const shade = ['#0f1114', '#3a3a3e', '#65666b', '#9a9a9e', '#c9c9c4', '#d9d9d3', '#e8e8e2'];
              const color = ('tone' in g && g.tone) || shade[i % shade.length];
              const clickable = grouping === 'project';
              return (
                <div key={g.label}
                  className="studio-row"
                  onClick={() => clickable && onOpenProject && onOpenProject(g.label)}
                  style={{
                    padding: '10px 6px', borderRadius: 6,
                    display: 'grid', gridTemplateColumns: '18px 1fr 70px 80px',
                    alignItems: 'center', gap: 12, fontSize: 13,
                    cursor: clickable ? 'pointer' : 'default',
                    transition: 'background .12s ease',
                  }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
                  <span style={{
                    color: T.text,
                    fontFamily: clickable ? T.fontMono : 'inherit',
                    fontWeight: 500,
                  }}>{g.label}</span>
                  <span style={{ textAlign: 'right', color: T.textDim, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
                    {g.pct}%
                  </span>
                  <span style={{
                    textAlign: 'right', color: T.text,
                    fontFamily: T.fontMono, fontVariantNumeric: 'tabular-nums',
                  }}>
                    ${g.cost.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </StudioBody>
    </div>
  );
}

function normalizeZero(v: number): number {
  // Clamp -0.0 and tiny float noise to 0.
  return Math.abs(v) < 0.005 ? 0 : v;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />{label}
    </span>
  );
}
