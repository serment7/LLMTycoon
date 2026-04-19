// Run with: npx tsx --test tests/sessionStatusEndpoint.regression.test.ts
//
// QA 회귀(#8888a819) — GET /api/claude/session-status 계약 + claudeTokenUsageStore
// 의 setSessionStatus 액션 전파.
//
// 서버 전체 부팅 없이 정적 스캔으로 엔드포인트 계약을 잠그고, 스토어 액션은
// `useSyncExternalStore` 와 호환되는 subscribe/getSnapshot 으로 실제 관찰한다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  claudeTokenUsageStore,
  setSessionStatusInState,
  EMPTY_TOTALS,
  emptyErrorCounters,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeSessionStatus } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(resolve(__dirname, '..', 'server.ts'), 'utf8');

// ────────────────────────────────────────────────────────────────────────────
// GET /api/claude/session-status — 서버 계약 정적 잠금
// ────────────────────────────────────────────────────────────────────────────

test('서버는 `/api/claude/slash-usage-preview` 로 Claude CLI `/usage` 프롬프트 프리뷰를 노출한다', () => {
  assert.match(
    SERVER_SRC,
    /app\.get\(\s*['"]\/api\/claude\/slash-usage-preview['"]/,
    'TokenUsageIndicator 가 마운트 시 headless /usage 시도 결과를 받을 수 있어야 한다',
  );
});

test('서버는 로컬 Claude Code JSONL 집계용 `/api/claude/jsonl-aggregate`·`POST …/sync-jsonl-usage` 를 노출한다', () => {
  assert.match(SERVER_SRC, /app\.get\(\s*['"]\/api\/claude\/jsonl-aggregate['"]/);
  assert.match(SERVER_SRC, /app\.post\(\s*['"]\/api\/claude\/sync-jsonl-usage['"]/);
});

test('서버는 OAuth `/usage` 동등 조회용 `GET /api/claude/oauth-usage` 를 노출한다', () => {
  assert.match(SERVER_SRC, /app\.get\(\s*['"]\/api\/claude\/oauth-usage['"]/);
});

test('서버는 워크스페이스 폴더를 OS 탐색기로 열기 위한 `POST /api/projects/:id/open-workspace` 를 노출한다', () => {
  assert.match(SERVER_SRC, /app\.post\(\s*['"]\/api\/projects\/:id\/open-workspace['"]/);
});

test('서버는 VS Code·Cursor CLI로 열기 위한 `POST /api/projects/:id/open-in-ide` 를 노출한다', () => {
  assert.match(SERVER_SRC, /app\.post\(\s*['"]\/api\/projects\/:id\/open-in-ide['"]/);
});

test('서버는 `/api/claude/session-status` 엔드포인트를 등록하고 { status, reason, at } 을 돌려준다', () => {
  assert.match(
    SERVER_SRC,
    /app\.get\(\s*['"]\/api\/claude\/session-status['"][\s\S]{0,400}res\.json\(\s*\{[\s\S]{0,200}status:\s*claudeSessionStatus[\s\S]{0,200}reason:\s*claudeSessionStatusReason[\s\S]{0,200}at:\s*claudeSessionStatusUpdatedAt/,
    '응답 shape 이 { status, reason, at } 세 필드를 전부 포함해야 한다(클라이언트 readOnly 가드 세팅용)',
  );
});

test('서버의 claudeSessionStatus 초기값은 "active" 이다', () => {
  // 구독 세션 기본 상태는 active. 마운트 직후 readOnly 가드가 활성화되지 않아야 한다.
  assert.match(
    SERVER_SRC,
    /let\s+claudeSessionStatus:\s*ClaudeSessionStatus\s*=\s*['"]active['"]/,
  );
});

test('서버는 onTokenExhausted 이벤트 훅에서 setClaudeSessionStatus("exhausted", …) 로 전이한다', () => {
  assert.match(
    SERVER_SRC,
    /onTokenExhausted\(\(event\)\s*=>\s*\{\s*setClaudeSessionStatus\(\s*['"]exhausted['"]\s*,\s*event\.message\s*\)\s*;?\s*\}\s*\)/,
    'Claude CLI/SDK 가 token_exhausted / subscription_expired 를 던지면 전역 상태가 exhausted 로 전이되어야 한다',
  );
});

test('소켓 신규 접속자에게도 claude-session:status 페이로드를 즉시 전달한다(재접속 복원)', () => {
  assert.match(
    SERVER_SRC,
    /socket\.emit\(\s*['"]claude-session:status['"]\s*,\s*\{[\s\S]{0,200}status:\s*claudeSessionStatus[\s\S]{0,200}reason:\s*claudeSessionStatusReason[\s\S]{0,200}at:\s*claudeSessionStatusUpdatedAt/,
    '신규 connection 에 현재 세션 상태를 동기화 지연 없이 보내야 한다',
  );
});

test('서버 브로드캐스터 변수명 claudeSessionStatusBroadcaster 로 io.emit 에 위임된다(폴백 이벤트 경로)', () => {
  assert.match(
    SERVER_SRC,
    /claudeSessionStatusBroadcaster\s*=\s*\(payload\)\s*=>\s*\{\s*io\.emit\(\s*['"]claude-session:status['"]\s*,\s*payload\s*\)/,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// setSessionStatusInState — 순수 함수 전파 불변
// ────────────────────────────────────────────────────────────────────────────

function makeActiveState() {
  return {
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(new Date()),
    history: [],
    loadError: null,
    sessionStatus: 'active' as ClaudeSessionStatus,
    sessionStatusReason: undefined as string | undefined,
  };
}

test('setSessionStatusInState — 상태/사유 변화 시 새 참조를, 동일하면 같은 참조를 돌려준다(리렌더 최소화)', () => {
  const s0 = makeActiveState();
  const s1 = setSessionStatusInState(s0, 'active', undefined);
  assert.equal(s1, s0, '동일 상태·동일 사유면 같은 참조(불필요 리렌더 차단)');

  const s2 = setSessionStatusInState(s0, 'exhausted', '토큰이 소진되었습니다');
  assert.notEqual(s2, s0, '전이 시 새 참조');
  assert.equal(s2.sessionStatus, 'exhausted');
  assert.equal(s2.sessionStatusReason, '토큰이 소진되었습니다');

  const s3 = setSessionStatusInState(s2, 'exhausted', '토큰이 소진되었습니다');
  assert.equal(s3, s2, '같은 사유 재세팅은 참조 동일');
});

// ────────────────────────────────────────────────────────────────────────────
// claudeTokenUsageStore.setSessionStatus — 구독자에게 전파
// ────────────────────────────────────────────────────────────────────────────

function resetStore() {
  try {
    window.localStorage.clear();
  } catch {
    /* SSR fallback */
  }
  claudeTokenUsageStore.__setForTest({
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(new Date()),
    history: [],
    loadError: null,
    sessionStatus: 'active',
    sessionStatusReason: undefined,
  });
}

test('claudeTokenUsageStore.setSessionStatus — active→exhausted 전이 시 구독자에게 1회 emit', () => {
  resetStore();
  let emits = 0;
  const unsub = claudeTokenUsageStore.subscribe(() => {
    emits += 1;
  });
  claudeTokenUsageStore.setSessionStatus('exhausted', '토큰 소진');
  assert.equal(emits, 1, '상태 전이 시 구독자에게 1회 통보');
  const snap = claudeTokenUsageStore.getSnapshot();
  assert.equal(snap.sessionStatus, 'exhausted');
  assert.equal(snap.sessionStatusReason, '토큰 소진');
  unsub();
});

test('claudeTokenUsageStore.setSessionStatus — 동일값 재호출은 emit 되지 않는다(리렌더 최소화)', () => {
  resetStore();
  claudeTokenUsageStore.setSessionStatus('exhausted', '재시도 불가');
  let emits = 0;
  const unsub = claudeTokenUsageStore.subscribe(() => {
    emits += 1;
  });
  claudeTokenUsageStore.setSessionStatus('exhausted', '재시도 불가');
  assert.equal(emits, 0, '동일 상태·사유 재세팅은 조용히 무시');
  unsub();
});

test('claudeTokenUsageStore.setSessionStatus — exhausted→active 복귀 시 구독자에게 통보', () => {
  resetStore();
  claudeTokenUsageStore.setSessionStatus('exhausted', '만료');
  let emits = 0;
  const unsub = claudeTokenUsageStore.subscribe(() => {
    emits += 1;
  });
  claudeTokenUsageStore.setSessionStatus('active', undefined);
  assert.equal(emits, 1);
  assert.equal(claudeTokenUsageStore.getSnapshot().sessionStatus, 'active');
  unsub();
});

test('ClaudeSessionStatus 타입 — active/warning/exhausted 3단계만 존재한다(시안 F1~F4 와 매핑 주석 참조)', () => {
  const valid: ClaudeSessionStatus[] = ['active', 'warning', 'exhausted'];
  assert.equal(valid.length, 3, '실 구현은 3단계. 시안 §1 의 F1~F4 는 UX 톤 4단계이며 exhausted 가 F4 에 대응');
});
