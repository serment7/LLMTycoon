// Run with: npx tsx --test tests/projects/createProjectDialogI18n.unit.test.ts
//
// 지시 #fdee74ae — CreateProjectDialog 가 참조하는 `projects.recommend.*` i18n 키가
// ko/en 양 locale 에 누락 없이 존재하는지 잠근다. 누락되면 translate() 가 key 원문을
// 돌려주므로 화면에 "projects.recommend.addToTeam" 같은 점 경로가 그대로 노출된다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { translate } from '../../src/i18n/index.ts';

const REQUIRED_KEYS: readonly string[] = [
  'projects.recommend.title',
  'projects.recommend.intro',
  'projects.recommend.cta',
  'projects.recommend.ctaHint',
  'projects.recommend.loading',
  'projects.recommend.empty',
  'projects.recommend.error',
  'projects.recommend.retry',
  'projects.recommend.regenerate',
  'projects.recommend.addToTeam',
  'projects.recommend.addAll',
  'projects.recommend.addedBadge',
  'projects.recommend.failedBadge',
  'projects.recommend.seedOnCreate',
  'projects.recommend.seedCount',
  'projects.recommend.pendingSeed',
  'projects.recommend.source.heuristic',
  'projects.recommend.source.claude',
  'projects.recommend.source.cache',
  'projects.recommend.source.translated',
];

test('I1. projects.recommend.* — en 로케일 모든 키가 번역 문자열을 돌려준다', () => {
  for (const key of REQUIRED_KEYS) {
    const translated = translate(key, 'en');
    assert.notEqual(translated, key, `en 에 ${key} 가 등록되지 않음`);
    assert.ok(translated.length > 0, `${key} 가 빈 문자열`);
  }
});

test('I2. projects.recommend.* — ko 로케일 모든 키가 번역 문자열을 돌려준다', () => {
  for (const key of REQUIRED_KEYS) {
    const translated = translate(key, 'ko');
    assert.notEqual(translated, key, `ko 에 ${key} 가 등록되지 않음`);
    assert.ok(translated.length > 0, `${key} 가 빈 문자열`);
  }
});

test('I3. projects.recommend.seedCount — {count} 플레이스홀더를 보존한다', () => {
  // interpolate() 는 UI 측 공용 유틸이므로 여기서는 i18n 리소스가 원문 그대로
  // 플레이스홀더를 유지하고 있는지만 확인한다.
  assert.match(translate('projects.recommend.seedCount', 'en'), /\{count\}/);
  assert.match(translate('projects.recommend.seedCount', 'ko'), /\{count\}/);
});
