/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * QA/UX: 로그 패널 탭 전환 (#LOG-PANEL-TABS).
 *
 * 기존 App.tsx 는 리더 지시 입력 + 로그 목록을 세로로 나란히 쌓아 두어 지시 창을
 * 넓게 쓸수록 로그가 시야에서 밀려나는 문제가 있었다. 탭 UX 로 전환하면 한 번에
 * 한 영역을 전면 노출할 수 있지만, 아래 불변식이 무너지면 사용자의 작업 컨텍스트가
 * 조용히 휘발한다 — 이 컴포넌트가 보장한다.
 *
 *   (a) 초기 진입 시 '지시' 탭이 기본 활성. localStorage 값이 있으면 이를 우선 복원.
 *   (b) '로그' 탭으로 전환하면 unseenLogCount 가 0 으로 리셋된다 (사용자가 봤다는 의미).
 *   (c) '지시' 탭에 머무는 동안 새 로그가 들어와도, 지시 패널은 언마운트되지 않고
 *       draft/첨부 상태는 그대로 유지된다. 동시에 '로그' 탭 배지는 증가한다.
 *   (d) ←/→ 키로 탭 전환이 가능하다 (roving tabindex 로 Tab 키는 패널 내부로 이동).
 *   (e) 리사이즈 핸들은 어느 탭에서도 동일하게 동작한다 (공용 헤더에 위치).
 *
 * 구현 주석: 두 탭 패널은 모두 마운트 상태를 유지하고 `hidden` 속성으로만 가린다.
 * 언마운트 → 재마운트 구조였다면 지시 textarea 의 로컬 커서 위치와 DirectivePrompt
 * 내부의 드래그 깊이 카운터가 매 탭 전환마다 리셋되어 (c) 불변식이 무너졌을 것이다.
 */

import React, { useEffect, useRef, useState } from 'react';

export type LogPanelTabKey = 'directive' | 'logs';

/** localStorage 기본 키. 테스트/스토리북에서는 storageKey props 로 오버라이드. */
export const LOG_PANEL_TAB_KEY = 'llm-tycoon:log-panel-tab';

/**
 * SSR·localStorage 미지원 환경에서는 null 을 반환해 호출부가 기본값으로 폴백할 수 있게 한다.
 * JSON 파싱이 아니라 enum 매칭이므로 try/catch 는 접근 거부(SecurityError) 대응만 한다.
 */
export function readStoredLogPanelTab(
  win: { localStorage: Pick<Storage, 'getItem'> } | undefined,
  storageKey: string = LOG_PANEL_TAB_KEY,
): LogPanelTabKey | null {
  if (!win) return null;
  try {
    const raw = win.localStorage.getItem(storageKey);
    return raw === 'directive' || raw === 'logs' ? raw : null;
  } catch {
    return null;
  }
}

export interface LogPanelTabsProps {
  /** '지시' 탭 내용. DirectivePrompt 등을 그대로 주입. */
  directive: React.ReactNode;
  /** '로그' 탭 내용. 로그 리스트/필터 등을 주입. */
  logs: React.ReactNode;
  /**
   * 로그 총 개수. 이 값이 증가할 때 활성 탭이 'logs' 가 아니면 unseen 배지가 증가한다.
   * 부모가 logs.length 같은 파생값을 그대로 넘겨 주면 된다.
   */
  logCount: number;
  /** 리사이즈 핸들 mousedown. 부모가 상위 패널 높이를 바꾸는 드래그 훅. */
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  storageKey?: string;
  /** localStorage 가 비어있을 때의 기본 탭. 기본값 'directive'. */
  initialTab?: LogPanelTabKey;
  /** 테스트 훅: 탭이 바뀔 때마다 호출. 프로덕션 코드는 필요 없음. */
  onActiveTabChange?: (tab: LogPanelTabKey) => void;
}

export function LogPanelTabs(props: LogPanelTabsProps) {
  const storageKey = props.storageKey ?? LOG_PANEL_TAB_KEY;
  const [activeTab, setActiveTab] = useState<LogPanelTabKey>(() => {
    const stored =
      typeof window !== 'undefined'
        ? readStoredLogPanelTab(window, storageKey)
        : null;
    return stored ?? props.initialTab ?? 'directive';
  });
  const [unseenLogCount, setUnseenLogCount] = useState(0);
  const lastLogCountRef = useRef<number>(props.logCount);

  // activeTab 지속성: 변경마다 localStorage 에 저장. 테스트 훅도 여기서 호출해
  // 두 부수효과가 동일한 렌더 사이클에서 발사되도록 한다.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(storageKey, activeTab); }
      catch { /* 쿼터 초과 등은 무시 */ }
    }
    props.onActiveTabChange?.(activeTab);
  }, [activeTab, storageKey]);

  // 새 로그 유입 → 활성 탭이 logs 가 아니면 unseen 누적.
  useEffect(() => {
    const diff = props.logCount - lastLogCountRef.current;
    lastLogCountRef.current = props.logCount;
    if (diff > 0 && activeTab !== 'logs') {
      setUnseenLogCount((c) => c + diff);
    }
  }, [props.logCount, activeTab]);

  // logs 탭 활성 → unseen 리셋.
  useEffect(() => {
    if (activeTab === 'logs') setUnseenLogCount(0);
  }, [activeTab]);

  // ←/→ 로 탭 전환. Home/End 도 허용해 키보드만 쓰는 사용자가 양끝으로 점프 가능.
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setActiveTab((t) => (t === 'directive' ? 'logs' : 'directive'));
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); setActiveTab('directive'); return; }
    if (e.key === 'End')  { e.preventDefault(); setActiveTab('logs'); return; }
  };

  return (
    <div className="log-panel-tabs" data-active-tab={activeTab}>
      <div
        className="log-panel-tabs__resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="로그 패널 크기 조절"
        onMouseDown={props.onResizeStart}
        data-testid="log-panel-resize-handle"
      />

      <div
        role="tablist"
        aria-label="로그 패널 탭"
        className="log-panel-tabs__tablist"
        onKeyDown={onTabKeyDown}
      >
        <button
          type="button"
          role="tab"
          id="log-panel-tab-directive"
          aria-selected={activeTab === 'directive'}
          aria-controls="log-panel-panel-directive"
          tabIndex={activeTab === 'directive' ? 0 : -1}
          onClick={() => setActiveTab('directive')}
          className="log-panel-tabs__tab"
          data-tab-key="directive"
        >
          지시
        </button>
        <button
          type="button"
          role="tab"
          id="log-panel-tab-logs"
          aria-selected={activeTab === 'logs'}
          aria-controls="log-panel-panel-logs"
          tabIndex={activeTab === 'logs' ? 0 : -1}
          onClick={() => setActiveTab('logs')}
          className="log-panel-tabs__tab"
          data-tab-key="logs"
        >
          <span>로그</span>
          {unseenLogCount > 0 && (
            <span
              className="log-panel-tabs__badge"
              // 스크린리더에는 실제 수치를 그대로 전달한다(정확성 우선). 시각
              // 배지는 3자리 이상이 들어오면 "99+" 로 축약해 다른 상단 배지와의
              // 레이아웃 정렬을 유지한다(App.tsx:1917 과 동일 규약).
              aria-label={`새 로그 ${unseenLogCount}건`}
              data-testid="log-unseen-badge"
            >
              {unseenLogCount > 99 ? '99+' : unseenLogCount}
            </span>
          )}
        </button>
      </div>

      {/*
        두 패널 모두 DOM 에 유지해 DirectivePrompt 내부 상태·드래프트가 탭 전환에
        의해 사라지지 않도록 한다. `hidden` 은 접근성 트리에서도 제외돼 스크린리더가
        숨은 탭을 읽지 않는다.
      */}
      <div
        role="tabpanel"
        id="log-panel-panel-directive"
        aria-labelledby="log-panel-tab-directive"
        hidden={activeTab !== 'directive'}
        className="log-panel-tabs__panel log-panel-tabs__panel--directive"
      >
        {props.directive}
      </div>
      <div
        role="tabpanel"
        id="log-panel-panel-logs"
        aria-labelledby="log-panel-tab-logs"
        hidden={activeTab !== 'logs'}
        className="log-panel-tabs__panel log-panel-tabs__panel--logs"
      >
        {props.logs}
      </div>
    </div>
  );
}

export default LogPanelTabs;
