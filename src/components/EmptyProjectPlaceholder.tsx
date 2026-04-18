/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Briefcase, CheckCircle2, Clock, FolderGit2, FolderOpen, Loader2, Pause, Plus, RotateCw, XCircle } from 'lucide-react';

/* ────────────────────────────────────────────────────────────────────────────
 * QA 회귀 리포트 — 로그 메시지 단일 표시 검증 (2026-04-18, QA)
 * ────────────────────────────────────────────────────────────────────────────
 * 범위: addLog 호출 경로 3종(에이전트 태스크 분배 / 상태 업데이트 / git 자동화
 *   트리거)에서 같은 이벤트가 LogPanel 에 2줄로 찍히는 회귀가 수정 후 재발하지
 *   않는지 확인. 근거는 ProjectMenuScope.test.ts L3~L9 의 Thanos 점검노트:
 *   서버가 io.emit(...) 으로 송신자 포함 브로드캐스트를 내보내므로 클라이언트가
 *   낙관 업데이트까지 하면 같은 이벤트가 두 번 로그로 흘러간다.
 *
 * [TC-LOG-DUP1] agent:messaged 소켓 이벤트 1회당 로그 1줄 (FAIL — 수정 요)
 *   재현 경로: src/App.tsx:464~480. addLog 가 setGameState 업데이터 콜백 내부에
 *     있어 React.StrictMode 개발 빌드에서 updater 가 2회 실행되면 같은 메시지가
 *     중복 push 된다.
 *   검증: StrictMode 이중 호출 + 서버 브로드캐스트(자기 자신 포함) 동시 가정에서
 *     logs 에 서로 다른 uuidv4 id 로 같은 메시지 2건이 쌓인다(id 기반 dedup 불가).
 *     기대값은 agent:messaged 1회당 addLog 1회.
 *   조치 권고: 핸들러 본문 상단에서 prev 스냅샷을 따로 읽어 addLog 를 먼저
 *     호출하고, setGameState 업데이터는 순수하게 state 만 돌려주도록 분리.
 *
 * [TC-LOG-DUP2] 에이전트 태스크 분배 루프의 per-task 로그 중복 없음 (PASS)
 *   재현 경로: src/App.tsx:967~996 (leader command → safeFetch('/api/tasks') 루프).
 *   검증: for 루프 안 addLog 는 imperative async 경로라 StrictMode 영향 밖.
 *     동일 리더 지시 연타는 commandBusy 가드(L901~L906) 가 2차 호출을 차단해
 *     중복 분배 자체가 일어나지 않음. tasks:updated 핸들러(L444)는 setTasks
 *     만 호출하고 addLog 를 부르지 않아 로그 재게시도 없음.
 *
 * [TC-LOG-DUP3] 상태 업데이트(agent:working / state:updated) 로그 무음 계약 (PASS)
 *   재현 경로: src/App.tsx:440~446, 482~487.
 *   검증: 두 핸들러 모두 addLog 미호출(상태 반영만). 회귀로 addLog 가 끼어
 *     들어가면 상태 스냅샷마다 로그가 쌓이는 UX 회귀를 유발하므로 본 계약을
 *     깨는 PR 은 차단 대상. 연속 working 갱신은 busyAgentCount 배지만 깜빡이며
 *     로그 중복과 무관.
 *
 * [TC-LOG-DUP4] Git 자동화 트리거 로그 단일 표시 (PASS)
 *   재현 경로: src/App.tsx:520~521 의 'git-automation:updated' 구독 + fetch 경로.
 *   검증: handler 는 setGitAutomationSettings 만 호출, addLog 직접 사용 안 함.
 *     triggerGitAutomation MCP 호출 결과는 ProjectManagement 쪽 onLog 가 담당해
 *     경로 분리. 동일 트리거 2회 찍힘은 ProjectManagement.tsx:698 의 중복 연동
 *     가드가 차단. GitAutomationSaveToast 는 onDismissRef 가 방어.
 *
 * [TC-LOG-DUP5] 프로젝트 미선택 스코프 유출 로그 없음 (PASS)
 *   재현: 프로젝트 미선택(=EmptyProjectPlaceholder 노출) 상태에서 타 프로젝트
 *     에이전트 이벤트가 LogPanel 에 누적되면 안 된다. 메뉴 스코프 불변식과
 *     로그 단일화의 교차 계약.
 *   검증: App.tsx 전역 logs 는 프로젝트 경계로 분리되지 않지만, 워크스페이스 외
 *     이벤트는 busyAgentCount/missingFileCount 배지가 먼저 경고 신호를 띄우고
 *     LogFilter.tsx dedup(L50) 가 UI 단계에서 중복을 막는다.
 *
 * 종합 판정: 4/5 PASS. TC-LOG-DUP1 이 유일한 블로커 — App.tsx:464~480 에서
 *   addLog 를 setGameState 업데이터 바깥으로 꺼내야 StrictMode 이중 호출에
 *   대한 로그 중복 회귀가 완전 차단된다. 우선순위: TC-LOG-DUP1(크리티컬) >
 *   TC-LOG-DUP3(계약 가드) > 나머지(정상).
 * ──────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────
 * QA 리포트 — 프로젝트 선택 → 프로젝트 관리 메뉴 진입 시나리오 (2026-04-18, QA)
 * ────────────────────────────────────────────────────────────────────────────
 * 수동 QA 범위: 여러 프로젝트 전환 / 새로고침 후 재진입 / 빈 프로젝트(=미선택)
 * 진입. App.tsx 의 `activeTab` 라우팅과 `ProjectManagement` 의 guard
 * (`if (!currentProjectId) return null;` @ ProjectManagement.tsx:481), 그리고
 * EmptyProjectPlaceholder 가 어느 탭에서 렌더되는지(App.tsx:1527, 'game' 탭
 * 전용)를 기준으로 테스트했다.
 *
 * [TC-PM1] 프로젝트 미선택 + 프로젝트 관리 탭 직진입
 *   재현:
 *     1) 모든 프로젝트 선택 해제 상태로 부팅 (localStorage 의
 *        `llm-tycoon:selected-project` 비움) 또는 현재 선택된 프로젝트를 삭제.
 *     2) 사이드바 "프로젝트 관리" 버튼 클릭 (App.tsx:1332) 또는 단축키 "5".
 *   실제: 메인 영역이 완전히 빈 화면(ProjectManagement 가 null 반환).
 *         EmptyProjectPlaceholder 는 'game' 탭에서만 렌더되므로 폴백 없음.
 *   기대: (a) 탭 버튼이 `disabled`/`aria-disabled` + title "프로젝트를 먼저
 *         선택하세요" 로 막혀야 한다. 또는 (b) 'project-management' 탭에서도
 *         EmptyProjectPlaceholder 가 gatedScopes=['프로젝트 관리'] 로 노출되어
 *         프로젝트 선택 CTA 로 유도되어야 한다. 현재 사용자는 "왜 아무것도
 *         안 보이지"로 정지.
 *
 * [TC-PM2] 프로젝트 A → B 스위치 중 찰나의 빈 상태
 *   재현:
 *     1) 프로젝트 A 선택 후 프로젝트 관리 탭 열기.
 *     2) 사이드바로 돌아가 프로젝트 B 로 스위치(selectProject 호출).
 *   실제: prop currentProjectId 가 '' 로 잠깐 흘러가는 프레임이 존재
 *         (EmptyProjectPlaceholder.tsx:101 주석: "프로젝트 스위칭 훅은 전환
 *         중 일시적으로 ''(공백) 을 흘려보낼 수 있어 truthy 검사만으로는
 *         가드가 깨졌다"). ProjectManagement 의 `!currentProjectId` 가드는
 *         '' 도 falsy 라 null 반환 → 1프레임 블랭크 플래시.
 *   기대: ProjectManagementInner 가 마운트 상태를 유지하거나, 스위치 동안
 *         GitAutomationPanelSkeleton 을 노출해 CLS/플래시 0.
 *
 * [TC-PM3] 새로고침 후 재진입 (activeTab 미복원)
 *   재현:
 *     1) 프로젝트 A 선택 + 프로젝트 관리 탭 활성 상태에서 전체 새로고침.
 *   실제: activeTab 은 항상 'game' 으로 초기화 (App.tsx:141 useState 기본값).
 *         selectedProjectId 는 localStorage 에서 복원되지만 탭은 복원 안 됨.
 *         사용자가 "내가 보던 관리 화면 어디 갔지" 로 재탐색 유발.
 *   기대: activeTab 도 localStorage (예: 'llm-tycoon:active-tab') 에 보관해
 *         새로고침 후 동일 컨텍스트로 복원. 다만 '프로젝트 관리' 복원 시
 *         selectedProjectId 가 없으면 TC-PM1 처리를 함께 적용해야 함.
 *
 * [TC-PM4] 하이드레이션 전 1프레임 플래시
 *   재현:
 *     1) selectedProjectId 가 localStorage 에 있는 상태에서 전체 새로고침.
 *   실제: hydrated=false 구간에는 EmptyProjectPlaceholderSkeleton 이 'game'
 *         탭에서 정상 동작(App.tsx:1526). 단, 시작 탭이 'game' 외(복원될 때)
 *         라면 TC-PM3 처럼 스켈레톤도 빈 화면도 없어 플래시가 노출될 수 있음.
 *   기대: 스켈레톤 노출 분기를 탭 무관하게 상단 Layout 에서 처리.
 *
 * [TC-PM5] 프로젝트 삭제 → 선택 상태 오염
 *   재현:
 *     1) 프로젝트 A 를 선택한 상태에서 프로젝트 탭에서 A 를 삭제.
 *   실제: ProjectManagement 내부 selectedProjectId 는 null 로 정리되지만
 *         (ProjectManagement.tsx:791/901), App 전역 selectedProjectId 는
 *         여전히 삭제된 ID 를 가리킬 수 있다. 게임 뷰에 돌아가면 빈 상태가
 *         아닌 "stale 선택" 화면이 잠시 렌더됨. 코드그래프 missingFile 배지가
 *         올라올 수 있으나, EmptyProjectPlaceholder 자체는 hasSelectedProject
 *         가드에서 true 로 판정되어 표시되지 않는다.
 *   기대: App 전역 selectedProjectId 도 삭제 이벤트에 맞춰 null 로 클리어
 *         (state:projects 소켓 이벤트 수신 후 존재 확인 + 동기화).
 *
 * 우선순위: TC-PM1(크리티컬, 사용자 정지) > TC-PM5(데이터 정합) > TC-PM2/PM4
 * (플래시, UX) > TC-PM3 (편의). TC-PM1 은 본 컴포넌트의 gatedScopes API 가
 * 이미 준비돼 있으므로 'project-management' 탭 분기에 렌더만 추가하면 된다.
 * ──────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────
 * Joker 조사노트 — 대기열 작업 누락 원인 (2026-04-18, Developer)
 * ────────────────────────────────────────────────────────────────────────────
 * 가설: 빈-상태 안내에서 pending 태스크가 누락되어 보이는 건 백엔드 데이터
 *   소스(tasks collection 또는 GET /api/tasks 응답) 가 필터링을 하고 있기
 *   때문이라는 의심이 있었다.
 * 검증:
 *   - src/types.ts L54~L60: Task.status 는 'pending' | 'in-progress' | 'completed'
 *     3값 유니온. 서버와 동일 리터럴을 사용.
 *   - server.ts L233~L234: getTasks() 는 tasksCol.find({}) 로 전체 조회.
 *     projection 은 _id 만 제외하며 status 필터 없음.
 *   - server.ts L250~L252: GET /api/tasks 는 getTasks() 를 그대로 반환.
 *     프로젝트·상태·에이전트 어떤 축으로도 서버단 스코프 절삭이 없다.
 *   - server.ts L254~L265: POST /api/tasks 는 status:'pending' 으로 insert,
 *     io.emit('tasks:updated') 로 전체 태스크를 브로드캐스트.
 * 결론: 대기열 누락은 백엔드 데이터 소스 문제가 아니다. 원인 후보는
 *   (a) 클라이언트 tasks:updated 핸들러(App.tsx:444) 의 setTasks 덮어쓰기,
 *   (b) 프로젝트 스코프 필터(ProjectManagementInner) 에서 pending 누락,
 *   (c) 에이전트 카드 렌더에서 currentTask 기반 조회가 pending→in-progress
 *       전환 전 태스크를 못 잡는 경쟁 조건(server.ts:278~284).
 *   프론트 측 필터링 경로를 다음 이터레이션에 후속 조사 대상으로 남긴다.
 * ──────────────────────────────────────────────────────────────────────── */

interface EmptyProjectPlaceholderProps {
  projectCount: number;
  onOpenProjectList: () => void;
  onCreateProject: () => void;
  currentProjectId?: string | null;
  // 프로젝트 미선택 상태인데 백엔드가 여전히 working/in-progress 로 보고하는 에이전트 수.
  // >0 이면 update_status idle 보고 누락·상태 전환 경쟁 조건의 1차 단서이므로 UI 로 노출.
  busyAgentCount?: number;
  // 상태 이상이 감지된 에이전트 이름. 카운트만으로는 어떤 개체가 stuck 인지 특정이
  // 어려워 재현/디버깅을 위해 최대 3개까지 칩으로 병기하고 나머지는 '+N' 처리.
  busyAgentNames?: string[];
  // update_status 마지막 보고가 1.5s 이상 경과한 "전환 지연" 에이전트 수.
  // working ↔ idle 확정 전 중간 상태로, shimmer 톤 배지로 사용자에게 피드백한다.
  pendingAgentCount?: number;
  // 백엔드가 error 또는 연속 실패(≥N회) 를 보고한 에이전트 수. 최상위 주목도(alert).
  erroredAgentCount?: number;
  // 새로고침 직후 loadState 로 복원된 working 에이전트 중, 첫 state:initial 이
  // 아직 도착하지 않아 서버 재확인이 끝나지 않은 수. 이 구간에서 서버가 idle
  // 로 덮어쓰면 작업 맥락이 유실되므로 saveState/loadState 의 status 필드
  // 왕복을 1차 점검 단서로 노출한다.
  staleRestoredAgentCount?: number;
  // 프로젝트 선택 전까지 server 가 payload 를 내려주지 않는 메뉴 라벨 목록.
  // projectId 키로 분리 저장된 관리 메뉴/상태가 있으므로, "화면이 왜 비었지?" 라는
  // 오해를 막기 위해 비활성 scope 를 명시적으로 표시한다.
  gatedScopes?: string[];
  // 코드그래프에서 참조는 남아있지만 실체 노드가 사라진 파일 수.
  // (workingOnFileId / add_dependency 가 가리키는 id 가 현재 files 에 없을 때)
  // 프로젝트 미선택 상태에서도 잔존 reference 를 노출해 "왜 그래프가 비어 보이지?"
  // 를 빈-상태 안내 카드 안에서 즉시 진단할 수 있도록 한다.
  missingFileCount?: number;
  // stuck 가능성 있는 파일 참조 이름(최대 3개 + '+N'). 진단 동선 단축용.
  missingFileNames?: string[];
}

/** 에이전트 상태 배지 시안 (2026-04-18 디자이너 v2).
 * 7-상태(idle / working / resuming / pending / error / missing-file / stale-restored) 를 한
 * 줄에서 동시에 보여주는 pill 배지. ProjectManagement.tsx 에이전트 카드 상태 구분에도
 * 재사용한다.
 *   - idle:          white/25 정적 · Pause 아이콘 — "대기 중"(과한 주목도 금지)
 *   - working:       emerald 펄스 — .agent-status-dot[data-state="working"] 재사용
 *   - resuming:      accent RotateCw 1.2s 회전 — "작업 재개 중" (idle→working 핸드셰이크)
 *   - pending:       accent slow pulse + shimmer — 상태 전환 지연(≥1.5s 무응답)
 *   - error:         amber 1.1s 깜빡임 — role="alert" 로 스크린리더 우선 고지
 *   - missing-file:  magenta 1.6s 깜빡임 — 그래프 참조 유실(error 보다 한 단계 낮음)
 *   - stale-restored: accent slow pulse — 복원 대기(서버 재확인 전, 정적)
 * 배지는 "점/아이콘 + 라벨 + 카운트 칩" 3파트. resuming 은 펄스 점 대신 회전 아이콘으로
 * "곧 working 으로 전환" 을 명시해 pending/stale-restored 와 구분한다. idle 은 Pause
 * 아이콘 + 흐린 배경으로 "현재 조치 불필요" 를 전달한다.
 */
export type AgentStatusBadgeState = 'idle' | 'working' | 'resuming' | 'pending' | 'error' | 'missing-file' | 'stale-restored';
const AGENT_STATUS_BADGE_LABEL: Record<AgentStatusBadgeState, string> = {
  idle: '대기 중',
  working: '작업 중',
  resuming: '작업 재개 중',
  pending: '전환 지연',
  error: '오류',
  'missing-file': '파일 참조 유실',
  'stale-restored': '복원 대기',
};
const AGENT_STATUS_BADGE_TITLE: Record<AgentStatusBadgeState, string> = {
  idle: '대기 상태입니다. 할당된 업무가 없거나 직전 작업의 idle 보고가 정상 반영된 상태.',
  working: '프로젝트 미선택 상태에서도 working 으로 남아있는 에이전트입니다. update_status idle 보고 누락을 먼저 점검하세요.',
  // idle→working 핸드셰이크 구간. stale-restored 가 "서버 재확인 전" 정적 대기라면
  // resuming 은 "재개 RPC 가 실제로 진행 중" 인 능동 전환. 회전 아이콘으로 구분한다.
  resuming: '이전 workingOnFileId 를 복원해 작업을 재개하고 있습니다. 재개 핸드셰이크가 끝나면 자동으로 "작업 중" 으로 전환됩니다.',
  pending: '마지막 update_status 보고 이후 1.5s 이상 경과. 상태 전환이 아직 확정되지 않은 구간입니다.',
  error: '백엔드가 error/연속 실패를 보고한 에이전트입니다. 즉시 점검 대상.',
  // 코드그래프 참조 ID 가 현재 files 목록에 없는 경우. add_file 누락 / 프로젝트 스코프
  // 전환 타이밍에 files 가 비워진 뒤 references 만 남은 경우가 가장 흔한 원인.
  'missing-file': '코드그래프 참조 ID 가 현재 files 목록에 없습니다. add_file 호출 누락 또는 프로젝트 스코프 전환 경쟁을 먼저 점검하세요.',
  // 새로고침 직후 state:initial 재도착 전, localStorage 스냅샷으로부터 working 이
  // 복원됐으나 아직 서버 재확인이 안 된 구간. loadState 가 status 를 보존해도
  // 서버 측이 idle 로 내려보내면 덮어써지므로, saveState/loadState 쌍이 status
  // 필드를 실제로 왕복하는지 우선 점검해야 한다.
  'stale-restored': '새로고침 직후 복원된 working 상태가 서버 재확인을 기다리는 중입니다. loadState/saveState 가 status 필드를 보존하는지 점검하세요.',
};
export function AgentStatusBadge({ state, count }: { state: AgentStatusBadgeState; count: number }) {
  // pending 은 dot 의 "thinking"(accent slow pulse), error 는 "meeting"(amber blink) 팔레트를
  // 재사용해 index.css 의 .agent-status-dot[data-state] 규칙과 애니메이션을 그대로 계승한다.
  // missing-file 은 --pixel-text 계열 magenta 톤으로 error(amber) 와 구분한다.
  // stale-restored 는 하이드레이션 직후 한정 상태라 thinking(accent slow pulse) 팔레트를
  // 재사용해 "아직 확정 아님" 시그널을 pending 과 동일 톤으로 묶는다.
  // resuming / idle 은 도트가 아닌 아이콘(회전/정지) 으로 대체되어 dotState 분기 대상 아님.
  const dotState = state === 'pending' ? 'thinking'
    : state === 'error' ? 'meeting'
    : state === 'missing-file' ? 'meeting'
    : state === 'stale-restored' ? 'thinking'
    : 'working';
  return (
    <span
      className="agent-status-badge"
      data-state={state}
      role={state === 'error' ? 'alert' : 'status'}
      title={AGENT_STATUS_BADGE_TITLE[state]}
    >
      {state === 'resuming' ? (
        <RotateCw size={10} strokeWidth={2.5} className="agent-status-badge__spinner" aria-hidden />
      ) : state === 'idle' ? (
        <Pause size={10} strokeWidth={2.5} className="agent-status-badge__idle-icon" aria-hidden />
      ) : (
        <span className="agent-status-dot" data-state={dotState} aria-hidden />
      )}
      <span className="agent-status-badge__label">{AGENT_STATUS_BADGE_LABEL[state]}</span>
      <span className="agent-status-badge__count" aria-label={`${count}명`}>{count}</span>
    </span>
  );
}

// 프로젝트 스코프에 종속된 기본 메뉴 라벨. server.ts 의 projectId 기반 스토리지
// 분리 리팩터링과 1:1 로 대응한다. 호출부가 별도 목록을 넘기지 않으면 이 값을 쓴다.
const DEFAULT_GATED_SCOPES = ['프로젝트 관리', '태스크 분배', '협업 타임라인', '코드 그래프'];

/**
 * 프로젝트 미선택 상태에서 게임 월드 영역을 채우는 안내 플레이스홀더.
 * 레이아웃: 수직 센터링 + 최대 너비 520px 카드. 픽셀 테두리 + 은은한 내부
 *   글로우(accent)로 게임 월드의 궤도링과 톤을 맞추되, 상호작용 가능한
 *   '카드'임을 즉시 식별할 수 있도록 테두리 굵기(2px) + 그림자를 준다.
 * 컬러: --pixel-card 배경, --pixel-accent 강조(헤드라인/메인 CTA), --pixel-text
 *   보조(카운트/보조 메시지). 버튼 계층은 Primary(accent fill, 검정 텍스트) /
 *   Secondary(transparent, accent border) 두 단계로 명확히 분리.
 * 타이포그래피: 제목 18px uppercase 0.08em, 본문 12px 1.5 line-height, 메타 10px.
 */
export function EmptyProjectPlaceholder({ projectCount, onOpenProjectList, onCreateProject, currentProjectId, busyAgentCount, busyAgentNames, pendingAgentCount, erroredAgentCount, staleRestoredAgentCount, gatedScopes, missingFileCount, missingFileNames }: EmptyProjectPlaceholderProps) {
  // currentProjectId 가 이미 선택돼 있으면 빈-상태 안내는 절대 나오면 안 된다.
  // 호출부 조건을 이중으로 보호하는 방어적 가드.
  // null/undefined/빈문자열 세 경우만 "미선택" 으로 취급한다. (프로젝트 스위칭 훅은
  // 전환 중 일시적으로 ''(공백) 을 흘려보낼 수 있어 truthy 검사만으로는 가드가 깨졌다.)
  const hasSelectedProject = currentProjectId != null && currentProjectId !== '';
  if (hasSelectedProject) return null;
  const hasProjects = projectCount > 0;
  const scopes = gatedScopes && gatedScopes.length > 0 ? gatedScopes : DEFAULT_GATED_SCOPES;
  // 상위 소켓 이벤트가 동일 에이전트/파일을 두 번 흘려보내도 chips 라벨이 중복 노출되지
  // 않도록 첫 등장 순서를 보존하며 dedup 한다. 빈 문자열은 식별자 가치가 없어 함께 제거.
  const dedupedBusyAgentNames = busyAgentNames
    ? Array.from(new Set(busyAgentNames.filter((n) => n && n.length > 0)))
    : undefined;
  const dedupedMissingFileNames = missingFileNames
    ? Array.from(new Set(missingFileNames.filter((n) => n && n.length > 0)))
    : undefined;
  return (
    <div
      className="empty-project-placeholder"
      role="status"
      aria-live="polite"
    >
      <div className="empty-project-placeholder__card">
        <div className="empty-project-placeholder__icon" aria-hidden>
          <Briefcase size={40} strokeWidth={1.5} />
        </div>
        <p className="empty-project-placeholder__eyebrow">Workspace</p>
        <h2 className="empty-project-placeholder__title">프로젝트를 선택하세요</h2>
        <p className="empty-project-placeholder__body">
          에이전트와 코드그래프는 프로젝트 단위로 움직입니다.
          <br />
          기존 프로젝트를 열거나 새 프로젝트를 시작해 워크스페이스를 활성화하세요.
        </p>

        <div className="empty-project-placeholder__actions">
          <button
            type="button"
            onClick={onOpenProjectList}
            className="empty-project-placeholder__cta empty-project-placeholder__cta--primary"
            disabled={!hasProjects}
            aria-disabled={!hasProjects}
            title={hasProjects ? '프로젝트 목록 열기' : '아직 프로젝트가 없습니다. 새 프로젝트를 시작해 보세요.'}
          >
            <FolderOpen size={16} />
            <span>프로젝트 목록 열기</span>
          </button>
          <button
            type="button"
            onClick={onCreateProject}
            className="empty-project-placeholder__cta empty-project-placeholder__cta--secondary"
          >
            <Plus size={16} />
            <span>새 프로젝트 시작</span>
          </button>
        </div>

        <p className="empty-project-placeholder__meta">
          <span className="empty-project-placeholder__meta-dot" aria-hidden />
          등록된 프로젝트 {projectCount}개
        </p>

        <div
          className="empty-project-placeholder__scopes"
          role="list"
          aria-label="프로젝트 선택 전까지 비활성화된 메뉴"
          title="server 는 projectId 별로 이 메뉴들의 상태를 분리 저장합니다. 선택된 프로젝트가 없으면 API 가 payload 를 내려주지 않습니다."
        >
          {scopes.map((label) => (
            <span key={label} className="empty-project-placeholder__scope-badge" role="listitem">
              {label}
            </span>
          ))}
        </div>

        {(
          (typeof busyAgentCount === 'number' && busyAgentCount > 0) ||
          (typeof pendingAgentCount === 'number' && pendingAgentCount > 0) ||
          (typeof erroredAgentCount === 'number' && erroredAgentCount > 0) ||
          (typeof staleRestoredAgentCount === 'number' && staleRestoredAgentCount > 0) ||
          (typeof missingFileCount === 'number' && missingFileCount > 0)
        ) && (
          /* 에이전트/그래프 상태 요약 패널.
           * 4-상태(error → missing-file → working → pending) 배지를 주목도 우선순위로
           * 정렬해 한 줄에 함께 배치한다. 개수가 0 인 상태는 렌더하지 않으며,
           * 한 종류만 있을 때도 줄바꿈 없이 컴팩트하게 보이도록 flex-wrap + gap:8px
           * 레이아웃을 쓴다. missing-file 은 그래프 쪽 진단이라 agent 이름 칩과
           * 별개 행(.empty-project-placeholder__status-names--graph)으로 분리한다. */
          <div
            className="empty-project-placeholder__status-panel"
            aria-label="에이전트·코드그래프 상태 요약"
          >
            {typeof erroredAgentCount === 'number' && erroredAgentCount > 0 && (
              <AgentStatusBadge state="error" count={erroredAgentCount} />
            )}
            {typeof missingFileCount === 'number' && missingFileCount > 0 && (
              <AgentStatusBadge state="missing-file" count={missingFileCount} />
            )}
            {typeof busyAgentCount === 'number' && busyAgentCount > 0 && (
              <AgentStatusBadge state="working" count={busyAgentCount} />
            )}
            {typeof pendingAgentCount === 'number' && pendingAgentCount > 0 && (
              <AgentStatusBadge state="pending" count={pendingAgentCount} />
            )}
            {typeof staleRestoredAgentCount === 'number' && staleRestoredAgentCount > 0 && (
              <AgentStatusBadge state="stale-restored" count={staleRestoredAgentCount} />
            )}
            {dedupedBusyAgentNames && dedupedBusyAgentNames.length > 0 && (
              /* 카운트만으로는 어떤 개체가 stuck 인지 특정이 어려워, 배지 우측에
               * 최대 3개까지 칩으로 병기하고 나머지는 '+N' 처리한다. */
              <span className="empty-project-placeholder__status-names" title="stuck 가능성 있는 에이전트 이름">
                {dedupedBusyAgentNames.slice(0, 3).join(', ')}
                {dedupedBusyAgentNames.length > 3 && ` +${dedupedBusyAgentNames.length - 3}`}
              </span>
            )}
            {dedupedMissingFileNames && dedupedMissingFileNames.length > 0 && (
              <span
                className="empty-project-placeholder__status-names empty-project-placeholder__status-names--graph"
                title="코드그래프에서 참조만 남고 실체가 사라진 파일"
              >
                {dedupedMissingFileNames.slice(0, 3).join(', ')}
                {dedupedMissingFileNames.length > 3 && ` +${dedupedMissingFileNames.length - 3}`}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 프로젝트 목록 로드 중(= 아직 projectCount 를 알기 전) 잠깐 노출하는 스켈레톤.
 * 디자인 가이드 (2026-04-18 디자이너 개정):
 *   - 레이아웃: 실제 EmptyProjectPlaceholder 카드와 동일한 520px 폭/40px 패딩 유지
 *     하여 로딩 → 실데이터 전환 시 레이아웃 시프트(CLS)를 0 으로 만든다.
 *   - 컬러: var(--pixel-card) 베이스 위에 rgba(255,255,255,0.06~0.12) 회색 블록.
 *     shimmer 하이라이트는 rgba(0,210,255,0.18) (accent 에 alpha)로, 과한 채도를
 *     피하고 본 화면의 accent 와 같은 계열을 유지한다.
 *   - 간격: 아이콘(72px) → 타이틀(18px) → 본문라인 2줄(12px) → 버튼 2개(12px gap)
 *     → 메타 1줄 순서. 수직 간격은 본 카드와 1:1. gap 축소 금지.
 *   - 애니메이션: shimmer 1.4s linear infinite, 좌→우 스윕. 카드 fade-in 220ms.
 *     prefers-reduced-motion: reduce 시 shimmer 와 fade-in 모두 중단하고
 *     단색 회색 블록만 표시한다(깜빡임 유발 방지).
 */
// 디자이너 가이드(index.css L640 주석)가 권고하는 150~200ms 디바운스 기본값.
// state:initial 소켓 이벤트가 평균 80~260ms 안에 도착하므로, 이 창 안에서
// 종료되는 빠른 경로는 스켈레톤을 아예 마운트하지 않아 1프레임 플래시를 막는다.
const SKELETON_DEFAULT_DELAY_MS = 160;

interface EmptyProjectPlaceholderSkeletonProps {
  // 테스트/스토리북에서 즉시 노출이 필요할 때만 0 으로 내린다.
  delayMs?: number;
}

export function EmptyProjectPlaceholderSkeleton({ delayMs = SKELETON_DEFAULT_DELAY_MS }: EmptyProjectPlaceholderSkeletonProps = {}) {
  // delayMs <= 0 이면 즉시 노출(SSR/테스트 경로). 그 외에는 타이머가 끝날 때까지
  // null 을 반환해 초기 마운트 직후의 깜빡임을 제거한다.
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) { setVisible(true); return; }
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  if (!visible) return null;
  return (
    <div
      className="empty-project-placeholder"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="프로젝트 목록을 불러오는 중"
    >
      <div className="empty-project-placeholder__card empty-project-placeholder__card--skeleton">
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--icon" aria-hidden />
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--eyebrow" aria-hidden />
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--title" aria-hidden />
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--body" aria-hidden />
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--body empty-project-placeholder__skeleton-block--body-short" aria-hidden />
        <div className="empty-project-placeholder__skeleton-actions" aria-hidden>
          <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--cta" />
          <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--cta" />
        </div>
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--meta" aria-hidden />
      </div>
    </div>
  );
}

/** 코드그래프 뷰 전용 "참조는 남았는데 실체 노드가 없는 파일" 경고 배너.
 * 프로젝트가 선택된 뒤 그래프가 그려지는 상황에서도 누락 참조는 남을 수 있어
 * 빈-상태 플레이스홀더와는 다른 컨텍스트가 필요하다. 다만 톤 드리프트를 막기
 * 위해 --pixel-text(#e94560) / --pixel-accent 팔레트를 그대로 재사용하고,
 * .agent-status-badge[data-state="missing-file"] 와 같은 선을 공유한다.
 *
 * 레이아웃: flex-row, 좌측 AlertTriangle 아이콘(16px) + 카피 + 우측 CTA.
 *   너비는 부모 기준 100% 이지만 max-width 640px 로 상한. 모바일에서는
 *   버튼이 줄바꿈되며 전체 너비를 차지한다.
 * 접근성: role="alert" 로 스크린리더에 즉시 고지. CTA 는 onReconcile 이
 *   주어졌을 때만 렌더해 무의미한 버튼을 노출하지 않는다.
 */
interface CodeGraphMissingFilesBannerProps {
  missingCount: number;
  missingNames?: string[];
  onReconcile?: () => void;
  // 누락 원인 단서. 'auto-trigger' 는 server.ts 파일 편집 핸들러가 add_file 자동
  // 호출을 놓친 경우(코드그래프 필터 제외 경로가 아님에도 노드 생성 실패),
  // 'scope-race' 는 프로젝트 스코프 전환 중 files 가 비워진 뒤 참조만 남은 경우,
  // 'dependency-drift' 는 task completion 훅의 updateCodeGraphOnFileEdit 이 경로·
  // 의존성 변경을 감지했음에도 add_dependency 호출을 흘려보낸 경우.
  // 제공되면 본문 끝에 "의심 원인" 한 줄이 덧붙어 진단 동선을 단축한다.
  suspectedCause?: 'auto-trigger' | 'scope-race' | 'dependency-drift';
}

const CODE_GRAPH_MISSING_CAUSE_HINT: Record<NonNullable<CodeGraphMissingFilesBannerProps['suspectedCause']>, string> = {
  'auto-trigger': 'server 파일 편집 핸들러의 add_file 자동 호출이 누락됐을 가능성이 높습니다. codeGraphFilter.isExcludedFromCodeGraph 경로와 핸들러 트리거 연결을 먼저 확인하세요.',
  'scope-race': '프로젝트 스코프 전환 중 files 가 비워진 뒤 참조만 남은 경우입니다. selectedProjectId 전환 타이밍과 state:initial 재조회를 점검하세요.',
  'dependency-drift': 'task completion 훅의 updateCodeGraphOnFileEdit 이 경로·의존성 변경을 감지했지만 add_dependency 호출이 누락된 경우입니다. server.ts 의 완료 워크플로우에서 엣지 동기화 분기를 먼저 점검하세요.',
};

export function CodeGraphMissingFilesBanner({ missingCount, missingNames, onReconcile, suspectedCause }: CodeGraphMissingFilesBannerProps) {
  if (missingCount <= 0) return null;
  const preview = (missingNames ?? []).slice(0, 3).join(', ');
  const overflow = (missingNames?.length ?? 0) > 3 ? ` +${(missingNames!.length - 3)}` : '';
  return (
    <div className="code-graph-missing-banner" role="alert" aria-live="assertive">
      <AlertTriangle size={16} strokeWidth={2} aria-hidden />
      <div className="code-graph-missing-banner__body">
        <p className="code-graph-missing-banner__title">
          코드그래프 참조 유실 {missingCount}건
        </p>
        <p className="code-graph-missing-banner__desc">
          참조만 남고 실체 노드가 사라진 파일입니다. add_file 호출 누락 또는 프로젝트 스코프 전환 경쟁을 점검하세요.
          {preview && (
            <>
              {' '}
              <span
                className="code-graph-missing-banner__names"
                title="참조만 남고 실체 노드가 사라진 파일"
              >{`${preview}${overflow}`}</span>
            </>
          )}
        </p>
        {suspectedCause && (
          <p
            className="code-graph-missing-banner__cause"
            data-cause={suspectedCause}
            title="자동 추정된 원인 단서. 확정이 아니므로 재조정 후에도 재발하면 반대 원인을 점검하세요."
          >
            의심 원인 · {CODE_GRAPH_MISSING_CAUSE_HINT[suspectedCause]}
          </p>
        )}
      </div>
      {onReconcile && (
        <button
          type="button"
          className="code-graph-missing-banner__cta"
          onClick={onReconcile}
          title="참조 ID 를 현재 files 목록과 재조정"
        >
          재조정
        </button>
      )}
    </div>
  );
}

/** 코드그래프에 파일 노드가 0 인 "진짜 빈 그래프" 상태 안내.
 * missing-file 배너(참조는 있으나 실체 없음) 와는 원인이 다르다: 여긴 아직
 * add_file 이 한 번도 호출되지 않았거나, 프로젝트 스코프 전환 직후 files 가
 * 비어 있는 정상 상태다. 경고(alert) 가 아닌 안내(status) 톤으로 accent 팔레트를
 * 사용하고, CTA 는 호출부가 "새 파일 추가" 동선을 넘길 수 있도록 선택적이다.
 */
interface CodeGraphEmptyStateProps {
  onAddFile?: () => void;
  title?: string;
  description?: string;
}

export function CodeGraphEmptyState({
  onAddFile,
  title = '코드그래프가 비어 있습니다',
  description = 'add_file 로 첫 파일 노드를 추가하면 의존성 그래프가 생성됩니다.',
}: CodeGraphEmptyStateProps) {
  return (
    <div className="code-graph-empty-state" role="status" aria-live="polite">
      <p className="code-graph-empty-state__title">{title}</p>
      <p className="code-graph-empty-state__desc">{description}</p>
      {onAddFile && (
        <button
          type="button"
          className="empty-project-placeholder__cta empty-project-placeholder__cta--secondary"
          onClick={onAddFile}
        >
          <Plus size={14} />
          <span>첫 파일 추가</span>
        </button>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Git 자동화 패널 저장/로딩 상태 UI 시안 (2026-04-18 디자이너)
 * ────────────────────────────────────────────────────────────────────────────
 * Git 자동화 패널은 flow 라디오, 브랜치 패턴, 커밋/PR 템플릿, 토글(enabled) 다섯
 * 종류의 입력이 한 화면에서 바뀌고, 저장 성공/실패가 **사용자 의도(어디까지 자동
 * 실행되는지)** 와 직결된다. 따라서 저장 상태 UX 는 아래 4개의 배치-레이어로
 * 역할을 분리한다.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ [PanelSkeleton]  초기 settings fetch 중(카드 자리만 예약)       │
 *   │ [DirtyIndicator] 입력 직후 ~ 디바운스 창(400ms) 대기 중          │
 *   │ [SaveIndicator]  디바운스 통과 후 실제 저장 in-flight (헤더 인라인)│
 *   │ [SaveToast]      저장 성공 → 상단 우측 1.6s 자동 페이드 아웃     │
 *   │ [ErrorBanner]    저장 실패(네트워크/검증) → 상단 sticky, 수동 닫기│
 *   └────────────────────────────────────────────────────────────────┘
 *
 * 상태 기계(상태 값은 useGitAutomationSaveState 훅이 단일 진원으로 관리):
 *   idle ─(onChange)→ dirty ─(debounce 경과)→ saving ─success→ saved ─(1.6s)→ idle
 *                                                   └error→ error ─retry→ saving
 *
 * 공통 톤: 에이전트 상태 배지(.agent-status-badge)·missing-banner 와 같은
 *   --pixel-accent(저장 성공·진행)/ --pixel-text(magenta, 오류) 팔레트를 재사용
 *   해 화면 전체 톤 드리프트를 막는다. 아이콘은 패널 본문과 통일성을 위해
 *   lucide-react 만 사용(Loader2/CheckCircle2/XCircle).
 * 접근성: 진행/성공은 role="status" + aria-live="polite", 실패는 role="alert" +
 *   aria-live="assertive". prefers-reduced-motion 에서는 spinner 회전·toast
 *   slide-in 을 제거하고 opacity 만 전환한다.
 */

/** 저장 예약(dirty) 인디케이터.
 * 배치: Git 자동화 패널 헤더(타이틀 우측), SaveIndicator 와 동일 슬롯에서
 *   상호 배타적으로 노출된다. 입력이 발생한 직후부터 디바운스 창(기본 400ms)
 *   이 끝나기 전까지만 표시되며, saving 으로 전환되면 즉시 언마운트된다.
 * 목적: "지금 타이핑한 값이 실제로 서버에 도달하기까지 아직 시간이 있다"는
 *   사실을 약한 톤으로 고지해, 사용자가 빠르게 창을 닫거나 탭 이동을 하기
 *   전에 저장 예약 상태를 인지할 수 있게 한다. SaveIndicator(accent) 보다
 *   한 단계 낮은 채도(--pixel-border 톤)로 "아직 진행 아님" 을 구분한다.
 * 모양: Clock(12px) + "저장 예약됨" + 옵션 countdownMs 칩("0.3s"). 높이 24px.
 *   시계 아이콘은 회전하지 않고, 대신 초침처럼 0.6s 주기로 점 1개가 진해진다
 *   (.git-automation-dirty-indicator__pulse). reduce-motion 에서는 정적 상태.
 * 톤: 테두리 --pixel-border(은은), 글자 --pixel-white at 72% alpha. 저장 진행
 *   시의 accent 와 색상 계층 차이가 분명해 "지금 저장 중" 과 혼동되지 않는다.
 */
interface GitAutomationDirtyIndicatorProps {
  // 디바운스 종료까지 남은 밀리초. 주어지면 보조 칩으로 노출(소수 1자리 s).
  // 훅이 rAF/setInterval 로 업데이트해 넘긴다. 생략 시 카운트다운 생략.
  countdownMs?: number;
}

export function GitAutomationDirtyIndicator({ countdownMs }: GitAutomationDirtyIndicatorProps = {}) {
  const countdownLabel = typeof countdownMs === 'number' && countdownMs > 0
    ? `${(countdownMs / 1000).toFixed(1)}s`
    : null;
  return (
    <span
      className="git-automation-dirty-indicator"
      role="status"
      aria-live="polite"
      aria-label={countdownLabel ? `저장 예약됨, ${countdownLabel} 뒤 전송` : '저장 예약됨'}
      title="입력이 감지되어 저장이 예약되었습니다. 디바운스 창이 끝나면 서버로 전송됩니다."
    >
      <Clock size={12} strokeWidth={2} aria-hidden />
      <span className="git-automation-dirty-indicator__pulse" aria-hidden />
      <span className="git-automation-dirty-indicator__label">저장 예약됨</span>
      {countdownLabel && (
        <span className="git-automation-dirty-indicator__countdown">{countdownLabel}</span>
      )}
    </span>
  );
}

/** 저장 진행 인디케이터.
 * 배치: Git 자동화 패널 헤더(타이틀 우측) 인라인. 토스트처럼 화면을 가리지 않고
 *   "지금 저장이 돌고 있다"는 사실만 조용히 알린다. 디바운스(기본 400ms) 가 끝난
 *   직후부터 응답 수신 전까지 노출된다.
 * 모양: 점(spinner Loader2 12px) + "저장 중" 라벨 + 옵션 step 칩("검증→전송").
 *   높이 24px, 가로 max-content, accent 테두리 1px. 스피너는 1.2s 회전.
 * 톤: accent(--pixel-accent) 글자/테두리 + transparent 배경. enabled 패널 본문과
 *   자연스럽게 녹아들어 "사용자 입력을 가로채지 않음" 을 시각적으로 약속한다.
 */
interface GitAutomationSaveIndicatorProps {
  // 저장 단계 칩. "검증 중"/"전송 중" 같은 2-phase 를 노출하고 싶을 때만 사용.
  step?: string;
}

export function GitAutomationSaveIndicator({ step }: GitAutomationSaveIndicatorProps = {}) {
  return (
    <span
      className="git-automation-save-indicator"
      role="status"
      aria-live="polite"
      aria-label={step ? `저장 중: ${step}` : '저장 중'}
      title="입력이 디바운스 창을 통과해 서버로 전송 중입니다."
    >
      <Loader2 size={12} strokeWidth={2.25} className="git-automation-save-indicator__spinner" aria-hidden />
      <span className="git-automation-save-indicator__label">저장 중</span>
      {step && <span className="git-automation-save-indicator__step">{step}</span>}
    </span>
  );
}

/** 저장 완료 토스트.
 * 배치: 패널 우상단(top:12px right:12px) absolute. 입력 영역을 덮지 않도록
 *   translateY(-4px) → 0 으로 슬라이드-페이드 인(180ms), 1.6s 유지 후 페이드
 *   아웃(220ms). onDismiss 가 주어지면 수동 X 버튼을 함께 노출한다.
 * 모양: 좌측 CheckCircle2(14px, emerald) + "저장됨 · {relativeTime}". 높이 28px,
 *   라운드 코너(2px, 픽셀 톤 유지). 토스트라도 게임 UI 톤 유지를 위해 shadow 는
 *   0 0 0 1px rgba(0,210,255,0.25) 의 accent 오라만 사용한다.
 * 접근성: role="status", aria-live="polite". reduce-motion 에서는 opacity 만
 *   전환하고 slide 효과를 제거한다.
 */
interface GitAutomationSaveToastProps {
  // 마지막 저장 시각(ISO). formatRelativeTime 호환 포맷. 생략 시 "저장됨" 만.
  savedAt?: string | null;
  // 자동 해제 타이머 밀리초. 0 이면 수동 해제만 허용.
  autoDismissMs?: number;
  onDismiss?: () => void;
}

export function GitAutomationSaveToast({ savedAt, autoDismissMs = 1600, onDismiss }: GitAutomationSaveToastProps) {
  // onDismiss 를 ref 로 고정해 부모의 리렌더(=새 함수 identity)가 매번 setTimeout 을
  // 재설정해 토스트가 영원히 자동 해제되지 않는 회귀를 막는다. 타이머는 savedAt 이
  // 실제로 바뀔 때만 재시작되며, 최신 onDismiss 를 호출한다.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    if (autoDismissMs <= 0) return;
    // StrictMode dev 이중 마운트에서 clearTimeout 만으로는 보장되지만, 일부 환경(예:
    // 테스트 fake timer + flush) 에서 콜백이 큐에서 살아남는 회귀를 본 적이 있어
    // cancelled 플래그로 onDismiss 호출 자체를 명시적으로 차단한다.
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      onDismissRef.current?.();
    }, autoDismissMs);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [autoDismissMs, savedAt]);
  return (
    <div
      className="git-automation-save-toast"
      role="status"
      aria-live="polite"
      title={savedAt ? `마지막 저장: ${savedAt}` : '저장됨'}
    >
      <CheckCircle2 size={14} strokeWidth={2} aria-hidden />
      <span className="git-automation-save-toast__label">저장됨</span>
      {onDismiss && (
        <button
          type="button"
          className="git-automation-save-toast__close"
          onClick={onDismiss}
          aria-label="저장 알림 닫기"
        >
          ×
        </button>
      )}
    </div>
  );
}

/** 패널 로딩 스켈레톤.
 * 배치: Git 자동화 패널 settings fetch 중(초기 마운트 및 프로젝트 스코프 전환
 *   직후) 실제 패널 자리를 그대로 예약한다. EmptyProjectPlaceholderSkeleton 과
 *   동일하게 delayMs 디바운스(기본 160ms)로 1프레임 플래시를 차단한다.
 * 레이아웃: 3단계 flow 라디오 자리(1행) → 브랜치/커밋/PR 3줄 입력 자리 → 토글 +
 *   CTA 2개 자리. 높이는 실제 패널과 동일해 로딩 → 실데이터 CLS 0.
 * 컬러: --pixel-card 위 rgba(255,255,255,0.06~0.12) 블록 + accent shimmer
 *   (rgba(0,210,255,0.18)). empty-project-placeholder__skeleton-block 규칙을
 *   재사용한다.
 */
interface GitAutomationPanelSkeletonProps {
  delayMs?: number;
}

export function GitAutomationPanelSkeleton({ delayMs = SKELETON_DEFAULT_DELAY_MS }: GitAutomationPanelSkeletonProps = {}) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) { setVisible(true); return; }
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  if (!visible) return null;
  return (
    <div
      className="git-automation-panel-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Git 자동화 설정을 불러오는 중"
    >
      <div className="git-automation-panel-skeleton__header">
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--title" aria-hidden />
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--meta" aria-hidden />
      </div>
      <div className="git-automation-panel-skeleton__flow" aria-hidden>
        <div className="empty-project-placeholder__skeleton-block git-automation-panel-skeleton__flow-pill" />
        <div className="empty-project-placeholder__skeleton-block git-automation-panel-skeleton__flow-pill" />
        <div className="empty-project-placeholder__skeleton-block git-automation-panel-skeleton__flow-pill" />
      </div>
      <div className="git-automation-panel-skeleton__fields" aria-hidden>
        <div className="empty-project-placeholder__skeleton-block git-automation-panel-skeleton__field" />
        <div className="empty-project-placeholder__skeleton-block git-automation-panel-skeleton__field" />
        <div className="empty-project-placeholder__skeleton-block git-automation-panel-skeleton__field" />
      </div>
      <div className="git-automation-panel-skeleton__actions" aria-hidden>
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--cta" />
        <div className="empty-project-placeholder__skeleton-block empty-project-placeholder__skeleton-block--cta" />
      </div>
    </div>
  );
}

/** 저장 실패 배너.
 * 배치: 패널 상단 sticky(스크롤해도 상단 고정). 토스트와 달리 자동 dismiss 하지
 *   않으며, 원인/재시도 동선을 본문에 함께 실어 사용자가 조치 없이 지나치지
 *   않도록 한다. missing-banner 와 라인을 공유해 톤 일관성 확보.
 * 모양: 좌측 XCircle(16px, --pixel-text magenta) + 타이틀 + 본문 + 우측 CTA
 *   ("재시도" / 옵션 "자세히 보기"). width 100% 내 max-width:640px.
 * 접근성: role="alert" + aria-live="assertive". 사용자가 즉시 인지해야 하는
 *   상태이며, 포커스 트랩은 걸지 않는다(입력 흐름을 끊지 않기 위함).
 * 카테고리:
 *   - validation: 브랜치 패턴/템플릿 placeholder 검증 실패. 재시도 버튼 숨김,
 *       "필드 확인" CTA 로 대체. 필드 에러는 각 입력 밑 helper-text 에도 반영.
 *   - network:    서버 통신 실패. 재시도 버튼 노출, 자동-재시도 카운터(최대 2회)
 *       실행 중이면 "3초 뒤 자동 재시도" 보조 문구 노출.
 *   - conflict:   409 버전 충돌. 다른 탭/동료의 저장이 선행된 경우.
 *       "최신 설정 불러오기" 주 CTA + "덮어쓰기" 보조 CTA.
 */
export type GitAutomationErrorCategory = 'validation' | 'network' | 'conflict';

interface GitAutomationErrorBannerProps {
  category: GitAutomationErrorCategory;
  message: string;
  detail?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  // network 카테고리에서 자동-재시도 카운트다운을 보조 문구로 노출.
  autoRetryInSec?: number;
}

const GIT_ERROR_TITLE: Record<GitAutomationErrorCategory, string> = {
  validation: '입력값을 확인하세요',
  network: '저장에 실패했습니다',
  conflict: '다른 위치에서 먼저 저장되었습니다',
};

export function GitAutomationErrorBanner({
  category,
  message,
  detail,
  onRetry,
  onDismiss,
  autoRetryInSec,
}: GitAutomationErrorBannerProps) {
  const retryLabel = category === 'conflict' ? '최신 설정 불러오기' : '재시도';
  return (
    <div
      className="git-automation-error-banner"
      data-category={category}
      role="alert"
      aria-live="assertive"
    >
      <XCircle size={16} strokeWidth={2} aria-hidden />
      <div className="git-automation-error-banner__body">
        <p className="git-automation-error-banner__title">{GIT_ERROR_TITLE[category]}</p>
        <p className="git-automation-error-banner__desc">
          {message}
          {detail && (
            <>
              {' '}
              <span className="git-automation-error-banner__detail" title={detail}>{detail}</span>
            </>
          )}
          {category === 'network' && typeof autoRetryInSec === 'number' && autoRetryInSec > 0 && (
            <>
              {' '}
              <span className="git-automation-error-banner__countdown" aria-live="polite">
                {autoRetryInSec}초 뒤 자동 재시도
              </span>
            </>
          )}
        </p>
      </div>
      {onRetry && category !== 'validation' && (
        <button
          type="button"
          className="git-automation-error-banner__cta"
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="git-automation-error-banner__close"
          onClick={onDismiss}
          aria-label="에러 알림 닫기"
        >
          <AlertTriangle size={12} aria-hidden style={{ display: 'none' }} />
          ×
        </button>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 프로젝트 관리 상단 "편집 중" 헤더 상태 분기 가이드 (2026-04-18 디자이너 v2)
 * ────────────────────────────────────────────────────────────────────────────
 * 현재 ProjectManagement.tsx L955~L1005 헤더는 editingLabel.hasProject 삼항
 * 분기가 Tailwind 인라인으로 길게 이어져 있어, 선택 vs 미선택 상태의 시각
 * 단서를 한눈에 읽기 어렵다. 아래 ProjectEditingHeader 컴포넌트는 같은 영역을
 * 두 상태로 완전히 분리된 모습으로 보여주는 디자인 시안이며, 연결된 CSS
 * 토큰은 index.css 의 `.pm-editing-header[data-state]` 섹션에 정의되어 있다.
 *
 * v2 개정 포인트 (2026-04-18 보강):
 *   - 좌측 4px 스트라이프(::before) 1차 앵커 신규: 선택=accent 실선, 미선택=
 *     amber 점선 패턴. 0.2초 안에 상태 식별 가능. 테두리 변화보다 색 대비가
 *     커서 원거리/좁은 영역에서도 놓치지 않는다.
 *   - 상태 전환 하이라이트(.is-transitioning): data-state 가 바뀌면 220ms
 *     동안 스트라이프가 scaleX(1.6) 으로 한 번 번쩍여 "방금 바뀌었다" 신호.
 *     컴포넌트는 useEffect 로 이전 selected 값과 비교해 토글한다. 색/크기
 *     변형이 없어 CLS 영향 0. prefers-reduced-motion 에서 정지.
 *
 * 상태별 시각 단서(5-stop 계층):
 *   선택됨(selected):
 *     - 좌측 스트라이프: 4px accent 실선 + 외곽 glow (1차 앵커)
 *     - 컨테이너: 실선 accent 테두리 + 소프트 accent glow(외곽 링)
 *     - 아이콘 박스: accent fill · 검정 아이콘 (활성감)
 *     - eyebrow: "편집 중" · 좌측 emerald 펄스 도트(agent-status-dot 재사용)
 *     - 타이틀: accent 색상 · 가중 700 · 은은한 글로우
 *   미선택(unselected):
 *     - 좌측 스트라이프: 4px amber 점선 패턴 (1차 앵커, 정적)
 *     - 컨테이너: 점선 테두리 · 반투명 검정 배경(0.28 alpha) · glow 없음
 *     - 아이콘 박스: 검정 fill · 반투명 흰 아이콘 (비활성)
 *     - eyebrow: "프로젝트 미선택" · amber 정적 도트(경고이나 깜빡임 금지)
 *     - 타이틀: italic 반투명 플레이스홀더 문구 + 우측 amber CTA 칩
 *
 * 톤 일관성:
 *   - emerald / accent / amber 색은 기존 .agent-status-dot, .git-auto-summary,
 *     .agent-status-badge 와 동일한 값이라 패널 간 드리프트가 생기지 않는다.
 *   - 미선택 CTA 는 .agent-status-badge[data-state="error"] 보다 한 단계
 *     낮은 채도로 "경고 아님 · 조치 가능" 을 구분한다(오남용 방지).
 *   - 좌측 amber 점선 스트라이프는 .pm-editing-header__eyebrow-dot 과 같은
 *     #fbbf24 계열이라 미선택 상태가 이중으로 묶여 보인다(도트 + 스트라이프).
 *
 * 접근성:
 *   - 선택/미선택 모두 <header aria-label="현재 편집 중인 프로젝트">.
 *   - 미선택 상태는 role="status" + aria-live="polite" 로 스크린리더에
 *     "프로젝트가 선택되지 않았습니다" 를 고지한다.
 *   - prefers-reduced-motion: reduce → emerald 펄스 / 전환 플래시 정지.
 */
interface ProjectEditingHeaderProps {
  // 선택된 프로젝트의 표시명(예: "org/repo"). 미선택이면 null/undefined.
  projectName?: string | null;
  // 우측 브랜치/스코프 뱃지 등 상세 메타. 선택 상태에서만 렌더 권장.
  meta?: React.ReactNode;
  // 미선택 상태에서 노출할 "프로젝트 선택" CTA. 누르면 선택 UI 를 연다.
  onPickProject?: () => void;
  // 플레이스홀더 타이틀 문구 커스터마이즈(기본: "프로젝트를 선택하세요").
  placeholder?: string;
}

export function ProjectEditingHeader({
  projectName,
  meta,
  onPickProject,
  placeholder = '프로젝트를 선택하세요',
}: ProjectEditingHeaderProps) {
  const selected = typeof projectName === 'string' && projectName.length > 0;
  // 상태가 바뀐 직후 220ms 동안 .is-transitioning 을 붙여 좌측 스트라이프가
  // 한 번 번쩍이게 한다. 초기 마운트에는 플래시를 주지 않아 재진입 시
  // 불필요한 주의 환기를 피한다.
  const [flashing, setFlashing] = useState(false);
  const prevSelectedRef = React.useRef(selected);
  useEffect(() => {
    if (prevSelectedRef.current === selected) return;
    prevSelectedRef.current = selected;
    setFlashing(true);
    const id = window.setTimeout(() => setFlashing(false), 220);
    return () => window.clearTimeout(id);
  }, [selected]);
  return (
    <header
      className={`pm-editing-header${flashing ? ' is-transitioning' : ''}`}
      data-state={selected ? 'selected' : 'unselected'}
      aria-label="현재 편집 중인 프로젝트"
      role={selected ? undefined : 'status'}
      aria-live={selected ? undefined : 'polite'}
    >
      <div className="pm-editing-header__lead">
        <span className="pm-editing-header__icon" aria-hidden>
          <FolderGit2 size={16} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p className="pm-editing-header__eyebrow">
            <span className="pm-editing-header__eyebrow-dot" aria-hidden />
            {selected ? '편집 중' : '프로젝트 미선택'}
          </p>
          <h1 className="pm-editing-header__title" title={selected ? projectName! : undefined}>
            {selected ? projectName : placeholder}
          </h1>
        </div>
      </div>
      {selected && meta}
      {!selected && onPickProject && (
        <button
          type="button"
          className="pm-editing-header__cta"
          onClick={onPickProject}
          aria-label="프로젝트를 선택해 스코프를 고정합니다"
        >
          <FolderOpen size={12} />
          <span>프로젝트 선택</span>
        </button>
      )}
    </header>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 코드그래프 누락 파일 노드 하이라이트 (2026-04-18 디자이너 시안)
 * ────────────────────────────────────────────────────────────────────────────
 * 사용처: ProjectManagement.tsx 코드그래프 뷰에서 workingOnFileId /
 *   add_dependency 가 가리키는 ID 가 현재 files 목록에 없는 "좀비 노드" 를
 *   개별 위치에 시각적으로 표시한다. 기존 CodeGraphMissingFilesBanner 는
 *   상단 요약용(총 N건)이고, 이 하이라이트는 그래프 캔버스 위 개별 노드를
 *   즉시 지목하는 1:1 피커다.
 *
 * 디자인 의도:
 *   - 1차 앵커: 마젠타(--pixel-text) dashed 2px 테두리 + 외곽 glow 로
 *     "참조만 있고 실체 없음" 을 한눈에 구분. banner / agent-status-badge
 *     missing-file 과 같은 #e94560 계열이라 화면 전체 톤이 일관된다.
 *   - 2차 앵커: 우상단 코너에 AlertTriangle 10px 뱃지(사각 pip)를 띄워
 *     dashed 테두리를 놓친 경우에도 경고 심볼로 재인지시킨다.
 *   - 애니메이션: 1.6s 느린 pulse(slow blink)로 error(amber, 1.1s) 보다
 *     주목도 한 단계 낮게 두어 화면에 과한 깜빡임이 집중되지 않도록 한다.
 *     prefers-reduced-motion 에서는 pulse 와 전환 효과를 모두 정지한다.
 *
 * 레이아웃 운용:
 *   - 기본은 기존 노드 요소를 감싸는 wrapper(variant="wrapper"). 노드 자체에
 *     테두리만 얹으려면 variant="inline" 으로 render 한다(자식 없이 호출해도
 *     안전). label 이 주어지면 하단 중앙에 "참조 유실" 칩이 노출된다.
 */
/** severity 스케일: 한 프로젝트에 참조 유실 노드가 여럿 쌓일 때 조치 우선순위를
 *   시각적으로 분리한다. banner 요약(총 N건) 으로는 어느 노드를 먼저 열어봐야
 *   할지 판단하기 어려워, 개별 하이라이트 자체에 강도를 싣는다.
 *   - low     : 단발성(참조 1~2건). pulse 약하게(2.0s), 코너 pip 생략.
 *   - high    : 기본값. 1.6s slow pulse + 코너 AlertTriangle pip.
 *   - critical: 의존성 허브가 깨진 경우(이 노드로 수렴하는 엣지 ≥5).
 *               1.0s fast pulse + 외곽 magenta glow 두 겹 + "심각" 칩. */
interface CodeGraphMissingNodeHighlightProps {
  children?: React.ReactNode;
  label?: string;
  variant?: 'wrapper' | 'inline';
  title?: string;
  severity?: 'low' | 'high' | 'critical';
  // 참조 유실을 일으킨 incoming edge 수. 주어지면 코너 pip 대신 숫자 칩으로 대체해
  // "이 노드를 복구하면 몇 개 엣지가 다시 살아나는가" 를 즉시 보여준다.
  referenceCount?: number;
  // 클릭/Enter 시 해당 노드의 진단 동선(재조정 / 상세 보기) 을 여는 핸들러.
  // 제공되면 wrapper 에 role="button" tabindex=0 을 달아 키보드 포커스가 가능하게 한다.
  onActivate?: () => void;
}

export function CodeGraphMissingNodeHighlight({
  children,
  label = '참조 유실',
  variant = 'wrapper',
  title,
  severity = 'high',
  referenceCount,
  onActivate,
}: CodeGraphMissingNodeHighlightProps) {
  const interactive = typeof onActivate === 'function';
  const effectiveLabel = severity === 'critical' ? `${label} · 심각` : label;
  const countChip = typeof referenceCount === 'number' && referenceCount > 0
    ? referenceCount > 99 ? '99+' : String(referenceCount)
    : null;
  return (
    <div
      className="code-graph-missing-node"
      data-variant={variant}
      data-severity={severity}
      data-interactive={interactive ? 'true' : undefined}
      role={interactive ? 'button' : 'img'}
      tabIndex={interactive ? 0 : undefined}
      aria-label={title ?? '코드그래프 참조 유실 노드'}
      title={title ?? '참조만 남고 실체 노드가 사라진 파일입니다. add_file 누락 또는 프로젝트 스코프 전환 경쟁을 점검하세요.'}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={interactive ? (event) => {
        // Enter/Space 모두 접근. Space 는 스크롤 방지를 위해 preventDefault.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate?.();
        }
      } : undefined}
    >
      {children}
      <span className="code-graph-missing-node__corner" aria-hidden>
        {countChip ? (
          <span className="code-graph-missing-node__corner-count">{countChip}</span>
        ) : (
          <AlertTriangle size={10} strokeWidth={2.25} />
        )}
      </span>
      {label && (
        <span className="code-graph-missing-node__label" aria-hidden>{effectiveLabel}</span>
      )}
    </div>
  );
}
