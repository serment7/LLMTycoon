# LLMTycoon

[한국어](README.md)

A development simulator where an AI agent team writes real code.
Give instructions to the Leader agent, and it distributes tasks to team members (Developer, QA, Designer, Researcher). Each agent reads, writes, and edits actual files through Claude CLI.

> **This project was built entirely through Vibe Coding.**
> All code was written solely through conversations with AI — no human-typed code.

## Warnings

> **This project is experimental and not yet suitable for production use.**

- **`--dangerously-skip-permissions` flag**: Agents invoke Claude CLI with permission checks disabled. Agents have unrestricted access to the file system — **do not run in environments containing sensitive data.** Always use an isolated workspace.
- **Stability limitations**: Rapidly prototyped through vibe coding. Unexpected behavior may occur in agent state management, error recovery, and concurrency handling.
- **Cost awareness**: Each agent invocation consumes API usage. In Auto-Dev mode, calls repeat every 12 seconds — monitor your billing accordingly.
- **Known limitations**:
  - Agents may perform work unrelated to instructions or repeatedly modify the same file
  - Git automation may fail intermittently
  - Leader task distribution may not always match team member roles

## Prerequisites

| Item | Version | Notes |
|------|---------|-------|
| Node.js | 18+ | |
| MongoDB | 6+ | Local or Atlas |
| Claude Code CLI | Latest | Verify with `claude --version`, authenticate with `claude login` |

## Installation & Running

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env and fill in required values like GIT_TOKEN_ENC_KEY

# Start development server
npm run dev
# → http://localhost:3000
```

## Environment Variables (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | | `mongodb://localhost:27017` | MongoDB connection URI |
| `MONGODB_DB` | | `llm-tycoon` | Database name |
| `PORT` | | `3000` | Server port |
| `GIT_TOKEN_ENC_KEY` | Yes | | Git token encryption key (32-byte hex) |
| `SESSION_SECRET` | | `change-me` | Session secret key |
| `DEV_MODE` | | `false` | `true` to bypass login |
| `ON_PREMISE` | | `true` | `false` to use OAuth |
| `CLAUDE_BIN` | | `claude` | Claude CLI path (when auto-detection fails) |
| `DEBUG_CLAUDE` | | `0` | `1` to enable Claude invocation debug logs |

## Tech Stack

- **Frontend**: React 19 + Vite + Tailwind CSS 4 + Motion (framer-motion)
- **Backend**: Express + Socket.IO + MongoDB
- **AI**: Claude Code CLI (MCP protocol provides per-agent tools)
- **Language**: TypeScript (ESM)

## Architecture

```
Browser (React SPA)
  │
  ├── Socket.IO ── Real-time state sync
  │
  └── REST API
        │
  Express Server (server.ts)
        │
        ├── MongoDB ── Project/Agent/Task/Settings persistence
        │
        ├── Claude CLI (stdin pipe) ── 1-shot commands (leader delegation, etc.)
        │
        └── AgentWorker (stream-json) ── Persistent per-agent process
              │
              └── MCP Server (mcp-agent-server.ts)
                    └── update_status, list_files, add_file, add_dependency
```

## Agent Roles

| Role | Responsibility |
|------|----------------|
| **Leader** | Analyzes user instructions and distributes tasks to team members (does not code directly) |
| **Developer** | Feature implementation, file creation/modification |
| **QA** | Test writing, code review |
| **Designer** | UI/UX related work |
| **Researcher** | Technical research, documentation |

## Operating Modes

### Auto-Dev OFF (Default)
Instruct the Leader → Task distribution → Every 12 seconds, pending tasks are detected and assigned agents execute automatically.

### Auto-Dev ON
Every 12 seconds, an idle agent is selected to autonomously search for and perform work. The Leader distributes role-based tasks to team members.

## Git Automation

Configure in Project Management > Git Automation Panel:

| Flow | Behavior |
|------|----------|
| **Commit Only** | Local commit only (safe) |
| **Commit + Push** | Commit then push to remote branch |
| **Full PR Flow** | Commit + Push + Create PR |

Branch strategies: `per-commit` / `per-task` / `per-session` / `fixed-branch`

Automatically triggered when an agent completes work.

## Key APIs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Full game state |
| POST | `/api/tasks` | Create task |
| PATCH | `/api/tasks/:id` | Update task status |
| PATCH | `/api/agents/:id/status` | Update agent status |
| POST | `/api/agent/think` | Invoke Claude |
| GET | `/api/projects/:id/git-automation` | Get git automation settings |
| POST | `/api/projects/:id/git-automation` | Save git automation settings |
| POST | `/api/emergency-stop` | Emergency stop all agents |

## Scripts

```bash
npm run dev          # Development server
npm run build        # Production build
npm run lint         # Type check
npm run audit:collab # Collaboration audit script
```

## License

**LLMTycoon License v1.0**

- Free to use for personal learning, research, and non-commercial purposes.
- Modification and redistribution require **prior notification and approval from the author**, unless the derivative work is released as open source.
- Companies or organizations using this for commercial purposes **must notify the author in advance**.
- All distributions must include attribution to the author.

Author: **uc5036@naver.com**

See [LICENSE](LICENSE) for details.
