import type { CircuitDocument } from '../core/types';
import { serializeDocument, deserializeDocument } from '../core/document';
import { API_BASE } from '../config';

export interface ProjectSummary {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  createdAt: string;
  componentCount: number;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const res = await fetch(`${API_BASE}/projects`);
  if (!res.ok) {
    throw new Error('Failed to list projects');
  }
  const data = await res.json();
  return data.projects;
}

export async function getProject(id: string): Promise<CircuitDocument> {
  const res = await fetch(`${API_BASE}/projects/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to load project ${id}`);
  }
  const data = await res.text();
  return deserializeDocument(data);
}

export async function saveProject(doc: CircuitDocument): Promise<CircuitDocument> {
  const payload = serializeDocument(doc);
  const res = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: payload,
  });
  
  if (!res.ok) {
    throw new Error('Failed to save project');
  }
  
  const data = await res.text();
  return deserializeDocument(data);
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to delete project');
  }
}

// ─── Component Library ───

import type { ComponentDefinition } from '../core/types';

/** Save component definitions to the server-side library cache */
export async function saveComponentsToLibrary(defs: ComponentDefinition[]): Promise<void> {
  if (defs.length === 0) return;
  try {
    await fetch(`${API_BASE}/components/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defs),
    });
  } catch (err) {
    console.warn('Failed to save components to library:', err);
  }
}

/** Batch-fetch component definitions from the server-side library cache */
export async function fetchComponentsFromLibrary(ids: string[]): Promise<Map<string, ComponentDefinition>> {
  const result = new Map<string, ComponentDefinition>();
  if (ids.length === 0) return result;
  try {
    const res = await fetch(`${API_BASE}/components/library/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) {
      const data = await res.json();
      const definitions = data.definitions || {};
      for (const [id, def] of Object.entries(definitions)) {
        result.set(id, def as ComponentDefinition);
      }
    }
  } catch (err) {
    console.warn('Failed to fetch components from library:', err);
  }
  return result;
}
