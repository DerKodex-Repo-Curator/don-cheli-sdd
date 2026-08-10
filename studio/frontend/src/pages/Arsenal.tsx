import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioTopBar, StudioBody, StudioButton, StudioPill } from '../components/StudioShell';
import { api, type ArsenalApiItem } from '../lib/api';

export interface ArsenalItem {
  id: string;
  name?: string;
  desc?: string;
  cat: string;
  uses?: number;
  when?: string;
}

type Tab = 'skills' | 'agents' | 'commands';

const MOCK_SKILLS: ArsenalItem[] = [
  { id: 'consulta-diseno',    name: 'Consulta de diseño',          cat: 'Diseño',        uses: 12 },
  { id: 'variantes',          name: 'Múltiples variantes visuales', cat: 'Diseño',        uses: 4 },
  { id: 'slop',               name: 'Detector de "relleno IA"',     cat: 'Calidad',       uses: 0 },
  { id: 'contexto',           name: 'Optimizar contexto',           cat: 'Contexto',      uses: 34 },
  { id: 'recuperacion',       name: 'Recuperación tras caída',      cat: 'Seguridad',     uses: 2 },
  { id: 'rebobinar',          name: 'Rebobinar en el tiempo',       cat: 'Investigación', uses: 1 },
  { id: 'mesa-redonda',       name: 'Mesa redonda',                 cat: 'Consulta',      uses: 6 },
  { id: 'mesa-tecnica',       name: 'Mesa técnica',                 cat: 'Consulta',      uses: 3 },
  { id: 'auditar-seguridad',  name: 'Auditar seguridad',            cat: 'Seguridad',     uses: 2 },
  { id: 'doctor',             name: 'Diagnóstico del proyecto',     cat: 'Mantenimiento', uses: 8 },
  { id: 'docs-viva',          name: 'Documentación viva',           cat: 'Mantenimiento', uses: 3 },
  { id: 'clarificar',         name: 'Volver a clarificar',          cat: 'Contexto',      uses: 5 },
];

const MOCK_AGENTS: ArsenalItem[] = [
  { id: 'estimador', name: 'Estimador', desc: 'Calcula costo y tiempo antes de empezar', cat: 'Planificación', uses: 8 },
];

const MOCK_COMMANDS: ArsenalItem[] = [
  { id: '/dc:especificar',        desc: 'Definir qué se va a construir',         cat: 'Flujo',         when: 'hace 4 min' },
  { id: '/dc:clarificar',         desc: 'Preguntas aclaratorias',                cat: 'Flujo',         when: 'hace 4 min' },
  { id: '/dc:planificar',         desc: 'Crear el plan de trabajo',              cat: 'Flujo',         when: 'hace 12 min' },
  { id: '/dc:disenar',            desc: 'Generar diseños visuales',              cat: 'Flujo',         when: 'ahora' },
  { id: '/dc:desglosar',          desc: 'Dividir en tareas chicas',              cat: 'Flujo',         when: '—' },
  { id: '/dc:construir',          desc: 'Implementar según el plan',             cat: 'Flujo',         when: 'ayer' },
  { id: '/dc:revisar',            desc: 'Revisión final del trabajo',            cat: 'Flujo',         when: 'ayer' },
  { id: '/dc:mesa-redonda',       desc: 'Panel de expertos multi-perspectiva',   cat: 'Consulta',      when: 'hace 2 días' },
  { id: '/dc:mesa-tecnica',       desc: 'Panel de ingenieros senior',            cat: 'Consulta',      when: 'hace 3 días' },
  { id: '/dc:auditar-seguridad',  desc: 'Buscar vulnerabilidades',               cat: 'Auditoría',     when: 'hace 1 semana' },
  { id: '/dc:slop-scan',          desc: 'Detectar código de baja calidad',       cat: 'Auditoría',     when: '—' },
  { id: '/dc:doctor',             desc: 'Chequeo general del proyecto',          cat: 'Mantenimiento', when: 'hace 2 días' },
  { id: '/dc:documentacion-viva', desc: 'Regenerar la documentación',            cat: 'Mantenimiento', when: '—' },
];

interface Props {
  skills?: ArsenalItem[];
  agents?: ArsenalItem[];
  commands?: ArsenalItem[];
}

function fromApi(item: ArsenalApiItem): ArsenalItem {
  return {
    id: item.id,
    name: item.name,
    desc: item.desc ?? undefined,
    cat: item.cat,
    uses: item.uses,
  };
}

export function Arsenal({ skills, agents, commands }: Props) {
  const [tab, setTab] = useState<Tab>('skills');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [remote, setRemote] = useState<{ skills: ArsenalItem[]; agents: ArsenalItem[]; commands: ArsenalItem[] } | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    if (skills && agents && commands) return;
    let cancelled = false;
    api.arsenal.inventory()
      .then((inv) => {
        if (cancelled) return;
        const empty = inv.skills.length === 0 && inv.agents.length === 0 && inv.commands.length === 0;
        if (empty) {
          setRemote({ skills: MOCK_SKILLS, agents: MOCK_AGENTS, commands: MOCK_COMMANDS });
          setUsingMock(true);
        } else {
          setRemote({
            skills: inv.skills.map(fromApi),
            agents: inv.agents.map(fromApi),
            commands: inv.commands.map(fromApi),
          });
          setUsingMock(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemote({ skills: MOCK_SKILLS, agents: MOCK_AGENTS, commands: MOCK_COMMANDS });
          setUsingMock(true);
        }
      });
    return () => { cancelled = true; };
  }, [skills, agents, commands]);

  const effective = {
    skills: skills ?? remote?.skills ?? MOCK_SKILLS,
    agents: agents ?? remote?.agents ?? MOCK_AGENTS,
    commands: commands ?? remote?.commands ?? MOCK_COMMANDS,
  };
  const datasets: Record<Tab, ArsenalItem[]> = effective;
  const data = datasets[tab];

  const categories = useMemo(() => {
    const set = new Set<string>(['all']);
    data.forEach((d) => d.cat && set.add(d.cat));
    return Array.from(set);
  }, [data]);

  const filtered = useMemo(() => {
    let arr = data.slice();
    if (category !== 'all') arr = arr.filter((x) => x.cat === category);
    if (query) {
      const q = query.toLowerCase();
      arr = arr.filter((x) =>
        (x.name || x.id).toLowerCase().includes(q) ||
        (x.desc || '').toLowerCase().includes(q),
      );
    }
    return arr;
  }, [data, query, category]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'skills',   label: 'Habilidades',   count: effective.skills.length },
    { id: 'agents',   label: 'Especialistas', count: effective.agents.length },
    { id: 'commands', label: 'Comandos',      count: effective.commands.length },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <StudioTopBar
        title="Arsenal"
        subtitle="Todas las habilidades, especialistas y comandos que Don Cheli puede usar"
        actions={<StudioButton primary>+ Agregar</StudioButton>}
      />

      {usingMock && (
        <div style={{
          padding: '8px 32px', background: T.warnBg, color: T.warn,
          fontSize: 12, borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{ fontWeight: 500 }}>Vista previa con datos de ejemplo</span>
          <span style={{ color: T.textDim, marginLeft: 6 }}>· No se pudo leer el inventario real del framework</span>
        </div>
      )}

      {/* Tabs */}
      <div style={{
        padding: '0 32px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', gap: 2, background: T.bg,
      }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); setCategory('all'); }} style={{
            border: 'none', background: 'transparent',
            padding: '12px 14px 10px', fontFamily: 'inherit',
            fontSize: 13, fontWeight: tab === t.id ? 500 : 400,
            color: tab === t.id ? T.text : T.textDim,
            borderBottom: `2px solid ${tab === t.id ? T.ink : 'transparent'}`,
            marginBottom: -1, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 7,
          }}>
            {t.label}
            <span style={{ fontSize: 11, color: T.textFaint, fontVariantNumeric: 'tabular-nums' }}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div style={{
        padding: '14px 32px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 8, background: T.panel, boxShadow: T.shadow,
          minWidth: 260,
        }}>
          <Search size={13} color={T.textFaint} strokeWidth={1.8} />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={`Buscar ${tab === 'skills' ? 'habilidad' : tab === 'agents' ? 'especialista' : 'comando'}…`}
            style={{
              border: 'none', outline: 'none', fontSize: 13,
              fontFamily: 'inherit', color: T.text, background: 'transparent', width: '100%',
            }} />
        </div>
        {categories.length > 1 && (
          <div style={{ display: 'flex', gap: 4, padding: 3, background: T.bgAlt, borderRadius: 8, flexWrap: 'wrap' }}>
            {categories.map((c) => (
              <button key={c} onClick={() => setCategory(c)} style={{
                border: 'none', background: category === c ? T.panel : 'transparent',
                padding: '5px 11px', borderRadius: 5,
                color: category === c ? T.text : T.textDim,
                fontSize: 12, fontFamily: 'inherit',
                fontWeight: category === c ? 500 : 400, cursor: 'pointer',
                boxShadow: category === c ? T.shadow : 'none',
              }}>{c === 'all' ? 'Todo' : c}</button>
            ))}
          </div>
        )}
      </div>

      <StudioBody>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: T.textDim }}>
            Nada coincide con esa búsqueda.
          </div>
        ) : tab === 'commands' ? (
          <CommandsTable commands={filtered} />
        ) : (
          <CardsGrid items={filtered} kind={tab} />
        )}
      </StudioBody>
    </div>
  );
}

function CommandsTable({ commands }: { commands: ArsenalItem[] }) {
  return (
    <div style={{ background: T.panel, borderRadius: 12, boxShadow: T.shadow, overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1.4fr 2fr 120px 100px',
        padding: '10px 20px', borderBottom: `1px solid ${T.border}`,
        fontSize: 10.5, color: T.textFaint, fontWeight: 500, letterSpacing: 0.4,
        textTransform: 'uppercase',
      }}>
        <div>Comando</div><div>Qué hace</div><div>Categoría</div>
        <div style={{ textAlign: 'right' }}>Usado</div>
      </div>
      {commands.map((c, i) => (
        <div key={c.id} className="studio-row" style={{
          display: 'grid', gridTemplateColumns: '1.4fr 2fr 120px 100px',
          padding: '12px 20px', fontSize: 12.5,
          borderBottom: i < commands.length - 1 ? `1px solid ${T.borderSoft}` : 'none',
          alignItems: 'center', cursor: 'pointer', transition: 'background .12s ease',
        }}>
          <span style={{ fontFamily: T.fontMono, color: T.text, fontWeight: 500 }}>{c.id}</span>
          <span style={{ color: T.textDim }}>{c.desc}</span>
          <span><StudioPill>{c.cat}</StudioPill></span>
          <span style={{ textAlign: 'right', color: T.textFaint, fontSize: 11.5 }}>{c.when ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

function CardsGrid({ items, kind }: { items: ArsenalItem[]; kind: 'skills' | 'agents' }) {
  const isAgent = kind === 'agents';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14,
    }}>
      {items.map((x, i) => (
        <div key={x.id} className="studio-card" style={{
          background: T.panel, borderRadius: 12, boxShadow: T.shadow,
          padding: 18, cursor: 'pointer',
          animation: `studioFadeIn 0.3s ${i * 0.03}s cubic-bezier(.22,1,.36,1) both`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9,
              background: isAgent ? 'oklch(95% 0.04 290)' : T.bgAlt,
              display: 'grid', placeItems: 'center',
              fontFamily: T.fontMono, fontSize: 14,
              color: isAgent ? 'oklch(50% 0.15 290)' : T.text, fontWeight: 500,
            }}>{isAgent ? '◈' : '✱'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: -0.1 }}>
                {x.name || x.id}
              </div>
              <div style={{ fontSize: 11, color: T.textFaint, marginTop: 2 }}>{x.cat}</div>
            </div>
          </div>

          {x.desc && (
            <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5, marginBottom: 14, minHeight: 36 }}>
              {x.desc}
            </div>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: 11.5, color: T.textFaint,
          }}>
            <span>{x.uses ?? 0} usos</span>
            <span style={{ color: T.textDim }}>Ver detalle →</span>
          </div>
        </div>
      ))}
    </div>
  );
}
