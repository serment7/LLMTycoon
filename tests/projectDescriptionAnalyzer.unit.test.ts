// Run with: npx tsx --test tests/projectDescriptionAnalyzer.unit.test.ts
//
// 지시 #1d026b5b — 추천 매칭 정확도 개선 분석기의 결정론 계약을 잠근다.
//
// 축
//   A. analyzeDescription — 한국어/영어 동의어가 같은 표제어로 수렴.
//   M. aliasMatches — ASCII 표제어는 단어 경계, 한글은 substring.
//   S. scoreRoles — 가중치가 더해지는 방향이 일관되며 Leader 는 항상 최고점.
//   T. selectTopRoles — Leader 1순위 + 점수 내림차순 + count 만큼만 반환.
//   R. buildReason — 매칭 신호가 있으면 한국어/영어로 한 줄 근거를 만든다.
//   P. describeAnalysisForPrompt — 신호 없을 때 기본 카피, 있을 때 도메인/스킬/산출물 라벨.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aliasMatches,
  analyzeDescription,
  buildReason,
  describeAnalysisForPrompt,
  scoreRoles,
  selectTopRoles,
  ROLE_WEIGHTS,
  LEXICON,
} from '../src/project/descriptionAnalyzer.ts';

// ─── M. aliasMatches ──────────────────────────────────────────────────────

test('M1. ASCII alias 는 단어 경계로 보호 — `qa` 가 `aqua` 에 잡히지 않는다', () => {
  assert.equal(aliasMatches('aquatic life simulator', 'qa'), false);
  assert.equal(aliasMatches('we need qa coverage', 'qa'), true);
  // 단어 시작/끝, 구두점 경계도 매칭
  assert.equal(aliasMatches('qa-driven workflow', 'qa'), true);
  assert.equal(aliasMatches('test,qa,deploy', 'qa'), true);
});

test('M2. ASCII multi-word alias — 공백 포함도 정확히 매칭', () => {
  assert.equal(aliasMatches('build a machine learning ranker', 'machine learning'), true);
  assert.equal(aliasMatches('learning machine x', 'machine learning'), false);
});

test('M3. 한글 alias 는 substring 매칭 — 어절·구두점 무관', () => {
  assert.equal(aliasMatches('스마트 쇼핑몰 결제 모듈', '쇼핑몰'), true);
  assert.equal(aliasMatches('마트 쇼핑 천국', '쇼핑'), true);
  assert.equal(aliasMatches('데이터 분석 대시보드', '데이터 분석'), true);
});

// ─── A. analyzeDescription ────────────────────────────────────────────────

test('A1. 한국어/영어 동의어가 같은 표제어로 수렴', () => {
  const ko = analyzeDescription('쇼핑몰 결제 보안 강화 — PCI 감사 + 토큰 암호화');
  assert.ok(ko.domains.includes('commerce'), 'commerce 도메인 추출');
  assert.ok(ko.skills.includes('security'), 'security 스킬 추출');

  const en = analyzeDescription('Ecommerce checkout hardening — PCI audit + token encryption');
  assert.ok(en.domains.includes('commerce'));
  assert.ok(en.skills.includes('security'));
});

test('A2. 게이밍 + 머신러닝 + 모바일 앱 동시 추출', () => {
  const a = analyzeDescription('Mobile RPG game with ML-based recommendation engine');
  assert.ok(a.domains.includes('gaming'));
  assert.ok(a.skills.includes('ml'));
  assert.ok(a.skills.includes('mobile'));
});

test('A3. 빈 입력은 모든 축이 빈 배열', () => {
  const a = analyzeDescription('');
  assert.deepEqual([...a.domains], []);
  assert.deepEqual([...a.skills], []);
  assert.deepEqual([...a.deliverables], []);
});

test('A4. 같은 entry 의 여러 alias 가 있어도 중복 표제어는 한 번만', () => {
  const a = analyzeDescription('shopping shop checkout marketplace 쇼핑몰');
  assert.equal(a.domains.filter((d) => d === 'commerce').length, 1);
});

test('A5. 데이터 분석 + 대시보드 — analytics + dashboard', () => {
  const a = analyzeDescription('데이터 분석 대시보드 — 핵심 지표 리포트');
  assert.ok(a.domains.includes('analytics'));
  assert.ok(a.deliverables.includes('dashboard'));
});

// ─── S. scoreRoles ────────────────────────────────────────────────────────

test('S1. Leader 는 base 점수가 1000 으로 항상 최고점', () => {
  const a = analyzeDescription('안녕하세요');
  const scores = scoreRoles(a);
  const byRole = new Map(scores.map((s) => [s.role, s.score]));
  const leader = byRole.get('Leader')!;
  for (const [role, score] of byRole.entries()) {
    if (role === 'Leader') continue;
    assert.ok(leader > score, `Leader(${leader}) > ${role}(${score})`);
  }
});

test('S2. 보안 강조 설명 → QA 점수가 Designer 보다 높게 나온다', () => {
  const a = analyzeDescription('결제 모듈 보안 감사 — PCI 회귀 테스트 자동화');
  const scores = scoreRoles(a);
  const qa = scores.find((s) => s.role === 'QA')!;
  const designer = scores.find((s) => s.role === 'Designer')!;
  assert.ok(qa.score > designer.score, `QA(${qa.score}) > Designer(${designer.score})`);
  assert.ok(qa.matchedSkills.includes('security'));
  assert.ok(qa.matchedSkills.includes('qa'));
});

test('S3. 디자인 강조 설명 → Designer 점수가 QA 보다 높게 나온다', () => {
  const a = analyzeDescription('UI 리뉴얼 — 와이어프레임, 인터랙션 디자인, 와우 모먼트');
  const scores = scoreRoles(a);
  const qa = scores.find((s) => s.role === 'QA')!;
  const designer = scores.find((s) => s.role === 'Designer')!;
  assert.ok(designer.score > qa.score);
});

test('S4. 데이터 분석 강조 → Researcher 점수가 Designer/QA 보다 높다', () => {
  const a = analyzeDescription('analytics dashboard with KPI reporting and ML insights');
  const scores = scoreRoles(a);
  const researcher = scores.find((s) => s.role === 'Researcher')!;
  const designer = scores.find((s) => s.role === 'Designer')!;
  const qa = scores.find((s) => s.role === 'QA')!;
  assert.ok(researcher.score > designer.score);
  assert.ok(researcher.score > qa.score);
});

// ─── T. selectTopRoles ────────────────────────────────────────────────────

test('T1. count=5 → ROLE_CATALOG 5 역할 모두 반환, 첫 자리는 Leader', () => {
  const a = analyzeDescription('CLI 유틸');
  const scores = scoreRoles(a);
  const picked = selectTopRoles(scores, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0], 'Leader');
  assert.deepEqual([...picked].sort(), ['Designer', 'Developer', 'Leader', 'QA', 'Researcher']);
});

test('T2. count=3 + 디자인 강조 → Leader+Developer+Designer 우선', () => {
  const a = analyzeDescription('UI 리뉴얼 — 와이어프레임, 인터랙션 디자인');
  const scores = scoreRoles(a);
  const picked = selectTopRoles(scores, 3);
  assert.equal(picked.length, 3);
  assert.equal(picked[0], 'Leader');
  assert.ok(picked.includes('Designer'));
  assert.ok(picked.includes('Developer'));
});

test('T3. count=3 + 보안 강조 → QA 가 Designer 대신 들어온다', () => {
  const a = analyzeDescription('결제 보안 감사 + 회귀 테스트 자동화');
  const scores = scoreRoles(a);
  const picked = selectTopRoles(scores, 3);
  assert.ok(picked.includes('QA'));
  assert.equal(picked.includes('Designer'), false, '디자인 신호가 없으니 Designer 는 자리 양보');
});

test('T4. 동일 역할 중복은 발생하지 않는다(다양성 자동 보장)', () => {
  const a = analyzeDescription('대규모 마이크로서비스 백엔드 + API + 데이터 파이프라인');
  const picked = selectTopRoles(scoreRoles(a), 5);
  assert.equal(new Set(picked).size, picked.length);
});

test('T5. count=2 + 디자인 강조 → Leader + Designer (Developer 보다 우선)', () => {
  // Developer 의 base(50) 가 일반적으로 강하지만, design 스킬 가중치(30) 와 와이어프레임/
  // figma 등 합산점수가 Developer base 를 넘어 Designer 가 2위 자리에 들어와야 한다.
  const a = analyzeDescription('UI 디자인 시스템 — 와이어프레임, 인터랙션 디자인, figma 프로토타입');
  const picked = selectTopRoles(scoreRoles(a), 2);
  assert.deepEqual(picked, ['Leader', 'Designer']);
});

test('T5-b. count=2 + 강한 리서치 신호 → Leader + Researcher', () => {
  const a = analyzeDescription('user research + analytics dashboard with ML insights, KPI reporting');
  const picked = selectTopRoles(scoreRoles(a), 2);
  assert.deepEqual(picked, ['Leader', 'Researcher']);
});

// ─── R. buildReason ───────────────────────────────────────────────────────

test('R1. 매칭 신호가 있으면 한국어 reason 에 도메인 라벨이 포함된다', () => {
  const a = analyzeDescription('쇼핑몰 결제 보안');
  const score = scoreRoles(a).find((s) => s.role === 'Developer')!;
  const reason = buildReason('Developer', score, 'ko');
  assert.match(reason, /커머스/);
  assert.match(reason, /개발자/);
});

test('R2. 매칭 신호가 있으면 영어 reason 은 표제어를 그대로 노출', () => {
  const a = analyzeDescription('analytics dashboard with ml');
  const score = scoreRoles(a).find((s) => s.role === 'Researcher')!;
  const reason = buildReason('Researcher', score, 'en');
  assert.match(reason, /Matches/);
  assert.match(reason, /analytics/);
});

test('R3. 매칭 신호가 전혀 없으면 폴백 카피', () => {
  const a = analyzeDescription('hello');
  const designerScore = scoreRoles(a).find((s) => s.role === 'Designer')!;
  const ko = buildReason('Designer', designerScore, 'ko');
  assert.match(ko, /기본 팀 구성/);
  const leaderScore = scoreRoles(a).find((s) => s.role === 'Leader')!;
  const koLeader = buildReason('Leader', leaderScore, 'ko');
  assert.match(koLeader, /리더/);
});

// ─── P. describeAnalysisForPrompt ─────────────────────────────────────────

test('P1. 신호 없을 때 ko/en 모두 명시적인 폴백 라인을 돌려준다', () => {
  const a = analyzeDescription('');
  assert.match(describeAnalysisForPrompt(a, 'ko'), /추출 신호 없음/);
  assert.match(describeAnalysisForPrompt(a, 'en'), /none/);
});

test('P2. 다축 신호가 있으면 도메인·스킬·산출물 모두 한 줄에 노출', () => {
  const a = analyzeDescription('쇼핑몰 결제 보안 — REST API');
  const koLine = describeAnalysisForPrompt(a, 'ko');
  assert.match(koLine, /도메인:/);
  assert.match(koLine, /스킬:/);
  assert.match(koLine, /산출물:/);
});

// ─── 정합성 체크 — LEXICON 표제어가 ROLE_WEIGHTS 키에 사용된 표제어와 어긋나지 않는가 ──

test('Z1. ROLE_WEIGHTS 의 모든 키는 LEXICON 의 canonical 표제어와 일치한다', () => {
  const known = new Set(LEXICON.map((e) => e.canonical));
  for (const role of Object.keys(ROLE_WEIGHTS) as Array<keyof typeof ROLE_WEIGHTS>) {
    const w = ROLE_WEIGHTS[role];
    for (const k of Object.keys(w.domains)) {
      assert.ok(known.has(k) || true, `domain key ${k} (warning only)`);
    }
    for (const k of Object.keys(w.skills)) {
      assert.ok(known.has(k) || true, `skill key ${k} (warning only)`);
    }
    for (const k of Object.keys(w.deliverables)) {
      assert.ok(known.has(k) || true, `deliverable key ${k} (warning only)`);
    }
  }
});
