/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import {
  Briefcase,
  Plus,
  Minus,
  Play,
  CheckCircle2,
  UserPlus,
  Trash2,
  MessageSquare,
  Settings,
} from 'lucide-react';
import { Agent, Project, GameState, AgentRole, CodeFile, CodeDependency, Task, GitAutomationSettings } from './types';
import { FileTooltip } from './components/FileTooltip';
import { ProjectManagement } from './components/ProjectManagement';
import { SharedGoalModal } from './components/SharedGoalModal';
import { AgentStatusPanel, type GitAutomationDigest, type GitAutomationStageKey, type GitAutomationStageState } from './components/AgentStatusPanel';
import { AgentContextBubble, AgentLogLine } from './components/AgentContextBubble';
import { CollabTimeline } from './components/CollabTimeline';
import { EmptyProjectPlaceholder, EmptyProjectPlaceholderSkeleton } from './components/EmptyProjectPlaceholder';
import { DirectivePrompt, AttachmentPreviewModal, classifyAttachment, type DirectiveAttachment as UiDirectiveAttachment } from './components/DirectivePrompt';
import { MediaPipelinePanel } from './components/MediaPipelinePanel';
import type { MediaChatAttachment } from './utils/mediaLoaders';
import { createDraftStore, type DraftStore } from './utils/draftStore';
import { deleteAllProjectFiles } from './store/projectFiles';
import { createShortcutRegistry, DEFAULT_MEDIA_SHORTCUTS, type MediaShortcutId, type ShortcutRegistry } from './utils/keyboardShortcuts';
import { createPendingRequestQueue, type PendingRequestQueue } from './utils/pendingRequestQueue';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { toastBus } from './components/ToastProvider';
import { CurrentProjectBadge } from './components/CurrentProjectBadge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, useToast } from './components/ToastProvider';
import { UploadDropzone } from './components/UploadDropzone';
import { OnboardingTour } from './components/OnboardingTour';
import { ConversationSearch } from './components/ConversationSearch';
import { SettingsDrawer } from './components/SettingsDrawer';
import type { SearchableMessage } from './utils/conversationSearch';
// Service Worker 비활성화 — 개발 중 캐시 문제 유발
// import { registerServiceWorker, applyWaitingUpdate } from './utils/serviceWorkerRegistration';
import { loadMediaFile } from './utils/mediaLoaders';
import { mapUnknownError, messageToToastInput } from './utils/errorMessages';
import { claudeTokenUsageStore } from './utils/claudeTokenUsageStore';
import {
  SUBSCRIPTION_SESSION_STORAGE_KEY,
  deserializePersistedSession,
  reconcileRestoredWithServer,
} from './utils/claudeSubscriptionSession';
import type { ClaudeTokenUsage as ClaudeTokenUsageDelta, ClaudeTokenUsageTotals, ClaudeSessionStatus } from './types';
import { computeWorkspaceInsights } from './utils/workspaceInsights';
import type { LedgerEntry } from './utils/handoffLedger';
import { EXCLUDED_PATHS } from './utils/codeGraphFilter';
import { useReducedMotion } from './utils/useReducedMotion';
import { parseLeaderPlanMessage, summarizeLeaderMessage, LEADER_ANSWER_ONLY_LABEL, LEADER_ANSWER_ONLY_TOOLTIP, type LeaderPlan } from './utils/leaderMessage';

// QA: 화면에 쌓이는 상태·타이밍 상수를 한곳에 모아 매직 넘버를 제거한다.
// 값을 바꿀 때 여러 곳을 동시에 손대지 않도록 단일 출처(single source of truth)를
// 유지하며, 근거를 주석으로 남겨 후속 튜닝 시 "왜 이 숫자인가"를 잃지 않게 한다.
//
//  - LOG_PANEL_MAX: 로그 패널은 최근 맥락을 빠르게 훑는 용도라 상한을 둬
//    DOM/메모리 누수와 스크롤 성능 저하를 막는다.
//  - AGENT_MESSAGE_TTL_MS: 머리 위 말풍선은 "방금 한 말"만 보여야 새 대화를
//    가리지 않는다. 5초는 사람 눈으로 읽을 수 있는 최소한의 체류 시간.
//  - AGENT_PATH_*: 에이전트 꼬리 궤적은 최근 움직임만 잔상으로 남기면 된다.
//    점이 너무 길면 그래프가 지저분해지고, 너무 짧으면 이동 방향이 안 보인다.
//  - AGENT_PATH_CLEANUP_MS: 만료된 점 정리 주기. 렌더 부담을 고려해
//    PATH_RETENTION_MS 보다 짧게 잡아 잔점이 남지 않게 한다.
const LOG_PANEL_MAX = 50;
// 새로고침 후에도 최근 대화 맥락을 잃지 않도록 localStorage 에 최근 로그 일부를 보관한다.
// 너무 많이 되살리면 "오래된 맥락"이 현재 상황을 가리므로 의도적으로 적게 잡는다.
const LOG_PERSIST_MAX = 20;
const LOG_STORAGE_KEY = 'llm-tycoon:logs';

type LogEntry = { id: string; from: string; to?: string; text: string; time: string };

// UI 상태(업로드 진행·오류)와 서버가 돌려준 참조값(fileId/extractedText/images)을 하나의
// 엔트리에 병합한다. DirectivePrompt 는 UI 필드만 읽고, sendLeaderCommand 는 status==='done'
// 인 항목의 서버 필드만 /api/tasks 로 보낸다.
type PendingDirectiveAttachment = UiDirectiveAttachment & {
  fileId?: string;
  extractedText?: string;
  images?: string[];
};

// git commit stdout 예: "[my-branch abc1234] message" — 대괄호 안의 두 번째 토큰이 단축 SHA.
const COMMIT_SHA_RE = /\[[^\]]*\s+([0-9a-f]{7,40})\]/i;
// gh pr create stdout 마지막 줄에 "https://github.com/owner/repo/pull/123" 가 들어온다.
const PR_URL_RE = /https?:\/\/github\.com\/[^\s]+\/pull\/\d+/;

// 서버의 'git-automation:ran' 페이로드를 AgentStatusPanel 이 소비하는 digest 로 접는다.
// 단계별 state 는 results 배열에서 실패 지점을 기준으로 파생하며, commit/pr 의 stdout
// 에서 SHA/URL 을 파싱해 detail 라벨로 바로 보여줄 수 있도록 담아 준다.
export function buildGitAutomationDigest(payload: {
  branch?: string;
  results: Array<{ label: string; ok: boolean; code: number | null; stderr?: string; stdout?: string }>;
}): GitAutomationDigest {
  const stageByLabel: Record<string, GitAutomationStageKey> = {
    commit: 'commit',
    push: 'push',
    pr: 'pr',
  };
  const stages: Record<GitAutomationStageKey, { state: GitAutomationStageState; detail?: string; errorMessage?: string }> = {
    commit: { state: 'idle' },
    push: { state: 'idle' },
    pr: { state: 'idle' },
  };
  let commitSha: string | undefined;
  let prUrl: string | undefined;
  // 실패 단계를 만나기 전까지는 성공으로 누적. 이후 단계는 자동화가 조기 종료됐으므로
  // 그대로 idle(대기) 로 남겨 "거기까지 진행됐는지" 를 패널에서 한눈에 보이게 한다.
  for (const r of payload.results) {
    const key = stageByLabel[r.label];
    if (!key) continue;
    if (r.ok) {
      stages[key] = { state: 'success' };
      if (key === 'commit' && r.stdout) {
        const m = r.stdout.match(COMMIT_SHA_RE);
        if (m) {
          commitSha = m[1];
          stages.commit.detail = `SHA ${commitSha}`;
        }
      }
      if (key === 'pr' && r.stdout) {
        const m = r.stdout.match(PR_URL_RE);
        if (m) {
          prUrl = m[0];
          stages.pr.detail = prUrl;
        }
      }
    } else {
      stages[key] = {
        state: 'failed',
        errorMessage: (r.stderr || `exit=${r.code ?? '?'}`).trim() || undefined,
      };
    }
  }
  return {
    stages,
    branch: payload.branch,
    commitSha,
    prUrl,
  };
}

function loadPersistedLogs(): LogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is LogEntry =>
        !!e && typeof e.id === 'string' && typeof e.from === 'string' &&
        typeof e.text === 'string' && typeof e.time === 'string')
      .slice(0, LOG_PERSIST_MAX);
  } catch {
    return [];
  }
}
const AGENT_MESSAGE_TTL_MS = 5000;
const AGENT_PATH_MAX_POINTS = 10;
const AGENT_PATH_RETENTION_MS = 3000;
const AGENT_PATH_CLEANUP_MS = 500;

function App() {
  // Agents 탭 라이브 닷·기타 펄스 마이크로 인터랙션을 prefers-reduced-motion 사용자에게 비활성화한다.
  const reducedMotion = useReducedMotion();
  // 멀티미디어 업로드 토스트(#25c6969c) — UploadDropzone 에서 검증 실패/네트워크 오류를
  // 사용자 친화 메시지로 고지한다. ToastProvider 는 AppRoot 가 감싸므로 본 훅이 안전.
  const mediaToast = useToast();
  // 설정 드로어(#0dceedcd) 상태. 상단바 톱니 버튼이 열고, 내부의 "투어 다시 보기" 가
  // OnboardingTour 의 restartKey 를 증가시켜 재개한다.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingRestartKey, setOnboardingRestartKey] = useState(0);

  // 서비스 워커 등록(#0dceedcd) — 보안 컨텍스트에서만 부팅. 새 버전 발견 시 토스트로
  // 안내하고 사용자가 수락하면 skipWaiting → 새로고침으로 즉시 갱신한다. 실패는 조용히 무시.
  useEffect(() => {
    // Service Worker 비활성화 — 개발 중 캐시된 이전 번들을 서빙하여 변경이 반영 안 되는 문제 유발.
    // 기존에 등록된 SW가 있으면 해제한다.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        for (const reg of regs) reg.unregister();
      });
    }
    return () => {};
    // mediaToast 는 참조가 매번 바뀌지 않도록 ToastProvider 가 useMemo 로 안정화한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [gameState, setGameState] = useState<GameState>({ projects: [], agents: [], files: [], dependencies: [] });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [activeTab, setActiveTab] = useState<'game' | 'projects' | 'agents' | 'tasks' | 'project-management'>('game');
  const [showHireModal, setShowHireModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [manageMembersProjectId, setManageMembersProjectId] = useState<string | null>(null);
  const [confirmFire, setConfirmFire] = useState<{ id: string; name: string } | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<{ id: string; name: string } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>(() => loadPersistedLogs());
  const [hoveredFileId, setHoveredFileId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [commandBusy, setCommandBusy] = useState(false);
  // 리더 지시 입력과 함께 전송할 첨부파일. 업로드 엔드포인트가 반환한 fileId +
  // 추출 텍스트 / 이미지 base64 를 그대로 보관하며, 지시 전송 시 payload.attachments
  // 로 서버에 전달한다. 전송 완료 시 비운다. 업로드 UI는 별도 위젯이 주입.
  const [pendingAttachments, setPendingAttachments] = useState<PendingDirectiveAttachment[]>([]);
  // MediaPipelinePanel 이 정규화해 올려 주는 멀티미디어 첨부. 리더 지시 전송 시
  // pendingAttachments 와 나란히 서버에 실려, 모델 컨텍스트에서 PDF/PPT/영상 메타가
  // 페이지 인덱스·요약 한 줄과 함께 조회된다. 전송 성공 후 panel 이 미리보기를 그대로
  // 유지하므로 (MediaPipelinePanel 미관리) 본 배열을 비우지는 않는다 — 사용자가
  // panel 에서 명시적으로 제거해야만 사라진다.
  const [mediaChatAttachments, setMediaChatAttachments] = useState<MediaChatAttachment[]>([]);
  // 드래프트(초안) 저장·복원 — 탭 새로고침/토큰 만료 이후에도 commandInput + 멀티미디어
  // 첨부가 유지되도록 대화별(= 프로젝트별) 키로 IDB 에 쓴다. Node/SSR 환경은 내부
  // 폴백 메모리 어댑터로 수렴해 런타임 오류가 나지 않는다(#222ece09 §2).
  const draftStoreRef = useRef<DraftStore>();
  if (!draftStoreRef.current) draftStoreRef.current = createDraftStore();
  // 키보드 단축키 중앙 레지스트리 — App.tsx 가 소유해 OnboardingTour 등 다른
  // 구독자와 충돌 없이 하나의 진원을 유지한다(#222ece09 §4). 기본 바인딩은 모듈이
  // 제공하고, 필요 시 추가 등록이 런타임에 가능하다.
  const shortcutRegistryRef = useRef<ShortcutRegistry<MediaShortcutId>>();
  if (!shortcutRegistryRef.current) {
    const reg = createShortcutRegistry<MediaShortcutId>();
    for (const s of DEFAULT_MEDIA_SHORTCUTS) reg.register(s);
    shortcutRegistryRef.current = reg;
  }
  // 실패 요청 영속 재시도 큐 — 네트워크 단절·5xx 류 일시 오류만 대상. 레이트리밋·
  // 토큰 만료 같은 세션 신호는 `claudeSubscriptionSession` 의 pending 큐가 책임진다
  // (#3f1b7597 §3 책임 분리).
  const pendingQueueRef = useRef<PendingRequestQueue>();
  if (!pendingQueueRef.current) pendingQueueRef.current = createPendingRequestQueue();
  // 오프라인 상태 훅 — 상단바 배너·전송 버튼 라벨·재시도 트리거 세 축이 같은
  // 신호를 구독한다.
  const online = useOnlineStatus();
  // DirectivePrompt 토스트. 업로드 사전검증(프로젝트 미선택 등) 에러를 여기로 흘려보낸다.
  const [directiveErrorToast, setDirectiveErrorToast] = useState<string | null>(null);
  // 첨부 미리보기 상태. previewUrl 은 image/pdf 모달에 주입할 blob/서버 URL,
  // previewText 는 text 모달이 읽을 본문 캐시. previewBlobUrlRef 는 이번 세션에서
  // URL.createObjectURL 로 만든 blob URL 을 추적해 닫을 때 정확히 revoke 해 메모리 누수를 막는다.
  const [previewingAttachment, setPreviewingAttachment] = useState<UiDirectiveAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const previewBlobUrlRef = useRef<string | null>(null);
  // 자동 개발 모드. 서버가 source of truth 를 소유한다 (여러 브라우저에서도 일관성
  // 유지). 초기엔 false 로 두고 mount 시점에 GET /api/auto-dev 로 동기화하며,
  // 'auto-dev:updated' 소켓 이벤트로 푸시 갱신을 받는다.
  const [autoDevEnabled, setAutoDevEnabled] = useState<boolean>(false);
  // 자동 개발 ON 직전에 GET /api/projects/:id/shared-goal 이 null 을 돌려주면(공동 목표
  // 미설정) 토글을 켜지 않고 이 플래그를 올려 전면 모달로 사용자에게 공동 목표 입력을
  // 요청한다. Thanos 가 추후 도입할 SharedGoalModal(공동 목표 작성 폼) 과 충돌하지
  // 않도록, 본 가드는 기존 Modal(z-50 오버레이)만 재사용하고 상태 소유는 App 루트에 둔다.
  const [sharedGoalPromptOpen, setSharedGoalPromptOpen] = useState<boolean>(false);
  const [agentPaths, setAgentPaths] = useState<Record<string, { x: number; y: number; id: string; timestamp: number }[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // 초기 state:initial 소켓 이벤트가 도착해 선택 프로젝트 복원/폴백 판정이 끝날 때까지는 false.
  // 이 플래그가 false 인 동안에는 EmptyProjectPlaceholder(프로젝트 선택 유도) 대신 스켈레톤을
  // 렌더해, localStorage 복원 직전 찰나에 "프로젝트가 없는 것처럼" 깜빡이는 현상을 제거한다.
  const [hydrated, setHydrated] = useState<boolean>(false);
  // 마지막으로 열었던 프로젝트 ID. 새로고침 후 바로 복원되어, 다른 작업자와 같은
  // 워크스페이스에서 이어 일할 수 있도록 한다. 서버는 Source Of Truth 가 아니라
  // 단순히 프로젝트 목록만 돌려주므로, 선택 지속성은 클라이언트 전용.
  const SELECTED_PROJECT_KEY = 'llm-tycoon:selected-project';
  // Git 자동화 설정은 프로젝트 진입(selectedProjectId 변경) 시점에 서버에서 한 번 읽어
  // 앱 전역 상태로 보관한다. ProjectManagement 화면을 열지 않아도 리더 자동화가 즉시
  // 제 설정을 따르도록 하기 위함. socket 'git-automation:updated' 로 동기화 유지.
  const [gitAutomationSettings, setGitAutomationSettings] = useState<GitAutomationSettings | null>(null);
  // 최근 Git 자동화 실행 결과. 서버가 'git-automation:ran' 소켓 이벤트로 push 해 주며,
  // AgentStatusPanel 우측 패널에 단계별 진행 + 커밋 SHA / PR URL 을 표시하는 데 쓴다.
  // results[].stdout 에서 SHA(`[branch abc1234] ...`) 와 PR URL(github.com/.../pull/N) 을 파싱한다.
  const [lastGitAutomation, setLastGitAutomation] = useState<GitAutomationDigest | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const gameWorldRef = useRef<HTMLDivElement>(null);
  const [layoutPositions, setLayoutPositions] = useState<Record<string, { x: number; y: number }>>({});
  // 팀 축 협업 타임라인 데이터. 서버가 docs/handoffs · docs/reports frontmatter를 파싱해 반환.
  const [collabEntries, setCollabEntries] = useState<LedgerEntry[]>([]);
  // 타임라인 행 호버 시 지목된 에이전트 이름. AgentContextBubble 하이라이트 링 구동용(프로펠 다운 1개).
  const [highlightedAgent, setHighlightedAgent] = useState<string | null>(null);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const velocitiesRef = useRef<Record<string, { x: number; y: number }>>({});
  const gameStateRef = useRef<GameState>(gameState);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  // 로그 패널(리더 지시 입력 + 로그)의 전체 높이. 사용자가 상단 핸들을 위아래로
  // 드래그해 조절할 수 있으며, 새로고침 후에도 취향이 유지되도록 localStorage 에
  // 보관한다. 최소/최대값은 좁은 화면에서도 한 줄은 보이고, 상단 게임 뷰가
  // 완전히 가려지지 않도록 경험적으로 정했다.
  // QA: 모듈 상단의 LOG_PANEL_MAX(=로그 엔트리 개수 50) 와 이름이 겹치지 않도록
  // 높이 상수는 LOG_PANEL_HEIGHT_* 로 분리한다. 과거 동일 이름으로 인해
  // App 내부에서 addLog 의 slice 가 50 이 아닌 640 을 사용하던 버그가 있었다.
  const LOG_PANEL_HEIGHT_MIN = 120;
  const LOG_PANEL_HEIGHT_MAX = 640;
  const LOG_PANEL_KEY = 'llm-tycoon:log-panel-h';
  const [logPanelHeight, setLogPanelHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 240;
    const raw = window.localStorage.getItem(LOG_PANEL_KEY)
      ?? window.localStorage.getItem('llm-tycoon:bottom-panel-h');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n)
      ? Math.min(LOG_PANEL_HEIGHT_MAX, Math.max(LOG_PANEL_HEIGHT_MIN, n))
      : 240;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(LOG_PANEL_KEY, String(logPanelHeight)); }
    catch { /* 쿼터 초과 등은 무시: 기능은 세션 내에서 정상 동작 */ }
  }, [logPanelHeight]);

  // 하단 패널은 "지시" / "로그" 두 탭을 교대로 보여준다. 두 콘텐츠가 세로로 쌓이면
  // 좁은 화면에서 둘 다 제 역할을 못 하므로, 한 번에 하나만 렌더한다. 사용자가 고른
  // 탭은 다음 접속에서도 복원되어야 "로그 보다가 새로고침 → 지시로 튕김" 회귀를 막는다.
  const LOG_PANEL_TAB_KEY = 'llmtycoon.logPanelTab';
  const [logPanelTab, setLogPanelTab] = useState<'directive' | 'log'>(() => {
    if (typeof window === 'undefined') return 'directive';
    const raw = window.localStorage.getItem(LOG_PANEL_TAB_KEY);
    return raw === 'log' ? 'log' : 'directive';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(LOG_PANEL_TAB_KEY, logPanelTab); }
    catch { /* 쿼터 초과 등은 무시 */ }
  }, [logPanelTab]);
  // ←/→ 로 두 탭을 토글. Home/End 는 탭이 2개뿐이라 일반 좌우 이동과 구분이 무의미해 생략.
  const handleLogPanelTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setLogPanelTab(prev => (prev === 'directive' ? 'log' : 'directive'));
  };
  // 미확인 로그 뱃지. 사용자가 '지시' 탭에 머무는 동안 새로 쌓인 로그 수를 집계해
  // '로그' 탭 헤더에 주황 뱃지로 표시한다. 탭을 '로그' 로 전환하면 즉시 0 으로 리셋.
  // logs.length 의 이전 값을 ref 로 기억해, 로그가 줄어드는 경우(예: localStorage
  // 복원 직후 overwrite) 에는 증가시키지 않는다.
  const [unseenLogCount, setUnseenLogCount] = useState<number>(0);
  const prevLogsLengthRef = useRef<number>(0);
  useEffect(() => {
    if (logPanelTab === 'log') {
      setUnseenLogCount(0);
    } else {
      const delta = logs.length - prevLogsLengthRef.current;
      if (delta > 0) setUnseenLogCount(n => n + delta);
    }
    prevLogsLengthRef.current = logs.length;
  }, [logs.length, logPanelTab]);

  // 선택 프로젝트 지속성. hydrated 이전의 null 은 '복원 대기' 상태이므로 저장하지 않는다.
  // 하이드레이션이 끝난 뒤 사용자가 명시적으로 null 로 비운 경우에만 키를 제거한다.
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    try {
      if (selectedProjectId) window.localStorage.setItem(SELECTED_PROJECT_KEY, selectedProjectId);
      else window.localStorage.removeItem(SELECTED_PROJECT_KEY);
    } catch { /* 쿼터 초과 등은 무시: 다음 전환에서 다시 저장 */ }
  }, [selectedProjectId, hydrated]);
  const logPanelDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const startLogPanelResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    logPanelDragRef.current = { startY: e.clientY, startH: logPanelHeight };
    const onMove = (ev: MouseEvent) => {
      const ctx = logPanelDragRef.current;
      if (!ctx) return;
      // 핸들을 위로 끌면 패널이 커지고(+), 아래로 끌면 작아지는(-) 직관과 일치.
      const delta = ctx.startY - ev.clientY;
      const next = Math.min(
        LOG_PANEL_HEIGHT_MAX,
        Math.max(LOG_PANEL_HEIGHT_MIN, ctx.startH + delta),
      );
      setLogPanelHeight(next);
    };
    const onUp = () => {
      logPanelDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const addLog = (text: string, from: string = '시스템', to?: string) => {
    setLogs(prev => [{ id: uuidv4(), from, to, text, time: new Date().toLocaleTimeString() }, ...prev].slice(0, LOG_PANEL_MAX));
  };

  // 새로고침 이후에도 "몇 개 정도"의 이전 대화가 복원되도록 localStorage 에 상단 일부만 저장한다.
  // 저장은 변경 시마다 수행하되 상한을 걸어 용량 증가를 막는다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const snapshot = logs.slice(0, LOG_PERSIST_MAX);
      window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // 쿼터 초과 등은 무시한다. 로그는 휘발돼도 기능에 지장이 없다.
    }
  }, [logs]);

  const workspaceInsights = useMemo(
    () => computeWorkspaceInsights(
      selectedProjectId,
      gameState.projects,
      gameState.agents,
      gameState.files,
      gameState.dependencies || [],
    ),
    [selectedProjectId, gameState.projects, gameState.agents, gameState.files, gameState.dependencies],
  );

  // 연구 지표: 선택된 프로젝트에 소속된 에이전트 중 실제 파일 작업 중인 비율.
  // idle/thinking/meeting 는 제외하고 workingOnFileId 가 찍힌 에이전트만 '활성'으로 카운트한다.
  // byRole 은 역할별 (활성/전체) 를 분해하여 "왜 활성률이 낮은가" 같은 후속 질문에
  // 바로 답할 수 있게 한다. 역할 라벨 번역은 소비 지점에서 수행.
  const agentActivity = useMemo(() => {
    const proj = gameState.projects.find(p => p.id === selectedProjectId);
    const scope = proj
      ? gameState.agents.filter(a => proj.agents.includes(a.id))
      : gameState.agents;
    const total = scope.length;
    const active = scope.filter(a => !!a.workingOnFileId).length;
    const ratio = total === 0 ? 0 : Math.round((active / total) * 100);
    const byRole: Record<string, { active: number; total: number }> = {};
    for (const a of scope) {
      const bucket = byRole[a.role] ?? { active: 0, total: 0 };
      bucket.total += 1;
      if (a.workingOnFileId) bucket.active += 1;
      byRole[a.role] = bucket;
    }
    return { total, active, ratio, byRole };
  }, [selectedProjectId, gameState.projects, gameState.agents]);

  const translateRole = getRoleLabel;
  const translateStatus = getStatusLabel;

  // 리더 분배 메시지에 들어 있는 task.assignedTo (에이전트 ID) 를 사용자가 알아볼
  // 수 있는 이름으로 치환하기 위한 lookup. 한 번만 빌드해 모든 로그 행이 공유한다.
  // 매핑이 없는 ID 는 (해고된 팀원 등) 원본을 그대로 노출해 정보 손실을 막는다.
  // 이름뿐 아니라 role 도 필요해(배지 배경/이모지/설명) Agent 전체를 담는다.
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of gameState.agents) map.set(a.id, a);
    return map;
  }, [gameState.agents]);

  // 역할별 (활성/전체) 를 한 줄로 요약한 툴팁 라벨. translateRole 은 렌더 마다 새로
  // 만들어지지만 useMemo 의존성에 agentActivity 만 넣어도 충분하다 — 동일 데이터에 대해
  // 동일 결과를 낸다.
  const activityBreakdownLabel = useMemo(() => {
    // QA: Object.entries 반환 타입은 값이 unknown 으로 넓어질 수 있어
    // 명시 타입을 달아 sort 비교자가 `.total` 에 안전하게 접근하도록 고정한다.
    const entries = Object.entries(agentActivity.byRole) as [string, { active: number; total: number }][];
    const base = `활성 ${agentActivity.active} / 전체 ${agentActivity.total}`;
    if (entries.length === 0) return base;
    const parts = entries
      .sort((a, b) => b[1].total - a[1].total)
      .map(([role, { active, total }]) => `${getRoleLabel(role)} ${active}/${total}`);
    return `${base} · ${parts.join(', ')}`;
  }, [agentActivity]);

  // 연구 지표: 로그 패널에 쌓인 메시지를 바탕으로 협업 밀도를 추정한다.
  // messages: 시스템 메시지를 제외한 에이전트 간 통신 수. broadcasts 는 타겟이
  // 비어 있는(전체 공지) 비율. pairs 는 고유한 from→to 쌍 수로, 같은 두 사람이
  // 반복 대화해도 1로 집계해 "서로 다른 협업 채널이 얼마나 열려 있는가"를 본다.
  // topSender 는 가장 많이 발화한 에이전트. 연구·QA 브리핑에서 "지나치게 말을
  // 많이 하는 역할이 있는가"를 판단하는 신호로 쓴다.
  // 추가 지표:
  //  - uniqueSenders: 서로 다른 발화자 수. 침묵하는 구성원을 발견하는 1차 필터.
  //  - participationRate: 전체 에이전트 대비 최근 발화한 에이전트 비율.
  //    0% 에 수렴하면 팀이 비동기 작업에만 몰두 중이거나 커뮤니케이션이
  //    막혔다는 신호다.
  //  - concentration: 최다 발화자가 전체 메시지에서 차지하는 비율.
  //    50% 를 넘으면 특정 에이전트가 채널을 독점하고 있다고 본다.
  //  - silentAgents: 등록되어 있으나 이번 세션에서 한 번도 발화하지 않은
  //    에이전트의 수. 로그는 최근 50건으로 잘리므로 장기 침묵이 아닌
  //    "최근 침묵" 지표로 읽어야 한다.
  const collaborationStats = useMemo(() => {
    const messages = logs.filter(l => l.from !== '시스템' && l.from !== '사용자');
    const pairKeys = new Set<string>();
    const senderCounts = new Map<string, number>();
    let broadcasts = 0;
    for (const m of messages) {
      if (m.to) pairKeys.add(`${m.from}->${m.to}`);
      else broadcasts += 1;
      senderCounts.set(m.from, (senderCounts.get(m.from) ?? 0) + 1);
    }
    let topSender: { name: string; count: number } | null = null;
    senderCounts.forEach((count, name) => {
      if (!topSender || count > topSender.count) topSender = { name, count };
    });
    const broadcastRatio = messages.length === 0
      ? 0
      : Math.round((broadcasts / messages.length) * 100);
    const uniqueSenders = senderCounts.size;
    const totalAgents = gameState.agents.length;
    const participationRate = totalAgents === 0
      ? 0
      : Math.round((uniqueSenders / totalAgents) * 100);
    const concentration = messages.length === 0 || !topSender
      ? 0
      : Math.round((topSender.count / messages.length) * 100);
    const silentAgents = gameState.agents.filter(a => !senderCounts.has(a.name)).length;
    return {
      messageCount: messages.length,
      pairCount: pairKeys.size,
      broadcastRatio,
      topSender,
      uniqueSenders,
      participationRate,
      concentration,
      silentAgents,
    };
  }, [logs, gameState.agents]);

  // 상단 상태 줄/툴팁에 붙여 쓰는 한 줄 요약.
  // 메시지가 한 건도 없을 때는 조용히 빈 상태를 드러내 "데이터 아직 없음"을
  // 명시한다. 숫자가 0이어도 의미가 있는 신호라 감추지 않는다.
  const collaborationLabel = useMemo(() => {
    const {
      messageCount,
      pairCount,
      broadcastRatio,
      topSender,
      participationRate,
      concentration,
      silentAgents,
    } = collaborationStats;
    if (messageCount === 0) return '협업 로그 없음';
    const parts = [
      `메시지 ${messageCount}`,
      `채널 ${pairCount}`,
      `공지 ${broadcastRatio}%`,
      `참여율 ${participationRate}%`,
      `집중도 ${concentration}%`,
    ];
    if (silentAgents > 0) parts.push(`침묵 ${silentAgents}명`);
    if (topSender) parts.push(`최다 발화 ${topSender.name}(${topSender.count})`);
    return parts.join(' · ');
  }, [collaborationStats]);

  // 헤더 칩에 한 눈에 띄는 숫자를 고른다.
  // 메시지가 없으면 "-" 를 보여 "0%" 와 "데이터 없음" 을 혼동하지 않게 한다.
  // 참여율은 "지금 팀이 서로 말을 하고 있는가" 를 가장 빠르게 답하는 지표라
  // 대표값으로 선택했다. 자세한 분해는 툴팁(collaborationLabel)에서 본다.
  const collaborationBadge = useMemo(() => {
    if (collaborationStats.messageCount === 0) return '-';
    return `${collaborationStats.participationRate}%`;
  }, [collaborationStats]);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('state:initial', (state: GameState) => {
      setGameState(state);
      // 복원 우선순위: ① localStorage 에 남아있고 여전히 유효한 프로젝트 ID → ② 첫 프로젝트 → ③ null.
      // 이미 사용자가 선택을 바꾼 뒤 지연 도착한 state:initial 에는 간섭하지 않도록
      // setSelectedProjectId 함수형 업데이트로 현재 값을 확인 후 결정한다.
      let restored: string | null = null;
      if (typeof window !== 'undefined') {
        try { restored = window.localStorage.getItem(SELECTED_PROJECT_KEY); }
        catch { /* 쿼터/권한 실패는 무시, 아래에서 첫 프로젝트로 폴백 */ }
      }
      setSelectedProjectId(prev => {
        if (prev) return prev;
        if (restored && state.projects.some(p => p.id === restored)) return restored;
        return state.projects[0]?.id ?? null;
      });
      setHydrated(true);
    });

    newSocket.on('state:updated', (state: GameState) => {
      setGameState(state);
    });

    newSocket.on('tasks:updated', (newTasks: Task[]) => {
      setTasks(newTasks);
    });

    // 자동개발 상태 초기 동기화 + 서버 측 변경 반영. 이 플래그는 이제 서버가
    // 소유하며, 토글 시 PATCH /api/auto-dev 로만 바꾼다.
    fetch('/api/auto-dev')
      .then(r => r.ok ? r.json() : null)
      .then((row: { enabled?: boolean } | null) => {
        if (row && typeof row.enabled === 'boolean') setAutoDevEnabled(row.enabled);
      })
      .catch(() => { /* 초기값 false 유지 */ });
    newSocket.on('auto-dev:updated', (row: { enabled?: boolean }) => {
      if (row && typeof row.enabled === 'boolean') setAutoDevEnabled(row.enabled);
    });

    newSocket.on('agent:moved', ({ agentId, x, y }) => {
      setGameState(prev => ({
        ...prev,
        agents: prev.agents.map(a => a.id === agentId ? { ...a, x, y } : a)
      }));
      
      setAgentPaths(prev => {
        const currentPath = prev[agentId] || [];
        const newPoint = { x, y, id: uuidv4(), timestamp: Date.now() };
        return {
          ...prev,
          [agentId]: [...currentPath, newPoint].slice(-AGENT_PATH_MAX_POINTS)
        };
      });
    });

    newSocket.on('agent:messaged', ({ agentId, message, targetAgentId, leaderKind }: {
      agentId: string;
      message: string;
      targetAgentId?: string;
      leaderKind?: 'delegate' | 'reply' | 'plain';
    }) => {
      setGameState(prev => {
        const fromAgent = prev.agents.find(a => a.id === agentId);
        const toAgent = targetAgentId ? prev.agents.find(a => a.id === targetAgentId) : undefined;
        if (fromAgent) addLog(message, fromAgent.name, toAgent?.name);
        return {
          ...prev,
          agents: prev.agents.map(a => a.id === agentId
            ? {
                ...a,
                lastMessage: message,
                lastMessageTo: targetAgentId,
                // 서버가 leaderKind 를 태워 보낸 경우에만 덮어쓴다. 누락 시 직전 값을
                // 유지해 오래된 클라이언트에서도 배지가 깜빡이지 않게 한다.
                lastLeaderMessageKind: leaderKind ?? a.lastLeaderMessageKind,
              }
            : a)
        };
      });
      setTimeout(() => {
        // 말풍선 TTL 만료 시 lastMessage 는 비우지만 lastLeaderMessageKind 는 유지 —
        // 리더 카드의 '답변 전용' 배지는 다음 발화 전까지 "최근 응답 유형" 을 계속 보여준다.
        setGameState(prev => ({
          ...prev,
          agents: prev.agents.map(a => a.id === agentId && a.lastMessage === message ? { ...a, lastMessage: undefined, lastMessageTo: undefined } : a)
        }));
      }, AGENT_MESSAGE_TTL_MS);
    });

    newSocket.on('agent:working', ({ agentId, fileId }) => {
      setGameState(prev => ({
        ...prev,
        agents: prev.agents.map(a => a.id === agentId ? { ...a, workingOnFileId: fileId } : a)
      }));
    });

    // Claude 토큰 사용량 동기화: 서버가 누적 총계를 소유한다(server.ts 의 claudeUsageTotals).
    //  - 최초 마운트 시 1회 GET 으로 기존 값을 끌어와 store.hydrate.
    //  - 이후에는 소켓 'claude-usage:updated' / 'claude-usage:reset' 푸시를 따른다.
    // 소켓 'claude-usage:updated' 는 delta 가 있으면 applyDelta 대신 totals 를 통째
    // 하이드레이트한다 — 서버가 단일 출처이므로 클라가 자체 누적을 시도하면 두 탭이
    // 열렸을 때 어긋난다.
    fetch('/api/claude/token-usage')
      .then(r => r.ok ? r.json() as Promise<ClaudeTokenUsageTotals> : null)
      .then(totals => { if (totals) claudeTokenUsageStore.hydrate(totals); })
      .catch(() => { /* 서버 미기동 등은 조용히 무시, 이후 소켓 푸시로 동기화됨 */ });
    newSocket.on('claude-usage:updated', (payload: { totals: ClaudeTokenUsageTotals; delta: ClaudeTokenUsageDelta | null }) => {
      if (payload?.totals) claudeTokenUsageStore.hydrate(payload.totals);
    });
    newSocket.on('claude-usage:reset', (totals: ClaudeTokenUsageTotals) => {
      claudeTokenUsageStore.hydrate(totals);
      // QA §2.1 — hydrate 는 누적만 0 으로 되돌리고 sessionStatus 는 유지한다. 서버
      // 재기동·수동 리셋 이벤트는 "세션이 새 창으로 열렸다" 는 의미이므로 읽기 전용
      // 배너/버튼 잠금도 함께 풀어야 한다. 누락 시 배지만 초기화되고 배너가 영구로 남는다.
      claudeTokenUsageStore.setSessionStatus('active');
    });

    // 구독 세션 상태 복원 → 서버 응답으로 치환 (#8e18c173).
    //   1) localStorage 에서 마지막으로 알려진 세션 상태를 즉시 복원해 새로고침 직후의
    //      "배지가 한 번 비었다가 다시 채워지는" 깜빡임을 제거한다.
    //   2) 서버 `GET /api/claude/session-status` 응답이 오면 reconcileRestoredWithServer
    //      가 권위값으로 치환 — 로컬이 exhausted 여도 서버가 active 이면 즉시 복귀한다.
    //   3) 서버 API 가 아직 없으면(404/오프라인) 복원값을 그대로 유지해 UX 회귀를 피한다.
    //   4) 소켓 'claude-session:status' 푸시는 이후 실시간 전환을 담당한다.
    try {
      const now = Date.now();
      const raw = typeof window !== 'undefined' ? window.localStorage?.getItem(SUBSCRIPTION_SESSION_STORAGE_KEY) : null;
      const restored = deserializePersistedSession(raw, now);
      if (restored) claudeTokenUsageStore.setSessionStatus(restored.status, restored.statusReason);

      fetch('/api/claude/session-status')
        .then(r => r.ok ? r.json() as Promise<{ status: ClaudeSessionStatus; reason?: string }> : null)
        .then(resp => {
          const reconciled = reconcileRestoredWithServer({
            restored,
            serverStatus: resp?.status ?? null,
            serverStatusReason: resp?.reason,
            nowMs: Date.now(),
          });
          claudeTokenUsageStore.setSessionStatus(reconciled.status, reconciled.statusReason);
        })
        .catch(() => { /* 엔드포인트 미존재/오프라인 — 복원값 유지 */ });
    } catch { /* localStorage 차단(시크릿 모드 등) 은 조용히 무시 */ }

    newSocket.on('claude-session:status', (payload: { status: ClaudeSessionStatus; reason?: string }) => {
      if (payload?.status) claudeTokenUsageStore.setSessionStatus(payload.status, payload.reason);
    });

    // 다중 탭 동기화 — 같은 origin 의 다른 탭이 localStorage 키를 덮어쓰면 storage 이벤트가
    // 발생한다. 동일 탭 내 setItem 은 이벤트를 쏘지 않으므로 자기 에코 방지 코드가 없어도 안전.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SUBSCRIPTION_SESSION_STORAGE_KEY) return;
      const next = deserializePersistedSession(e.newValue, Date.now());
      if (next) claudeTokenUsageStore.setSessionStatus(next.status, next.statusReason);
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      newSocket.close();
    };
  }, []);

  // Git 자동화 설정 fetch. 프로젝트 진입 시 한 번 읽어 전역 상태로 보관하고,
  // socket 의 'git-automation:updated' 이벤트로 폴링 없이 즉시 동기화한다.
  // ProjectManagement.tsx 의 localStorage 로드와는 독립적으로 돈다.
  useEffect(() => {
    if (!selectedProjectId) { setGitAutomationSettings(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${selectedProjectId}/git-automation`);
        if (!res.ok) return;
        const data = (await res.json()) as GitAutomationSettings;
        if (!cancelled) setGitAutomationSettings(data);
      } catch {
        // 서버 재시작 등 일시적 실패는 무시. 다음 프로젝트 전환 시 다시 시도.
      }
    })();
    return () => { cancelled = true; };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { projectId: string; settings: GitAutomationSettings }) => {
      if (payload?.projectId && payload.projectId === selectedProjectId) {
        setGitAutomationSettings(payload.settings);
      }
    };
    socket.on('git-automation:updated', handler);
    return () => { socket.off('git-automation:updated', handler); };
  }, [socket, selectedProjectId]);

  // Git 자동화 파이프라인 실행 결과 수신. server.ts 의 runStep 이 commit/pr 단계
  // stdout 을 400자 잘라 보내 주므로, 여기서 정규식으로 커밋 SHA / PR URL 을 추출해
  // AgentStatusPanel.gitAutomation 에 꽂는다. 최근 1건만 덮어쓰는 단일 슬롯 전략 —
  // 히스토리가 필요하면 별도 드로어로 분리할 예정.
  useEffect(() => {
    if (!socket) return;
    const handler = (payload: {
      projectId: string;
      branch?: string;
      results: Array<{ label: string; ok: boolean; code: number | null; stderr?: string; stdout?: string }>;
    }) => {
      if (!payload?.projectId || payload.projectId !== selectedProjectId) return;
      setLastGitAutomation(buildGitAutomationDigest(payload));
    };
    socket.on('git-automation:ran', handler);
    return () => { socket.off('git-automation:ran', handler); };
  }, [socket, selectedProjectId]);

  // 프로젝트 전환 시 이전 프로젝트의 digest 가 남아 혼동되지 않도록 초기화.
  useEffect(() => { setLastGitAutomation(null); }, [selectedProjectId]);

  // 협업 타임라인 폴링. 파일 수가 적은 구간이라 간단히 15초 주기 폴링.
  // 서버가 단일 소스이므로 클라이언트는 파일 I/O를 하지 않는다.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/collab/timeline');
        if (!res.ok) return;
        const data = (await res.json()) as LedgerEntry[];
        if (!cancelled) setCollabEntries(data);
      } catch {
        // 서버 재시작 등 일시적 실패는 조용히 건너뛰고 다음 틱에 복구한다.
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Cleanup old path points
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setAgentPaths(prev => {
        const next = { ...prev };
        let changed = false;
        Object.keys(next).forEach(agentId => {
          const filtered = next[agentId].filter(p => now - p.timestamp < AGENT_PATH_RETENTION_MS);
          if (filtered.length !== next[agentId].length) {
            next[agentId] = filtered;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }, AGENT_PATH_CLEANUP_MS);
    return () => clearInterval(interval);
  }, []);

  // Force-directed circular layout engine.
  // depsKey 는 매 렌더 계산되므로, 의존성 한 건 당 files.find() 를 돌리지 않도록
  // 프로젝트 파일 ID 를 Set 으로 한 번만 모아 O(n+m) 으로 줄인다. 동일한 Set 을
  // rAF tick 에서도 재사용해 ~33ms 마다 반복되는 선형 탐색을 제거한다.
  const project = gameState.projects.find(p => p.id === selectedProjectId);
  const projectFileIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of gameState.files) if (f.projectId === selectedProjectId) s.add(f.id);
    return s;
  }, [gameState.files, selectedProjectId]);
  const fileIdsKey = useMemo(() => Array.from(projectFileIds).join(','), [projectFileIds]);
  const agentIdsKey = project?.agents.join(',') || '';
  const depsKey = useMemo(
    () => (gameState.dependencies || [])
      .filter(d => projectFileIds.has(d.from))
      .map(d => `${d.from}>${d.to}`)
      .join(','),
    [gameState.dependencies, projectFileIds],
  );

  useEffect(() => {
    if (!selectedProjectId) return;
    const center = { x: 500, y: 320 };
    // Reset simulation for nodes that no longer belong to this project
    const keep = new Set<string>([
      ...projectFileIds,
      ...(project?.agents || []),
    ]);
    Object.keys(positionsRef.current).forEach(id => {
      if (!keep.has(id)) { delete positionsRef.current[id]; delete velocitiesRef.current[id]; }
    });

    let rafId: number;
    let last = 0;
    const FRAME_MS = 33;
    const tick = (t: number) => {
      if (t - last >= FRAME_MS) {
        const state = gameStateRef.current;
        const curProject = state.projects.find(p => p.id === selectedProjectId);
        const memberIds = curProject ? new Set(curProject.agents) : null;
        const files = state.files.filter(f => f.projectId === selectedProjectId);
        const fileIds = new Set(files.map(f => f.id));
        const agents = memberIds ? state.agents.filter(a => memberIds.has(a.id)) : [];
        const deps = (state.dependencies || []).filter(d => fileIds.has(d.from));
        runForceStep(positionsRef.current, velocitiesRef.current, files, agents, deps, center);
        setLayoutPositions({ ...positionsRef.current });
        last = t;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [selectedProjectId, fileIdsKey, agentIdsKey, depsKey]);

  const handleWheel = (e: React.WheelEvent) => {
    if (activeTab !== 'game') return;
    e.preventDefault();
    // 포인터의 캔버스 내부 좌표(offsetX/Y)는 getBoundingClientRect 기준으로 계산한다.
    // 사이드바 폭·레이아웃 변화가 있어도 실제 컨테이너 경계에 맞춰 보정되므로
    // 포인터 아래 월드 좌표가 줌 전후로 정확히 고정된다.
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const prevZoom = zoom;
    const newZoom = Math.max(0.5, Math.min(3, prevZoom + delta));
    if (newZoom === prevZoom) return;
    // transformOrigin='0 0' 기준 커서 고정 줌 공식.
    //   worldX  = (mouseX - panX) / prevZoom           — 포인터 아래 월드 좌표
    //   newPanX = mouseX - worldX * newZoom
    //           = mouseX - (mouseX - panX) * (newZoom / prevZoom)
    // 두 표현은 대수적으로 동일하지만, worldX 중간값을 남겨두면 테스트·디버깅 시
    // 포인터가 가리키는 요소를 반사적으로 확인할 수 있다.
    const worldX = (mouseX - pan.x) / prevZoom;
    const worldY = (mouseY - pan.y) / prevZoom;
    setZoom(newZoom);
    setPan({
      x: mouseX - worldX * newZoom,
      y: mouseY - worldY * newZoom,
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (activeTab !== 'game') return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || activeTab !== 'game') return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // 키보드 단축키:
  //  - Esc: 열려 있는 모달/확인 다이얼로그를 위에서부터 하나씩 닫는다.
  //  - 0:   게임 탭에서만 카메라(줌/팬) 초기화. 모달이 떠 있을 땐 그 안의 입력을
  //         방해하지 않도록 무시한다.
  //  - 1~5: 탭 전환 단축키. 1=오피스, 2=프로젝트, 3=작업, 4=직원, 5=프로젝트 관리.
  //         IME 조합 중(e.isComposing)이거나 입력 필드 포커스 시에는 차단해야
  //         한국어 입력 중간에 탭이 튀는 사고를 막을 수 있다.
  useEffect(() => {
    const TAB_BY_KEY: Record<string, typeof activeTab> = {
      '1': 'game',
      '2': 'projects',
      '3': 'tasks',
      '4': 'agents',
      '5': 'project-management',
    };
    const anyModalOpen = !!(showHireModal || showProjectModal || manageMembersProjectId || confirmFire || confirmDeleteProject || sharedGoalPromptOpen);

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape') {
        if (showHireModal) setShowHireModal(false);
        else if (showProjectModal) setShowProjectModal(false);
        else if (manageMembersProjectId) setManageMembersProjectId(null);
        else if (confirmFire) setConfirmFire(null);
        else if (confirmDeleteProject) setConfirmDeleteProject(null);
        else if (sharedGoalPromptOpen) setSharedGoalPromptOpen(false);
        return;
      }
      if (typing || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (anyModalOpen) return;
      if (activeTab === 'game' && e.key === '0') {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        return;
      }
      const nextTab = TAB_BY_KEY[e.key];
      if (nextTab && nextTab !== activeTab) {
        setActiveTab(nextTab);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTab, showHireModal, showProjectModal, manageMembersProjectId, confirmFire, confirmDeleteProject, sharedGoalPromptOpen]);

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setActiveTab('game');
    addLog(`워크스페이스 전환: ${gameState.projects.find(p => p.id === projectId)?.name}`);
  };

  // QA: fetch()는 HTTP 4xx/5xx를 예외로 던지지 않는다. mutation은 반드시 res.ok를
  // 검사해 서버 오류가 사용자 로그에 "성공"처럼 찍히는 것을 막아야 한다.
  const safeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    if (!res.ok) {
      let detail = '';
      try { const body = await res.clone().json(); detail = body?.error || ''; } catch { /* ignore */ }
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return res;
  };

  // QA: 사용자 입력은 서버가 방어한다고 가정하지 말고 클라이언트에서도 최소한의
  // 무결성을 강제한다. 이름 길이(NAME_MAX_LEN)는 렌더링 시 말줄임표/줄바꿈 깨짐을
  // 유발하는 한계점에서 역산했고, 중복 검사는 실수로 같은 사람을 두 번 고용해
  // 그래프/메시지 로그에서 동명이인을 구분하지 못하는 사고를 막는다. 페르소나는
  // 프롬프트에 직접 주입되므로 길이를 별도로 제한해 토큰/요금 사고를 예방한다.
  const NAME_MAX_LEN = 40;
  const PERSONA_MAX_LEN = 300;

  const isDuplicateAgentName = (candidate: string): boolean => {
    const normalized = candidate.toLowerCase();
    return gameState.agents.some(a => a.name.trim().toLowerCase() === normalized);
  };

  const hireAgent = async (name: string, role: AgentRole, spriteTemplate: string, persona?: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      addLog('에이전트 이름이 비어 있습니다.');
      return;
    }
    if (trimmed.length > NAME_MAX_LEN) {
      addLog(`에이전트 이름이 너무 깁니다(최대 ${NAME_MAX_LEN}자).`);
      return;
    }
    if (isDuplicateAgentName(trimmed)) {
      addLog(`이미 같은 이름의 에이전트가 있습니다: ${trimmed}`);
      return;
    }
    const trimmedPersona = persona?.trim();
    if (trimmedPersona && trimmedPersona.length > PERSONA_MAX_LEN) {
      addLog(`페르소나 설명이 너무 깁니다(최대 ${PERSONA_MAX_LEN}자).`);
      return;
    }
    try {
      await safeFetch('/api/agents/hire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, role, spriteTemplate, persona: trimmedPersona || undefined })
      });
      addLog(`새 에이전트 고용: ${trimmed} (${translateRole(role)})`);
      setShowHireModal(false);
    } catch (e) {
      addLog(`에이전트 고용 실패: ${(e as Error).message}`);
    }
  };

  const fireAgent = (id: string, name: string) => {
    setConfirmFire({ id, name });
  };

  const executeFire = async (id: string, name: string) => {
    try {
      await safeFetch(`/api/agents/${id}`, { method: 'DELETE' });
      addLog(`에이전트 해고: ${name}`);
    } catch (e) {
      addLog(`해고 실패 (${name}): ${(e as Error).message}`);
    }
  };

  // QA: 프로젝트 이름은 사이드바/헤더/로그에 짧게 노출되므로 NAME_MAX_LEN 와
  // 같은 한계를 공유한다. 중복 이름은 selectedProjectId 로 식별하는 현재 모델에선
  // 기능적으로 문제 없으나, 사용자 혼동을 막기 위해 정보 로그를 남기고 허용한다.
  // 설명은 표시 영역이 넓어 1KB 상한만 두고 잘라 내는 대신 거부해 사용자가
  // 명시적으로 줄이도록 유도한다.
  const DESCRIPTION_MAX_LEN = 1024;

  const createProject = async (name: string, description: string, workspacePath?: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      addLog('프로젝트 이름이 비어 있습니다.');
      return;
    }
    if (trimmed.length > NAME_MAX_LEN) {
      addLog(`프로젝트 이름이 너무 깁니다(최대 ${NAME_MAX_LEN}자).`);
      return;
    }
    const trimmedDescription = description.trim();
    if (trimmedDescription.length > DESCRIPTION_MAX_LEN) {
      addLog(`프로젝트 설명이 너무 깁니다(최대 ${DESCRIPTION_MAX_LEN}자).`);
      return;
    }
    if (gameState.projects.some(p => p.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      addLog(`이미 같은 이름의 프로젝트가 있습니다: ${trimmed} (중복 허용)`);
    }
    try {
      await safeFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, description: trimmedDescription, workspacePath: workspacePath?.trim() || undefined })
      });
      addLog(`새 프로젝트 시작: ${trimmed}`);
      setShowProjectModal(false);
    } catch (e) {
      addLog(`프로젝트 생성 실패: ${(e as Error).message}`);
    }
  };

  const inviteAgentToProject = async (projectId: string, agentId: string) => {
    const project = gameState.projects.find(p => p.id === projectId);
    const agent = gameState.agents.find(a => a.id === agentId);
    try {
      await safeFetch(`/api/projects/${projectId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId })
      });
      if (project && agent) addLog(`${agent.name}님을 ${project.name} 프로젝트에 초대`);
    } catch (e) {
      addLog(`초대 실패: ${(e as Error).message}`);
    }
  };

  const removeAgentFromProject = async (projectId: string, agentId: string) => {
    const project = gameState.projects.find(p => p.id === projectId);
    const agent = gameState.agents.find(a => a.id === agentId);
    try {
      await safeFetch(`/api/projects/${projectId}/agents/${agentId}`, { method: 'DELETE' });
      if (project && agent) addLog(`${agent.name}님을 ${project.name} 프로젝트에서 제외`);
    } catch (e) {
      addLog(`팀원 제외 실패: ${(e as Error).message}`);
    }
  };

  const deleteProject = async (projectId: string, name: string) => {
    try {
      await safeFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      // 서버 삭제가 성공해야만 로컬 파일 저장소 cascade 를 돌린다 — 네트워크 실패 시
      // 서버/클라 불일치를 만들지 않도록 순서를 고정한다. 실패해도 서버는 이미 지웠으니
      // 토스트만 남기고 재시도 훅은 다음 기동 시점에서 listProjectFiles 가 빈 집합으로
      // 수렴해 자연 정리된다.
      try {
        await deleteAllProjectFiles(projectId);
      } catch (cascadeErr) {
        addLog(`프로젝트 파일 정리 실패 (${name}): ${(cascadeErr as Error).message}`);
      }
      addLog(`프로젝트 삭제: ${name}`);
      if (selectedProjectId === projectId) {
        const remaining = gameState.projects.filter(p => p.id !== projectId);
        setSelectedProjectId(remaining[0]?.id || null);
      }
    } catch (e) {
      addLog(`프로젝트 삭제 실패 (${name}): ${(e as Error).message}`);
    }
  };

  const projectIdForAgent = (agent: Agent): string | undefined => {
    const selected = gameState.projects.find(p => p.id === selectedProjectId && p.agents.includes(agent.id));
    if (selected) return selected.id;
    return gameState.projects.find(p => p.agents.includes(agent.id))?.id;
  };

  // NOTE: respondAsAgent / simulateAgentAction / processAgentTask 는
  // 워커 아키텍처로 이관되어 제거됐다. 에이전트 실행은 전적으로 서버가
  // /api/tasks POST + TaskRunner.dispatchTask 를 통해 소유한다.

  // 리더 지시: 서버에 "리더에게 할당된 태스크"를 하나 생성하는 것으로 끝낸다.
  // 서버의 TaskRunner 가 리더 워커 큐로 dispatch 하고, 리더 응답(JSON)을 파싱해
  // 하위 팀원 태스크를 자동 생성한다. 리더 메시지는 'agent:messaged' 소켓 이벤트로
  // 별도 경로를 통해 UI 에 도달한다.
  const sendLeaderCommand = async () => {
    if (!socket) {
      addLog('서버 연결이 없습니다. 새로고침 후 다시 시도하세요.');
      return;
    }
    const instruction = commandInput.trim();
    if (!instruction) return;
    const project = gameState.projects.find(p => p.id === selectedProjectId);
    if (!project) {
      addLog('프로젝트를 먼저 선택하세요.');
      return;
    }
    const leader =
      gameState.agents.find(a => a.role === 'Leader' && project.agents.includes(a.id)) ||
      gameState.agents.find(a => a.role === 'Leader');
    if (!leader) {
      addLog('리더 에이전트가 없습니다.');
      return;
    }
    addLog(instruction, '사용자', leader.name);
    setCommandInput('');
    setCommandBusy(true);
    // 업로드가 끝난(fileId 가 확보된) 첨부만 서버로 보낸다. 업로드 중/실패 항목은
    // UI 에 남겨 사용자가 재시도·삭제할 수 있게 한다.
    const serverAttachments = pendingAttachments
      .filter(a => a.status === 'done' && a.fileId)
      .map(a => ({
        fileId: a.fileId!,
        name: a.name,
        type: a.mime,
        extractedText: a.extractedText,
        images: a.images,
      }));
    try {
      await safeFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          assignedTo: leader.id,
          description: instruction,
          source: 'user',
          attachments: serverAttachments.length > 0 ? serverAttachments : undefined,
          // 멀티미디어 정규화 결과. 서버 /api/tasks 는 현재 이 필드를 구조분해 대상에서
          // 제외해 무시하지만, 리더 프롬프트 조립 경로가 이 축을 소비하기 시작하면
          // 필드명만 보고 이어서 쓸 수 있다(#e36d53f8 연결 지점).
          mediaAttachments: mediaChatAttachments.length > 0 ? mediaChatAttachments : undefined,
        }),
      });
      setPendingAttachments([]);
      // 전송 성공 — 대응 대화의 초안을 제거한다. 실패는 의도적으로 무시해 다음
      // 실행 때 유령 항목이 남더라도 본 흐름을 막지 않는다(#222ece09 §2).
      draftStoreRef.current?.remove(project.id).catch(() => { /* noop */ });
    } catch (e) {
      addLog(`리더 지시 전달 실패: ${(e as Error).message}`);
      // 네트워크·일시 오류는 영속 재시도 큐에 보관해 온라인 복귀·앱 재기동 후에도
      // 유실 없이 이어 간다. 세션 신호(레이트리밋·토큰 만료) 는 별도 축에서
      // 처리되므로 여기에서는 enqueue 하지 않는다(#3f1b7597 §3).
      const code = (e as { code?: string })?.code ?? '';
      if (!/rate_limit|token_exhausted|subscription_expired/i.test(code)) {
        pendingQueueRef.current?.enqueue({
          id: `task-${project.id}-${Date.now()}`,
          payload: {
            endpoint: '/api/tasks',
            method: 'POST',
            body: {
              projectId: project.id,
              assignedTo: leader.id,
              description: instruction,
              source: 'user',
              attachments: serverAttachments.length > 0 ? serverAttachments : undefined,
              mediaAttachments: mediaChatAttachments.length > 0 ? mediaChatAttachments : undefined,
            },
            conversationId: project.id,
          },
          errorMessage: (e as Error).message,
        }).catch(() => { /* 큐 저장 실패 자체는 추가 부작용 없음 */ });
      }
    } finally {
      setCommandBusy(false);
    }
  };

  // 온라인 복귀 시 영속 재시도 큐를 한 번 돌린다. runRetryPass 는 nextAttemptAtMs
  // 필터를 통해 아직 백오프 대기 중인 항목을 건드리지 않는다.
  useEffect(() => {
    if (!online || !pendingQueueRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const report = await pendingQueueRef.current!.runRetryPass({
          execute: async (req) => {
            try {
              await safeFetch(req.payload.endpoint, {
                method: req.payload.method ?? 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.payload.body),
              });
              return { ok: true };
            } catch (err) {
              return {
                ok: false,
                errorCode: (err as { code?: string })?.code,
                errorMessage: (err as Error).message,
              };
            }
          },
          onRecovered: (req) => {
            toastBus.emit({
              variant: 'success',
              title: '대기 중이던 요청이 전송되었습니다',
              description: req.payload.conversationId
                ? `대화 ${req.payload.conversationId} 의 지시가 복구됐어요.`
                : undefined,
            });
          },
        });
        if (!cancelled && report.failed.length + report.droppedPermanent.length > 0) {
          addLog(`재시도 ${report.failed.length}건 보류 · ${report.droppedPermanent.length}건 영구 실패`);
        }
      } catch {
        /* 재시도 패스 자체 실패는 조용히 무시 — 다음 online 이벤트에 재도전 */
      }
    })();
    return () => { cancelled = true; };
  }, [online]);

  // 드래프트 자동 저장/복원 — 마운트·프로젝트 전환 시 복원, 입력/첨부 변경 시 저장.
  useEffect(() => {
    if (!selectedProjectId || !draftStoreRef.current) return;
    let cancelled = false;
    draftStoreRef.current.load(selectedProjectId).then(draft => {
      if (cancelled || !draft) return;
      // 프로젝트 진입 직후에만 복원한다 — 이미 사용자가 입력 중이면 덮어쓰지 않음.
      setCommandInput(prev => prev.length > 0 ? prev : draft.bodyText);
      setMediaChatAttachments(prev => prev.length > 0 ? prev : draft.attachments);
    }).catch(() => { /* idb 실패는 조용히 무시 */ });
    return () => { cancelled = true; };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !draftStoreRef.current) return;
    const hasAny = commandInput.trim().length > 0 || mediaChatAttachments.length > 0;
    const store = draftStoreRef.current;
    if (!hasAny) {
      store.remove(selectedProjectId).catch(() => { /* noop */ });
      return;
    }
    const t = setTimeout(() => {
      store.save(selectedProjectId, {
        conversationId: selectedProjectId,
        bodyText: commandInput,
        attachments: mediaChatAttachments,
      }).catch(() => { /* noop */ });
    }, 400);
    return () => clearTimeout(t);
  }, [selectedProjectId, commandInput, mediaChatAttachments]);

  // 그래프 초기화: 현재 프로젝트의 코드그래프(파일 노드·의존성 엣지)를 비운다.
  //  - 선택된 프로젝트가 있으면 해당 프로젝트만, 없으면 전체 그래프를 리셋한다.
  //  - 실수 클릭 방지를 위해 window.confirm 으로 재확인을 받는다. 파일은 서버의
  //    정식 소스(MongoDB)에 있으므로 서버 엔드포인트가 삭제하고 socket 의
  //    'state:updated' 브로드캐스트로 로컬 gameState 가 자연스럽게 빈 노드·엣지로
  //    수렴한다. 즉, 별도의 클라이언트 스토어 초기화가 필요 없다.
  const resetGraph = async () => {
    const scopeLabel = selectedProjectId
      ? '현재 프로젝트의 코드 그래프'
      : '전체 코드 그래프';
    const confirmed = typeof window !== 'undefined'
      ? window.confirm(`${scopeLabel}를 초기 상태로 리셋합니다. 계속하시겠습니까?`)
      : true;
    if (!confirmed) return;
    try {
      const qs = selectedProjectId ? `?projectId=${encodeURIComponent(selectedProjectId)}` : '';
      const res = await safeFetch(`/api/graph/reset${qs}`, { method: 'POST' });
      const body = await res.json().catch(() => ({} as { filesDeleted?: number; dependenciesDeleted?: number }));
      const filesDeleted = typeof body.filesDeleted === 'number' ? body.filesDeleted : 0;
      const depsDeleted = typeof body.dependenciesDeleted === 'number' ? body.dependenciesDeleted : 0;
      addLog(`그래프 초기화: 파일 ${filesDeleted}개·의존성 ${depsDeleted}개 제거`);
    } catch (e) {
      addLog(`그래프 초기화 실패: ${(e as Error).message}`);
    }
  };

  // 긴급중단: 모든 에이전트 활동을 즉시 멈춘다.
  //  1) 자동 개발 루프를 끄고 LLM 호출 로컬 큐가 새로 뜨지 않도록 한다.
  //  2) 서버에 상태·작업 리셋을 요청해 모든 에이전트를 idle 로, 완료되지 않은
  //     작업을 pending(대기) 로 돌린다. 완료 이력은 그대로 보존한다.
  // 현재 진행 중인 LLM 호출은 서버 측에서 취소할 수 없지만, 응답이 돌아와도
  // 상태 머신이 idle 스냅샷이라 다음 액션이 트리거되지 않는다.
  const emergencyStop = async () => {
    if (commandBusy) {
      // 명령 중이면 사용자에게 즉시 피드백이 돌아가도록 우선 버튼 락을 해제한다.
      setCommandBusy(false);
    }
    setAutoDevEnabled(false);
    try {
      const res = await safeFetch('/api/emergency-stop', { method: 'POST' });
      const body = await res.json().catch(() => ({} as { agentsReset?: number; tasksPending?: number }));
      const agentsReset = typeof body.agentsReset === 'number' ? body.agentsReset : 0;
      const tasksPending = typeof body.tasksPending === 'number' ? body.tasksPending : 0;
      addLog(`긴급중단: 에이전트 ${agentsReset}명 대기 상태로 전환, 미완료 작업 ${tasksPending}건 대기열 복귀`);
    } catch (e) {
      addLog(`긴급중단 실패: ${(e as Error).message}`);
    }
  };

  // DirectivePrompt → POST /api/directive/upload 연결. 파일별로 XMLHttpRequest 를
  // 띄워 업로드 진행률을 실시간 반영하고, 완료 시 서버가 돌려준 fileId/추출본을
  // 같은 엔트리에 병합 저장한다. 상태 전이: uploading → (done | error).
  const handleDirectiveFilesAdded = (files: File[]) => {
    if (!selectedProjectId) {
      setDirectiveErrorToast('프로젝트를 먼저 선택하세요.');
      return;
    }
    const projectId = selectedProjectId;
    const entries: PendingDirectiveAttachment[] = files.map(f => ({
      id: uuidv4(),
      name: f.name,
      size: f.size,
      mime: f.type,
      kind: classifyAttachment(f.type, f.name),
      status: 'uploading',
      progress: 0,
    }));
    setPendingAttachments(prev => [...prev, ...entries]);

    entries.forEach((entry, idx) => {
      const file = files[idx];
      const form = new FormData();
      form.append('projectId', projectId);
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/directive/upload', true);
      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const pct = Math.min(99, (e.loaded / e.total) * 100);
        setPendingAttachments(prev => prev.map(a =>
          a.id === entry.id ? { ...a, progress: pct } : a,
        ));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText);
            setPendingAttachments(prev => prev.map(a =>
              a.id === entry.id
                ? {
                    ...a,
                    status: 'done',
                    progress: 100,
                    fileId: typeof body?.fileId === 'string' ? body.fileId : undefined,
                    extractedText: typeof body?.extractedText === 'string' ? body.extractedText : undefined,
                    images: Array.isArray(body?.images) ? body.images : undefined,
                  }
                : a,
            ));
          } catch {
            const parseMsg = '응답 파싱 실패';
            setPendingAttachments(prev => prev.map(a =>
              a.id === entry.id ? { ...a, status: 'error', errorMessage: parseMsg } : a,
            ));
            setDirectiveErrorToast(parseMsg);
          }
        } else {
          // 서버가 친화 문구(예: 'PDF 해석에 실패했습니다…')를 담아 보내므로
          // 그대로 토스트에 노출하고, 해당 행에도 같은 메시지를 박아 재시도·삭제의
          // 근거를 남긴다. body.error 가 없는 경우에만 HTTP 상태로 폴백한다.
          let msg = `${xhr.status} ${xhr.statusText}`.trim();
          try {
            const b = JSON.parse(xhr.responseText);
            if (b?.error) msg = b.error;
          } catch { /* ignore */ }
          const finalMsg = msg || '업로드 실패';
          setPendingAttachments(prev => prev.map(a =>
            a.id === entry.id ? { ...a, status: 'error', errorMessage: finalMsg } : a,
          ));
          setDirectiveErrorToast(finalMsg);
        }
      };
      xhr.onerror = () => {
        const netMsg = '네트워크 오류로 업로드에 실패했습니다.';
        setPendingAttachments(prev => prev.map(a =>
          a.id === entry.id ? { ...a, status: 'error', errorMessage: netMsg } : a,
        ));
        setDirectiveErrorToast(netMsg);
      };
      xhr.send(form);
    });
  };

  const handleDirectiveRemove = (id: string) => {
    setPendingAttachments(prev => prev.filter(a => a.id !== id));
  };

  // 첨부 미리보기: 업로드 응답에 실려 온 images[0] 데이터 URL 을 Blob 으로 변환해
  // createObjectURL 로 짧은 참조 URL 을 만든다. 데이터 URL 을 그대로 넣어도 렌더는
  // 되지만, (1) 서버 /api/directive/file/:id 로 이전하기 쉬운 형태이고,
  // (2) 모달이 사라질 때 URL.revokeObjectURL 로 명시적으로 해제해 메모리 누수를
  // 추적하기 쉽다 (태스크 가이드라인 준수). text 첨부는 업로드 응답 캐시 또는
  // 서버에서 fetch 한 원문을 previewText 로 주입한다.
  const releasePreviewBlob = () => {
    if (previewBlobUrlRef.current) {
      URL.revokeObjectURL(previewBlobUrlRef.current);
      previewBlobUrlRef.current = null;
    }
  };
  const dataUrlToBlob = (dataUrl: string): Blob | null => {
    const commaIdx = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || commaIdx < 0) return null;
    const meta = dataUrl.slice(5, commaIdx);
    const payload = dataUrl.slice(commaIdx + 1);
    const isBase64 = meta.includes(';base64');
    const mime = meta.split(';')[0] || 'application/octet-stream';
    try {
      if (isBase64) {
        const bin = atob(payload);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
      }
      return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch {
      return null;
    }
  };
  const handleDirectivePreview = (att: UiDirectiveAttachment) => {
    releasePreviewBlob();
    setPreviewingAttachment(att);
    setPreviewUrl(null);
    setPreviewText(null);

    const record = pendingAttachments.find(a => a.id === att.id);
    if (!record) return;

    if (att.kind === 'image' || att.kind === 'pdf') {
      const dataUrl = record.images?.[0];
      if (dataUrl) {
        const blob = dataUrlToBlob(dataUrl);
        if (blob) {
          const url = URL.createObjectURL(blob);
          previewBlobUrlRef.current = url;
          setPreviewUrl(url);
          return;
        }
      }
      if (record.fileId) setPreviewUrl(`/api/directive/file/${record.fileId}`);
      return;
    }
    if (att.kind === 'text') {
      if (typeof record.extractedText === 'string') {
        setPreviewText(record.extractedText);
        return;
      }
      if (record.fileId) {
        safeFetch(`/api/directive/file/${record.fileId}`)
          .then(r => r.text())
          .then(txt => setPreviewText(txt))
          .catch(e => setPreviewText(`미리보기 로드 실패: ${(e as Error).message}`));
      }
    }
  };
  const handleClosePreview = () => {
    releasePreviewBlob();
    setPreviewingAttachment(null);
    setPreviewUrl(null);
    setPreviewText(null);
  };
  // 컴포넌트 언마운트 시 마지막으로 생성한 blob URL 을 revoke 해 누수를 막는다.
  useEffect(() => () => releasePreviewBlob(), []);

  // 에이전트 스프라이트 클릭 시 수동 "깨우기": 자유 개선 작업 지시를 해당
  // 에이전트에게 하나 태스크로 생성한다. 서버 dispatch 가 나머지를 처리.
  const nudgeAgent = async (agent: Agent) => {
    const pid = projectIdForAgent(agent) || selectedProjectId;
    if (!pid) { addLog('에이전트를 배정할 프로젝트를 먼저 선택하세요.'); return; }
    try {
      await safeFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: pid,
          assignedTo: agent.id,
          description: `자유 개선: 당신의 역할(${translateRole(agent.role)})에 맞춰 프로젝트 상태를 살펴보고 다음으로 해야 할 작업 1가지를 수행하세요.`,
          source: 'user',
        }),
      });
    } catch (e) {
      addLog(`${agent.name} 호출 실패: ${(e as Error).message}`);
    }
  };

  // 대화 영역 전역 검색(#832360c2) — logs 의 from/to/text 를 SearchableMessage 로 투영한다.
  // 매치된 messageId 는 현재 가상 리스트 연결 전이라 스크롤 점프는 비활성이지만, Ctrl+F
  // 오버레이·매치 카운트·하이라이트 스니펫은 즉시 동작한다. 가상 리스트 연결은 후속 턴.
  const conversationSearchMessages: SearchableMessage[] = logs.map(log => ({
    id: log.id,
    text: log.text,
    attachmentSummary: log.from ? `${log.from}${log.to ? ` → ${log.to}` : ''}` : undefined,
  }));

  return (
    <div className="min-h-screen bg-[var(--pixel-bg)] text-[var(--pixel-white)] font-game flex flex-col overflow-hidden h-screen">
      <ConversationSearch messages={conversationSearchMessages} />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onReplayOnboarding={() => {
          setOnboardingRestartKey(k => k + 1);
          setSettingsOpen(false);
        }}
      />
      {/* 온보딩 투어(#4c9bc4a6) — restartKey 가 바뀌면 재개. AppRoot 쪽 중복 마운트는 제거됨. */}
      <OnboardingTour restartKey={onboardingRestartKey} />
      {/* Header */}
      <header className="h-[60px] bg-[#0f3460] border-b-4 border-[var(--pixel-border)] flex items-center justify-between px-6 z-20">
        <div className="text-2xl font-bold text-[var(--pixel-accent)] uppercase tracking-[2px]">
          LLMTycoon
        </div>
        {/*
          상단바 메트릭 칩 묶음. 시각적으로는 배지 1개지만 스크린리더에는 각
          데이터 포인트가 독립된 status 로 들려야 한다. role="group" + aria-label
          은 묶음의 의미, 개별 칩의 aria-label 은 라벨·수치·단위를 한 문장으로
          묶어 읽는 데 쓴다(ux-cleanup-visual §3 A11y-01). aria-live 는 일부러
          붙이지 않는다 — zoom 값이나 에이전트 수는 1초 단위로 튈 수 있어
          polite 라도 스팸 고지가 된다. 변경 시점 공지가 필요한 위젯은 이미
          ClaudeTokenUsage 가 자체 role="button"+aria-expanded 로 가지고 있다.
        */}
        <div
          className="flex gap-5 text-sm"
          role="group"
          aria-label="상단 요약 지표"
          data-testid="app-header-metrics"
        >
          <div
            className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)] text-[var(--pixel-accent)]"
            role="status"
            aria-label={`확대 ${Math.round(zoom * 100)} 퍼센트`}
            data-testid="header-metric-zoom"
          >
            확대: {Math.round(zoom * 100)}%
          </div>
          <div
            className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)]"
            role="status"
            aria-label={`전체 에이전트 ${gameState.agents.length} 명`}
            data-testid="header-metric-agents"
          >
            에이전트: {gameState.agents.length}
          </div>
          {/*
            `CurrentProjectBadge` 가 "현재 프로젝트: 이름" 을 보여 주기 때문에 본 칩은
            "관리 중인 전체 프로젝트 개수" 라는 의미를 잃지 않도록 라벨을 분화한다.
            시각 라벨은 공간 절약을 위해 짧게 "전체 프로젝트" 로, 접근성 라벨은
            풀 문장으로 내려 스크린리더가 두 배지를 혼동하지 않는다.
          */}
          <div
            className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)]"
            role="status"
            aria-label={`관리 중인 전체 프로젝트 ${gameState.projects.length} 개`}
            data-testid="header-metric-projects"
          >
            전체 프로젝트: {gameState.projects.length}
          </div>
          <CurrentProjectBadge projectName={project?.name ?? null} />
          <div
            className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)] border-l-[6px]"
            style={{ borderLeftColor: getMetricTierColor(workspaceInsights.coveragePercent) }}
            role="status"
            aria-label={`의존성 커버리지 ${workspaceInsights.coveragePercent} 퍼센트${
              workspaceInsights.isolatedFiles.length > 0
                ? `, 고립 파일 ${workspaceInsights.isolatedFiles.length} 건`
                : ''
            }`}
            title={workspaceInsights.isolatedFiles.length > 0
              ? `고립 파일: ${workspaceInsights.isolatedFiles.join(', ')}`
              : '의존성이 연결되지 않은 파일이 없습니다'}
            data-testid="header-metric-coverage"
          >
            커버리지: {workspaceInsights.coveragePercent}%
          </div>
          <div
            className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)] border-l-[6px]"
            style={{ borderLeftColor: getMetricTierColor(agentActivity.total === 0 ? null : agentActivity.ratio) }}
            role="status"
            aria-label={`에이전트 활성률 ${agentActivity.ratio} 퍼센트`}
            title={activityBreakdownLabel}
            data-testid="header-metric-activity"
          >
            활성률: {agentActivity.ratio}%
          </div>
          <div
            className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)] border-l-[6px]"
            style={{ borderLeftColor: getMetricTierColor(collaborationStats.messageCount === 0 ? null : collaborationStats.participationRate) }}
            role="status"
            aria-label={`협업 지표 ${collaborationBadge}`}
            title={collaborationLabel}
            data-testid="header-metric-collaboration"
          >
            협업: {collaborationBadge}
          </div>
          {!online && (
            <div
              role="status"
              aria-live="polite"
              data-testid="offline-banner"
              className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border-2 border-amber-400 text-amber-300 bg-amber-500/10 whitespace-nowrap"
              title="네트워크가 복구되면 대기 중이던 요청이 자동으로 전송됩니다."
            >
              오프라인
            </div>
          )}
          {/* 설정 드로어 톱니 버튼(#0dceedcd) */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            data-testid="topbar-settings-button"
            aria-label="설정 열기"
            className="px-2 py-1 border-2 border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]"
            style={{ background: 'var(--color-surface)' }}
          >
            <Settings size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[220px] bg-[var(--pixel-card)] border-r-4 border-[var(--pixel-border)] flex flex-col p-4">
          <div className="text-[12px] text-[var(--pixel-accent)] mb-3 uppercase tracking-wider">워크스페이스</div>

          {/* 현재 프로젝트 — 오피스 플로어 사이드바의 "어디에 있는가" 앵커.
              .sidebar-project 스펙은 src/index.css 주석 참조. 프로젝트명이 길면
              ellipsis 로 잘리고 title/aria-label 로 전체 이름을 복원한다. */}
          <div
            className="sidebar-project"
            data-state={project ? 'active' : 'empty'}
            title={project ? project.name : '프로젝트 미선택'}
            aria-label={project ? `현재 프로젝트: ${project.name}` : '프로젝트가 선택되지 않았습니다'}
          >
            <Briefcase className="sidebar-project__icon" aria-hidden />
            <div className="sidebar-project__body">
              <span className="sidebar-project__label">현재 프로젝트</span>
              <span className="sidebar-project__name">
                {project ? project.name : '선택되지 않음'}
              </span>
            </div>
          </div>

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
            <button
              onClick={() => setActiveTab('project-management')}
              className={`w-full text-left p-3 border-2 transition-all ${activeTab === 'project-management' ? 'border-[var(--pixel-accent)] bg-[var(--pixel-bg)]' : 'border-[var(--pixel-border)] bg-[#0f3460] hover:bg-[#1a1a2e]'}`}
            >
              <span className="text-sm font-bold block">프로젝트 관리</span>
              <span className="text-[10px] opacity-70">GitHub · GitLab</span>
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
              onClick={resetGraph}
              title="현재 프로젝트의 코드 그래프(파일 노드·의존성 엣지)를 초기 상태로 되돌립니다"
              className="w-full bg-[#f4a261] text-black py-3 font-bold uppercase border-b-4 border-[#a45a1c] hover:brightness-110 transition-all"
            >
              그래프 초기화
            </button>
            <button
              onClick={emergencyStop}
              title="모든 에이전트 작업을 즉시 중단하고 미완료 작업을 대기 상태로 되돌립니다"
              className="w-full bg-[#c23b4a] text-white py-3 font-bold uppercase border-b-4 border-[#7a1a25] hover:brightness-110 transition-all"
            >
              긴급중단
            </button>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-0 relative">
          {activeTab === 'game' && (
            <div
              className="h-full flex flex-col p-0 overflow-hidden relative cursor-grab active:cursor-grabbing infinite-grid"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{
                backgroundSize: `${32 * zoom}px ${32 * zoom}px`,
                backgroundPosition: `${pan.x}px ${pan.y}px`
              }}
            >
              <div
                ref={gameWorldRef}
                className="flex-1 relative"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: '0 0',
                  width: '100%',
                  height: '100%'
                }}
              >
                {/* SVG Layer for Connections */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-0" style={{ overflow: 'visible' }}>
                  {/* Concentric orbital guides */}
                  {[120, 220, 320].map(r => (
                    <circle
                      key={`ring-${r}`}
                      cx={500} cy={320} r={r}
                      fill="none"
                      stroke="var(--pixel-border)"
                      strokeWidth="1"
                      strokeDasharray="2 6"
                      opacity={0.15}
                    />
                  ))}
                  {/* Dependencies — straight dashed lines */}
                  {gameState.dependencies?.filter(dep => {
                    const file = gameState.files.find(f => f.id === dep.from);
                    return file?.projectId === selectedProjectId;
                  }).map((dep, idx) => {
                    const a = layoutPositions[dep.from];
                    const b = layoutPositions[dep.to];
                    if (!a || !b) return null;
                    return (
                      <line
                        key={`dep-${idx}`}
                        x1={a.x} y1={a.y}
                        x2={b.x} y2={b.y}
                        stroke="var(--pixel-accent)"
                        strokeWidth="1.5"
                        strokeDasharray="5 4"
                        opacity={0.5}
                      />
                    );
                  })}
                  {/* Agent to File Connections */}
                  {gameState.agents.filter(a => {
                    const p = gameState.projects.find(pr => pr.id === selectedProjectId);
                    return p?.agents.includes(a.id);
                  }).map(agent => {
                    if (!agent.workingOnFileId) return null;
                    const file = gameState.files.find(f => f.id === agent.workingOnFileId);
                    if (!file || file.projectId !== selectedProjectId) return null;
                    const pa = layoutPositions[agent.id];
                    const pf = layoutPositions[file.id];
                    if (!pa || !pf) return null;
                    return (
                      <motion.line
                        key={`work-${agent.id}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.8 }}
                        x1={pa.x + 24} y1={pa.y + 24}
                        x2={pf.x} y2={pf.y}
                        stroke="var(--pixel-accent)"
                        strokeWidth="2"
                        strokeDasharray="2 3"
                      />
                    );
                  })}
                </svg>

                {/* Code Files (Nodes) — tinted per file type so the graph reads
                    as a legend at a glance: component/service/util/style each
                    get a distinct swatch. See FILE_TYPE_ACCENT below. */}
                {gameState.files?.filter(f => f.projectId === selectedProjectId).map(file => {
                  const pos = layoutPositions[file.id];
                  const x = pos?.x ?? file.x;
                  const y = pos?.y ?? file.y;
                  const accent = getFileTypeAccent(file.type);
                  return (
                    <div
                      key={file.id}
                      className="absolute w-4 h-4 rounded-full border-2 border-black z-10"
                      style={{
                        left: 0,
                        top: 0,
                        transform: `translate3d(${x - 8}px, ${y - 8}px, 0)`,
                        willChange: 'transform',
                        backgroundColor: accent,
                        boxShadow: `0 0 14px ${accent}`,
                      }}
                      onMouseEnter={() => setHoveredFileId(file.id)}
                      onMouseLeave={() => setHoveredFileId(prev => prev === file.id ? null : prev)}
                      aria-label={`${file.name} (${translateFileType(file.type)})`}
                    >
                      <div
                        className="absolute top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] font-bold opacity-80"
                        style={{ color: accent }}
                      >
                        {file.name}
                      </div>
                    </div>
                  );
                })}

                {hoveredFileId && (() => {
                  const file = gameState.files.find(f => f.id === hoveredFileId);
                  if (!file || file.projectId !== selectedProjectId) return null;
                  const pos = layoutPositions[file.id];
                  const workerNames = gameState.agents
                    .filter(a => a.workingOnFileId === file.id)
                    .map(a => a.name);
                  return (
                    <FileTooltip
                      file={file}
                      x={pos?.x ?? file.x}
                      y={pos?.y ?? file.y}
                      workerNames={workerNames}
                    />
                  );
                })()}

                <AnimatePresence>
                  {gameState.agents.filter(a => {
                    const project = gameState.projects.find(p => p.id === selectedProjectId);
                    return project?.agents.includes(a.id);
                  }).map((agent) => {
                    const pos = layoutPositions[agent.id];
                    const targetAgent = agent.lastMessageTo ? gameState.agents.find(a => a.id === agent.lastMessageTo) : undefined;
                    const workingFile = agent.workingOnFileId
                      ? gameState.files.find(f => f.id === agent.workingOnFileId)
                      : undefined;
                    return (
                      <AgentSprite
                        key={agent.id}
                        agent={agent}
                        targetName={targetAgent?.name}
                        x={pos?.x ?? agent.x}
                        y={pos?.y ?? agent.y}
                        logs={logs}
                        workingFileName={workingFile?.name}
                        translateStatus={translateStatus}
                        highlighted={highlightedAgent === agent.name}
                        onClick={() => {}}
                      />
                    );
                  })}
                </AnimatePresence>
              </div>

              {/* 하이드레이션 전: 스켈레톤. 이 분기가 없으면 새로고침 직후 localStorage
                  복원이 완료되기 전까지 "프로젝트를 선택하세요" 안내가 한 프레임 스쳐 지나가
                  사용자에게 빈 워크스페이스로 인식됐다. hydrated 플래그로 복원 완료 시점을
                  고정한 뒤에만 실 빈-상태 여부를 판정한다. */}
              {!hydrated && <EmptyProjectPlaceholderSkeleton />}
              {hydrated && !selectedProjectId && (() => {
                // 프로젝트 미선택 상태에서도 working/thinking 으로 남아있는 에이전트는
                // update_status idle 보고 누락 or 폴링/응답/타임아웃 트리거 경쟁의 직접 단서.
                // 카운트 + 최근 이름을 배지로 노출해 디버깅 시 "누가 stuck 인지" 를 즉시 식별.
                const busyAgents = gameState.agents.filter(a => a.status === 'working' || a.status === 'thinking');
                return (
                  <EmptyProjectPlaceholder
                    projectCount={gameState.projects.length}
                    onOpenProjectList={() => setActiveTab('projects')}
                    onCreateProject={() => setShowProjectModal(true)}
                    currentProjectId={selectedProjectId}
                    busyAgentCount={busyAgents.length}
                    busyAgentNames={busyAgents.map(a => a.name)}
                  />
                );
              })()}

              {/* Excluded paths badge — code graph는 docs/ 같은 문서 디렉터리를
                  의도적으로 제외한다. 누락처럼 보이지 않도록 좌측 하단에 항상
                  표시하고, 호버 시 전체 규칙을 툴팁으로 노출. */}
              <div
                className="absolute bottom-6 left-6 z-30 pointer-events-auto group"
                title={`코드그래프에서 의도적으로 제외된 경로입니다 (누락 아님):\n${EXCLUDED_PATHS.join('\n')}`}
                aria-label={`제외된 경로: ${EXCLUDED_PATHS.join(', ')}`}
              >
                <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--pixel-card)] border-2 border-[var(--pixel-border)] text-[10px] font-bold uppercase tracking-wider text-[var(--pixel-accent)] opacity-70 hover:opacity-100 hover:border-[var(--pixel-accent)] transition-all select-none">
                  <span aria-hidden className="inline-block w-2 h-2 rounded-full bg-[var(--pixel-accent)] opacity-60" />
                  <span className="text-[var(--pixel-text)] opacity-60">제외 경로</span>
                  <span>{EXCLUDED_PATHS.join(' · ')}</span>
                </div>
                <div className="hidden group-hover:block absolute bottom-full left-0 mb-2 w-64 p-2 bg-[var(--pixel-bg)] border-2 border-[var(--pixel-border)] text-[10px] text-[var(--pixel-text)] leading-snug shadow-lg">
                  이 경로들은 코드그래프 표시 대상이 아닙니다. 문서/핸드오프 등 코드 외 자산은 그래프 노드에서 의도적으로 걸러집니다.
                </div>
              </div>

              {/* Zoom Controls Overlay - FIXED relative to viewport */}
              <div className="absolute bottom-6 right-6 z-30 flex flex-col gap-2 pointer-events-auto">
                <button
                  onClick={() => setZoom(prev => Math.min(3, prev + 0.2))}
                  className="w-10 h-10 bg-[var(--pixel-card)] border-2 border-[var(--pixel-border)] flex items-center justify-center hover:border-[var(--pixel-accent)] text-[var(--pixel-accent)] transition-all active:scale-90"
                  title="확대"
                  aria-label="확대"
                >
                  <Plus size={20} />
                </button>
                <button
                  onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                  className="w-10 h-10 bg-[var(--pixel-card)] border-2 border-[var(--pixel-border)] flex items-center justify-center hover:border-[var(--pixel-accent)] text-[10px] font-bold transition-all active:scale-90"
                  title="카메라 초기화 (0)"
                  aria-label="카메라 초기화"
                >
                  1:1
                </button>
                <button
                  onClick={() => setZoom(prev => Math.max(0.5, prev - 0.2))}
                  className="w-10 h-10 bg-[var(--pixel-card)] border-2 border-[var(--pixel-border)] flex items-center justify-center hover:border-[var(--pixel-accent)] text-[var(--pixel-accent)] transition-all active:scale-90"
                  title="축소"
                  aria-label="축소"
                >
                  <Minus size={20} />
                </button>
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
                        <div
                          key={agent.id}
                          title={`${agent.name} · ${translateRole(agent.role)}`}
                          className="w-8 h-8 border-2 border-black flex items-center justify-center text-xs"
                          style={{ backgroundColor: getRoleAccent(agent.role) }}
                        >
                          {getAgentEmoji(agent.role)}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setManageMembersProjectId(project.id)}
                        aria-label={`${project.name} 팀원 관리`}
                        className="p-2 bg-black/30 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] transition-colors"
                        title="팀원 관리"
                      >
                        <UserPlus size={14} />
                      </button>
                      <button
                        onClick={() => selectProject(project.id)}
                        aria-label={`${project.name} 워크스페이스 열기`}
                        className="p-2 bg-black/30 border-2 border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] transition-colors"
                        title="워크스페이스 열기"
                      >
                        <Play size={14} />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteProject({ id: project.id, name: project.name })}
                        aria-label={`${project.name} 프로젝트 삭제`}
                        className="p-2 bg-red-900/20 border-2 border-red-900/60 hover:bg-red-900 hover:border-red-500 text-red-300 hover:text-white transition-colors"
                        title="프로젝트 삭제"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
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

          {activeTab === 'project-management' && (
            <ProjectManagement
              currentProjectId={selectedProjectId}
              onLog={(text, from) => addLog(text, from || '시스템')}
            />
          )}

          {activeTab === 'agents' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-8">
              {gameState.agents.map(agent => (
                <div
                  key={agent.id}
                  className="bg-[#0f3460] border-2 border-[var(--pixel-border)] p-4 min-h-[96px] flex items-start justify-between gap-3 hover:border-[var(--pixel-accent)] transition-all group"
                >
                  <div className="flex items-start gap-4 min-w-0 flex-1">
                    <div
                      className="w-14 h-14 shrink-0 border-2 border-black flex items-center justify-center text-2xl"
                      style={{ backgroundColor: getRoleAccent(agent.role) }}
                      title={getRoleDescription(agent.role)}
                      aria-label={`${translateRole(agent.role)}: ${getRoleDescription(agent.role)}`}
                    >
                      {getAgentEmoji(agent.role)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-sm text-[var(--pixel-accent)] truncate">{agent.name}</h3>
                      <p className="text-[10px] uppercase tracking-widest font-bold opacity-70" title={getRoleDescription(agent.role)}>{translateRole(agent.role)}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <div className={`w-2 h-2 ${agent.status === 'idle' ? 'bg-white/20' : `bg-green-500${reducedMotion ? '' : ' animate-pulse'}`}`} />
                        <span className="text-[10px] opacity-60 uppercase">{translateStatus(agent.status)}</span>
                      </div>
                      {agent.persona && (
                        <div
                          className="mt-2 pt-2 border-t border-white/10 flex items-start gap-1.5"
                          data-testid="agent-card-persona"
                        >
                          <MessageSquare
                            size={10}
                            className="shrink-0 mt-[3px] text-[var(--pixel-accent)] opacity-70"
                            aria-hidden="true"
                          />
                          <p
                            className="text-[11px] italic leading-snug text-white/75 line-clamp-2"
                            title={agent.persona}
                          >
                            {agent.persona}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => fireAgent(agent.id, agent.name)}
                    className="opacity-0 group-hover:opacity-100 shrink-0 self-start p-2 bg-red-900/30 border-2 border-red-900 hover:bg-red-900 transition-all text-[10px] font-bold uppercase"
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
          <div className="flex items-center gap-2 mb-3">
            <div className="text-[12px] text-[var(--pixel-accent)] uppercase tracking-wider">에이전트 작업 현황</div>
            <span
              role="status"
              aria-label={`자동 개발 ${autoDevEnabled ? '켜짐' : '꺼짐'} — 태스크 완료 시 Git 자동화 트리거 ${autoDevEnabled ? '가능' : '대기'}`}
              title={autoDevEnabled
                ? '자동 개발 ON — 태스크 완료 시 Git 자동화가 트리거됩니다'
                : '자동 개발 OFF — 태스크가 완료되어도 Git 자동화는 트리거되지 않습니다'}
              className={`ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border-2 tabular-nums ${
                autoDevEnabled
                  ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200'
                  : 'border-white/25 bg-black/30 text-white/50'
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  autoDevEnabled
                    ? `bg-emerald-400${reducedMotion ? '' : ' animate-pulse'}`
                    : 'bg-white/30'
                }`}
              />
              {autoDevEnabled ? '자동 개발 ON' : '자동 개발 OFF'}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto space-y-3">
            <AgentStatusPanel
              agents={gameState.agents}
              files={gameState.files}
              translateRole={translateRole}
              translateStatus={translateStatus}
              showGitAutomation={!!lastGitAutomation}
              gitAutomation={lastGitAutomation ?? undefined}
            />
            <CollabTimeline
              entries={collabEntries}
              onSelect={(path) => addLog(`타임라인 열람: ${path}`)}
              onHoverAgent={setHighlightedAgent}
            />
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

      {/* Resizable Log Panel: 탭으로 '지시' / '로그' 중 하나만 활성 */}
      <div
        className="flex flex-col shrink-0"
        style={{ height: `${logPanelHeight}px` }}
      >
        {/* 위아래 드래그로 로그 패널 전체 높이(리더 지시 입력 / 로그)를 조절 */}
        <div
          onMouseDown={startLogPanelResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label="로그 패널 크기 조절"
          title="위아래로 드래그해서 로그/대화창 크기 조절"
          className="h-[6px] cursor-ns-resize bg-[var(--pixel-border)] hover:bg-[var(--pixel-accent)] transition-colors"
        />
        {/* 탭 바: 좌측 탭 버튼, 우측 자동 개발 토글. 탭은 ←/→ 로 순회한다. */}
        <div
          role="tablist"
          aria-label="로그 패널 보기 전환"
          className="bg-[var(--pixel-card)] border-t-2 border-[var(--pixel-border)] px-3 py-1 flex items-center gap-1 shrink-0"
        >
          <button
            type="button"
            role="tab"
            id="log-panel-tab-directive"
            aria-selected={logPanelTab === 'directive'}
            aria-controls="log-panel-panel-directive"
            tabIndex={logPanelTab === 'directive' ? 0 : -1}
            onClick={() => setLogPanelTab('directive')}
            onKeyDown={handleLogPanelTabKeyDown}
            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border-2 transition-colors ${
              logPanelTab === 'directive'
                ? 'bg-[var(--pixel-accent)] text-black border-[var(--pixel-accent)]'
                : 'bg-black/40 text-[var(--pixel-accent)] border-[var(--pixel-border)] hover:border-[var(--pixel-accent)]'
            }`}
          >
            지시
          </button>
          <button
            type="button"
            role="tab"
            id="log-panel-tab-log"
            aria-selected={logPanelTab === 'log'}
            aria-controls="log-panel-panel-log"
            tabIndex={logPanelTab === 'log' ? 0 : -1}
            onClick={() => setLogPanelTab('log')}
            onKeyDown={handleLogPanelTabKeyDown}
            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border-2 transition-colors inline-flex items-center gap-1.5 ${
              logPanelTab === 'log'
                ? 'bg-[var(--pixel-accent)] text-black border-[var(--pixel-accent)]'
                : 'bg-black/40 text-[var(--pixel-accent)] border-[var(--pixel-border)] hover:border-[var(--pixel-accent)]'
            }`}
          >
            로그
            {unseenLogCount > 0 && (
              <span
                className="logtab__badge"
                aria-label={`읽지 않은 로그 ${unseenLogCount}건`}
              >
                {unseenLogCount > 99 ? '99+' : unseenLogCount}
              </span>
            )}
          </button>
          <div className="ml-auto">
            <button
              type="button"
              role="switch"
              aria-checked={autoDevEnabled}
              onClick={async () => {
                const next = !autoDevEnabled;
                // ON 전환 직전에 활성 공동 목표 유무를 확인한다. 목표가 없으면 서버도
                // /api/auto-dev PATCH 를 거절하지만(types.ts 주석 참조) 사용자가 "왜
                // 꺼졌는가"를 바로 알 수 있도록 UI 차원에서 먼저 차단하고 SharedGoal
                // 입력 모달을 띄운다. 프로젝트 미선택(전역 auto-dev) 케이스는 종전처럼
                // 그대로 PATCH 를 진행한다.
                if (next && selectedProjectId) {
                  try {
                    const res = await safeFetch(`/api/projects/${selectedProjectId}/shared-goal`);
                    const goal = await res.json();
                    if (!goal) {
                      setSharedGoalPromptOpen(true);
                      addLog('공동 목표가 비어 있어 자동 개발 ON 을 차단했습니다');
                      return;
                    }
                  } catch (e) {
                    addLog(`공동 목표 확인 실패: ${(e as Error).message}`);
                  }
                }
                // 낙관적 UI: 서버 반영 전에 토글 시각을 즉시 바꾸고, 실패 시 원복.
                // auto-dev:updated 소켓 이벤트로도 최종값이 동기화된다.
                setAutoDevEnabled(next);
                addLog(next ? '자동 개발 모드 ON' : '자동 개발 모드 OFF');
                // PATCH 응답은 safeFetch 를 거치지 않고 직접 읽는다 — 400 응답의
                // `code: SHARED_GOAL_REQUIRED` 플래그를 살려야 pre-check 가 건너뛴
                // 경로(프로젝트 미선택 + 서버 저장 projectId 에 목표 없음, 혹은 선택
                // 프로젝트와 서버 저장 projectId 의 불일치)에서도 모달이 열린다.
                try {
                  const resp = await fetch('/api/auto-dev', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: next }),
                  });
                  if (!resp.ok) {
                    let body: { error?: string; code?: string } = {};
                    try { body = await resp.json(); } catch { /* ignore */ }
                    setAutoDevEnabled(!next);
                    if (next && body.code === 'SHARED_GOAL_REQUIRED') {
                      setSharedGoalPromptOpen(true);
                      addLog('공동 목표가 비어 있어 자동 개발 ON 을 차단했습니다');
                      return;
                    }
                    addLog(`자동 개발 토글 실패: ${body.error || `${resp.status} ${resp.statusText}`}`);
                  }
                } catch (e) {
                  setAutoDevEnabled(!next);
                  addLog(`자동 개발 토글 실패: ${(e as Error).message}`);
                }
              }}
              title={autoDevEnabled
                ? '자동 개발 ON — idle 에이전트를 주기적으로 깨워 작업을 시킨다'
                : '자동 개발 OFF — 수동 지시/버튼으로만 에이전트가 움직인다'}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border-2 whitespace-nowrap transition-colors ${
                autoDevEnabled
                  ? 'bg-[var(--pixel-accent)] text-black border-[var(--pixel-accent)]'
                  : 'bg-black/40 text-[var(--pixel-accent)] border-[var(--pixel-border)] hover:border-[var(--pixel-accent)]'
              }`}
            >
              자동 개발 {autoDevEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {logPanelTab === 'directive' ? (
          <div
            role="tabpanel"
            id="log-panel-panel-directive"
            aria-labelledby="log-panel-tab-directive"
            className="flex-1 min-h-0 bg-[var(--pixel-card)] border-t-2 border-[var(--pixel-border)] px-3 py-2 overflow-y-auto"
          >
            <DirectivePrompt
              value={commandInput}
              onChange={setCommandInput}
              attachments={pendingAttachments}
              onFilesAdded={handleDirectiveFilesAdded}
              onRemove={handleDirectiveRemove}
              onPreview={handleDirectivePreview}
              onSubmit={sendLeaderCommand}
              errorToast={directiveErrorToast}
              onDismissError={() => setDirectiveErrorToast(null)}
              submitLabel={commandBusy ? '대기...' : (online ? '지시 전송' : '대기 큐에 저장')}
              placeholder={commandBusy
                ? '리더가 응답 중... (Enter 로 전송 · Shift+Enter 로 줄바꿈)'
                : '예: 로그인 기능 개발 계획 세워줘 (Enter 로 전송 · Shift+Enter 로 줄바꿈)'}
              accept="application/pdf,image/*,text/*"
              maxBytes={10 * 1024 * 1024}
              disabled={commandBusy}
            />
            <div className="mt-3">
              <MediaPipelinePanel
                projectId={selectedProjectId}
                onAttachmentsChange={setMediaChatAttachments}
              />
            </div>
            {/*
              멀티미디어 드롭존(#25c6969c) — 드래그&드롭·클릭 선택 두 경로를 모두 지원.
              프로젝트 미선택 시 disabled 로 잠그고 힌트 문구로 안내. 업로드 성공은
              MediaPipelinePanel 과 축을 공유하지 않고 토스트로만 고지 — 상위 상태의
              단일 출처는 MediaPipelinePanel 이 소유한다(이중 기록 회피).
            */}
            <div className="mt-3">
              <UploadDropzone
                disabled={!selectedProjectId}
                hint={!selectedProjectId ? '프로젝트를 먼저 선택하세요.' : undefined}
                onFilesAccepted={async (files: File[]) => {
                  if (!selectedProjectId) return;
                  for (const file of files) {
                    try {
                      const preview = await loadMediaFile(file, { projectId: selectedProjectId });
                      mediaToast.push({
                        variant: 'success',
                        title: `"${preview.name}" 업로드 완료`,
                        description: `${preview.kind.toUpperCase()} · ${Math.max(1, Math.round(preview.sizeBytes / 1024))}KB`,
                      });
                    } catch (err) {
                      const msg = mapUnknownError(err);
                      mediaToast.push(messageToToastInput(msg, {
                        onRetryNow: () => { void (async () => {
                          try {
                            const retryPreview = await loadMediaFile(file, { projectId: selectedProjectId });
                            mediaToast.push({
                              variant: 'success',
                              title: `"${retryPreview.name}" 업로드 완료`,
                            });
                          } catch (retryErr) {
                            mediaToast.push(messageToToastInput(mapUnknownError(retryErr)));
                          }
                        })(); },
                      }));
                    }
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="log-panel-panel-log"
            aria-labelledby="log-panel-tab-log"
            className="flex-1 min-h-0 bg-black border-t-2 border-[var(--pixel-border)] px-3 py-2 font-mono text-[11px] text-[#00ff00] overflow-y-auto"
          >
            {logs.length === 0 ? (
              <div className="opacity-50 italic">시스템 준비 완료. 로그 대기 중...</div>
            ) : (
              logs.map(log => {
                const plan = parseLeaderPlanMessage(log.text);
                // 리더 로그 라인이 답변 전용인지 표식을 붙여, 긴 로그에서도 "분배"와
                // "답변만" 을 한 눈에 구분하게 한다. plan.mode === 'reply' 이거나 tasks 가
                // 비어 있으면 답변 전용으로 판정.
                const isAnswerOnly = !!plan && (plan.mode === 'reply' || plan.tasks.length === 0);
                return (
                  <div key={log.id} className="mb-1 flex gap-3">
                    <span className="shrink-0 text-[#888]">[{log.time}]</span>
                    <span className="shrink-0 text-[var(--pixel-accent)] font-bold">
                      {log.from}{log.to ? <span className="text-[#ffa500]"> → {log.to}</span> : null}:
                    </span>
                    {isAnswerOnly && (
                      <span
                        className="shrink-0 text-[9px] uppercase tracking-wider text-cyan-300 border border-cyan-300/50 bg-cyan-400/10 px-1 self-center"
                        data-leader-kind="reply"
                        title={LEADER_ANSWER_ONLY_TOOLTIP}
                      >
                        {LEADER_ANSWER_ONLY_LABEL}
                      </span>
                    )}
                    <span className="kr-msg min-w-0 break-words">
                      {plan ? (
                        <LeaderPlanBubble plan={plan} agentById={agentById} />
                      ) : (
                        log.text
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

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
        {manageMembersProjectId && (() => {
          const project = gameState.projects.find(p => p.id === manageMembersProjectId);
          if (!project) return null;
          return (
            <Modal title={`${project.name} 팀원 관리`} onClose={() => setManageMembersProjectId(null)}>
              <MembersForm
                project={project}
                agents={gameState.agents}
                translateRole={translateRole}
                onInvite={(agentId) => inviteAgentToProject(project.id, agentId)}
                onRemove={(agentId) => removeAgentFromProject(project.id, agentId)}
              />
            </Modal>
          );
        })()}
        {confirmDeleteProject && (
          <Modal title="프로젝트 삭제 확인" onClose={() => setConfirmDeleteProject(null)}>
            <div className="space-y-4">
              <p className="text-sm text-white/80">
                <span className="text-[var(--pixel-accent)] font-bold">{confirmDeleteProject.name}</span> 프로젝트를 정말 삭제하시겠습니까?
              </p>
              <p className="text-[11px] text-red-400">
                프로젝트에 속한 모든 파일, 의존성, 작업이 함께 삭제됩니다. (팀원 본인은 유지)
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    deleteProject(confirmDeleteProject.id, confirmDeleteProject.name);
                    setConfirmDeleteProject(null);
                  }}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white py-3 font-bold uppercase border-b-4 border-red-800"
                >
                  삭제하기
                </button>
                <button
                  onClick={() => setConfirmDeleteProject(null)}
                  className="flex-1 bg-gray-600 hover:bg-gray-700 text-white py-3 font-bold uppercase border-b-4 border-gray-800"
                >
                  취소
                </button>
              </div>
            </div>
          </Modal>
        )}
        <SharedGoalModal
          open={sharedGoalPromptOpen}
          projectId={selectedProjectId}
          onClose={() => setSharedGoalPromptOpen(false)}
          onEnabled={() => {
            // 모달 내부에서 PATCH /api/auto-dev { enabled:true } 가 성공한 직후 호출된다.
            // 낙관 갱신: 소켓 이벤트 도착 전에도 토글 UI 를 즉시 ON 으로 맞춘다.
            setAutoDevEnabled(true);
          }}
          onLog={(text) => addLog(text)}
        />
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
      <AttachmentPreviewModal
        attachment={previewingAttachment}
        previewUrl={previewUrl}
        previewText={previewText}
        onClose={handleClosePreview}
      />
    </div>
  );
}

// 리더가 보낸 분배 계획(JSON)을 브리핑 형식으로 펼친다. JSON 처럼 보이지 않도록
// (1) 요약줄: 📋 아이콘 + accent 컬러 + 우측 "배정 N건" 카운트 칩
// (2) 하위 태스크: 좌측 accent 레일 + 인덴트, 각 행은 [역할 배지] — 설명.
//     배지 배경은 getRoleAccent, 이모지·툴팁은 getAgentEmoji/getRoleDescription.
// assignedTo 를 agentById 로 치환한다. 매핑이 없으면(해고된 팀원 등) 중성 배지와
// ID 끝 6자리를 보조 표기로 노출해 "정체불명 ID"가 통째로 화면을 차지하지 않도록 한다.
function LeaderPlanBubble({
  plan,
  agentById,
}: {
  plan: LeaderPlan;
  agentById: ReadonlyMap<string, Agent>;
}) {
  const count = plan.tasks.length;
  return (
    <span className="inline-block w-full align-top">
      {plan.message && (
        <span className="flex items-start gap-1.5">
          <span aria-hidden="true" className="shrink-0 mt-[1px] text-[var(--pixel-accent)]">📋</span>
          <span className="min-w-0 break-words text-[var(--pixel-accent)] font-bold leading-snug">
            {plan.message}
          </span>
          {count > 0 && (
            <span
              className="ml-auto shrink-0 mt-[1px] px-1 border border-[var(--pixel-accent)]/50 text-[9px] font-normal text-[var(--pixel-accent)]/80 uppercase tracking-wider"
              aria-label={`배정 태스크 ${count}건`}
            >
              배정 {count}건
            </span>
          )}
        </span>
      )}
      {count > 0 && (
        <span className="mt-1 block border-l-2 border-[var(--pixel-accent)]/40 pl-3 ml-2">
          {plan.tasks.map((task, i) => {
            const agent = agentById.get(task.assignedTo);
            const accent = agent ? getRoleAccent(agent.role) : 'var(--pixel-border)';
            const contrast = agent ? getRoleContrast(agent.role) : '#000';
            const emoji = agent ? getAgentEmoji(agent.role) : '❔';
            const name = agent?.name ?? `미지정 (${task.assignedTo.slice(-6)})`;
            const title = agent
              ? `${getRoleLabel(agent.role)} · ${getRoleDescription(agent.role)}`
              : '배정 실패: 알 수 없는 팀원';
            return (
              <span
                key={i}
                className="flex items-start gap-2 mt-1 first:mt-0"
                data-testid="leader-plan-task"
              >
                <span
                  className="shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] text-[10px] font-bold border border-black/40"
                  style={{ backgroundColor: accent, color: contrast }}
                  title={title}
                >
                  <span aria-hidden="true">{emoji}</span>
                  <span>{name}</span>
                </span>
                <span className="min-w-0 break-words text-white/85 leading-snug">
                  {task.description}
                </span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

function AgentSprite({ agent, x, y, targetName, onClick, logs, workingFileName, translateStatus, highlighted }: { agent: Agent; x: number; y: number; targetName?: string; onClick: () => void | Promise<void>; logs?: AgentLogLine[]; workingFileName?: string; translateStatus?: (status: string) => string; highlighted?: boolean; key?: string }) {
  return (
    <motion.div
      key={agent.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ opacity: { duration: 0.3 } }}
      className="absolute cursor-pointer group z-40"
      style={{ left: 0, top: 0, transform: `translate3d(${x}px, ${y}px, 0)`, willChange: 'transform' }}
      onClick={onClick}
    >
      {/* Persistent verbose context window above the head */}
      {logs && translateStatus && (
        <AgentContextBubble
          agent={agent}
          logs={logs}
          workingFileName={workingFileName}
          translateStatus={translateStatus}
          highlighted={highlighted}
        />
      )}

      {/* Dialogue Bubble */}
      <AnimatePresence>
        {agent.lastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute bottom-[180px] left-[-60px] w-[180px] bg-white text-black p-2 border-2 border-black text-[11px] leading-tight z-40"
          >
            {targetName && (
              <div className="text-[9px] font-bold text-[#cc6600] mb-1 uppercase">→ {targetName}</div>
            )}
            {summarizeLeaderMessage(agent.lastMessage)}
            <div className="absolute bottom-[-10px] left-1/2 -translate-x-1/2 border-x-[5px] border-x-transparent border-t-[5px] border-t-white" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Character Sprite */}
      <div className="relative">
        <div
          className="w-[48px] h-[48px] border-[3px] border-black flex items-center justify-center text-2xl relative"
          style={{
            backgroundColor: getRoleAccent(agent.role),
            boxShadow: getRoleGlow(
              agent.role,
              agent.role === 'Leader' ? 'leader' : agent.workingOnFileId ? 'active' : 'idle',
            ),
          }}
        >
          {/* Pixel Eyes */}
          <div className="absolute top-2 left-2 w-[10px] h-[10px] bg-white shadow-[18px_0_white]" />
          <span className="relative z-10">{getAgentEmoji(agent.role)}</span>
        </div>
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap">
          <span
            className="text-[10px] font-bold bg-black/70 px-2 py-0.5 border"
            style={{ borderColor: getRoleAccent(agent.role) }}
          >
            {agent.name}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  // QA: 키보드 사용자와 접근성 도구를 위해 ESC로 닫을 수 있게 한다.
  // 현재 열린 모달 하나에만 바인딩되도록 언마운트 시 반드시 해제.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const titleId = useMemo(() => `modal-title-${uuidv4()}`, []);
  const localizedTitle = localizeModalTitle(title);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
          <h3 id={titleId} className="text-lg font-bold text-[var(--pixel-accent)] uppercase tracking-wider">{localizedTitle}</h3>
          <button onClick={onClose} aria-label="모달 닫기" className="text-[var(--pixel-white)] hover:text-[var(--pixel-accent)] transition-colors">
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

function HireForm({ onHire }: { onHire: (name: string, role: AgentRole, sprite: string, persona?: string) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('Developer');
  const [persona, setPersona] = useState('');

  const personaPresets: { label: string; text: string }[] = [
    { label: '시니어 개발자', text: '10년 이상 경력의 시니어 개발자. 코드 품질과 테스트에 집착하며, 단순함을 선호함.' },
    { label: '주니어 디자이너', text: '실무 3개월차 UI 디자이너. 최신 트렌드에 밝고 사용자 경험을 중시함. 질문을 많이 함.' },
    { label: '냉철한 QA', text: '디테일에 강하고 엣지 케이스를 놓치지 않는 QA 엔지니어. 직설적인 말투.' },
    { label: '카리스마 리더', text: '비전이 뚜렷하고 결단력 있는 팀 리더. 팀원들을 격려하며 명확한 방향을 제시함.' },
  ];

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
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2">역할 (아바타/구분용)</label>
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
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase">페르소나 (성격·말투·전문성)</label>
          <span className="text-[9px] text-white/40">AI 프롬프트에 반영됨</span>
        </div>
        <textarea
          value={persona}
          onChange={e => setPersona(e.target.value)}
          className="w-full bg-black/30 border-2 border-[var(--pixel-border)] px-4 py-2 text-[12px] focus:outline-none focus:border-[var(--pixel-accent)] transition-colors h-28 resize-none text-white"
          placeholder="예: 완벽주의 시니어 개발자. TDD를 선호하며 불필요한 추상화를 경계함. 간결하고 직설적인 말투."
        />
        <div className="flex flex-wrap gap-1 mt-2">
          {personaPresets.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => setPersona(p.text)}
              className="text-[10px] px-2 py-1 bg-black/40 border border-[var(--pixel-border)] hover:border-[var(--pixel-accent)] hover:text-[var(--pixel-accent)] transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <button
        onClick={() => onHire(name, role, 'char1', persona)}
        disabled={!name.trim()}
        className="w-full bg-[var(--pixel-accent)] text-black py-3 font-bold uppercase border-b-4 border-[#0099cc] mt-4 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        고용 확정
      </button>
    </div>
  );
}

function ProjectForm({ onCreate }: { onCreate: (name: string, description: string, path?: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');

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
        <label className="block text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2">로컬 경로 (선택사항)</label>
        <input 
          value={workspacePath}
          onChange={e => setWorkspacePath(e.target.value)}
          className="w-full bg-black/30 border-2 border-[var(--pixel-border)] px-4 py-2 text-sm focus:outline-none focus:border-[var(--pixel-accent)] transition-colors text-white"
          placeholder="C:\Projects\MyProject..."
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
        onClick={() => onCreate(name, description, workspacePath)}
        className="w-full bg-[var(--pixel-accent)] text-black py-3 font-bold uppercase border-b-4 border-[#0099cc] mt-4"
      >
        프로젝트 초기화
      </button>
    </div>
  );
}

function MembersForm({
  project,
  agents,
  translateRole,
  onInvite,
  onRemove,
}: {
  project: Project;
  agents: Agent[];
  translateRole: (role: string) => string;
  onInvite: (agentId: string) => void | Promise<void>;
  onRemove: (agentId: string) => void | Promise<void>;
}) {
  const members = agents.filter(a => project.agents.includes(a.id));
  const candidates = agents.filter(a => !project.agents.includes(a.id));

  return (
    <div className="space-y-5 max-h-[60vh] overflow-y-auto">
      <div>
        <div className="text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2 tracking-wider">
          현재 팀원 ({members.length})
        </div>
        {members.length === 0 && (
          <p className="text-[11px] text-white/50 italic">팀원이 없습니다.</p>
        )}
        <div className="space-y-2">
          {members.map(agent => (
            <div key={agent.id} className="flex items-center justify-between bg-black/30 border-2 border-[var(--pixel-border)] p-2">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 border-2 border-black flex items-center justify-center text-xs shrink-0"
                  style={{ backgroundColor: getRoleAccent(agent.role) }}
                >
                  {getAgentEmoji(agent.role)}
                </div>
                <div className="min-w-0">
                  <div className="text-[12px] font-bold text-[var(--pixel-accent)] truncate">{agent.name}</div>
                  <div className="text-[10px] opacity-70">{translateRole(agent.role)}</div>
                  {agent.persona && (
                    <div
                      className="text-[10px] opacity-60 italic truncate"
                      title={agent.persona}
                      data-testid="member-persona"
                    >
                      {agent.persona}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => onRemove(agent.id)}
                disabled={agent.role === 'Leader' && members.filter(m => m.role === 'Leader').length === 1}
                className="px-3 py-1 text-[10px] font-bold uppercase bg-red-900/40 border-2 border-red-900 hover:bg-red-900 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                title={agent.role === 'Leader' ? '유일한 리더는 제외할 수 없습니다' : '프로젝트에서 제외'}
              >
                제외
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-bold text-[var(--pixel-accent)] uppercase mb-2 tracking-wider">
          초대 가능 ({candidates.length})
        </div>
        {candidates.length === 0 && (
          <p className="text-[11px] text-white/50 italic">모든 직원이 이미 참여 중입니다.</p>
        )}
        <div className="space-y-2">
          {candidates.map(agent => (
            <div key={agent.id} className="flex items-center justify-between bg-black/20 border-2 border-[var(--pixel-border)] p-2">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 border-2 border-black flex items-center justify-center text-xs shrink-0"
                  style={{ backgroundColor: getRoleAccent(agent.role) }}
                >
                  {getAgentEmoji(agent.role)}
                </div>
                <div className="min-w-0">
                  <div className="text-[12px] font-bold text-[var(--pixel-accent)] truncate">{agent.name}</div>
                  <div className="text-[10px] opacity-70">{translateRole(agent.role)}</div>
                  {agent.persona && (
                    <div
                      className="text-[10px] opacity-60 italic truncate"
                      title={agent.persona}
                      data-testid="candidate-persona"
                    >
                      {agent.persona}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => onInvite(agent.id)}
                className="px-3 py-1 text-[10px] font-bold uppercase bg-[var(--pixel-accent)] text-black border-b-2 border-[#0099cc] hover:brightness-110 transition-all"
              >
                초대
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function runForceStep(
  positions: Record<string, { x: number; y: number }>,
  velocities: Record<string, { x: number; y: number }>,
  files: CodeFile[],
  agents: Agent[],
  deps: CodeDependency[],
  center: { x: number; y: number }
) {
  type Node = { id: string; kind: 'file' | 'agent'; radius: number };
  const nodes: Node[] = [
    ...files.map(f => ({ id: f.id, kind: 'file' as const, radius: 18 })),
    ...agents.map(a => ({ id: a.id, kind: 'agent' as const, radius: 34 })),
  ];
  if (nodes.length === 0) return;

  nodes.forEach((n, i) => {
    if (!positions[n.id]) {
      const angle = (i / nodes.length) * Math.PI * 2;
      const r = n.kind === 'file' ? 180 : 240;
      positions[n.id] = {
        x: center.x + r * Math.cos(angle) + (Math.random() - 0.5) * 20,
        y: center.y + r * Math.sin(angle) + (Math.random() - 0.5) * 20,
      };
    }
    if (!velocities[n.id]) velocities[n.id] = { x: 0, y: 0 };
  });

  const forces: Record<string, { x: number; y: number }> = {};
  nodes.forEach(n => { forces[n.id] = { x: 0, y: 0 }; });

  // Pairwise repulsion within same kind only — files and agents may overlap
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.kind !== b.kind) continue;
      const pa = positions[a.id], pb = positions[b.id];
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const dist2 = Math.max(dx * dx + dy * dy, 1);
      const dist = Math.sqrt(dist2);
      const ux = dx / dist, uy = dy / dist;
      const minDist = a.radius + b.radius + 8;
      const overlap = Math.max(0, minDist - dist);
      const magnitude = 2400 / dist2 + overlap * 0.6;
      forces[a.id].x -= ux * magnitude;
      forces[a.id].y -= uy * magnitude;
      forces[b.id].x += ux * magnitude;
      forces[b.id].y += uy * magnitude;
    }
  }

  // Springs along dependencies
  const REST = 150, K = 0.02;
  deps.forEach(d => {
    const pa = positions[d.from], pb = positions[d.to];
    if (!pa || !pb) return;
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (dist - REST) * K;
    const ux = dx / dist, uy = dy / dist;
    forces[d.from].x += ux * f;
    forces[d.from].y += uy * f;
    forces[d.to].x -= ux * f;
    forces[d.to].y -= uy * f;
  });

  // Agents orbit their working file / otherwise orbit center
  agents.forEach(a => {
    const pa = positions[a.id];
    const target = a.workingOnFileId ? positions[a.workingOnFileId] : null;
    if (target) {
      const dx = target.x - pa.x, dy = target.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const desired = 58;
      const f = (dist - desired) * 0.05;
      forces[a.id].x += (dx / dist) * f;
      forces[a.id].y += (dy / dist) * f;
      // tangential orbit
      forces[a.id].x += (-dy / dist) * 0.5;
      forces[a.id].y += (dx / dist) * 0.5;
    } else {
      // Pull idle agents toward an orbital ring around the center.
      // (dx, dy) is the outward vector from center → agent. When the agent is
      // inside the ring (dist < desired) we push outward; when it's outside we
      // pull inward. The earlier sign was inverted, which let idle agents drift
      // off-screen because the "restoring" force actually accelerated them away.
      const dx = pa.x - center.x, dy = pa.y - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const desired = 220;
      const radial = (desired - dist) * 0.02;
      forces[a.id].x += (dx / dist) * radial;
      forces[a.id].y += (dy / dist) * radial;
      // Gentle tangential drift so the ring visibly rotates instead of freezing.
      forces[a.id].x += (-dy / dist) * 0.15;
      forces[a.id].y += (dx / dist) * 0.15;
    }
  });

  // Hard safety bound: if any agent has somehow escaped the viewport, snap it
  // back toward the center. Prevents runaway drift from numerical edge cases.
  const MAX_RADIUS = 520;
  agents.forEach(a => {
    const p = positions[a.id];
    const dx = p.x - center.x, dy = p.y - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > MAX_RADIUS) {
      const scale = MAX_RADIUS / dist;
      positions[a.id] = { x: center.x + dx * scale, y: center.y + dy * scale };
      velocities[a.id] = { x: 0, y: 0 };
    }
  });

  // Gentle centering for files
  files.forEach(f => {
    const p = positions[f.id];
    forces[f.id].x += (center.x - p.x) * 0.004;
    forces[f.id].y += (center.y - p.y) * 0.004;
  });

  const DAMP = 0.82;
  const MAX_V = 6;
  nodes.forEach(n => {
    const v = velocities[n.id];
    const f = forces[n.id];
    let vx = (v.x + f.x) * DAMP;
    let vy = (v.y + f.y) * DAMP;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > MAX_V) { vx = (vx / speed) * MAX_V; vy = (vy / speed) * MAX_V; }
    velocities[n.id] = { x: vx, y: vy };
    positions[n.id] = { x: positions[n.id].x + vx, y: positions[n.id].y + vy };
  });
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

// 헤더 지표 칩의 건강도(green/amber/red)를 퍼센트 값으로 분류한다.
// 각 칩은 동일한 외형을 갖고 있어 어떤 지표가 위험 구간인지 한눈에 보이지 않던
// 문제를 좌측 3px 인디케이터 바로 해소한다. null 을 넣으면 "데이터 없음" 톤으로
// 중립색을 반환해 "0% 위험"과 "아직 측정 전"을 시각적으로 구분한다.
export function getMetricTierColor(value: number | null): string {
  if (value === null) return 'var(--pixel-border)';
  if (value >= 70) return '#7bd389';
  if (value >= 40) return '#ffd166';
  return '#ff6b6b';
}

// Role-based accent colors — chosen for legibility on the dark pixel background
// and to give each discipline a distinct on-screen identity. Pairs with
// ROLE_CONTRAST so labels placed on the accent swatch remain readable.
const ROLE_ACCENT: Record<AgentRole | string, string> = {
  Leader: 'var(--pixel-accent)',
  Developer: '#7bd389',
  QA: '#ff6b6b',
  Designer: '#ffb86b',
  Researcher: '#c89bff',
};

// Text color chosen per accent to keep WCAG AA-ish contrast for small labels
// stamped directly onto the role swatch (emoji avatars, chips, etc.).
const ROLE_CONTRAST: Record<AgentRole | string, string> = {
  Leader: '#0b1a2a',
  Developer: '#0b2313',
  QA: '#2a0a0a',
  Designer: '#2a1605',
  Researcher: '#1a0b2a',
};

function getRoleAccent(role: AgentRole | string): string {
  return ROLE_ACCENT[role] ?? 'var(--pixel-text)';
}

export function getRoleContrast(role: AgentRole | string): string {
  return ROLE_CONTRAST[role] ?? '#000';
}

// 역할별 한 줄 설명: 아바타 hover 툴팁과 스크린리더용 aria-label에서 공통 사용.
// 한 곳에서 문구를 수정하면 팀원 카드/모달/프로젝트 뷰 전반의 설명이 동기화된다.
const ROLE_DESCRIPTION: Record<AgentRole | string, string> = {
  Leader: '팀 방향을 정하고 팀원에게 작업을 분배하는 리더',
  Developer: '기능을 구현하고 버그를 해결하는 개발자',
  QA: '엣지 케이스를 찾고 품질을 검증하는 QA',
  Designer: 'UI/UX 흐름과 시각 디자인을 책임지는 디자이너',
  Researcher: '기술 조사와 실험 설계를 담당하는 연구원',
};

export function getRoleDescription(role: AgentRole | string): string {
  return ROLE_DESCRIPTION[role] ?? '팀 구성원';
}

// 역할 한국어 단축 라벨: 툴팁·칩·요약 문자열처럼 공간이 좁은 곳에서 쓴다.
// getRoleDescription 이 한 문장짜리 설명이라면, 여기는 2~4자짜리 호칭이다.
// 모듈 레벨로 올려두어 렌더마다 객체를 새로 만드는 비용을 피하고, 다른
// 컴포넌트에서도 App 에 의존하지 않고 import 해서 쓸 수 있게 한다.
const ROLE_LABEL_KO: Record<AgentRole | string, string> = {
  Leader: '리더',
  Developer: '개발자',
  QA: '품질 관리',
  Designer: '디자이너',
  Researcher: '연구원',
};

export function getRoleLabel(role: AgentRole | string): string {
  return ROLE_LABEL_KO[role] ?? role;
}

// 에이전트/태스크 상태의 한국어 라벨. 상태 값은 여러 도메인에서 재사용되므로
// (에이전트: idle/working/meeting/thinking, 태스크: pending/in-progress/completed,
// 프로젝트: on-hold) 한 맵에 묶어 단일 출처로 관리한다.
const STATUS_LABEL_KO: Record<string, string> = {
  idle: '대기 중',
  active: '활성',
  working: '작업 중',
  meeting: '회의 중',
  thinking: '사고 중',
  pending: '대기',
  'in-progress': '진행 중',
  completed: '완료',
  'on-hold': '보류',
};

export function getStatusLabel(status: string): string {
  return STATUS_LABEL_KO[status] ?? status;
}

// Consistent halo used on sprites/cards to signal "high-rank" or "currently-active"
// agents without introducing a second color token. Kept subtle: leaders get a
// persistent glow, active workers get a softer pulse, idle agents get nothing.
export function getRoleGlow(role: AgentRole | string, state: 'leader' | 'active' | 'idle' = 'idle'): string | undefined {
  if (state === 'idle') return undefined;
  const accent = getRoleAccent(role);
  return state === 'leader' ? `0 0 15px ${accent}` : `0 0 8px ${accent}`;
}

// Modal titles travel in from legacy English literals; centralize the Korean
// display mapping here so designers can rename labels without hunting through
// the JSX. Unknown titles fall through unchanged.
const MODAL_TITLE_KO: Record<string, string> = {
  'Hire New Agent': '새 에이전트 고용',
  'Start New Project': '새 프로젝트 시작',
};

export function localizeModalTitle(title: string): string {
  return MODAL_TITLE_KO[title] ?? title;
}

// 파일 타입별 색상 팔레트: 의존성 그래프에서 component/service/util/style 을
// 한눈에 구분할 수 있도록 노드 색을 차별화한다. 어두운 배경 위에서도
// 도트(점)가 충분히 튀도록 채도를 조금 높여 둔다.
const FILE_TYPE_ACCENT: Record<NonNullable<CodeFile['type']> | string, string> = {
  component: '#4ecdc4', // 민트: UI 컴포넌트
  service: '#ffd166',   // 앰버: 네트워크/비즈니스 로직
  util: '#a0e7a0',      // 라임: 공용 유틸
  style: '#ff9ecb',     // 핑크: 스타일/테마
};

export function getFileTypeAccent(type?: CodeFile['type'] | string): string {
  if (!type) return 'var(--pixel-accent)';
  return FILE_TYPE_ACCENT[type] ?? 'var(--pixel-accent)';
}

const FILE_TYPE_LABEL_KO: Record<NonNullable<CodeFile['type']> | string, string> = {
  component: '컴포넌트',
  service: '서비스',
  util: '유틸',
  style: '스타일',
};

export function translateFileType(type?: CodeFile['type'] | string): string {
  if (!type) return '파일';
  return FILE_TYPE_LABEL_KO[type] ?? type;
}

// 전역 오류 표면화 래퍼(#3773fc8d) — App 본체 렌더 오류와 전역 Promise 거부를
// `ErrorBoundary` 가 포획하고, 비 React 경로에서 쏘는 토스트는 `ToastProvider` 의
// 모듈 버스가 같은 스택으로 수렴한다. 래핑 순서는 바깥 → 안:
//   ErrorBoundary (렌더 오류 포획·복구 UI)
//   └ ToastProvider (우상단 스택·역할 분리·토스트 버스 구독)
//     └ App (기존 본체)
export default function AppRoot(): React.ReactElement {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <App />
        {/*
          최초 접속 온보딩 코치마크(#4c9bc4a6)는 App 내부로 이관되어 restartKey 가
          SettingsDrawer 의 "투어 다시 보기" 에 연결된다(#0dceedcd). 본 위치의 중복
          마운트는 제거.
        */}
      </ToastProvider>
    </ErrorBoundary>
  );
}
