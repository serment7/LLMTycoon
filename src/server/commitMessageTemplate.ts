// 태스크 경계 커밋(#f3c0ea52) 전용 한국어 커밋 메시지 템플릿 생성기.
//
// 기존 `src/utils/gitAutomation.ts::formatCommitMessage` 는 "설정 기반 템플릿"
// (type/scope/summary 를 Conventional Commits 형식으로 조립) 이다. 본 모듈은
// 여기에 태스크 description 과 변경 파일 목록을 결합하는 한 겹 위의 책임을
// 맡는다 — 입력은 "사람이 이해하는 맥락" 이고, 출력은 "기존 커밋 스타일에 맞는
// 한 줄 제목".
//
// 최근 커밋(4aed31a · fdda31b · d0a2e68) 에서 관찰된 스타일:
//   · `"{type}: {요약}"` — 짧은 영문 type + 콜론 + 한국어 요약
//   · 말미에 검증 결과를 괄호로 병기: "… 회귀 테스트 추가(16건 통과)"
//   · 스코프는 생략이 기본(코드가 특정 레이어에 한정될 때만 덧붙인다)
//
// 본 모듈은 이 관찰을 다음 결정 규칙으로 정리한다(우선순위 순):
//   1) description 이 이미 `"{type}: "` 로 시작하면 그 type 을 존중한다.
//   2) 아니면 변경 파일 경로 패턴으로 type 을 추론한다(tests/ → test, docs/ →
//      docs, src/server/ 또는 src/components/ → feat, 그 외 설정성 파일만이면
//      chore).
//   3) 요약은 description 의 나머지 본문을 공백 정규화해 80자 이내로 사용
//      (잘라내지 않는다 — 최근 커밋에서 80자 이상 요약도 그대로 두었다).
//   4) 검증 결과(verified) 가 주어지면 말미에 "(…)" 로 붙인다.
//
// 모든 판단은 순수 함수로 구현해 jsdom 없이 바로 회귀가 돈다.

export interface CommitMessageTemplateInput {
  /** 태스크 설명(원문). `type: 요약` 형태가 이미 포함돼 있으면 그 type 을 승격. */
  description: string;
  /** 변경 파일 상대 경로 배열(워크스페이스 루트 기준). */
  changedFiles: readonly string[];
  /**
   * 선택 — 검증 결과 한 줄 요약(예: `"12건 통과"`, `"타입 검사 OK"`). 제공 시
   * 최종 제목 말미에 ` (…)` 로 덧붙인다. 최근 커밋의 `(16건 통과)` 규약과 일치.
   */
  verified?: string;
  /**
   * 선택 — 접두어(예: `"auto: "`). `GitAutomationSettings.commitMessagePrefix`
   * 값을 그대로 받는다. 빈 문자열이면 접두어 없이 원문 유지.
   */
  prefix?: string;
}

const CONVENTIONAL_TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore',
] as const;

/** description 이 `"type: 본문"` 형태라면 그 type 과 본문을 분리해 돌려준다. */
function splitTypedDescription(desc: string): { type: string | null; body: string } {
  const m = desc.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
  if (!m) return { type: null, body: desc };
  const typeCandidate = m[1].toLowerCase();
  if (!CONVENTIONAL_TYPES.includes(typeCandidate as (typeof CONVENTIONAL_TYPES)[number])) {
    // 알려지지 않은 접두어는 "type" 이 아니라 일반 문장의 일부로 취급.
    return { type: null, body: desc };
  }
  return { type: typeCandidate, body: m[2] };
}

/**
 * 변경 파일 배열의 경로 패턴으로 Conventional Commits type 을 추론한다.
 * 휴리스틱:
 *   · 모두 `tests/` 하위  → `test`
 *   · 모두 `docs/`  하위  → `docs`
 *   · `src/server/` 또는 `src/utils/` 코드가 섞이면 → `feat`
 *   · `src/components/` 만 있으면 → `feat`
 *   · 설정·루트 파일만 (package.json, tsconfig 등) → `chore`
 *   · 그 외 → `chore` 폴백
 */
export function inferCommitTypeFromPaths(paths: readonly string[]): string {
  if (paths.length === 0) return 'chore';
  const norm = paths.map(p => p.replace(/\\/g, '/').trim()).filter(Boolean);
  if (norm.length === 0) return 'chore';
  const allIn = (prefix: string) => norm.every(p => p.startsWith(prefix));
  if (allIn('tests/')) return 'test';
  if (allIn('docs/')) return 'docs';
  const anyCode = norm.some(p => p.startsWith('src/server/') || p.startsWith('src/utils/') || p.startsWith('src/components/') || p === 'server.ts');
  if (anyCode) {
    // 테스트만 있는 경우는 위에서 잡혔으므로 여기서는 "코드 변경이 섞였다" 의 의미.
    return 'feat';
  }
  return 'chore';
}

/**
 * 공백 정규화 + 80자 제한 완화 요약. 최근 커밋 중 `(16건 통과)` 말미 괄호가 있는
 * 사례가 80자를 넘어도 그대로 보존됐으므로, 본 함수도 **자르지 않는다**. 다만 연속
 * 공백/개행은 하나의 공백으로 압축해 한 줄 제목을 보장한다.
 */
export function normalizeSummary(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 태스크 경계 커밋 제목을 한 줄로 조립한다. 출력 예:
 *   · `"test: 상단바 Claude 토큰 사용량 위젯 회귀 테스트 추가(16건 통과)"`
 *   · `"feat: mediaGenerator 에 exhausted 가드 추가"`
 *   · `"auto: chore: 설정 파일 정리"` (prefix 가 지정된 경우)
 */
export function buildTaskBoundaryCommitMessage(input: CommitMessageTemplateInput): string {
  const desc = (input.description ?? '').trim();
  const { type: explicitType, body } = splitTypedDescription(desc);
  const type = explicitType ?? inferCommitTypeFromPaths(input.changedFiles);
  const summary = normalizeSummary(body || desc) || 'update';
  const withVerified = input.verified && input.verified.trim().length > 0
    ? `${summary}(${input.verified.trim()})`
    : summary;
  const core = `${type}: ${withVerified}`;
  const prefix = (input.prefix ?? '').trim();
  if (!prefix) return core;
  // 접두어가 이미 `"type: "` 형태라면 그대로 덧붙이고, 아니면 공백 보정.
  return prefix.endsWith(' ') ? `${prefix}${core}` : `${prefix} ${core}`;
}
