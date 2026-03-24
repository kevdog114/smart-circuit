import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';

export const projectsRouter = Router();

// Ensure data directory exists
const DATA_DIR = path.join(process.cwd(), 'data', 'projects');

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create projects directory:', err);
  }
}

ensureDataDir();

// GET /api/projects - List all projects
projectsRouter.get('/', async (_req, res) => {
  try {
    const files = await fs.readdir(DATA_DIR);
    const projects = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
        const doc = JSON.parse(content);
        // Only return metadata for the list view
        const componentCount = doc.sheets?.[0]?.components?.length ?? 0;
        projects.push({
          id: doc.id,
          name: doc.name,
          version: doc.version,
          updatedAt: doc.updatedAt,
          createdAt: doc.createdAt,
          componentCount
        });
      } catch (err) {
        console.error(`Error reading project file ${file}:`, err);
      }
    }
    
    // Sort by updated descending
    projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    
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
    // Basic sanitization
    const safeId = path.basename(id);
    const filePath = path.join(DATA_DIR, `${safeId}.json`);
    
    // Check if exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Project not found' });
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const doc = JSON.parse(content);
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
    const safeId = path.basename(id);
    const filePath = path.join(DATA_DIR, `${safeId}.json`);

    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Project not found' });
    }

    await fs.unlink(filePath);
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
    
    // Basic structural validation
    if (!doc || !doc.id || !doc.name) {
      return res.status(400).json({ error: 'Invalid project document' });
    }
    
    // Update timestamp
    doc.updatedAt = new Date().toISOString();
    
    const safeId = path.basename(doc.id);
    const filePath = path.join(DATA_DIR, `${safeId}.json`);
    
    await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8');
    
    // Return the updated document (with new timestamp)
    res.json(doc);
  } catch (err) {
    console.error('Failed to save project:', err);
    res.status(500).json({ error: 'Failed to save project' });
  }
});
