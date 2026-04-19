// Run with: npx tsx --test src/components/EmptyProjectPlaceholder.test.tsx
//
// 디자이너 회귀 고정(#EMPTY-ACTIVE-SCOPE): 프로젝트 미선택 플레이스홀더에서
// activeScope prop 을 넘겼을 때, 해당 메뉴 라벨이
//   1) 본문 바로 아래 "접근하려던 메뉴 · {라벨}" 인라인 힌트로 노출되고
//   2) scope-badge 목록 중 동일 라벨 배지에 data-active="true" 가 붙으며
//   3) scopes 배열에 없는 라벨을 넘기면 조용히 무시된다
// 라는 사용자 불변식을 DOM 관찰로 고정한다. CSS 는 data-active 에 바인딩되므로
// 클래스 자체가 아니라 data 속성과 aria-current 속성으로 assert 한다.

import 'global-jsdom/register';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

import { EmptyProjectPlaceholder } from './EmptyProjectPlaceholder.tsx';

afterEach(() => {
  cleanup();
});

function renderPlaceholder(extra: Record<string, unknown> = {}) {
  return render(
    <EmptyProjectPlaceholder
      projectCount={0}
      onOpenProjectList={() => {}}
      onCreateProject={() => {}}
      {...extra}
    />,
  );
}

test('activeScope 라벨이 본문 힌트로 노출된다', () => {
  const { container } = renderPlaceholder({ activeScope: '프로젝트 관리' });
  const hint = container.querySelector('.empty-project-placeholder__active-scope');
  assert.ok(hint, '접근하려던 메뉴 힌트가 렌더돼야 한다');
  assert.match(hint!.textContent ?? '', /접근하려던 메뉴/);
  assert.match(hint!.textContent ?? '', /프로젝트 관리/);
});

test('activeScope 와 일치하는 scope-badge 에만 data-active="true" 가 붙는다', () => {
  const { container } = renderPlaceholder({ activeScope: '프로젝트 관리' });
  const badges = container.querySelectorAll('.empty-project-placeholder__scope-badge');
  assert.ok(badges.length >= 2, '기본 scopes 가 최소 2개 이상 렌더돼야 한다');
  let activeCount = 0;
  for (const badge of badges) {
    if (badge.getAttribute('data-active') === 'true') {
      activeCount += 1;
      assert.equal(badge.textContent, '프로젝트 관리');
      assert.equal(badge.getAttribute('aria-current'), 'true');
    }
  }
  assert.equal(activeCount, 1, '정확히 하나의 배지만 활성화돼야 한다');
});

test('scopes 배열에 없는 activeScope 는 조용히 무시된다(드리프트 방어)', () => {
  const { container } = renderPlaceholder({
    gatedScopes: ['프로젝트 관리', '코드 그래프'],
    activeScope: '존재하지 않는 메뉴',
  });
  const hint = container.querySelector('.empty-project-placeholder__active-scope');
  assert.equal(hint, null, '미매칭 activeScope 는 힌트를 노출하지 않는다');
  const active = container.querySelector('.empty-project-placeholder__scope-badge[data-active="true"]');
  assert.equal(active, null, '미매칭 activeScope 는 어떤 배지도 활성화하지 않는다');
});

test('activeScope 가 없으면 힌트와 data-active 가 전부 생략된다', () => {
  const { container } = renderPlaceholder();
  const hint = container.querySelector('.empty-project-placeholder__active-scope');
  assert.equal(hint, null);
  const active = container.querySelector('.empty-project-placeholder__scope-badge[data-active="true"]');
  assert.equal(active, null);
});

test('커스텀 gatedScopes 와 activeScope 조합이 동작한다', () => {
  const { container } = renderPlaceholder({
    gatedScopes: ['설정', '모니터링', '로그'],
    activeScope: '모니터링',
  });
  const badges = Array.from(container.querySelectorAll('.empty-project-placeholder__scope-badge'));
  assert.equal(badges.length, 3);
  const labels = badges.map(b => b.textContent);
  assert.deepEqual(labels, ['설정', '모니터링', '로그']);
  const active = container.querySelector('.empty-project-placeholder__scope-badge[data-active="true"]');
  assert.equal(active?.textContent, '모니터링');
});

// ─── 지시 #893b9a4f 보강 ──────────────────────────────────────────────────────

test('currentProjectId 에 실제 ID 가 있으면 플레이스홀더가 숨겨진다', () => {
  const { container } = renderPlaceholder({ currentProjectId: 'proj-abc' });
  assert.equal(
    container.querySelector('.empty-project-placeholder'),
    null,
    '프로젝트가 선택된 상태에서 플레이스홀더가 떠 있으면 회귀',
  );
});

test('projectCount === 0 이면 primary CTA(프로젝트 목록 열기) 가 disabled + aria-disabled 이다', () => {
  const { container } = renderPlaceholder({ projectCount: 0 });
  const primary = container.querySelector<HTMLButtonElement>(
    '.empty-project-placeholder__cta--primary',
  );
  assert.ok(primary, 'primary CTA 가 렌더되어야 한다');
  assert.equal(primary!.disabled, true, 'primary CTA 는 disabled');
  assert.equal(primary!.getAttribute('aria-disabled'), 'true', 'aria-disabled 중복 선언');
});

test('projectCount > 0 이면 primary CTA 가 활성화된다', () => {
  const { container } = renderPlaceholder({ projectCount: 3 });
  const primary = container.querySelector<HTMLButtonElement>(
    '.empty-project-placeholder__cta--primary',
  );
  assert.ok(primary);
  assert.equal(primary!.disabled, false, 'primary CTA 는 활성');
  assert.notEqual(primary!.getAttribute('aria-disabled'), 'true');
});

