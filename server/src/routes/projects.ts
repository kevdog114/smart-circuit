import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { getPool, ensureDatabaseReady, isDatabaseAvailable } from '../services/database.js';

export const projectsRouter = Router();

// File-based fallback
const DATA_DIR = path.join(process.cwd(), 'data', 'projects');

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create projects directory:', err);
  }
}

ensureDataDir();

// Initialize database connection on startup
ensureDatabaseReady().catch(() => {});

// ----- Database-backed operations -----

async function dbListProjects() {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, name, version, updated_at, created_at, (data->sheets->0->components) IS NOT NULL AS has_components FROM projects ORDER BY updated_at DESC'
  );
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    version: row.version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    componentCount: row.has_components ? parseInt((row.data.sheets?.[0]?.components?.length ?? 0).toString()) || 0 : 0,
  }));
}

async function dbGetProject(id: string) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

async function dbSaveProject(id: string, name: string, version: string, data: any) {
  const pool = getPool();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO projects (id, name, version, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), $5)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       version = EXCLUDED.version,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [id, name, version, JSON.stringify(data), now]
  );
  return { id, name, version, data, updatedAt: now };
}

async function dbDeleteProject(id: string) {
  const pool = getPool();
  const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
  return result.rows.length > 0;
}

// ----- File-based fallback operations -----

async function fileListProjects() {
  const files = await fs.readdir(DATA_DIR);
  const projects = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
      const doc = JSON.parse(content);
      const componentCount = doc.sheets?.[0]?.components?.length ?? 0;
      projects.push({
        id: doc.id,
        name: doc.name,
        version: doc.version,
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
        componentCount,
      });
    } catch (err) {
      console.error(`Error reading project file ${file}:`, err);
    }
  }

  projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return projects;
}

async function fileGetProject(id: string) {
  const safeId = path.basename(id);
  const filePath = path.join(DATA_DIR, `${safeId}.json`);
  try {
    await fs.access(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function fileSaveProject(doc: any) {
  doc.updatedAt = new Date().toISOString();
  const safeId = path.basename(doc.id);
  const filePath = path.join(DATA_DIR, `${safeId}.json`);
  await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8');
  return doc;
}

async function fileDeleteProject(id: string) {
  const safeId = path.basename(id);
  const filePath = path.join(DATA_DIR, `${safeId}.json`);
  try {
    await fs.access(filePath);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// ----- Routes -----

// GET /api/projects - List all projects
projectsRouter.get('/', async (_req, res) => {
  try {
    let projects;
    if (isDatabaseAvailable()) {
      projects = await dbListProjects();
    } else {
      projects = await fileListProjects();
    }
    res.json({ projects });
  } catch (err) {
    console.error('Failed to list projects:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// GET /api/projects/:id - Get a specific project
projectsRouter.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let doc;

    if (isDatabaseAvailable()) {
      const row = await dbGetProject(id);
      if (!row) return res.status(404).json({ error: 'Project not found' });
      doc = row.data;
      doc.id = row.id;
      doc.version = row.version;
      doc.createdAt = row.created_at;
      doc.updatedAt = row.updated_at;
    } else {
      doc = await fileGetProject(id);
      if (!doc) return res.status(404).json({ error: 'Project not found' });
    }

    res.json(doc);
  } catch (err) {
    console.error('Failed to get project:', err);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

// DELETE /api/projects/:id - Delete a project
projectsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let deleted;

    if (isDatabaseAvailable()) {
      deleted = await dbDeleteProject(id);
    } else {
      deleted = await fileDeleteProject(id);
    }

    if (!deleted) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// POST /api/projects - Create or update a project
projectsRouter.post('/', async (req, res) => {
  try {
    const doc = req.body;

    if (!doc || !doc.id || !doc.name) {
      return res.status(400).json({ error: 'Invalid project document' });
    }

    let result;
    if (isDatabaseAvailable()) {
      result = await dbSaveProject(doc.id, doc.name, doc.version || '1.0.0', doc);
      res.json({
        id: result.id,
        name: result.name,
        version: result.version,
        ...result.data,
        updatedAt: result.updatedAt,
      });
    } else {
      result = await fileSaveProject(doc);
      res.json(result);
    }
  } catch (err) {
    console.error('Failed to save project:', err);
    res.status(500).json({ error: 'Failed to save project' });
  }
});
