// Run with: npx tsx --test src/components/LogPanelTabs.test.tsx
//
// QA (#LOG-PANEL-TABS): 로그 패널 탭 전환 UX 의 사용자 불변식 고정.
// DirectivePrompt 통합 테스트와 동일한 스택(jsdom + @testing-library/react) 을 쓴다.
//
// 검증 시나리오 (사용자 문장 → 관찰 가능한 DOM/상태 불변식):
//   (1) 초기 진입 시 '지시' 탭 활성. localStorage 에 직전 선택이 남아 있으면 그쪽을 복원.
//   (2) '로그' 탭으로 전환하면 unseenLogCount 가 0 으로 리셋되고 배지가 사라진다.
//   (3) '지시' 탭에 머무는 동안 새 로그가 들어오면 draft/첨부 DOM 상태는 유지되고
//       '로그' 탭 배지만 증가한다 (draft/첨부는 패널의 실자식 input 으로 모델링).
//   (4) ←/→ 키로 탭 전환이 가능. 비활성 탭은 tabIndex=-1 이라 Tab 키가 건너뛰어
//       실제 포커스가 활성 패널의 첫 포커스 가능한 자식으로 이동한다.
//   (5) 로그 탭에서도 리사이즈 핸들(mousedown)이 동일하게 onResizeStart 를 호출한다.
//
// 픽스처: localStorage 는 jsdom 제공 기본 구현을 쓰고, 테스트마다 afterEach 로 비운다.
// 지시 패널의 draft 는 실제 DirectivePrompt 대신 `<textarea data-testid="draft" />` 로
// 단순화 — 이 컴포넌트가 검증하려는 불변식은 "패널이 언마운트되지 않는다" 이므로
// 한 단계 아래 컴포넌트의 구현 세부를 재검증할 필요가 없다.

import 'global-jsdom/register';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  LogPanelTabs,
  LOG_PANEL_TAB_KEY,
  readStoredLogPanelTab,
  type LogPanelTabKey,
} from './LogPanelTabs.tsx';

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch {}
});

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function tabs(container: HTMLElement): { directive: HTMLButtonElement; logs: HTMLButtonElement } {
  const d = container.querySelector<HTMLButtonElement>('[data-tab-key="directive"]');
  const l = container.querySelector<HTMLButtonElement>('[data-tab-key="logs"]');
  if (!d || !l) throw new Error('탭 버튼이 렌더되지 않았다');
  return { directive: d, logs: l };
}

function Harness(props: {
  initialLogs?: number;
  onResizeStart?: (e: React.MouseEvent<HTMLDivElement>) => void;
  initialTab?: LogPanelTabKey;
  storageKey?: string;
  draftTestId?: string;
  extraPanelButton?: boolean;
}) {
  const [logCount, setLogCount] = useState(props.initialLogs ?? 0);
  return (
    <>
      <button
        type="button"
        data-testid="harness-add-log"
        onClick={() => setLogCount((c) => c + 1)}
      >
        addLog
      </button>
      <LogPanelTabs
        logCount={logCount}
        onResizeStart={props.onResizeStart ?? (() => {})}
        initialTab={props.initialTab}
        storageKey={props.storageKey}
        directive={
          <>
            <textarea
              data-testid={props.draftTestId ?? 'draft'}
              defaultValue=""
              aria-label="지시 본문"
            />
            {props.extraPanelButton && (
              <button type="button" data-testid="directive-inner-btn">inner</button>
            )}
          </>
        }
        logs={
          <div data-testid="logs-slot">logs here ({logCount})</div>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 순수 헬퍼: readStoredLogPanelTab
// ---------------------------------------------------------------------------

test('TC-LPT-00: readStoredLogPanelTab 은 화이트리스트 밖 값을 null 로 떨어뜨린다', () => {
  const store = new Map<string, string>();
  const fakeWin = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null } as Pick<Storage, 'getItem'>,
  };
  assert.equal(readStoredLogPanelTab(fakeWin, 'k'), null, '없으면 null');
  store.set('k', 'directive');
  assert.equal(readStoredLogPanelTab(fakeWin, 'k'), 'directive');
  store.set('k', 'logs');
  assert.equal(readStoredLogPanelTab(fakeWin, 'k'), 'logs');
  store.set('k', 'garbage');
  assert.equal(readStoredLogPanelTab(fakeWin, 'k'), null, '쓰레기 값은 무시');
  assert.equal(readStoredLogPanelTab(undefined, 'k'), null, 'SSR 안전 가드');
});

// ---------------------------------------------------------------------------
// (1) 초기 탭 + localStorage 복원
// ---------------------------------------------------------------------------

test('TC-LPT-01a: localStorage 가 비어있으면 초기 탭은 "지시"', () => {
  const { container } = render(<Harness />);
  const { directive, logs } = tabs(container);
  assert.equal(directive.getAttribute('aria-selected'), 'true');
  assert.equal(logs.getAttribute('aria-selected'), 'false');
  // 지시 패널만 노출, 로그 패널은 hidden.
  const directivePanel = container.querySelector<HTMLElement>('#log-panel-panel-directive');
  const logsPanel = container.querySelector<HTMLElement>('#log-panel-panel-logs');
  assert.ok(directivePanel && !directivePanel.hasAttribute('hidden'), '지시 패널은 보여야 한다');
  assert.ok(logsPanel && logsPanel.hasAttribute('hidden'), '로그 패널은 hidden');
});

test('TC-LPT-01b: localStorage 에 "logs" 가 있으면 그쪽으로 복원', () => {
  window.localStorage.setItem(LOG_PANEL_TAB_KEY, 'logs');
  const { container } = render(<Harness />);
  const { directive, logs } = tabs(container);
  assert.equal(logs.getAttribute('aria-selected'), 'true', '복원된 탭이 활성');
  assert.equal(directive.getAttribute('aria-selected'), 'false');
});

test('TC-LPT-01c: 탭 전환 시 localStorage 에 현재 탭이 저장된다', () => {
  const { container } = render(<Harness />);
  const { logs } = tabs(container);
  act(() => { fireEvent.click(logs); });
  assert.equal(
    window.localStorage.getItem(LOG_PANEL_TAB_KEY),
    'logs',
    '사용자가 고른 탭이 즉시 저장돼야 한다',
  );
});

test('TC-LPT-01d: 쓰레기 값이 저장돼 있으면 initialTab 폴백', () => {
  window.localStorage.setItem(LOG_PANEL_TAB_KEY, 'something-else');
  const { container } = render(<Harness initialTab="directive" />);
  const { directive } = tabs(container);
  assert.equal(directive.getAttribute('aria-selected'), 'true');
});

// ---------------------------------------------------------------------------
// (2) '로그' 탭 전환 시 unseenLogCount 리셋
// ---------------------------------------------------------------------------

test('TC-LPT-02: 로그 탭으로 전환하면 unseen 배지가 0 으로 리셋된다', () => {
  const { container, getByTestId } = render(<Harness />);
  const addLogBtn = getByTestId('harness-add-log');

  // 지시 탭 유지 상태에서 로그 3건 도착.
  act(() => { fireEvent.click(addLogBtn); fireEvent.click(addLogBtn); fireEvent.click(addLogBtn); });
  const badge = container.querySelector<HTMLElement>('[data-testid="log-unseen-badge"]');
  assert.ok(badge, '배지가 떠야 한다');
  assert.equal(badge!.textContent, '3');

  // 로그 탭 클릭 → 배지 사라짐.
  act(() => { fireEvent.click(tabs(container).logs); });
  assert.equal(
    container.querySelector('[data-testid="log-unseen-badge"]'),
    null,
    '로그를 본 순간 unseen 은 0 이 되어 배지가 제거된다',
  );
});

// ---------------------------------------------------------------------------
// (3) 지시 탭 유지 중 새 로그 유입 → draft/첨부 보존 + 배지 증가
// ---------------------------------------------------------------------------

test('TC-LPT-03: 지시 탭에서 입력 중 새 로그가 들어와도 draft 가 유지되고 배지만 증가', () => {
  const { container, getByTestId } = render(<Harness />);

  // 사용자가 지시 draft 에 본문을 입력.
  const draft = getByTestId('draft') as HTMLTextAreaElement;
  act(() => { fireEvent.change(draft, { target: { value: '로그인 기능 설계해줘' } }); });
  assert.equal(draft.value, '로그인 기능 설계해줘');

  // 두 건의 새 로그가 들어옴.
  const addLogBtn = getByTestId('harness-add-log');
  act(() => { fireEvent.click(addLogBtn); fireEvent.click(addLogBtn); });

  // 배지는 2 로 올라오고, draft 는 같은 DOM 노드를 유지해 값이 보존된다.
  const badge = container.querySelector<HTMLElement>('[data-testid="log-unseen-badge"]');
  assert.ok(badge);
  assert.equal(badge!.textContent, '2');
  const draftAfter = getByTestId('draft') as HTMLTextAreaElement;
  assert.equal(draftAfter, draft, '지시 패널은 언마운트되지 않아 textarea 는 동일 노드');
  assert.equal(draftAfter.value, '로그인 기능 설계해줘', 'draft 값은 그대로 보존');

  // 지시 패널은 여전히 보이고 로그 패널은 hidden (탭 전환 없이 배경에서만 카운트).
  const directivePanel = container.querySelector<HTMLElement>('#log-panel-panel-directive');
  const logsPanel = container.querySelector<HTMLElement>('#log-panel-panel-logs');
  assert.ok(directivePanel && !directivePanel.hasAttribute('hidden'));
  assert.ok(logsPanel && logsPanel.hasAttribute('hidden'));
});

// ---------------------------------------------------------------------------
// (4) ←/→ 키 전환 + Tab 키 포커스 이동
// ---------------------------------------------------------------------------

test('TC-LPT-04a: ←/→ 키로 탭이 전환된다', () => {
  const { container } = render(<Harness />);
  const { directive, logs } = tabs(container);

  directive.focus();
  act(() => { fireEvent.keyDown(directive, { key: 'ArrowRight' }); });
  assert.equal(logs.getAttribute('aria-selected'), 'true', '→ 로 로그 탭 활성');

  logs.focus();
  act(() => { fireEvent.keyDown(logs, { key: 'ArrowLeft' }); });
  assert.equal(directive.getAttribute('aria-selected'), 'true', '← 로 지시 탭으로 복귀');
});

test('TC-LPT-04b: 비활성 탭의 tabIndex 는 -1 — Tab 키는 패널 내부로 이동', async () => {
  const user = userEvent.setup();
  const { container, getByTestId } = render(<Harness extraPanelButton />);
  const { directive, logs } = tabs(container);

  // 초기 상태: directive=0, logs=-1 (roving tabindex 관례).
  assert.equal(directive.tabIndex, 0);
  assert.equal(logs.tabIndex, -1);

  directive.focus();
  assert.equal(document.activeElement, directive);

  // Tab → 비활성 tab 버튼(logs, tabIndex=-1)은 건너뛰고 지시 패널 내부 textarea 로 이동.
  await user.tab();
  assert.equal(
    document.activeElement,
    getByTestId('draft'),
    'Tab 은 tabIndex=-1 인 비활성 탭을 건너뛰고 활성 패널의 첫 포커스 가능 노드로 이동',
  );

  // 화살표로 탭 전환하면 roving tabindex 도 뒤따른다.
  directive.focus();
  act(() => { fireEvent.keyDown(directive, { key: 'ArrowRight' }); });
  assert.equal(tabs(container).logs.tabIndex, 0, '활성이 된 탭은 tabIndex 0');
  assert.equal(tabs(container).directive.tabIndex, -1, '비활성이 된 탭은 tabIndex -1');
});

// ---------------------------------------------------------------------------
// (5) 로그 탭에서도 리사이즈 핸들 동작
// ---------------------------------------------------------------------------

test('TC-LPT-05: 로그 탭으로 전환해도 리사이즈 핸들 mousedown 이 onResizeStart 를 호출한다', () => {
  const calls: Array<React.MouseEvent<HTMLDivElement>> = [];
  const { container } = render(
    <Harness onResizeStart={(e) => { calls.push(e); }} />,
  );
  const handle = container.querySelector<HTMLElement>('[data-testid="log-panel-resize-handle"]');
  assert.ok(handle, '리사이즈 핸들이 렌더돼야 한다');

  // 지시 탭에서 먼저 동작 확인.
  act(() => { fireEvent.mouseDown(handle!); });
  assert.equal(calls.length, 1, '지시 탭에서 1회 호출');

  // 로그 탭으로 전환 후 다시 드래그.
  act(() => { fireEvent.click(tabs(container).logs); });
  act(() => { fireEvent.mouseDown(handle!); });
  assert.equal(calls.length, 2, '로그 탭에서도 동일하게 호출되어 핸들이 살아있다');

  // 핸들은 탭과 독립된 공통 헤더에 있으므로 역할 속성도 유지되어야 한다.
  assert.equal(handle!.getAttribute('role'), 'separator');
  assert.equal(handle!.getAttribute('aria-orientation'), 'horizontal');
});
