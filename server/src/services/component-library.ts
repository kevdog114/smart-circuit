// ============================================================
// Smart Circuit — Component Library Service
// Persistent JSON-file store for JLCPCB/EasyEDA component definitions.
// Each component is stored as {id}.json in data/components/.
// ============================================================

import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'components');

// Ensure directory exists on module load
(async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create components directory:', err);
  }
})();

/** Sanitize an ID for use as a filename */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/** Save a component definition to disk */
export async function saveComponentDef(def: Record<string, unknown>): Promise<void> {
  const id = def.id as string;
  if (!id) throw new Error('Component definition must have an id');
  const filePath = path.join(DATA_DIR, `${safeId(id)}.json`);
  await fs.writeFile(filePath, JSON.stringify(def, null, 2), 'utf-8');
}

/** Save multiple component definitions */
export async function saveComponentDefs(defs: Record<string, unknown>[]): Promise<number> {
  let saved = 0;
  for (const def of defs) {
    try {
      await saveComponentDef(def);
      saved++;
    } catch (err) {
      console.warn('Failed to save component:', (def as any).id, err);
    }
  }
  return saved;
}

/** Get a single component definition by ID */
export async function getComponentDef(id: string): Promise<Record<string, unknown> | null> {
  const filePath = path.join(DATA_DIR, `${safeId(id)}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Get multiple component definitions by IDs */
export async function getComponentDefs(ids: string[]): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};
  await Promise.all(
    ids.map(async (id) => {
      const def = await getComponentDef(id);
      if (def) result[id] = def;
    })
  );
  return result;
}

/** List all cached component IDs */
export async function listComponentIds(): Promise<string[]> {
  try {
    const files = await fs.readdir(DATA_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
