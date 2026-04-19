// Run with: npx tsx --test tests/tokenUsageSettingsPanelExport.e2e.test.tsx
//
// E2E 확장(#784994db) — 상단바 Claude 토큰 사용량 위젯 U1~U4 통과 이후
// 신규 유틸/설정 UX 의 교차 통합 시나리오를 잠근다.
//
// 검사 대상:
//   · TokenUsageSettingsPanel 의 임계값 저장 → ClaudeTokenUsage 배지의
//     data-severity 전환(normal → caution → warning).
//   · 동일 패널의 "내보내기" 섹션(CSV/JSON) → Blob 생성·a[download] 클릭 흐름.
//     (window.URL.createObjectURL/revokeObjectURL 를 스텁으로 잡는다.)
//   · localStorage.setItem 이 throw 하는 "저장 실패" 경로 → 에러 배너가 노출되고
//     onApply 가 호출되지 않음(회귀 #3c0b0d6f 의 반대 계약).
//   · ToastProvider 로 감싸도 Panel 의 role="dialog"·role="alert" 가 별도 aria-live
//     영역으로 공존(AuthGate 의 role="status" 와 계약 경합 없음).
//   · AuthGate 접근성 회귀(authGateAccessibility.regression.test.ts) 의 정적
//     계약은 본 시나리오를 추가해도 손상되지 않는다 — 파일을 읽어 동일 계약을
//     재검증해 테스트 묶음 간 간섭을 차단.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { ClaudeTokenUsage } from '../src/components/ClaudeTokenUsage.tsx';
import { TokenUsageSettingsPanel } from '../src/components/TokenUsageSettingsPanel.tsx';
import { ToastProvider, useToast } from '../src/components/ToastProvider.tsx';
import {
  claudeTokenUsageStore,
  EMPTY_TOTALS,
  emptyErrorCounters,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';
import {
  TOKEN_USAGE_THRESHOLDS_STORAGE_KEY,
  deserializeThresholds,
} from '../src/utils/claudeTokenUsageThresholds.ts';
import type { ClaudeTokenUsage as Usage } from '../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ────────────────────────────────────────────────────────────────────────────

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetchStub(getTotals: () => object = () => ({ ...EMPTY_TOTALS, byModel: {} })): () => void {
  const orig = globalThis.fetch;
  const stub: FetchStub = async () =>
    new Response(JSON.stringify(getTotals()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  (globalThis as unknown as { fetch: FetchStub }).fetch = stub;
  return () => {
    (globalThis as unknown as { fetch: typeof orig }).fetch = orig;
  };
}

function resetStoreAndStorage() {
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom 외 환경 */
  }
  claudeTokenUsageStore.__setForTest({
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(new Date()),
    history: [],
    loadError: null,
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
}

function applyUsage(delta: Partial<Usage>): void {
  act(() => {
    claudeTokenUsageStore.applyDelta({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6',
      at: new Date().toISOString(),
      ...delta,
    } as Usage);
  });
}

/**
 * URL.createObjectURL 는 jsdom 29 에서도 기본 미구현. Blob 을 받아 가상 URL 을
 * 만들어 주되, 테스트가 끝나면 Blob 바디를 꺼내볼 수 있도록 `lastBlob` 을 보관.
 */
function installObjectUrlStub() {
  const holder: { lastBlob: Blob | null; url: string } = { lastBlob: null, url: 'blob:llmtycoon/test' };
  const origCreate = (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL;
  const origRevoke = (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    holder.lastBlob = b;
    return holder.url;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  return {
    holder,
    restore() {
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = origCreate as unknown;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = origRevoke as unknown;
    },
  };
}

/** a.click() 이 실제로 호출됐는지 기록하는 스파이. 다운로드 흐름 검증용. */
function installAnchorClickSpy() {
  const records: Array<{ href: string; download: string }> = [];
  const origCreate = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const el = origCreate(tag);
    if (tag.toLowerCase() === 'a') {
      const anchor = el as HTMLAnchorElement;
      const origClick = anchor.click.bind(anchor);
      anchor.click = () => {
        records.push({ href: anchor.href, download: anchor.download });
        // 실제 navigation 방지: 원본 click 호출은 생략.
        void origClick;
      };
    }
    return el;
  }) as typeof document.createElement;
  return {
    records,
    restore() {
      document.createElement = origCreate;
    },
  };
}

async function readBlobText(blob: Blob): Promise<string> {
  // TextDecoder 는 기본적으로 UTF-8 BOM 을 제거하므로 ignoreBOM:true 로 원본을
  // 그대로 복원한다. CSV 는 Excel 호환을 위해 BOM 의 존재 자체를 계약으로 한다.
  const buf = await blob.arrayBuffer();
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(buf));
}

// ────────────────────────────────────────────────────────────────────────────
// E2E-4a · 임계값 저장 → 위젯 severity 가 즉시 전환
// ────────────────────────────────────────────────────────────────────────────

test('E2E-4a · 임계값 저장 직후 ClaudeTokenUsage 의 data-severity 가 warning 으로 전환된다', async () => {
  resetStoreAndStorage();
  // fetch 스텁은 호출 시점의 스토어 all 축을 그대로 돌려보내 hydrate 가 applyDelta
  // 누적분을 덮어쓰지 않도록 한다.
  const restore = installFetchStub(() => claudeTokenUsageStore.getSnapshot().all);

  // 누적 7,000 토큰. 초기 임계값 없음 → normal.
  applyUsage({ input_tokens: 5000, output_tokens: 2000, model: 'claude-sonnet-4-6' });

  const widgetHandle = render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();

  const widget = () => document.querySelector('[data-testid="claude-token-usage"]') as HTMLElement;
  assert.equal(widget().getAttribute('data-severity'), 'normal', '초기에는 임계값 없음 → normal');

  // 설정 패널을 열어 임계값을 저장. caution=3000, warning=5000 → 7000 >= warning.
  // Panel 은 별도 DOM 에 render 해도 저장 후 widget 이 loadThresholdsFromStorage 로
  // 복원되지 않으므로, widget 은 onApply 경유로 임계값을 받는 UI 구성을 테스트할 수
  // 없다. 따라서 여기서는 Panel 의 onApply 콜백 + widget re-mount 2단계로 확인한다.
  let appliedCount = 0;
  const panelHandle = render(
    React.createElement(TokenUsageSettingsPanel, {
      initial: { caution: {}, warning: {} },
      onClose: () => {},
      onApply: () => {
        appliedCount += 1;
      },
    }),
  );
  const [cTokens, , wTokens] = Array.from(document.querySelectorAll('form input')) as HTMLInputElement[];
  act(() => {
    fireEvent.change(cTokens, { target: { value: '3000' } });
    fireEvent.change(wTokens, { target: { value: '5000' } });
  });
  const form = document.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });
  assert.equal(appliedCount, 1, 'onApply 는 성공 경로에서 정확히 1회 호출');

  // localStorage 에 동일 키로 저장됐는지 — 위젯이 재마운트 시 이를 반영할 수 있다.
  const raw = window.localStorage.getItem(TOKEN_USAGE_THRESHOLDS_STORAGE_KEY);
  assert.ok(raw, '임계값이 localStorage 에 저장되어야 한다');
  const back = deserializeThresholds(raw);
  assert.equal(back.caution.tokens, 3000);
  assert.equal(back.warning.tokens, 5000);

  // widget 재마운트 시 저장된 임계값을 읽어 severity 를 재계산해야 한다.
  widgetHandle.unmount();
  const remounted = render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();
  assert.equal(
    widget().getAttribute('data-severity'),
    'warning',
    '재마운트 후 warning 으로 승격되어야 한다(토큰 합계 7000 ≥ 5000)',
  );

  panelHandle.unmount();
  remounted.unmount();
  cleanup();
  restore();
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-4b · CSV 내보내기 → Blob + a[download] 클릭
// ────────────────────────────────────────────────────────────────────────────

test('E2E-4b · "today" 범위 CSV 내보내기는 BOM·헤더·배지 수치를 포함한 Blob 을 생성한다', async () => {
  resetStoreAndStorage();
  applyUsage({ input_tokens: 1234, output_tokens: 567, model: 'claude-opus-4-7' });

  const url = installObjectUrlStub();
  const anchor = installAnchorClickSpy();

  const handle = render(
    React.createElement(TokenUsageSettingsPanel, {
      initial: { caution: {}, warning: {} },
      onClose: () => {},
      onApply: () => {},
    }),
  );

  const csvBtn = document.querySelector('[data-testid="token-usage-export-csv"]') as HTMLButtonElement;
  assert.ok(csvBtn, 'CSV 버튼이 존재해야 한다');
  act(() => {
    fireEvent.click(csvBtn);
  });

  assert.equal(anchor.records.length, 1, 'a.click 이 정확히 1회 호출되어야 한다');
  assert.match(anchor.records[0].download, /^claude-token-usage_today_.*\.csv$/, '파일명 규약');
  assert.ok(url.holder.lastBlob, 'Blob 이 생성되어야 한다');
  assert.equal(url.holder.lastBlob!.type, 'text/csv;charset=utf-8');

  const text = await readBlobText(url.holder.lastBlob!);
  assert.ok(text.startsWith('\uFEFF'), 'CSV 는 UTF-8 BOM 으로 시작');
  assert.match(text, /date,callCount,/, '헤더 행 포함');
  assert.match(text, /1234/, '입력 토큰 수치 포함');
  assert.match(text, /567/, '출력 토큰 수치 포함');

  handle.unmount();
  cleanup();
  url.restore();
  anchor.restore();
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-4c · JSON 내보내기 — schema/range 메타 유지
// ────────────────────────────────────────────────────────────────────────────

test('E2E-4c · "week" 범위 JSON 내보내기 — schema·range·rows 메타가 보존된다', async () => {
  resetStoreAndStorage();
  applyUsage({ input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-4-6' });

  const url = installObjectUrlStub();
  const anchor = installAnchorClickSpy();

  const handle = render(
    React.createElement(TokenUsageSettingsPanel, {
      initial: { caution: {}, warning: {} },
      onClose: () => {},
      onApply: () => {},
    }),
  );

  const weekRadio = document.querySelector('[data-testid="token-usage-export-range-week"]') as HTMLInputElement;
  assert.ok(weekRadio, 'week 라디오가 존재해야 한다');
  act(() => {
    fireEvent.click(weekRadio);
  });

  const jsonBtn = document.querySelector('[data-testid="token-usage-export-json"]') as HTMLButtonElement;
  act(() => {
    fireEvent.click(jsonBtn);
  });

  assert.equal(anchor.records.length, 1);
  assert.match(anchor.records[0].download, /^claude-token-usage_week_.*\.json$/);
  assert.equal(url.holder.lastBlob!.type, 'application/json;charset=utf-8');
  const parsed = JSON.parse(await readBlobText(url.holder.lastBlob!));
  assert.equal(parsed.schema, 'llmtycoon.tokenUsage.export/v1');
  assert.equal(parsed.range, 'week');
  assert.ok(Array.isArray(parsed.rows), 'rows 는 배열');
  // week 는 오늘 + history 6 + 합계 1. history 가 비어 있으면 1 + 1 = 2 이상.
  assert.ok(parsed.rows.length >= 2, `week 는 최소 2행 이상: ${parsed.rows.length}`);
  assert.equal(parsed.rows[parsed.rows.length - 1].date, '합계');

  handle.unmount();
  cleanup();
  url.restore();
  anchor.restore();
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-4d · 저장 실패(localStorage.setItem throw) → error 배너 + onApply 미호출
// ────────────────────────────────────────────────────────────────────────────

test('E2E-4d · localStorage 쿼터 초과 시 에러 배너가 노출되고 onApply 는 호출되지 않는다', async () => {
  resetStoreAndStorage();

  // setItem 이 localStorage 의 `llmtycoon.tokenUsage.thresholds.v1` 키에 대해서만
  // throw 하도록 prototype 에 임시 오버라이드.
  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function patched(key: string, value: string) {
    if (key === TOKEN_USAGE_THRESHOLDS_STORAGE_KEY) {
      const err = new Error('QuotaExceededError');
      (err as Error & { name: string }).name = 'QuotaExceededError';
      throw err;
    }
    return origSetItem.call(this, key, value);
  };

  let applied = false;
  let closed = false;
  const handle = render(
    React.createElement(TokenUsageSettingsPanel, {
      initial: { caution: {}, warning: {} },
      onClose: () => {
        closed = true;
      },
      onApply: () => {
        applied = true;
      },
    }),
  );

  const [cTokens, , wTokens] = Array.from(document.querySelectorAll('form input')) as HTMLInputElement[];
  act(() => {
    fireEvent.change(cTokens, { target: { value: '1000' } });
    fireEvent.change(wTokens, { target: { value: '5000' } });
  });
  const form = document.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });

  assert.equal(applied, false, '저장 실패 시 onApply 는 호출되면 안 된다');
  assert.equal(closed, false, '저장 실패 시 onClose 도 호출되면 안 된다');
  const banner = document.querySelector('[data-testid="token-usage-settings-error"]');
  assert.ok(banner, '저장 실패 배너가 노출되어야 한다');
  assert.match(banner!.textContent ?? '', /저장 실패/);
  // role="alert" 로 스크린리더가 즉시 낭독.
  assert.equal(banner!.getAttribute('role'), 'alert');

  Storage.prototype.setItem = origSetItem;
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-4e · ToastProvider 래핑 공존 — aria-live 영역 분리 확인
// ────────────────────────────────────────────────────────────────────────────

function ToastProbe({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }) {
  const api = useToast();
  React.useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

test('E2E-4e · ToastProvider 래핑 하에서 Panel 의 role="dialog" 와 toast container 가 독립 공존한다', async () => {
  resetStoreAndStorage();

  let toastApi: ReturnType<typeof useToast> | null = null;
  const handle = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ToastProbe, {
        onReady: (api) => {
          toastApi = api;
        },
      }),
      React.createElement(TokenUsageSettingsPanel, {
        initial: { caution: {}, warning: {} },
        onClose: () => {},
        onApply: () => {},
      }),
    ),
  );

  await flushMicrotasks();

  const dialog = document.querySelector('[data-testid="token-usage-settings-panel"]');
  const container = document.querySelector('[data-testid="toast-container"]');
  assert.ok(dialog, 'Panel 의 dialog role 이 존재');
  assert.ok(container, 'ToastProvider 의 container 가 존재');
  assert.equal(dialog!.getAttribute('role'), 'dialog');
  assert.equal(dialog!.getAttribute('aria-label'), '토큰 사용량 임계값 설정');

  // 토스트를 warning 으로 push 하면 assertive 알림이 추가로 붙어도
  // Panel 의 dialog 선언과 충돌하지 않는다.
  assert.ok(toastApi, 'useToast 훅이 노출되어야 한다');
  act(() => {
    toastApi!.push({ variant: 'warning', title: '임계값 경고', description: '비용이 곧 경고 한계에 도달합니다.' });
  });
  await flushMicrotasks();

  const warningToast = document.querySelector('[data-testid="toast-warning"]');
  assert.ok(warningToast, 'warning 토스트가 DOM 에 렌더되어야 한다');
  assert.equal(warningToast!.getAttribute('role'), 'alert', 'warning 토스트는 role="alert"');
  assert.equal(warningToast!.getAttribute('aria-live'), 'assertive', 'T-10: warning 은 assertive');

  // Panel 의 role="dialog" 는 토스트와 별개 컨테이너에 존재해야 한다(컨테이너가
  // Panel 을 감싸고 있지 않음).
  assert.ok(
    container !== dialog && !container!.contains(dialog!),
    'toast container 는 dialog 를 감싸지 않아야 한다(aria tree 간섭 방지)',
  );

  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-4f · validateThresholds 실패 — caution ≥ warning 이면 submit 차단
// ────────────────────────────────────────────────────────────────────────────

test('E2E-4f · caution 이 warning 보다 크면 에러 배너가 뜨고 onApply 는 호출되지 않는다', async () => {
  resetStoreAndStorage();

  let applied = false;
  const handle = render(
    React.createElement(TokenUsageSettingsPanel, {
      initial: { caution: {}, warning: {} },
      onClose: () => {},
      onApply: () => {
        applied = true;
      },
    }),
  );

  const [cTokens, , wTokens] = Array.from(document.querySelectorAll('form input')) as HTMLInputElement[];
  act(() => {
    fireEvent.change(cTokens, { target: { value: '9000' } });
    fireEvent.change(wTokens, { target: { value: '1000' } });
  });
  const form = document.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });

  assert.equal(applied, false, 'validate 실패 시 onApply 는 호출되면 안 된다');
  const banner = document.querySelector('[data-testid="token-usage-settings-error"]');
  assert.ok(banner, '검증 실패 배너가 있어야 한다');
  assert.match(banner!.textContent ?? '', /주의 임계값\(토큰\)/);
  // 저장 자체가 차단되었으므로 localStorage 에는 아무 것도 들어가지 않아야 한다.
  assert.equal(
    window.localStorage.getItem(TOKEN_USAGE_THRESHOLDS_STORAGE_KEY),
    null,
    '검증 실패 시 저장도 생략되어야 한다',
  );

  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-4g · AuthGate 접근성 계약 불변 — 정적 검사 (Panel 도입과 독립)
// ────────────────────────────────────────────────────────────────────────────

test('E2E-4g · AuthGate 접근성 계약은 Panel/Toast 도입 후에도 불변이다', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(resolve(__dirname, '..', 'src', 'components', 'AuthGate.tsx'), 'utf8');
  // role="status" · aria-live="polite" 가 로딩 영역에 살아있는지 재확인(회귀 지표).
  assert.match(SRC, /role="status"/);
  assert.match(SRC, /aria-live="polite"/);
  assert.match(SRC, /aria-label="인증 서버 연결 다시 시도"/);
  // Panel 의 role 과 label 은 서로 다른 의미 — 간섭 우려 정적 교차 검사.
  const PANEL = readFileSync(
    resolve(__dirname, '..', 'src', 'components', 'TokenUsageSettingsPanel.tsx'),
    'utf8',
  );
  assert.match(PANEL, /role="dialog"/);
  assert.match(PANEL, /aria-label="토큰 사용량 임계값 설정"/);
  // AuthGate 는 "dialog" role 을 선언하지 않아야 한다(충돌 방지).
  assert.ok(!SRC.includes('role="dialog"'), 'AuthGate 는 dialog role 을 선언하지 않는다');
});
