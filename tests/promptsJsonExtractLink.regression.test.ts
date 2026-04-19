// Run with: npx tsx --test tests/promptsJsonExtractLink.regression.test.ts
//
// 회귀 테스트: `src/server/prompts.ts` 가 `src/server/promptsJsonExtract.ts` 의
// `findBalancedJsonCandidates` 를 **실제로 import 해서 사용** 하는지 **정적 연결** 을
// 잠근다.
//
// 배경
// ─────────────────────────────────────────────────────────────────────────────
// 기존 promptsJsonExtract.robustness.test.ts 는 `extractLeaderPlan` 의 견고성을
// 다각도로 검증하지만, "prompts.ts 가 두 유틸을 실제로 쓰는가" 자체는 잠그지 않는다.
// 만약 누군가 `prompts.ts` 에서 다시 raw regex(예: `text.match(/\{[\s\S]*\}/)`) 로
// 되돌리면 robustness 테스트는 통과하지만 근본 회귀(리더 JSON 추출 취약) 가
// 조용히 재발한다. 본 파일은 이 "정적 연결" 자체를 별도로 고정한다.
//
// 또한 `src/server/agentWorker.ts` 의 NDJSON 파싱(`JSON.parse(line)`) 은
// **LLM 응답 텍스트가 아닌 stream-json 프로토콜** 을 처리하므로 promptsJsonExtract
// 를 써서는 안 된다는 점을 코멘트와 음성 테스트로 명시한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_PATH = resolve(__dirname, '..', 'src', 'server', 'prompts.ts');
const WORKER_PATH = resolve(__dirname, '..', 'src', 'server', 'agentWorker.ts');

test('prompts.ts 는 promptsJsonExtract 에서 findBalancedJsonCandidates 를 import 한다', () => {
  const src = readFileSync(PROMPTS_PATH, 'utf8');
  assert.match(
    src,
    /import\s*\{[^}]*\bfindBalancedJsonCandidates\b[^}]*\}\s*from\s*['"]\.\/promptsJsonExtract['"]/,
    "`import { findBalancedJsonCandidates } from './promptsJsonExtract'` 가 있어야 한다",
  );
});

test('prompts.ts 는 raw regex `{[\\s\\S]*}` 로 JSON 을 긁지 않는다', () => {
  const src = readFileSync(PROMPTS_PATH, 'utf8');
  // 과거 구현이 썼던 greedy 정규식이 되살아나면 multi-block · fenced · string-brace
  // 회귀가 한꺼번에 터진다. 문자열 리터럴 또는 정규식 리터럴 둘 다 금지.
  assert.doesNotMatch(
    src,
    /\.match\(\s*\/\\\{\[\\s\\S\]\*\\\}\//,
    'prompts.ts 에 `.match(/\\{[\\s\\S]*\\}/)` 같은 greedy 정규식이 남아 있다 — findBalancedJsonCandidates 로 교체하라',
  );
});

test('prompts.ts 의 extractLeaderPlan 안에서 findBalancedJsonCandidates 가 호출된다', () => {
  const src = readFileSync(PROMPTS_PATH, 'utf8');
  // 함수 시작부터 닫는 중괄호까지의 블록을 개략적으로 잡아, 그 안에서 호출
  // 사실만 확인한다(함수 내부 파싱 없이 간단한 정적 검사로 충분).
  const startIdx = src.indexOf('export function extractLeaderPlan');
  assert.ok(startIdx >= 0, 'extractLeaderPlan 선언을 찾을 수 없다');
  const rest = src.slice(startIdx);
  assert.match(
    rest,
    /findBalancedJsonCandidates\s*\(\s*text\s*\)/,
    'extractLeaderPlan 내부에서 findBalancedJsonCandidates(text) 가 호출되어야 한다',
  );
});

test('agentWorker.ts 는 promptsJsonExtract 를 import 하지 않는다 (NDJSON 경계)', () => {
  const src = readFileSync(WORKER_PATH, 'utf8');
  // agentWorker 는 stream-json(NDJSON) 를 한 줄씩 JSON.parse 하므로 LLM 응답용
  // 블록 스캐너가 들어가면 오히려 회귀가 된다. 실수로 리팩터링 시 이 경계를
  // 넘지 않도록 음성 테스트로 잠근다.
  assert.doesNotMatch(
    src,
    /from\s+['"][^'"]*promptsJsonExtract['"]/,
    'agentWorker.ts 가 promptsJsonExtract 를 import 한다 — NDJSON 파싱 경로에는 해당 유틸을 적용하지 말 것',
  );
});
