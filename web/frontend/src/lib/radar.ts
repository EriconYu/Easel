import type { WorkbenchTask } from './api';

export interface RadarSource {
  id: string;
  title: string;
  url: string;
  platform: string;
  label: string;
  published_at: string | null;
  fetched_at: string | null;
  hot: string;
}

/** Explicit user action only: persist evidence, never call a paid model here. */
export async function importRadarSource(persona: string, source: RadarSource): Promise<WorkbenchTask> {
  const response = await fetch('/api/workbench/import-source', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona, source }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === 'string' ? error.detail : `来源导入失败（${response.status}）`);
  }
  return response.json();
}
