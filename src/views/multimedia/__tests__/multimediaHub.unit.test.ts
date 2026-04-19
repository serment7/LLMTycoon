// Run with: npx tsx --test src/views/multimedia/__tests__/multimediaHub.unit.test.ts
//
// 지시 #95de334d · 멀티미디어 허브 라우트·훅·컴포넌트 계약 회귀.
//
// React 컴포넌트 렌더링은 기존 프로젝트 관행(정적 소스 regex + 순수 함수 직접 호출)
// 을 그대로 따라 번들·jsdom 부트스트랩 비용을 피한다.
//
// 테스트 축
//   A. routes.ts — 매니페스트 / URL 슬러그 파서
//   B. useMultimediaJobs — 작업 큐 스토어 (start/update/complete/fail/cancel/clear)
//   C. 정적 소스 계약 — MultimediaHub/Shell 의 핵심 접근성·토큰 속성이 유지되는지

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  MULTIMEDIA_CARDS,
  MULTIMEDIA_CATEGORIES,
  parseMultimediaRoute,
  resolveCardByRoute,
  resolveCardByUrlPath,
} from '../routes.ts';
import {
  createMultimediaJobsStore,
} from '../useMultimediaJobs.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

// ────────────────────────────────────────────────────────────────────────────
// A. routes.ts
// ────────────────────────────────────────────────────────────────────────────

test('A1. MULTIMEDIA_CARDS — 6 축 모두 등록 + 각 카드가 필수 필드 보유', () => {
  assert.equal(MULTIMEDIA_CARDS.length, 6);
  const routes = MULTIMEDIA_CARDS.map((c) => c.route).sort();
  assert.deepEqual(routes, [
    'input-automation', 'pdf', 'ppt', 'research', 'search', 'video',
  ]);
  for (const c of MULTIMEDIA_CARDS) {
    assert.ok(c.label.length > 0);
    assert.ok(c.urlPath.startsWith('/multimedia/'));
    assert.ok(c.expectedTokens > 0);
    assert.ok(['neutral', 'heavy'].includes(c.costAccent));
  }
});

test('A2. 카테고리 4종 — 문서 / 리서치 / 영상 / 자동화', () => {
  assert.equal(MULTIMEDIA_CATEGORIES.length, 4);
  const ids = MULTIMEDIA_CATEGORIES.map((c) => c.id).sort();
  assert.deepEqual(ids, ['automation', 'documents', 'research', 'video']);
});

test('A3. InputAutomation 카드는 기본 잠금(defaultLocked=true) + 해제 힌트 보유', () => {
  const auto = MULTIMEDIA_CARDS.find((c) => c.route === 'input-automation');
  assert.ok(auto);
  assert.equal(auto!.defaultLocked, true);
  assert.match(auto!.unlockHint!, /활성화/);
  // 나머지는 기본 OFF 아님
  for (const c of MULTIMEDIA_CARDS) {
    if (c.route === 'input-automation') continue;
    assert.equal(c.defaultLocked, false, `${c.route} 는 기본 잠금이 아니어야 한다`);
  }
});

test('A4. 비용 heavy 규칙 — 영상·리서치·입력 자동화가 heavy 배지', () => {
  const heavy = MULTIMEDIA_CARDS.filter((c) => c.costAccent === 'heavy').map((c) => c.route).sort();
  assert.deepEqual(heavy, ['input-automation', 'research', 'video']);
});

test('A5. parseMultimediaRoute — 슬러그 → route key', () => {
  assert.equal(parseMultimediaRoute('/multimedia'), 'hub');
  assert.equal(parseMultimediaRoute('/multimedia/'), 'hub');
  assert.equal(parseMultimediaRoute('/multimedia/pdf'), 'pdf');
  assert.equal(parseMultimediaRoute('/multimedia/input-automation'), 'input-automation');
  assert.equal(parseMultimediaRoute('/multimedia/unknown-axis'), 'hub', '미지 슬러그는 허브로 폴백');
});

test('A6. resolveCardByRoute / resolveCardByUrlPath 가 동일 카드를 돌려준다', () => {
  const byRoute = resolveCardByRoute('research');
  const byUrl = resolveCardByUrlPath('/multimedia/research');
  assert.ok(byRoute && byUrl);
  assert.equal(byRoute!.kind, 'research');
  assert.equal(byRoute!.kind, byUrl!.kind);
  assert.equal(resolveCardByRoute('hub'), null);
});

// ────────────────────────────────────────────────────────────────────────────
// B. useMultimediaJobs — 스토어 직접 검증
// ────────────────────────────────────────────────────────────────────────────

test('B1. start 는 신규 job 을 큐 상태로 추가하고 id 를 돌려준다', () => {
  let t = 1000;
  const store = createMultimediaJobsStore(() => (t += 10));
  const id = store.start({ kind: 'pdf', title: '요약' });
  const jobs = store.getSnapshot();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  assert.equal(jobs[0].status, 'queued');
  assert.equal(jobs[0].progress, 0);
});

test('B2. update / complete / fail — 상태 전이 · updatedAtMs 갱신', () => {
  let t = 1000;
  const store = createMultimediaJobsStore(() => (t += 10));
  const id = store.start({ kind: 'video', title: 'hero' });
  store.update(id, { status: 'running', progress: 0.5, phase: 'mid' });
  assert.equal(store.getSnapshot()[0].status, 'running');
  assert.equal(store.getSnapshot()[0].progress, 0.5);
  store.complete(id, '1.2s · 1080p');
  const done = store.getSnapshot()[0];
  assert.equal(done.status, 'completed');
  assert.equal(done.progress, 1);
  assert.equal(done.resultSummary, '1.2s · 1080p');
  store.fail(id, '디스크 부족');
  const failed = store.getSnapshot()[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorMessage, '디스크 부족');
});

test('B3. subscribe — 상태 변경마다 리스너 호출', () => {
  const store = createMultimediaJobsStore();
  const snapshots: number[] = [];
  const unsubscribe = store.subscribe((jobs) => snapshots.push(jobs.length));
  const id = store.start({ kind: 'research', title: 'X' });
  store.update(id, { status: 'running' });
  store.complete(id);
  unsubscribe();
  store.clearAll();
  assert.deepEqual(snapshots, [1, 1, 1], '리스너 호출 횟수가 상태 변경과 일치');
});

test('B4. cancel / clear / clearAll', () => {
  const store = createMultimediaJobsStore();
  const a = store.start({ kind: 'pdf', title: 'A' });
  const b = store.start({ kind: 'pptx', title: 'B' });
  store.cancel(a);
  assert.equal(store.getSnapshot().find((j) => j.id === a)!.status, 'cancelled');
  store.clear(b);
  assert.equal(store.getSnapshot().length, 1);
  store.clearAll();
  assert.equal(store.getSnapshot().length, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// C. 정적 소스 계약
// ────────────────────────────────────────────────────────────────────────────

test('C1. MultimediaHub.tsx — section aria-labelledby + h1 title id 매칭', () => {
  const src = readRepo('src/views/multimedia/MultimediaHub.tsx');
  assert.match(src, /aria-labelledby="multimedia-hub-title"/);
  assert.match(src, /id="multimedia-hub-title"/);
  assert.match(src, /data-testid="multimedia-hub"/);
  assert.match(src, /role="grid"/);
});

test('C2. MultimediaHub.tsx — 4 카테고리 탭 + 6 카드 data-testid 노출', () => {
  const src = readRepo('src/views/multimedia/MultimediaHub.tsx');
  for (const id of ['documents', 'research', 'video', 'automation']) {
    assert.match(src, new RegExp(`multimedia-hub-category-\\$\\{cat\\.id\\}|multimedia-hub-category-${id}`),
      `카테고리 탭 ${id} 가 data-testid 로 노출되어야 한다`);
  }
  // 카드 testid 는 동적 — route 키가 들어가므로 템플릿 문자열 형태만 확인
  assert.match(src, /data-testid=\{`multimedia-hub-card-\$\{card\.route\}`\}/);
  assert.match(src, /data-testid=\{`multimedia-hub-card-\$\{card\.route\}-cta`\}/);
  assert.match(src, /data-testid=\{`multimedia-hub-card-\$\{card\.route\}-cost`\}/);
});

test('C3. MultimediaAdapterShell.tsx — phase 4상태 + aria-busy 일치', () => {
  const src = readRepo('src/views/multimedia/MultimediaAdapterShell.tsx');
  for (const phase of ['empty', 'form', 'loading', 'success', 'error']) {
    assert.match(src, new RegExp(`phase === '${phase}'`),
      `${phase} phase 렌더 분기가 있어야 한다`);
  }
  assert.match(src, /aria-busy=\{phase === 'loading' \|\| undefined\}/);
  assert.match(src, /role="alert"/);
  assert.match(src, /role="progressbar"/);
});

test('C4. MultimediaAdapterShell.tsx — 허브 디자인 시스템 토큰 재사용(H-07 "신규 색 토큰 0")', () => {
  const src = readRepo('src/views/multimedia/MultimediaAdapterShell.tsx');
  // 시안 §6.1 의 필수 재사용 토큰이 참조돼야 한다.
  for (const token of [
    '--media-asset-surface-bg',
    '--attachment-preview-border',
    '--error-state-bg',
    '--error-state-border',
    '--error-state-strip',
    '--shared-goal-modal-field-focus',
    '--shared-goal-modal-confirm-bg',
    '--token-gauge-track',
  ]) {
    assert.ok(src.includes(token), `${token} 토큰이 Shell 에서 참조되어야 한다`);
  }
  // 신규 `--media-hub-*` 색 토큰이 Shell 에서 새로 선언/정의되지는 않는다.
  // 정의는 css 에서만 하고 컴포넌트는 var() 참조만 해야 한다.
  assert.doesNotMatch(src, /^\s*--media-hub-[a-z-]+:/m,
    'Shell 에서 --media-hub-* 토큰을 직접 선언하면 안 된다');
});

test('C5. App.tsx — "multimedia" 탭이 추가되고 사이드바 / 메인 / 단축키 매핑 3곳에 배선', () => {
  const src = readRepo('src/App.tsx');
  assert.match(src, /setActiveTab\('multimedia'\)/);
  assert.match(src, /activeTab === 'multimedia'/);
  assert.match(src, /<MultimediaHub \/>/);
  assert.match(src, /data-testid="sidebar-nav-multimedia"/);
  assert.match(src, /'6':\s*'multimedia'/);
});

test('C6. PlaceholderAdapterView — 레지스트리 미등록 처리 + 잠금 전달 계약', () => {
  const src = readRepo('src/views/multimedia/adapterViews/PlaceholderAdapterView.tsx');
  assert.match(src, /registered\s*=\s*true/);
  assert.match(src, /ADAPTER_NOT_REGISTERED/);
  assert.match(src, /useMultimediaJobs\(\)/);
  assert.match(src, /locked=\{props\.locked\}/);
});
