# LLMTycoon

[English](README.en.md)

AI 에이전트 팀이 실제 코드를 작성하는 개발 시뮬레이터.
리더 에이전트에게 지시하면 팀원(Developer, QA, Designer, Researcher)에게 업무를 분배하고, 각 에이전트가 Claude CLI를 통해 실제 파일을 읽고/쓰고/편집합니다.

> **이 프로젝트는 100% 바이브코딩(Vibe Coding)으로 제작되었습니다.**
> 모든 코드가 AI와의 대화만으로 작성되었으며, 사람이 직접 타이핑한 코드는 없습니다.

## 주의 사항

> **이 프로젝트는 실험적 단계이며, 실무 투입에는 적합하지 않습니다.**

- **`--dangerously-skip-permissions` 사용**: 에이전트가 Claude CLI를 호출할 때 권한 확인을 건너뛰는 플래그를 사용합니다. 에이전트가 파일 시스템에 자유롭게 접근할 수 있으므로, **중요한 데이터가 있는 환경에서는 사용하지 마세요.** 반드시 격리된 워크스페이스에서 실행하시기 바랍니다.
- **안정성 부족**: 바이브코딩으로 빠르게 프로토타이핑된 프로젝트로, 에이전트 상태 관리, 에러 복구, 동시성 처리 등에서 예기치 않은 동작이 발생할 수 있습니다.
- **비용 주의**: 에이전트가 Claude CLI를 호출할 때마다 API 사용량이 발생합니다. 자동 개발 모드에서는 12초마다 호출이 반복되므로 요금에 유의하세요.
- **알려진 한계**:
  - 에이전트가 지시와 무관한 작업을 수행하거나, 같은 파일을 반복 수정하는 경우가 있습니다
  - Git 자동화가 간헐적으로 실패할 수 있습니다
  - 리더의 태스크 분배가 팀원 역할과 맞지 않을 수 있습니다

## 사전 조건

| 항목 | 버전 | 비고 |
|------|------|------|
| Node.js | 18+ | |
| MongoDB | 6+ | 로컬 또는 Atlas |
| Claude Code CLI | 최신 | `claude --version` 으로 확인, `claude login` 으로 인증 |

## 설치 및 실행

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 열어 GIT_TOKEN_ENC_KEY 등 필요한 값을 채워 넣으세요

# 개발 서버 실행
npm run dev
# → http://localhost:3000
```

## 환경변수 (.env)

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `MONGODB_URI` | | `mongodb://localhost:27017` | MongoDB 연결 URI |
| `MONGODB_DB` | | `llm-tycoon` | 데이터베이스 이름 |
| `PORT` | | `3000` | 서버 포트 |
| `GIT_TOKEN_ENC_KEY` | O | | Git 토큰 암호화 키 (32바이트 hex) |
| `SESSION_SECRET` | | `change-me` | 세션 비밀키 |
| `DEV_MODE` | | `false` | `true`면 로그인 우회 |
| `ON_PREMISE` | | `true` | `false`면 OAuth 사용 |
| `CLAUDE_BIN` | | `claude` | Claude CLI 경로 (자동 탐지 안 될 때) |
| `DEBUG_CLAUDE` | | `0` | `1`이면 Claude 호출 디버그 로그 |

## 기술 스택

- **프론트엔드**: React 19 + Vite + Tailwind CSS 4 + Motion (framer-motion)
- **백엔드**: Express + Socket.IO + MongoDB
- **AI**: Claude Code CLI (MCP 프로토콜로 에이전트별 도구 제공)
- **언어**: TypeScript (ESM)

## 아키텍처

```
브라우저 (React SPA)
  │
  ├── Socket.IO ── 실시간 상태 동기화
  │
  └── REST API
        │
  Express 서버 (server.ts)
        │
        ├── MongoDB ── 프로젝트/에이전트/태스크/설정 영속화
        │
        ├── Claude CLI (stdin 파이프) ── 1-shot 명령 (리더 분배 등)
        │
        └── AgentWorker (stream-json) ── 에이전트별 상시 프로세스
              │
              └── MCP Server (mcp-agent-server.ts)
                    └── update_status, list_files, add_file, add_dependency
```

## 에이전트 역할

| 역할 | 하는 일 |
|------|---------|
| **Leader** | 사용자 지시를 분석하여 팀원에게 태스크 분배 (직접 코딩하지 않음) |
| **Developer** | 기능 구현, 파일 생성/수정 |
| **QA** | 테스트 작성, 코드 리뷰 |
| **Designer** | UI/UX 관련 작업 |
| **Researcher** | 기술 조사, 문서 작성 |

## 동작 모드

### 자동 개발 OFF (기본)
리더에게 지시 → 태스크 분배 → 12초마다 pending 태스크를 감지하여 할당된 에이전트가 자동 실행

### 자동 개발 ON
12초마다 idle 에이전트를 선택하여 자율적으로 작업 탐색 및 수행. 리더는 팀원에게 역할 기반 업무 분배.

## Git 자동화

프로젝트 관리 > Git 자동화 패널에서 설정:

| 흐름 | 동작 |
|------|------|
| **Commit Only** | 로컬 커밋만 (안전) |
| **Commit + Push** | 커밋 후 원격 브랜치 푸시 |
| **Full PR Flow** | 커밋 + 푸시 + PR 생성 |

브랜치 전략: `per-commit` / `per-task` / `per-session` / `fixed-branch`

에이전트 작업 완료 시 자동으로 트리거됩니다.

## 주요 API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/state` | 전체 게임 상태 |
| POST | `/api/tasks` | 태스크 생성 |
| PATCH | `/api/tasks/:id` | 태스크 상태 변경 |
| PATCH | `/api/agents/:id/status` | 에이전트 상태 변경 |
| POST | `/api/agent/think` | Claude 호출 |
| GET | `/api/projects/:id/git-automation` | Git 자동화 설정 조회 |
| POST | `/api/projects/:id/git-automation` | Git 자동화 설정 저장 |
| POST | `/api/emergency-stop` | 전체 에이전트 긴급 정지 |

## 스크립트

```bash
npm run dev          # 개발 서버
npm run build        # 프로덕션 빌드
npm run lint         # 타입 체크
npm run audit:collab # 협업 감사 스크립트
```

## 라이선스

**LLMTycoon License v1.0**

- 개인 학습, 연구, 비상업적 목적으로 자유롭게 사용할 수 있습니다.
- 수정 및 재배포 시, **오픈소스 프로젝트가 아닌 경우** 사전에 저작자에게 고지하고 승인을 받아야 합니다.
- 기업 또는 단체가 상업적 목적으로 사용하는 경우, **사전에 저작자에게 고지**해야 합니다.
- 모든 배포물에 저작자 표시(attribution)를 포함해야 합니다.

저작자: **uc5036@naver.com**

자세한 내용은 [LICENSE](LICENSE) 파일을 참고하세요.
