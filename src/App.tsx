/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Users, 
  Briefcase, 
  Plus, 
  MessageSquare, 
  Settings, 
  Play, 
  CheckCircle2, 
  Terminal,
  UserPlus,
  LayoutDashboard
} from 'lucide-react';
import { Agent, Project, GameState, AgentRole } from './types';
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export default function App() {
  const [gameState, setGameState] = useState<GameState>({ projects: [], agents: [] });
  const [tasks, setTasks] = useState<any[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [activeTab, setActiveTab] = useState<'game' | 'projects' | 'agents' | 'tasks'>('game');
  const [showHireModal, setShowHireModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [confirmFire, setConfirmFire] = useState<{ id: string; name: string } | null>(null);
  const [logs, setLogs] = useState<{ id: string; text: string; time: string }[]>([]);
  const gameWorldRef = useRef<HTMLDivElement>(null);

  const addLog = (text: string) => {
    setLogs(prev => [{ id: uuidv4(), text, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 50));
  };

  const translateRole = (role: string) => {
    const roles: Record<string, string> = {
      'Leader': '리더',
      'Developer': '개발자',
      'QA': '품질 관리',
      'Designer': '디자이너',
      'Researcher': '연구원'
    };
    return roles[role] || role;
  };

  const translateStatus = (status: string) => {
    const statuses: Record<string, string> = {
      'idle': '대기 중',
      'active': '활성',
      'pending': '대기',
      'in-progress': '진행 중',
      'completed': '완료'
    };
    return statuses[status] || status;
  };

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('state:initial', (state: GameState) => {
      setGameState(state);
    });

    newSocket.on('state:updated', (state: GameState) => {
      setGameState(state);
    });

    newSocket.on('tasks:updated', (newTasks: any[]) => {
      setTasks(newTasks);
    });

    newSocket.on('agent:moved', ({ agentId, x, y }) => {
      setGameState(prev => ({
        ...prev,
        agents: prev.agents.map(a => a.id === agentId ? { ...a, x, y } : a)
      }));
    });

    newSocket.on('agent:messaged', ({ agentId, message }) => {
      setGameState(prev => {
        const agent = prev.agents.find(a => a.id === agentId);
        if (agent) addLog(`[${agent.name}] ${message}`);
        return {
          ...prev,
          agents: prev.agents.map(a => a.id === agentId ? { ...a, lastMessage: message } : a)
        };
      });
      // Clear message after 5 seconds
      setTimeout(() => {
        setGameState(prev => ({
          ...prev,
          agents: prev.agents.map(a => a.id === agentId && a.lastMessage === message ? { ...a, lastMessage: undefined } : a)
        }));
      }, 5000);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  // Periodic autonomous actions
  useEffect(() => {
    const interval = setInterval(() => {
      if (gameState.agents.length > 0 && socket) {
        const randomAgent = gameState.agents[Math.floor(Math.random() * gameState.agents.length)];
        simulateAgentAction(randomAgent);
      }
    }, 10000); // Every 10 seconds an agent does something
    return () => clearInterval(interval);
  }, [gameState.agents, socket]);

  const hireAgent = async (name: string, role: AgentRole, spriteTemplate: string) => {
    await fetch('/api/agents/hire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role, spriteTemplate })
    });
    addLog(`새 에이전트 고용: ${name} (${translateRole(role)})`);
    setShowHireModal(false);
  };

  const fireAgent = (id: string, name: string) => {
    setConfirmFire({ id, name });
  };

  const executeFire = async (id: string, name: string) => {
    await fetch(`/api/agents/${id}`, {
      method: 'DELETE'
    });
    addLog(`에이전트 해고: ${name}`);
  };

  const createProject = async (name: string, description: string) => {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    addLog(`새 프로젝트 시작: ${name}`);
    setShowProjectModal(false);
  };

  const startMeeting = async () => {
    if (!socket) return;
    addLog("팀 회의 시작 중...");
    
    // Move all agents to the center
    gameState.agents.forEach((agent, i) => {
      const targetX = 400 + (Math.cos(i) * 100);
      const targetY = 300 + (Math.sin(i) * 100);
      socket.emit('agent:move', { agentId: agent.id, x: targetX, y: targetY });
    });

    // Sequence of speaking
    const agents = [...gameState.agents];
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const prompt = i === 0 
        ? "You are the leader of a team meeting. Start the meeting and ask for updates."
        : `You are in a team meeting. The leader just spoke. Give a short update on your ${agent.role} work.`;
      
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `You are ${agent.name} (${agent.role}). ${prompt} Max 10 words.`,
        });
        socket.emit('agent:message', { agentId: agent.id, message: response.text || "I'm ready!" });
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for bubble to show
      } catch (e) {
        console.error(e);
      }
    }
  };

  const simulateAgentAction = async (agent: Agent) => {
    if (!socket) return;
    
    if (agent.role === 'Leader') {
      // Leader distributes tasks
      addLog(`${agent.name} 리더가 업무를 분배하고 있습니다...`);
      const otherAgents = gameState.agents.filter(a => a.id !== agent.id);
      if (otherAgents.length > 0 && gameState.projects.length > 0) {
        const randomAgent = otherAgents[Math.floor(Math.random() * otherAgents.length)];
        const randomProject = gameState.projects[Math.floor(Math.random() * gameState.projects.length)];
        
        // Move leader towards the assigned agent for "briefing"
        const targetX = randomAgent.x + (Math.random() > 0.5 ? 60 : -60);
        const targetY = randomAgent.y + (Math.random() > 0.5 ? 60 : -60);
        socket.emit('agent:move', { agentId: agent.id, x: targetX, y: targetY });

        await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            projectId: randomProject.id, 
            assignedTo: randomAgent.id, 
            description: `${randomProject.name} 프로젝트 기능 구현` 
          })
        });
        
        socket.emit('agent:message', { 
          agentId: agent.id, 
          message: `${randomAgent.name}님, ${randomProject.name} 작업을 진행해 주세요.` 
        });
      }
    } else {
      // Regular agent action
      const otherAgents = gameState.agents.filter(a => a.id !== agent.id);
      const shouldVisit = Math.random() > 0.7 && otherAgents.length > 0;

      if (shouldVisit) {
        const target = otherAgents[Math.floor(Math.random() * otherAgents.length)];
        socket.emit('agent:message', { agentId: agent.id, message: `${target.name}님과 협업 중...` });
        
        // Move close to target
        const targetX = target.x + (Math.random() > 0.5 ? 50 : -50);
        const targetY = target.y + (Math.random() > 0.5 ? 50 : -50);
        socket.emit('agent:move', { agentId: agent.id, x: targetX, y: targetY });
      } else {
        socket.emit('agent:message', { agentId: agent.id, message: "다음 단계를 생각 중..." });
      }
      
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `You are an AI agent named ${agent.name} with the role of ${agent.role} in a software company. 
          Current status: ${agent.status}. 
          Give a short (max 10 words) status update or a thought about your work in Korean.`,
        });
        
        const message = response.text || "열심히 일하는 중!";
        socket.emit('agent:message', { agentId: agent.id, message });
        
        // Randomly move agent if not visiting
        if (!shouldVisit) {
          const newX = Math.max(50, Math.min(750, agent.x + (Math.random() - 0.5) * 200));
          const newY = Math.max(50, Math.min(450, agent.y + (Math.random() - 0.5) * 200));
          socket.emit('agent:move', { agentId: agent.id, x: newX, y: newY });
        }
        
      } catch (error) {
        console.error("Agent thinking failed:", error);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[var(--pixel-bg)] text-[var(--pixel-white)] font-game flex flex-col overflow-hidden h-screen">
      {/* Header */}
      <header className="h-[60px] bg-[#0f3460] border-b-4 border-[var(--pixel-border)] flex items-center justify-between px-6 z-20">
        <div className="text-2xl font-bold text-[var(--pixel-accent)] uppercase tracking-[2px]">
          LLM 타이쿤 v1.0
        </div>
        <div className="flex gap-5 text-sm">
          <div className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)]">
            에이전트: {gameState.agents.length}
          </div>
          <div className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)]">
            프로젝트: {gameState.projects.length}
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[220px] bg-[var(--pixel-card)] border-r-4 border-[var(--pixel-border)] flex flex-col p-4">
          <div className="text-[12px] text-[var(--pixel-accent)] mb-3 uppercase tracking-wider">워크스페이스</div>
          
          <nav className="flex-1 space-y-3 overflow-y-auto">
            <button 
              onClick={() => setActiveTab('game')}
              className={`w-full text-left p-3 border-2 transition-all ${activeTab === 'game' ? 'border-[var(--pixel-accent)] bg-[var(--pixel-bg)]' : 'border-[var(--pixel-border)] bg-[#0f3460] hover:bg-[#1a1a2e]'}`}
            >
              <span className="text-sm font-bold block">오피스 플로어</span>
              <span className="text-[10px] opacity-70">실시간 뷰</span>
            </button>
            
            <div className="h-px bg-[var(--pixel-border)] my-2" />
            
            <button 
              onClick={() => setActiveTab('projects')}
              className={`w-full text-left p-3 border-2 transition-all ${activeTab === 'projects' ? 'border-[var(--pixel-accent)] bg-[var(--pixel-bg)]' : 'border-[var(--pixel-border)] bg-[#0f3460] hover:bg-[#1a1a2e]'}`}
            >
              <span className="text-sm font-bold block">프로젝트</span>
              <span className="text-[10px] opacity-70">관리</span>
            </button>
            <button 
              onClick={() => setActiveTab('tasks')}
              className={`w-full text-left p-3 border-2 transition-all ${activeTab === 'tasks' ? 'border-[var(--pixel-accent)] bg-[var(--pixel-bg)]' : 'border-[var(--pixel-border)] bg-[#0f3460] hover:bg-[#1a1a2e]'}`}
            >
              <span className="text-sm font-bold block">작업</span>
              <span className="text-[10px] opacity-70">대기열</span>
            </button>
            <button 
              onClick={() => setActiveTab('agents')}
              className={`w-full text-left p-3 border-2 transition-all ${activeTab === 'agents' ? 'border-[var(--pixel-accent)] bg-[var(--pixel-bg)]' : 'border-[var(--pixel-border)] bg-[#0f3460] hover:bg-[#1a1a2e]'}`}
            >
              <span className="text-sm font-bold block">직원 목록</span>
              <span className="text-[10px] opacity-70">직원 명단</span>
            </button>
          </nav>

          <div className="mt-auto pt-4 space-y-3">
            <button 
              onClick={() => setShowHireModal(true)}
              className="w-full bg-[var(--pixel-accent)] text-black py-3 font-bold uppercase border-b-4 border-[#0099cc] hover:brightness-110 transition-all"
            >
              에이전트 고용
            </button>
            <button 
              onClick={startMeeting}
              className="w-full bg-[var(--pixel-text)] text-white py-3 font-bold uppercase border-b-4 border-[#a02d42] hover:brightness-110 transition-all"
            >
              팀 회의
            </button>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-0 relative">
          {activeTab === 'game' && (
            <div className="h-full flex flex-col p-0">
              <div 
                ref={gameWorldRef}
                className="flex-1 bg-[var(--pixel-bg)] relative overflow-hidden"
                style={{
                  backgroundImage: `
                    linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)
                  `,
                  backgroundSize: '32px 32px'
                }}
              >
                <AnimatePresence>
                  {gameState.agents.map((agent) => (
                    <AgentSprite 
                      key={agent.id} 
                      agent={agent} 
                      onClick={() => simulateAgentAction(agent)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}

          {activeTab === 'projects' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-8">
              {gameState.projects.map(project => (
                <div key={project.id} className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-5 hover:border-[var(--pixel-accent)] transition-all">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-bold text-[var(--pixel-accent)]">{project.name}</h3>
                    <span className="px-2 py-1 bg-black/30 text-[10px] uppercase font-bold border border-[var(--pixel-border)]">
                      {translateStatus(project.status)}
                    </span>
                  </div>
                  <p className="text-white/70 text-xs mb-6 h-12 line-clamp-3">{project.description}</p>
                  <div className="flex items-center justify-between mt-auto">
                    <div className="flex -space-x-2">
                      {gameState.agents.filter(a => project.agents.includes(a.id)).map(agent => (
                        <div key={agent.id} title={agent.name} className={`w-8 h-8 border-2 border-black ${agent.role === 'Leader' ? 'bg-[var(--pixel-accent)]' : 'bg-[var(--pixel-text)]'} flex items-center justify-center text-xs`}>
                          {getAgentEmoji(agent.role)}
                        </div>
                      ))}
                    </div>
                    <button className="p-2 bg-black/30 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] transition-colors">
                      <Play size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <button 
                onClick={() => setShowProjectModal(true)}
                className="border-2 border-dashed border-[var(--pixel-border)] p-6 flex flex-col items-center justify-center gap-3 text-[var(--pixel-accent)] hover:bg-white/5 transition-all"
              >
                <Plus size={32} />
                <span className="font-bold uppercase text-xs">[+] 새 프로젝트</span>
              </button>
            </div>
          )}

          {activeTab === 'tasks' && (
            <div className="space-y-4 p-8">
              {tasks.length === 0 && (
                <div className="text-center py-20 bg-[var(--pixel-card)] border-2 border-[var(--pixel-border)]">
                  <CheckCircle2 size={48} className="mx-auto text-[var(--pixel-border)] mb-4" />
                  <p className="text-[var(--pixel-accent)] font-bold uppercase text-sm">현재 대기 중인 작업이 없습니다.</p>
                </div>
              )}
              {tasks.map(task => (
                <div key={task.id} className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-black/30 border-2 border-[var(--pixel-border)] flex items-center justify-center">
                      <Briefcase size={20} className="text-[var(--pixel-accent)]" />
                    </div>
                    <div>
                      <p className="font-bold text-sm text-[var(--pixel-accent)]">{task.description}</p>
                      <p className="text-[10px] opacity-70 uppercase tracking-wider">
                        담당자: {gameState.agents.find(a => a.id === task.assignedTo)?.name || '알 수 없음'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 border-2 text-[10px] font-bold uppercase ${
                      task.status === 'pending' ? 'border-yellow-500 text-yellow-500' : 
                      task.status === 'in-progress' ? 'border-blue-500 text-blue-500' : 
                      'border-green-500 text-green-500'
                    }`}>
                      {translateStatus(task.status)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'agents' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-8">
              {gameState.agents.map(agent => (
                <div key={agent.id} className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-5 flex items-center justify-between hover:border-[var(--pixel-accent)] transition-all group">
                  <div className="flex items-center gap-4">
                    <div className={`w-14 h-14 border-2 border-black ${agent.role === 'Leader' ? 'bg-[var(--pixel-accent)]' : 'bg-[var(--pixel-text)]'} flex items-center justify-center text-2xl`}>
                      {getAgentEmoji(agent.role)}
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-[var(--pixel-accent)]">{agent.name}</h3>
                      <p className="text-[10px] uppercase tracking-widest font-bold opacity-70">{translateRole(agent.role)}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <div className={`w-2 h-2 ${agent.status === 'idle' ? 'bg-white/20' : 'bg-green-500 animate-pulse'}`} />
                        <span className="text-[10px] opacity-60 uppercase">{translateStatus(agent.status)}</span>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => fireAgent(agent.id, agent.name)}
                    className="opacity-0 group-hover:opacity-100 p-2 bg-red-900/30 border-2 border-red-900 hover:bg-red-900 transition-all text-[10px] font-bold uppercase"
                  >
                    해고
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        </main>

        {/* Right Panel (Management Console Style) */}
        <aside className="w-[280px] bg-[var(--pixel-card)] border-l-4 border-[var(--pixel-border)] p-4 flex flex-col">
          <div className="text-[12px] text-[var(--pixel-accent)] mb-3 uppercase tracking-wider">현재 직원</div>
          <div className="flex-1 space-y-2 overflow-y-auto">
            {gameState.agents.map(agent => (
              <div key={agent.id} className="bg-black/20 border-2 border-[var(--pixel-border)] p-2 grid grid-cols-[40px_1fr] gap-3">
                <div className={`w-8 h-8 border-2 border-black ${agent.role === 'Leader' ? 'bg-[var(--pixel-accent)]' : 'bg-[var(--pixel-text)]'} flex items-center justify-center text-xs`}>
                  {getAgentEmoji(agent.role)}
                </div>
                <div className="overflow-hidden">
                  <h4 className="text-[12px] text-[var(--pixel-accent)] font-bold truncate">{agent.name}</h4>
                  <p className="text-[10px] opacity-80 truncate">{translateRole(agent.role)} - {translateStatus(agent.status)}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t-2 border-[var(--pixel-border)]">
            <div className="text-[12px] text-[var(--pixel-accent)] mb-2 uppercase tracking-wider">마켓플레이스</div>
            <button 
              onClick={() => setShowHireModal(true)}
              className="w-full bg-[var(--pixel-accent)] text-black py-2 text-xs font-bold uppercase border-b-2 border-[#0099cc]"
            >
              새 에이전트 고용
            </button>
          </div>
        </aside>
      </div>

      {/* Bottom Log */}
      <footer className="h-[140px] bg-black border-t-4 border-[var(--pixel-border)] p-3 font-mono text-[11px] text-[#00ff00] overflow-y-auto">
        {logs.length === 0 && <div className="opacity-50 italic">시스템 준비 완료. 로그 대기 중...</div>}
        {logs.map(log => (
          <div key={log.id} className="mb-1 flex gap-3">
            <span className="text-[#888]">[{log.time}]</span>
            <span className="text-[var(--pixel-accent)] font-bold uppercase">시스템:</span>
            <span>{log.text}</span>
          </div>
        ))}
      </footer>

      {/* Modals */}
      <AnimatePresence>
        {showHireModal && (
          <Modal title="Hire New Agent" onClose={() => setShowHireModal(false)}>
            <HireForm onHire={hireAgent} />
          </Modal>
        )}
        {showProjectModal && (
          <Modal title="Start New Project" onClose={() => setShowProjectModal(false)}>
            <ProjectForm onCreate={createProject} />
          </Modal>
        )}
        {confirmFire && (
          <Modal title="직원 해고 확인" onClose={() => setConfirmFire(null)}>
            <div className="space-y-4">
              <p className="text-sm text-white/80">{confirmFire.name}님을 정말로 해고하시겠습니까?</p>
              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    executeFire(confirmFire.id, confirmFire.name);
                    setConfirmFire(null);
                  }}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white py-3 font-bold uppercase border-b-4 border-red-800"
                >
                  해고하기
                </button>
                <button 
                  onClick={() => setConfirmFire(null)}
                  className="flex-1 bg-gray-600 hover:bg-gray-700 text-white py-3 font-bold uppercase border-b-4 border-gray-800"
                >
                  취소
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentSprite({ agent, onClick }: { agent: Agent; onClick: () => void | Promise<void>; key?: string }) {
  return (
    <motion.div
      key={agent.id}
      layoutId={agent.id}
      initial={{ x: agent.x, y: agent.y, opacity: 0 }}
      animate={{ x: agent.x, y: agent.y, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 100, damping: 20 }}
      className="absolute cursor-pointer group"
      style={{ left: 0, top: 0 }}
      onClick={onClick}
    >
      {/* Dialogue Bubble */}
      <AnimatePresence>
        {agent.lastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute bottom-[60px] left-[-50px] w-[160px] bg-white text-black p-2 border-2 border-black text-[11px] leading-tight z-20"
          >
            {agent.lastMessage}
            <div className="absolute bottom-[-10px] left-1/2 -translate-x-1/2 border-x-[5px] border-x-transparent border-t-[5px] border-t-white" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Character Sprite */}
      <div className="relative">
        <div 
          className={`w-[48px] h-[48px] border-[3px] border-black flex items-center justify-center text-2xl relative ${agent.role === 'Leader' ? 'bg-[var(--pixel-accent)] shadow-[0_0_15px_var(--pixel-accent)]' : 'bg-[var(--pixel-text)]'}`}
        >
          {/* Pixel Eyes */}
          <div className="absolute top-2 left-2 w-[10px] h-[10px] bg-white shadow-[18px_0_white]" />
          <span className="relative z-10">{getAgentEmoji(agent.role)}</span>
        </div>
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap">
          <span className="text-[10px] font-bold bg-black/70 px-2 py-0.5 border border-[var(--pixel-border)]">
            {agent.name}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/80 backdrop-blur-sm" 
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="relative w-full max-w-md bg-[var(--pixel-card)] border-4 border-[var(--pixel-border)] shadow-2xl overflow-hidden"
      >
        <div className="p-4 border-b-4 border-[var(--pixel-border)] flex justify-between items-center bg-[#0f3460]">
          <h3 className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider">{title === 'Hire New Agent' ? '새 에이전트 고용' : title === 'Start New Project' ? '새 프로젝트 시작' : title}</h3>
          <button onClick={onClose} className="text-[var(--pixel-white)] hover:text-[var(--pixel-accent)] transition-colors">
            <Plus className="rotate-45" />
          </button>
        </div>
        <div className="p-6">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function HireForm({ onHire }: { onHire: (name: string, role: AgentRole, sprite: string) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Developer');

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2">에이전트 이름</label>
        <input 
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-black/30 border-2 border-[var(--pixel-border)] px-4 py-2 text-sm focus:outline-none focus:border-[var(--pixel-accent)] transition-colors text-white"
          placeholder="이름 입력..."
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2">역할 선택</label>
        <select 
          value={role}
          onChange={e => setRole(e.target.value as AgentRole)}
          className="w-full bg-black/30 border-2 border-[var(--pixel-border)] px-4 py-2 text-sm focus:outline-none focus:border-[var(--pixel-accent)] transition-colors text-white"
        >
          <option value="Leader">리더</option>
          <option value="Developer">개발자</option>
          <option value="QA">품질 관리</option>
          <option value="Designer">디자이너</option>
          <option value="Researcher">연구원</option>
        </select>
      </div>
      <button 
        onClick={() => onHire(name, role, 'char1')}
        className="w-full bg-[var(--pixel-accent)] text-black py-3 font-bold uppercase border-b-4 border-[#0099cc] mt-4"
      >
        고용 확정
      </button>
    </div>
  );
}

function ProjectForm({ onCreate }: { onCreate: (name: string, description: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2">프로젝트 제목</label>
        <input 
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-black/30 border-2 border-[var(--pixel-border)] px-4 py-2 text-sm focus:outline-none focus:border-[var(--pixel-accent)] transition-colors text-white"
          placeholder="프로젝트 이름..."
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2">설명</label>
        <textarea 
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="w-full bg-black/30 border-2 border-[var(--pixel-border)] px-4 py-2 text-sm focus:outline-none focus:border-[var(--pixel-accent)] transition-colors h-24 resize-none text-white"
          placeholder="미션 목표..."
        />
      </div>
      <button 
        onClick={() => onCreate(name, description)}
        className="w-full bg-[var(--pixel-accent)] text-black py-3 font-bold uppercase border-b-4 border-[#0099cc] mt-4"
      >
        프로젝트 초기화
      </button>
    </div>
  );
}

function getAgentColor(role: AgentRole) {
  switch (role) {
    case 'Leader': return 'from-yellow-400 to-orange-500';
    case 'Developer': return 'from-blue-400 to-indigo-500';
    case 'QA': return 'from-red-400 to-pink-500';
    case 'Designer': return 'from-purple-400 to-fuchsia-500';
    case 'Researcher': return 'from-green-400 to-emerald-500';
    default: return 'from-gray-400 to-gray-500';
  }
}

function getAgentEmoji(role: AgentRole) {
  switch (role) {
    case 'Leader': return '👑';
    case 'Developer': return '💻';
    case 'QA': return '🔍';
    case 'Designer': return '🎨';
    case 'Researcher': return '📚';
    default: return '🤖';
  }
}
