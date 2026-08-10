import { useMemo, useState } from 'react';
import { studioTokens as T } from '../lib/studioTokens';
import { StudioTopBar, StudioBody } from '../components/StudioShell';

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'callout'; tone: 'success' | 'warn' | 'neutral'; title: string; text: string }
  | { kind: 'cta'; label: string; target: string }
  | { kind: 'steps'; items: { n: number; label: string; desc: string }[] }
  | { kind: 'glossary'; items: { term: string; def: string }[] };

interface Section {
  id: string;
  label: string;
  title: string;
  blocks: Block[];
}

const SECTIONS: Section[] = [
  {
    id: 'inicio',
    label: 'Empezar aquí',
    title: 'Bienvenido a Don Cheli',
    blocks: [
      { kind: 'p', text: 'Don Cheli es una metodología y un framework que te acompaña a construir software paso a paso, con la ayuda de la inteligencia artificial. Esta Guía es la referencia rápida: ábrela cuando necesites recordar algo o aprender algo nuevo.' },
      { kind: 'h2', text: '¿Qué hace Don Cheli?' },
      { kind: 'p', text: 'Toma una idea y la convierte en código siguiendo un proceso ordenado. En vez de improvisar, sigue siempre los mismos siete pasos.' },
      { kind: 'h2', text: '¿Quién está detrás del trabajo?' },
      { kind: 'p', text: 'Tú. Don Cheli no decide solo: te pregunta cuando hay duda, te avisa cuando algo se desvía, y se detiene si el costo se sale de lo previsto. Tú apruebas, pausas y diriges.' },
      { kind: 'callout', tone: 'success', title: 'Atajo', text: '¿Te quieres lanzar ya? Cierra esta guía, vuelve a Ahora, pulsa "Empezar algo nuevo" y elige una carpeta. Don Cheli te lleva de la mano.' },
    ],
  },
  {
    id: 'modo-trabajo',
    label: 'Cómo trabaja',
    title: 'Tres lugares se complementan',
    blocks: [
      { kind: 'p', text: 'Don Cheli no es una herramienta separada. Es una metodología que vive dentro de las herramientas que ya usas. Para aprovecharlo al máximo se combinan tres lugares.' },
      { kind: 'h2', text: '1. Tu editor con IA' },
      { kind: 'p', text: 'Donde se hace el trabajo. Le pides cosas en lenguaje natural o usas comandos como /dc:especificar, /dc:planificar. Funciona con Claude Code, Cursor, OpenCode, Gemini (Antigravity), Codex, Qwen, Amp y Windsurf.' },
      { kind: 'h2', text: '2. Don Cheli Studio' },
      { kind: 'p', text: 'Esta torre de control visual. Ves qué está pasando en vivo, los costos, los archivos generados, el historial. Acompaña a tu editor, no lo reemplaza.' },
      { kind: 'h2', text: '3. Terminal' },
      { kind: 'p', text: 'Solo para administrar: instalar el framework, actualizarlo, abrir el Studio.' },
      { kind: 'callout', tone: 'neutral', title: 'Importante', text: 'La metodología es la misma con cualquier editor. Solo cambia cómo se invocan los comandos.' },
    ],
  },
  {
    id: 'pasos',
    label: 'Los 7 pasos',
    title: 'Cada trabajo sigue siempre estos siete pasos',
    blocks: [
      { kind: 'p', text: 'Don Cheli es opinionado. Cada trabajo sigue siempre la misma secuencia. No te deja saltar pasos, pero tú decides cuándo arrancar y cuándo pausar.' },
      { kind: 'steps', items: [
        { n: 1, label: 'Especificar', desc: 'Qué se va a construir y para quién. Producto que escribe Don Cheli en spec.md.' },
        { n: 2, label: 'Aclarar',     desc: 'Don Cheli te hace preguntas para resolver ambigüedades. Las respuestas van a clarify.md.' },
        { n: 3, label: 'Planificar',  desc: 'Arquitectura y decisiones técnicas. plan.md con los pasos del trabajo.' },
        { n: 4, label: 'Diseñar',     desc: 'Wireframes, copy, tokens. Genera archivos en design/. Requiere tu aprobación.' },
        { n: 5, label: 'Desglosar',   desc: 'Convierte el plan en tareas pequeñas. tasks.md con la lista.' },
        { n: 6, label: 'Construir',   desc: 'El código real. Todo en una copia aislada de tu carpeta (git worktree).' },
        { n: 7, label: 'Revisar',     desc: 'Validación final con tests, controles de calidad y aprobación.' },
      ]},
      { kind: 'callout', tone: 'success', title: 'Tu código original está seguro', text: 'Don Cheli trabaja sobre una copia de tu carpeta. Tu código original no se modifica hasta que pasen todos los controles de calidad y tú lo apruebes.' },
    ],
  },
  {
    id: 'reglas',
    label: 'Reglas',
    title: 'Las leyes de hierro de Don Cheli',
    blocks: [
      { kind: 'p', text: 'Don Cheli sigue tres reglas no negociables. Te las muestra en cada trabajo y se asegura de cumplirlas.' },
      { kind: 'h2', text: '1. TDD: las pruebas primero' },
      { kind: 'p', text: 'Todo código de producción tiene pruebas automáticas. Don Cheli las escribe o las pide antes de cerrar un trabajo.' },
      { kind: 'h2', text: '2. Causa raíz antes que parche' },
      { kind: 'p', text: 'Si algo falla, primero se busca por qué. Las soluciones rápidas que solo enmascaran el problema están prohibidas.' },
      { kind: 'h2', text: '3. Evidencia antes de afirmaciones' },
      { kind: 'p', text: 'Don Cheli no dice "ya quedó listo" sin haberlo verificado. Cada paso necesita evidencia.' },
      { kind: 'callout', tone: 'warn', title: 'Reglas de desviación', text: 'Si algo se sale del plan, sigue una de cinco reglas según la magnitud del desvío.' },
    ],
  },
  {
    id: 'mesas',
    label: 'Mesas',
    title: 'Paneles de expertos virtuales',
    blocks: [
      { kind: 'p', text: 'Antes de tomar decisiones difíciles, puedes convocar un panel de expertos virtuales. Hay dos formatos.' },
      { kind: 'h2', text: 'Mesa Redonda — exploratoria' },
      { kind: 'p', text: 'Discusión multi-perspectiva: CPO, Arquitecto, UX, Negocio, QA, Seguridad y DevOps. Útil para alinear producto y técnica al inicio de un proyecto. /dc:mesa-redonda. ~$0.40, 2 min.' },
      { kind: 'h2', text: 'Mesa Técnica — implementación' },
      { kind: 'p', text: 'Panel de ingenieros senior: Tech Lead, Arquitecto, Backend, Frontend. Decisiones de stack, patrones, trade-offs técnicos. /dc:mesa-tecnica. ~$0.60, 3 min.' },
    ],
  },
  {
    id: 'glosario',
    label: 'Glosario',
    title: 'Glosario',
    blocks: [
      { kind: 'glossary', items: [
        { term: 'SDD', def: 'Desarrollo Dirigido por Especificaciones. La metodología en la que se basa Don Cheli.' },
        { term: 'Trabajo', def: 'Una ejecución completa del flujo de 7 pasos sobre un proyecto.' },
        { term: 'Proyecto', def: 'Una carpeta de código con la estructura de Don Cheli (.dc/). Puede tener muchos trabajos.' },
        { term: 'Gate', def: 'Verificación automática que Don Cheli ejecuta antes de pasar al siguiente paso.' },
        { term: 'Worktree', def: 'Copia aislada de tu carpeta donde Don Cheli hace los cambios.' },
        { term: 'Habilidad', def: 'Capacidad puntual que Don Cheli puede invocar.' },
        { term: 'Comando', def: 'Atajo escrito (ej. /dc:especificar) que dispara una acción.' },
        { term: 'Agente', def: 'Ayudante especializado que Don Cheli llama internamente.' },
      ]},
    ],
  },
];

export function Guia() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const cur = useMemo(() => SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0], [activeId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, animation: 'studioFadeIn .28s cubic-bezier(.22,1,.36,1)' }}>
      <StudioTopBar title="Guía" subtitle="Manual y referencia rápida" />

      <div style={{
        padding: '12px 32px', borderBottom: `1px solid ${T.border}`,
        background: T.bg, display: 'flex', gap: 6, flexWrap: 'wrap',
      }}>
        {SECTIONS.map((s) => {
          const on = s.id === activeId;
          return (
            <span key={s.id} onClick={() => setActiveId(s.id)} style={{
              padding: '6px 12px', borderRadius: 999,
              background: on ? T.text : T.panel,
              color: on ? '#fff' : T.textDim,
              boxShadow: on ? 'none' : T.shadow,
              fontSize: 12, fontWeight: 500,
              cursor: 'pointer', whiteSpace: 'nowrap',
              transition: 'background .12s ease, color .12s ease',
            }}>{s.label}</span>
          );
        })}
      </div>

      <StudioBody padding="28px 32px 48px">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 32, maxWidth: 1080 }}>
          <div key={activeId} style={{ animation: 'studioFadeIn 0.3s cubic-bezier(.22,1,.36,1) both' }}>
            <div style={{
              fontSize: 30, fontWeight: 500, letterSpacing: -0.8,
              lineHeight: 1.15, marginBottom: 24,
            }}>{cur.title}</div>

            {cur.blocks.map((b, i) => <BlockView key={i} block={b} />)}
          </div>

          <div style={{ position: 'sticky', top: 0 }}>
            <div style={{
              fontSize: 11, color: T.textFaint, fontWeight: 500,
              textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10,
            }}>En esta sección</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {cur.blocks
                .filter((b): b is Extract<Block, { kind: 'h2' }> => b.kind === 'h2')
                .map((h, i) => (
                  <span key={i} style={{
                    fontSize: 12.5, color: T.textDim, padding: '4px 8px',
                    borderRadius: 6, cursor: 'pointer',
                  }}>{h.text}</span>
                ))}
            </div>
          </div>
        </div>
      </StudioBody>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'p') {
    return (
      <p style={{ fontSize: 14.5, lineHeight: 1.65, color: T.text, margin: '0 0 16px', maxWidth: '70ch' }}>
        {block.text}
      </p>
    );
  }
  if (block.kind === 'h2') {
    return (
      <h2 style={{ fontSize: 18, fontWeight: 500, letterSpacing: -0.3, margin: '24px 0 8px', color: T.text }}>
        {block.text}
      </h2>
    );
  }
  if (block.kind === 'callout') {
    const palette = block.tone === 'success'
      ? { bg: T.successBg, border: T.success }
      : block.tone === 'warn'
      ? { bg: T.warnBg, border: T.warn }
      : { bg: T.bgAlt, border: T.border };
    return (
      <div style={{
        margin: '16px 0', padding: '12px 14px', borderRadius: 10,
        background: palette.bg, border: `1px solid ${palette.border}`,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{block.title}</div>
        <div style={{ fontSize: 13.5, color: T.textDim, lineHeight: 1.55 }}>{block.text}</div>
      </div>
    );
  }
  if (block.kind === 'cta') {
    return (
      <div style={{ margin: '20px 0' }}>
        <button style={{
          padding: '9px 16px', borderRadius: 8,
          background: T.text, color: '#fff', border: 'none',
          fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
        }}>▶ {block.label}</button>
      </div>
    );
  }
  if (block.kind === 'steps') {
    return (
      <div style={{ margin: '16px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {block.items.map((it) => (
          <div key={it.n} style={{
            display: 'grid', gridTemplateColumns: '36px 1fr', gap: 14,
            padding: '12px 14px', borderRadius: 10,
            background: T.panel, boxShadow: T.shadow,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: T.bgAlt, color: T.textDim,
              display: 'grid', placeItems: 'center',
              fontFamily: T.fontMono, fontSize: 12, fontWeight: 600,
            }}>{it.n}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{it.label}</div>
              <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.55 }}>{it.desc}</div>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (block.kind === 'glossary') {
    return (
      <div style={{ margin: '16px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {block.items.map((it, k) => (
          <div key={it.term} style={{
            paddingTop: k === 0 ? 0 : 14,
            borderTop: k === 0 ? 'none' : `1px solid ${T.borderSoft}`,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{it.term}</div>
            <div style={{ fontSize: 13.5, color: T.textDim, lineHeight: 1.55 }}>{it.def}</div>
          </div>
        ))}
      </div>
    );
  }
  return null;
}
