
export type AgentRole = 'Leader' | 'Developer' | 'QA' | 'Designer' | 'Researcher';

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  spriteTemplate: string;
  x: number;
  y: number;
  status: 'idle' | 'working' | 'meeting' | 'thinking';
  currentTask?: string;
  lastMessage?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  workspacePath: string;
  agents: string[]; // Agent IDs
  status: 'active' | 'completed' | 'on-hold';
}

export interface GameState {
  projects: Project[];
  agents: Agent[];
}

export interface Task {
  id: string;
  projectId: string;
  assignedTo: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed';
}
