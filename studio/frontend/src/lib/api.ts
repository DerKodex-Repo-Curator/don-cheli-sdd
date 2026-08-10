// Detect if running inside Tauri or in a regular browser
const IS_TAURI = !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

// ── Web mode: HTTP fetch ─────────────────────────────

async function httpRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Types ────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: string;
}

export interface ProjectScanResult {
  path: string;
  exists: boolean;
  is_directory: boolean;
  is_empty: boolean;
  suggested_name: string;
  has_dc_artifacts: boolean;
  has_git: boolean;
  git_remote: string | null;
  framework: string | null;
  package_manager: string | null;
  dependencies: string[];
  services_detected: ServiceSpec[];
  file_count: number;
  readme_excerpt: string | null;
  already_imported: boolean;
  already_imported_as: string | null;
}

export interface ProjectImportResponse {
  project: Project;
  blueprint_path: string | null;
  framework: string | null;
  services_detected: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  editor: string;
  status: 'active' | 'done' | 'paused' | 'pending';
  current_step: string;
  total_cost: number;
  total_runs: number;
  success_runs: number;
  last_used_iso: string | null;
  last_used_human: string;
}

export interface PhaseInfo {
  name: string;
  command: string;
  status: string;
  duration_ms?: number;
  cost_usd?: number;
  retries: number;
}

export interface ArtifactInfo {
  type: string;
  name: string;
  path: string;
  phase: string;
  size_bytes: number;
}

export interface PipelineRun {
  id: string;
  project_id: string;
  task: string;
  provider: string;
  model: string;
  status: string;
  current_phase?: string;
  total_cost: number;
  started_at: string;
  completed_at?: string;
  error?: string;
  signer?: string;
}

export interface PhaseRecord {
  id: number;
  run_id: string;
  name: string;
  command: string;
  status: string;
  attempt: number;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  cost_usd: number;
  error?: string;
  layer?: string;
}

export interface PipelineStatus {
  run_id?: string;
  status: string;
  state?: Record<string, unknown>;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_git: boolean;
  has_package_json: boolean;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  entries: DirEntry[];
}

// ── Unified API (works in both Tauri and Web) ────────

async function call<T>(tauriCmd: string, httpPath: string, httpMethod: string, args?: Record<string, unknown>): Promise<T> {
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(tauriCmd, args);
  }
  const options: RequestInit = { method: httpMethod };
  if (httpMethod === 'POST' && args) {
    options.body = JSON.stringify(args);
  }
  return httpRequest<T>(httpPath, options);
}

export const api = {
  projects: {
    list: () => call<Project[]>('list_projects', '/projects', 'GET'),
    summary: () => httpRequest<ProjectSummary[]>('/projects/summary'),
    get: (id: string) => call<Project | null>('get_project', `/projects/${id}`, 'GET', { id }),
    create: (name: string, path: string) =>
      call<Project>('create_project', '/projects', 'POST', { name, path }),
    delete: (id: string) =>
      call<boolean>('delete_project', `/projects/${id}`, 'DELETE', { id }),
    scan: (path: string) => httpRequest<ProjectScanResult>(`/projects/scan?path=${encodeURIComponent(path)}`),
    import: (name: string, path: string, generate_blueprint = true) =>
      httpRequest<ProjectImportResponse>('/projects/import', {
        method: 'POST',
        body: JSON.stringify({ name, path, generate_blueprint }),
      }),
  },

  pipeline: {
    start: (projectId: string, task: string, options?: { provider?: string; model?: string; signer?: string }) =>
      call<string>('start_pipeline', `/pipeline/${projectId}/start`, 'POST', {
        projectId, task, provider: options?.provider, model: options?.model, signer: options?.signer,
      }),
    stop: (projectId: string) =>
      call<{ status: string }>('stop_pipeline', `/pipeline/${projectId}/stop`, 'POST', { projectId }),
    status: (projectId: string) =>
      call<PipelineStatus>('pipeline_status', `/pipeline/${projectId}/status`, 'GET', { projectId }),
    phases: (projectId: string) =>
      call<PhaseInfo[]>('list_phases', `/pipeline/${projectId}/phases`, 'GET', { projectId }),
    artifacts: (projectId: string) =>
      call<ArtifactInfo[]>('list_artifacts', `/pipeline/${projectId}/artifacts`, 'GET', { projectId }),
    artifactContent: (projectId: string, artifactType: string, name: string) =>
      call<{ name: string; content: string; type: string }>(
        'get_artifact_content',
        `/pipeline/${projectId}/artifacts/${artifactType}/${name}`,
        'GET',
        { projectId, artifactType, name },
      ),
  },

  runs: {
    active: () => httpRequest<PipelineRun[]>('/runs/active'),
    today: () => httpRequest<PipelineRun[]>('/runs/today'),
    get: (runId: string) => httpRequest<PipelineRun>(`/runs/${runId}`),
    phases: (runId: string) => httpRequest<PhaseRecord[]>(`/runs/${runId}/phases`),
    retry: (runId: string, phaseId: number) => httpRequest<unknown>(`/runs/${runId}/phases/${phaseId}/retry`, { method: 'POST' }),
    forProject: (projectId: string) => httpRequest<PipelineRun[]>(`/runs/project/${projectId}`),
  },

  filesystem: {
    browse: (path?: string) => {
      if (IS_TAURI) {
        return call<BrowseResult>('browse_filesystem', '', 'GET', { path });
      }
      const params = path ? `?path=${encodeURIComponent(path)}` : '';
      return httpRequest<BrowseResult>(`/filesystem/browse${params}`);
    },
    mkdir: (path: string) =>
      call<void>('create_directory', '/filesystem/mkdir', 'POST', { path }),
  },

  arsenal: {
    inventory: () => httpRequest<{
      skills: ArsenalApiItem[];
      agents: ArsenalApiItem[];
      commands: ArsenalApiItem[];
    }>('/arsenal/inventory'),
  },

  design: {
    list: (projectId: string) => httpRequest<DesignListResponse>(`/pipeline/${projectId}/design/list`),
    fileUrl: (projectId: string, filename: string) =>
      // Keep slashes (filename may be "atoms/button.html") — only encode special chars per segment.
      `/api/pipeline/${projectId}/design/file/${filename.split('/').map(encodeURIComponent).join('/')}`,
    approve: (projectId: string, signer?: string, notes?: string) =>
      httpRequest<ApprovalState>(`/pipeline/${projectId}/design/approve`, {
        method: 'POST',
        body: JSON.stringify({ signer, notes }),
      }),
    reject: (projectId: string, signer?: string, notes?: string) =>
      httpRequest<ApprovalState>(`/pipeline/${projectId}/design/reject`, {
        method: 'POST',
        body: JSON.stringify({ signer, notes }),
      }),
    generate: (projectId: string, prompt_override?: string) =>
      httpRequest<{ status: string }>(`/pipeline/${projectId}/design/generate`, {
        method: 'POST',
        body: JSON.stringify({ prompt_override }),
      }),
    applyToCode: (projectId: string) =>
      httpRequest<{ status: string; reason?: string }>(
        `/pipeline/${projectId}/design/apply-to-code`,
        { method: 'POST' },
      ),
    screenPreviews: (projectId: string) =>
      httpRequest<ScreenPreviewsResponse>(`/pipeline/${projectId}/design/screen-previews`),
    listAssets: (projectId: string) =>
      httpRequest<{ assets: DesignAsset[] }>(`/pipeline/${projectId}/design/assets`),
    uploadAsset: (projectId: string, payload: { name: string; ext: string; data_base64: string }) =>
      httpRequest<DesignAsset>(`/pipeline/${projectId}/design/upload-asset`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    deleteAsset: (projectId: string, filename: string) =>
      httpRequest<{ removed: boolean }>(
        `/pipeline/${projectId}/design/asset/${encodeURIComponent(filename)}`,
        { method: 'DELETE' },
      ),
    addScreens: (projectId: string, opts?: { count?: number; screens?: string[] }) =>
      httpRequest<{ status: string; reason?: string }>(
        `/pipeline/${projectId}/design/add-screens`,
        {
          method: 'POST',
          body: JSON.stringify({
            count: opts?.count,
            screens: opts?.screens ?? [],
          }),
        },
      ),
  },

  github: {
    status: (projectId: string) => httpRequest<GithubStatus>(`/projects/${projectId}/github/status`),
    init: (projectId: string, payload: { visibility: 'public' | 'private'; description?: string; name?: string }) =>
      httpRequest<GithubInitResponse>(`/projects/${projectId}/github/init`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  services: {
    detect: (text: string) => httpRequest<{ services: ServiceSpec[] }>(`/services/detect`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
    fromContext: (projectId: string) => httpRequest<ServicesContextResponse>(
      `/pipeline/${projectId}/services/from-context`
    ),
  },

  questions: {
    pending: (projectId: string) => httpRequest<QuestionsPendingResponse>(
      `/pipeline/${projectId}/questions/pending`
    ),
    all: (projectId: string) => httpRequest<QuestionsPendingResponse>(
      `/pipeline/${projectId}/questions/all`
    ),
    answer: (projectId: string, questionId: string, answer: string, opts?: { answered_by?: string; skipped?: boolean }) =>
      httpRequest<RuntimeAnswer>(`/pipeline/${projectId}/questions/${encodeURIComponent(questionId)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer, answered_by: opts?.answered_by, skipped: opts?.skipped ?? false }),
      }),
  },

  preview: {
    info: (projectId: string) =>
      httpRequest<PreviewInfo>(`/pipeline/${projectId}/preview/info`),
    status: (projectId: string) =>
      httpRequest<PreviewStatus>(`/pipeline/${projectId}/preview/status`),
    start: (projectId: string, install: boolean) =>
      httpRequest<PreviewStatus>(`/pipeline/${projectId}/preview/start`, {
        method: 'POST',
        body: JSON.stringify({ install }),
      }),
    stop: (projectId: string) =>
      httpRequest<PreviewStatus>(`/pipeline/${projectId}/preview/stop`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    writeEnv: (projectId: string, vars: Record<string, string>, filename?: string) =>
      httpRequest<{ path: string; written_keys: string[] }>(
        `/pipeline/${projectId}/preview/env`,
        { method: 'POST', body: JSON.stringify({ vars, filename }) },
      ),
  },

  costs: {
    aggregated: () => httpRequest<AggregatedCosts>('/costs/aggregated'),
  },

  system: {
    info: () => httpRequest<SystemInfo>('/system/info'),
  },

  envInventory: {
    get: (projectId: string) =>
      httpRequest<EnvInventoryResponse>(`/projects/${projectId}/env-inventory`),
  },

  onboard: {
    status: (projectId: string) =>
      httpRequest<OnboardStatus>(`/projects/${projectId}/onboard-sdd/status`),
    start: (projectId: string, opts?: { include_improvements?: boolean; user_goal?: string }) =>
      httpRequest<{ status: string }>(`/projects/${projectId}/onboard-sdd`, {
        method: 'POST',
        body: JSON.stringify({
          include_improvements: opts?.include_improvements ?? true,
          user_goal: opts?.user_goal,
        }),
      }),
  },

  mcps: {
    list: () => httpRequest<McpListResponse>('/mcps/list'),
    install: (suggestionId: string) =>
      httpRequest<McpOpResult>('/mcps/install', {
        method: 'POST',
        body: JSON.stringify({ suggestion_id: suggestionId }),
      }),
    uninstall: (name: string) =>
      httpRequest<McpOpResult>(`/mcps/${encodeURIComponent(name)}/uninstall`, { method: 'POST' }),
    enable: (name: string) =>
      httpRequest<McpOpResult>(`/mcps/${encodeURIComponent(name)}/enable`, { method: 'POST' }),
    disable: (name: string) =>
      httpRequest<McpOpResult>(`/mcps/${encodeURIComponent(name)}/disable`, { method: 'POST' }),
  },
};

export interface ArsenalApiItem {
  id: string;
  name: string;
  desc: string | null;
  cat: string;
  uses: number;
}

export interface AggregatedCosts {
  this_month: number;
  budget: number;
  estimated_end: number;
  last_month: number;
  jobs_this_month: number;
  daily: { d: number; v: number }[];
  by_project: { id: string; cost: number; pct: number }[];
  by_model: { id: string; cost: number; pct: number }[];
  by_step: { id: string; cost: number; pct: number }[];
}

export interface MockupInfo {
  name: string;
  title: string;
  category: string;
  size_bytes: number;
  modified_at: string;
}

export interface ApprovalState {
  status: 'pending' | 'approved' | 'rejected';
  signer: string | null;
  at: string;
  notes: string | null;
}

export interface MobbinRef {
  screen: string;
  query: string;
  refs: string[];
  takeaways: string;
}

export interface StitchScreen {
  id: string;
  name: string;
  slug: string;
}

export interface DesignAsset {
  name: string;
  ext: string;
  url: string;
  size_bytes: number;
}

export interface ScreenPreview {
  id: string;
  name: string;
  slug: string;
  screenshot_url: string | null;
  width: number | null;
  height: number | null;
}

export interface ScreenPreviewsResponse {
  previews: ScreenPreview[];
  generated_at: string;
  stitch_project_id: string;
}

export interface DesignListResponse {
  mockups: MockupInfo[];
  approval: ApprovalState | null;
  tokens: Record<string, unknown> | null;
  stitch_url: string | null;
  stitch_project_id: string | null;
  stitch_screens: StitchScreen[];
  design_brief: string | null;
  mobbin_refs: MobbinRef[];
}

export interface EnvVarSpec {
  name: string;
  example: string | null;
  description: string | null;
}

export interface ServiceKey {
  name: string;
  label: string;
  kind: 'public' | 'secret';
  example_prefix: string | null;
  description: string;
}

export interface ServiceSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  dashboard_url: string;
  docs_url: string;
  free_tier: string;
  instructions: string[];
  env_keys: ServiceKey[];
  npm_packages: string[];
  env_var_patterns: string[];
}

export interface GithubStatus {
  has_repo: boolean;
  repo_url: string | null;
  owner: string | null;
  name: string | null;
  visibility: string | null;
  default_branch: string | null;
  gh_authenticated: boolean;
  authenticated_user: string | null;
}

export interface GithubInitResponse {
  repo_url: string;
  owner: string;
  name: string;
  visibility: string;
}

export interface RuntimeQuestion {
  id: string;
  phase: string | null;
  question: string;
  context?: string | null;
  kind: 'text' | 'choice' | 'boolean';
  options: string[];
  default?: string | null;
  urgency: 'blocking' | 'informative';
  created_at?: string | null;
}

export interface RuntimeAnswer {
  id: string;
  answer: string;
  answered_by?: string | null;
  answered_at?: string | null;
  skipped: boolean;
}

export interface QuestionWithAnswer extends RuntimeQuestion {
  answer: RuntimeAnswer | null;
}

export interface QuestionsPendingResponse {
  questions: QuestionWithAnswer[];
  blocking_count: number;
  source: string | null;
}

export interface ServicesContextResponse {
  services: ServiceSpec[];
  env_keys_filled: string[];
  sources: string[];
}

export interface PreviewInfo {
  detected: boolean;
  framework: string;
  root: string;
  relative_root: string;
  package_manager: string;
  install_cmd: string | null;
  dev_cmd: string | null;
  build_cmd: string | null;
  default_port: number | null;
  env_required: EnvVarSpec[];
  services: ServiceSpec[];
  env_keys_filled: string[];
  notes: string[];
}

export interface PreviewStatus {
  running: boolean;
  url: string | null;
  started_at: string | null;
  last_line: string | null;
  error: string | null;
}

export interface SystemInfo {
  framework_version: string | null;
  framework_root: string | null;
  studio_db_path: string;
  hooks_installed: { claude: boolean; codex: boolean; opencode: boolean };
}

export interface EnvFile {
  path: string;
  stack: string;
  is_example: boolean;
  keys: string[];
}

export interface ServiceMatch {
  id: string;
  name: string;
  category: string;
  dashboard_url: string;
  docs_url: string;
  stacks: string[];
  expected_keys: string[];
  configured_keys: string[];
  missing_keys: string[];
}

export interface EnvSuggestion {
  id: string;
  name: string;
  reason: string;
}

export interface EnvInventoryResponse {
  files: EnvFile[];
  services_detected: ServiceMatch[];
  orphan_keys: string[];
  suggestions: EnvSuggestion[];
}

export interface OnboardStatus {
  has_imported_blueprint: boolean;
  has_full_blueprint: boolean;
  has_spec: boolean;
  has_plan: boolean;
  has_tasks: boolean;
  has_audit: boolean;
  has_design: boolean;
  eligible: boolean;
}

export interface McpServer {
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  scope: 'user' | 'global' | string;
  status: 'connected' | 'needs_auth' | 'unknown' | 'disabled' | string;
  requires_auth: boolean;
  source_file: string;
  enabled: boolean;
}

export interface McpOpResult {
  status: 'installed' | 'uninstalled' | 'enabled' | 'disabled' | 'failed' | 'rejected' | 'not_found' | string;
  message: string;
  stdout: string | null;
  stderr: string | null;
}

export interface McpSuggestion {
  id: string;
  name: string;
  category: string;
  description: string;
  install_hint: string;
  docs_url: string | null;
}

export interface McpListResponse {
  installed: McpServer[];
  suggestions: McpSuggestion[];
  mobbin_auth_command: string;
}
