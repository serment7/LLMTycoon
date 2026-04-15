import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Agent, Project, GameState, AgentRole } from './src/types';

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const PORT = 3000;

  app.use(express.json());

  // In-memory state (for demo purposes, could be persistent)
  let gameState: GameState = {
    projects: [],
    agents: []
  };

  let tasks: any[] = [];

  // Initial agents
  const initialAgents: Agent[] = [
    { id: uuidv4(), name: '알파', role: 'Leader', spriteTemplate: 'char1', x: 100, y: 100, status: 'idle' },
    { id: uuidv4(), name: '베타', role: 'Developer', spriteTemplate: 'char2', x: 200, y: 150, status: 'idle' },
    { id: uuidv4(), name: '감마', role: 'QA', spriteTemplate: 'char3', x: 300, y: 200, status: 'idle' }
  ];
  gameState.agents = initialAgents;

  // API Routes
  app.get('/api/state', (req, res) => {
    res.json(gameState);
  });

  app.get('/api/tasks', (req, res) => {
    res.json(tasks);
  });

  app.post('/api/tasks', (req, res) => {
    const { projectId, assignedTo, description } = req.body;
    const newTask = {
      id: uuidv4(),
      projectId,
      assignedTo,
      description,
      status: 'pending'
    };
    tasks.push(newTask);
    io.emit('tasks:updated', tasks);
    res.json(newTask);
  });

  app.post('/api/projects', (req, res) => {
    const { name, description } = req.body;
    const newProject: Project = {
      id: uuidv4(),
      name,
      description,
      workspacePath: `./workspaces/${name.toLowerCase().replace(/\s+/g, '-')}`,
      agents: [],
      status: 'active'
    };
    gameState.projects.push(newProject);
    io.emit('state:updated', gameState);
    res.json(newProject);
  });

  app.post('/api/agents/hire', (req, res) => {
    const { name, role, spriteTemplate } = req.body;
    const newAgent: Agent = {
      id: uuidv4(),
      name,
      role: role as AgentRole,
      spriteTemplate,
      x: Math.random() * 500,
      y: Math.random() * 500,
      status: 'idle'
    };
    gameState.agents.push(newAgent);
    io.emit('state:updated', gameState);
    res.json(newAgent);
  });

  app.delete('/api/agents/:id', (req, res) => {
    const { id } = req.params;
    gameState.agents = gameState.agents.filter(a => a.id !== id);
    // Also remove from tasks if assigned
    tasks = tasks.filter(t => t.assignedTo !== id);
    
    io.emit('state:updated', gameState);
    io.emit('tasks:updated', tasks);
    res.json({ success: true });
  });

  // Socket logic
  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('state:initial', gameState);

    socket.on('agent:move', ({ agentId, x, y }) => {
      const agent = gameState.agents.find(a => a.id === agentId);
      if (agent) {
        agent.x = x;
        agent.y = y;
        socket.broadcast.emit('agent:moved', { agentId, x, y });
      }
    });

    socket.on('agent:message', ({ agentId, message }) => {
      const agent = gameState.agents.find(a => a.id === agentId);
      if (agent) {
        agent.lastMessage = message;
        io.emit('agent:messaged', { agentId, message });
      }
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
