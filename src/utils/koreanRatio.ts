// 에이전트 응답의 한국어 비율 검증.
//
// 시스템 프롬프트가 "한국어로만 답하라" 를 강하게 명시하지만, 모델이 영어로 떨어지는
// 회귀가 종종 관찰된다. 매 응답마다 한글:영문 비율을 계산해 일정 임계값 이하이면
// 재요청 또는 경고로 흐름을 보호한다.
//
// 검증 대상에서 제외해야 하는 토큰들 (게임 도메인상 영문이 정상인 부분):
//  - 코드 블록(```...```) · 인라인 코드(`...`)
//  - 파일 경로 (./src/foo.tsx, /api/bar, C:\Users\..., a/b/c)
//  - URL (http://..., https://...)
//  - camelCase / PascalCase / snake_case 식별자
//  - 점 표기 식별자 (foo.bar.baz)
// 위를 먼저 strip 한 뒤 남은 본문에서 한글/영문 글자만 카운트해 비율을 낸다.

// 한글 범위: 음절(\uac00-\ud7a3) + 호환 자모(\u3131-\u318f, 예: ㅋ/ㅎ/ㅠ) + 초/중/종성 자모(\u1100-\u11ff).
// "ㅋㅋㅋ" 같은 자모-only 텍스트도 한국어 신호로 집계한다.
const HANGUL_REGEX = /[\uac00-\ud7a3\u3131-\u318f\u1100-\u11ff]/g;
const ALPHA_REGEX = /[A-Za-z]/g;

export function stripCodeAndIdentifiers(input: string): string {
  if (!input) return '';
  let s = input;
  // 1) 펜스 코드블록
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // 2) 인라인 코드
  s = s.replace(/`[^`]*`/g, ' ');
  // 3) URL
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  // 4) 파일/디렉터리 경로 — 슬래시·백슬래시·콜론을 끼고 있는 토큰 제거
  s = s.replace(/[A-Za-z0-9_.@~-]*[\\/][A-Za-z0-9_./\\@~-]+/g, ' ');
  // 5) Windows 드라이브 경로 (C:\...) — 단독 형태도 제거
  s = s.replace(/\b[A-Za-z]:\\[^\s]*/g, ' ');
  // 6) 점 표기 식별자 (foo.bar / foo.bar.baz)
  s = s.replace(/\b[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+\b/g, ' ');
  // 7) PascalCase / camelCase / snake_case 식별자(대문자나 _ 가 끼어 있는 영문 토큰)
  s = s.replace(/\b[A-Za-z_][A-Za-z0-9]*(?:[A-Z_][A-Za-z0-9_]*)+\b/g, ' ');
  return s;
}

// 한글 대 (한글+영문) 비율. 두 글자 카운트가 모두 0이면 0 반환(검증 의미 없음).
export function koreanRatio(text: string): number {
  const cleaned = stripCodeAndIdentifiers(text || '');
  const hangul = cleaned.match(HANGUL_REGEX)?.length ?? 0;
  const alpha = cleaned.match(ALPHA_REGEX)?.length ?? 0;
  const denom = hangul + alpha;
  if (denom === 0) return 0;
  return hangul / denom;
}

// 한글 비율이 임계값 이상인가. 짧은 응답(예: "ok", "ack") 은 통계적 의미가 없어
// 통과 처리한다 — false-positive 가 흐름을 막는 비용이 너무 크다.
export const DEFAULT_KOREAN_THRESHOLD = 0.4;
export const MIN_KOREAN_SAMPLE_LENGTH = 16;

export function isMostlyKorean(text: string, threshold: number = DEFAULT_KOREAN_THRESHOLD): boolean {
  if (!text) return true;
  const cleaned = stripCodeAndIdentifiers(text);
  if (cleaned.replace(/\s+/g, '').length < MIN_KOREAN_SAMPLE_LENGTH) return true;
  const hangul = cleaned.match(HANGUL_REGEX)?.length ?? 0;
  const alpha = cleaned.match(ALPHA_REGEX)?.length ?? 0;
  // 측정 가능한 언어 신호가 전혀 없으면(숫자/구두점/이모지만) 통과로 취급한다 —
  // 분모 0 인 상태를 "한국어 0%" 로 해석하면 오경고가 터진다.
  if (hangul + alpha === 0) return true;
  return hangul / (hangul + alpha) >= threshold;
}

// 리더 분배 응답({tasks:[{description}], message}) 의 자연어 영역만 모아서 검증
// 표본을 만든다. JSON 파싱이 실패하면 원문 그대로 돌려준다.
// description / message 외의 키는 제외해 JSON 키 자체가 영문이라는 이유로
// 잘못된 alarm 이 떨어지지 않도록 한다.
export function collectNaturalLanguageSample(text: string): string {
  if (!text) return '';
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed === 'object') {
        const parts: string[] = [];
        if (typeof parsed.message === 'string') parts.push(parsed.message);
        if (Array.isArray(parsed.tasks)) {
          for (const t of parsed.tasks) {
            if (t && typeof t.description === 'string') parts.push(t.description);
          }
        }
        if (parts.length > 0) return parts.join('\n');
      }
    } catch {
      // 파싱 실패 → 원문 fallback
    }
  }
  return text;
}
