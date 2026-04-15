import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Project, GameState, AgentRole } from './src/types';
import Database from 'better-sqlite3';

const db = new Database('tycoon.db');

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    workspacePath TEXT,
    status TEXT
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    spriteTemplate TEXT,
    x REAL,
    y REAL,
    status TEXT,
    workingOnFileId TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    assignedTo TEXT,
    description TEXT,
    status TEXT
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT,
    x REAL,
    y REAL,
    projectId TEXT,
    type TEXT
  );

  CREATE TABLE IF NOT EXISTS dependencies (
    from_id TEXT,
    to_id TEXT
  );

  CREATE TABLE IF NOT EXISTS project_agents (
    projectId TEXT,
    agentId TEXT,
    PRIMARY KEY (projectId, agentId)
  );
`);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const PORT = 3000;

  app.use(express.json());

  // Helper to get full state
  const getGameState = (): GameState => {
    const projects = db.prepare('SELECT * FROM projects').all() as any[];
    const agents = db.prepare('SELECT * FROM agents').all() as Agent[];
    const files = db.prepare('SELECT * FROM files').all() as any[];
    const dependencies = db.prepare('SELECT from_id as "from", to_id as "to" FROM dependencies').all() as any[];
    
    // Populate agents for each project
    const projectAgents = db.prepare('SELECT * FROM project_agents').all() as any[];
    const projectsWithAgents = projects.map(p => ({
      ...p,
      agents: projectAgents.filter(pa => pa.projectId === p.id).map(pa => pa.agentId)
    }));

    return { projects: projectsWithAgents, agents, files, dependencies };
  };

  // Seed initial data if empty
  const projectCount = db.prepare('SELECT count(*) as count FROM projects').get() as any;
  if (projectCount.count === 0) {
    const defaultProjectId = uuidv4();
    db.prepare('INSERT INTO projects (id, name, description, workspacePath, status) VALUES (?, ?, ?, ?, ?)').run(
      defaultProjectId, 'Core System', 'The main engine of LLM Tycoon', './workspaces/core', 'active'
    );

    const initialFiles = [
      { id: 'f1', name: 'App.tsx', x: 150, y: 150, projectId: defaultProjectId, type: 'component' },
      { id: 'f2', name: 'Header.tsx', x: 300, y: 100, projectId: defaultProjectId, type: 'component' },
      { id: 'f3', name: 'Sidebar.tsx', x: 300, y: 200, projectId: defaultProjectId, type: 'component' },
      { id: 'f4', name: 'api.ts', x: 500, y: 150, projectId: defaultProjectId, type: 'service' },
      { id: 'f5', name: 'utils.ts', x: 650, y: 150, projectId: defaultProjectId, type: 'util' },
    ];
    const insertFile = db.prepare('INSERT INTO files (id, name, x, y, projectId, type) VALUES (?, ?, ?, ?, ?, ?)');
    initialFiles.forEach(f => insertFile.run(f.id, f.name, f.x, f.y, f.projectId, f.type));

    const initialDeps = [
      { from: 'f1', to: 'f2' },
      { from: 'f1', to: 'f3' },
      { from: 'f2', to: 'f4' },
      { from: 'f3', to: 'f4' },
      { from: 'f4', to: 'f5' },
    ];
    const insertDep = db.prepare('INSERT INTO dependencies (from_id, to_id) VALUES (?, ?)');
    initialDeps.forEach(d => insertDep.run(d.from, d.to));

    const initialAgents = [
      { id: uuidv4(), name: '알파', role: 'Leader', spriteTemplate: 'char1', x: 100, y: 100, status: 'idle' },
      { id: uuidv4(), name: '베타', role: 'Developer', spriteTemplate: 'char2', x: 200, y: 150, status: 'idle' },
      { id: uuidv4(), name: '감마', role: 'QA', spriteTemplate: 'char3', x: 300, y: 200, status: 'idle' }
    ];
    const insertAgent = db.prepare('INSERT INTO agents (id, name, role, spriteTemplate, x, y, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertProjectAgent = db.prepare('INSERT INTO project_agents (projectId, agentId) VALUES (?, ?)');
    
    initialAgents.forEach(a => {
      insertAgent.run(a.id, a.name, a.role, a.spriteTemplate, a.x, a.y, a.status);
      insertProjectAgent.run(defaultProjectId, a.id);
    });
  }

  // API Routes
  app.get('/api/state', (req, res) => {
    res.json(getGameState());
  });

  app.get('/api/tasks', (req, res) => {
    const tasks = db.prepare('SELECT * FROM tasks').all();
    res.json(tasks);
  });

  app.post('/api/tasks', (req, res) => {
    const { projectId, assignedTo, description } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO tasks (id, projectId, assignedTo, description, status) VALUES (?, ?, ?, ?, ?)').run(
      id, projectId, assignedTo, description, 'pending'
    );
    const tasks = db.prepare('SELECT * FROM tasks').all();
    io.emit('tasks:updated', tasks);
    res.json({ id, projectId, assignedTo, description, status: 'pending' });
  });

  app.post('/api/projects', (req, res) => {
    const { name, description, workspacePath } = req.body;
    const id = uuidv4();
    const finalPath = workspacePath || `./workspaces/${name.toLowerCase().replace(/\s+/g, '-')}`;
    
    db.prepare('INSERT INTO projects (id, name, description, workspacePath, status) VALUES (?, ?, ?, ?, ?)').run(
      id, name, description, finalPath, 'active'
    );

    // Assign Leader to new project by default
    const leader = db.prepare("SELECT id FROM agents WHERE role = 'Leader' LIMIT 1").get() as any;
    if (leader) {
      db.prepare('INSERT INTO project_agents (projectId, agentId) VALUES (?, ?)').run(id, leader.id);
    }
    
    io.emit('state:updated', getGameState());
    res.json({ id, name, description, workspacePath: finalPath, status: 'active' });
  });

  app.post('/api/agents/hire', (req, res) => {
    const { name, role, spriteTemplate } = req.body;
    const id = uuidv4();
    const x = Math.random() * 500;
    const y = Math.random() * 500;
    
    db.prepare('INSERT INTO agents (id, name, role, spriteTemplate, x, y, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, name, role, spriteTemplate, x, y, 'idle'
    );
    
    io.emit('state:updated', getGameState());
    res.json({ id, name, role, spriteTemplate, x, y, status: 'idle' });
  });

  app.delete('/api/agents/:id', (req, res) => {
    const { id } = req.params;
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE assignedTo = ?').run(id);
    
    io.emit('state:updated', getGameState());
    io.emit('tasks:updated', db.prepare('SELECT * FROM tasks').all());
    res.json({ success: true });
  });

  // Socket logic
  io.on('connection', (socket) => {
    socket.emit('state:initial', getGameState());

    socket.on('agent:move', ({ agentId, x, y }) => {
      db.prepare('UPDATE agents SET x = ?, y = ? WHERE id = ?').run(x, y, agentId);
      socket.broadcast.emit('agent:moved', { agentId, x, y });
    });

    socket.on('agent:working', ({ agentId, fileId }) => {
      db.prepare('UPDATE agents SET workingOnFileId = ? WHERE id = ?').run(fileId, agentId);
      io.emit('agent:working', { agentId, fileId });
    });

    socket.on('agent:message', ({ agentId, message }) => {
      // We don't necessarily need to persist every message, but we could
      io.emit('agent:messaged', { agentId, message });
    });

    socket.on('disconnect', () => {
      console.log('User disconnected');
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
