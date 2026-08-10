import { useCallback, useEffect, useState } from 'react';
import { BuildFlow } from './pages/BuildFlow';
import { Projects } from './pages/Projects';
import { Historial } from './pages/Historial';
import { Gastos } from './pages/Gastos';
import { Arsenal } from './pages/Arsenal';
import { Guia } from './pages/Guia';
import { Configuracion } from './pages/Configuracion';
import { Ahora } from './pages/Ahora';
import { ProyectoDetalle } from './pages/ProyectoDetalle';
import { NuevoTrabajo } from './pages/NuevoTrabajo';
import { StudioShell, type StudioRoute } from './components/StudioShell';
import { FolderPickerModal } from './components/FolderPickerModal';
import { ImportProjectModal } from './components/ImportProjectModal';
import { api } from './lib/api';
import './index.css';

type AppRoute = StudioRoute | 'build' | 'proyecto-detalle' | 'nuevo-trabajo';

function App() {
  const [route, setRoute] = useState<AppRoute>('proyectos');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const goToProjectDetail = useCallback((id: string) => {
    setSelectedProjectId(id);
    setRoute('proyecto-detalle');
  }, []);

  // When "Seguir donde estabas" is clicked: pick the most recent project
  // and open its detail page (instead of the legacy dark BuildFlow).
  const handleResume = useCallback(async () => {
    try {
      const projects = await api.projects.list();
      if (projects.length > 0) {
        goToProjectDetail(projects[0].id);
      } else {
        setRoute('proyectos');
      }
    } catch {
      setRoute('proyectos');
    }
  }, [goToProjectDetail]);

  const handleFolderPicked = useCallback(async (path: string) => {
    const name = path.split('/').filter(Boolean).pop() ?? 'untitled';
    try {
      const project = await api.projects.create(name, path);
      goToProjectDetail(project.id);
    } catch {
      setRoute('proyectos');
    }
    setPickerOpen(false);
  }, [goToProjectDetail]);

  // When the selected project disappears (e.g. deleted), bounce back to list.
  useEffect(() => {
    if (route === 'proyecto-detalle' && !selectedProjectId) {
      setRoute('proyectos');
    }
  }, [route, selectedProjectId]);

  // BuildFlow is the legacy dark-themed flow. Reserved for "+ Nuevo trabajo"
  // until that flow is ported into the redesign shell.
  if (route === 'build') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex' }}>
        <BuildFlow />
        <BackToShell onClick={() => setRoute(selectedProjectId ? 'proyecto-detalle' : 'ahora')} />
      </div>
    );
  }

  return (
    <>
      <StudioShell
        route={
          route === 'proyecto-detalle' || route === 'nuevo-trabajo'
            ? 'proyectos'
            : (route as StudioRoute)
        }
        onNav={(r) => setRoute(r)}
        monthSpend={12.40}
        monthBudget={100}
        activeNowBadge={1}
      >
        {route === 'ahora' && (
          <Ahora
            onStartNew={() => setPickerOpen(true)}
            onResume={handleResume}
            onOpenHistory={() => setRoute('historial')}
            onOpenProject={goToProjectDetail}
          />
        )}
        {route === 'proyectos' && (
          <Projects
            onGoNow={() => setRoute('ahora')}
            onNewProject={() => setPickerOpen(true)}
            onImportProject={() => setImportOpen(true)}
            onOpenProject={goToProjectDetail}
          />
        )}
        {route === 'proyecto-detalle' && selectedProjectId && (
          <ProyectoDetalle
            projectId={selectedProjectId}
            onBack={() => setRoute('proyectos')}
            onGoNow={() => setRoute('ahora')}
            onNewJob={() => setRoute('nuevo-trabajo')}
            onOpenArsenal={() => setRoute('arsenal')}
          />
        )}
        {route === 'nuevo-trabajo' && selectedProjectId && (
          <NuevoTrabajo
            projectId={selectedProjectId}
            onBack={() => setRoute('proyecto-detalle')}
            onStarted={() => setRoute('ahora')}
          />
        )}
        {route === 'historial' && <Historial onOpenRun={() => setRoute('ahora')} />}
        {route === 'gastos' && <Gastos onOpenProject={goToProjectDetail} />}
        {route === 'arsenal' && <Arsenal />}
        {route === 'guia' && <Guia />}
        {route === 'configuracion' && <Configuracion />}
      </StudioShell>

      <FolderPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleFolderPicked}
      />

      <ImportProjectModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={goToProjectDetail}
      />
    </>
  );
}

function BackToShell({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: 'fixed', top: 12, right: 12, zIndex: 1000,
        padding: '6px 12px', borderRadius: 8, border: '1px solid #2A2A30',
        background: '#141416', color: '#E8E8EC', fontSize: 11,
        fontFamily: '"Geist Mono", monospace', cursor: 'pointer',
      }}
    >
      ← Volver al Studio
    </button>
  );
}

export default App;
