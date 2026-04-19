// 리더 에이전트 응답의 JSON 블록을 견고하게 추출하기 위한 유틸. `prompts.ts` 의
// `extractLeaderPlan` 이 과거 썼던 `text.match(/\{[\s\S]*\}/)` 의 세 가지 취약점을
// 교정한다:
//
//   1) 다중 JSON 블록 — 리더가 "분배 예와 답변 예를 둘 다 출력" 한 경우, greedy
//      정규식은 두 블록을 이어붙인 잘못된 문자열을 만든다. 본 스캐너는 **균형 잡힌**
//      중괄호 쌍만 후보로 내놓는다.
//   2) ```json 코드 펜스 — 과거 주석은 방어한다고 선언했지만 실제로는 ``` 를
//      포함한 덩어리를 그대로 JSON.parse 로 넘겨 실패했다. 본 유틸은 앞단에서
//      일괄 제거한다(```json, ```, ~~~json, ~~~ 지원).
//   3) 문자열 리터럴 내 `}` — 문자열 안의 닫는 중괄호가 조기 종료를 유도했다.
//      본 스캐너는 JSON 문자열 상태(`"` 토글 + 백슬래시 이스케이프) 를 추적해
//      중괄호 깊이를 안전하게 센다.
//
// 후보는 "문서에 등장한 순서" 로 반환한다. 호출자는 각 후보를 `JSON.parse` 해
// 본인의 구조 검증을 통과한 첫 후보를 채택하면 된다.

/** 코드 펜스(``` 또는 ~~~) 와 optional language tag 를 제거한 평문을 반환.
 *  추가 정규화:
 *    - UTF-8 BOM(`\uFEFF`) 제거 — LLM 응답이 파일/스트림 경계에서 BOM 을 머금고
 *      오면 첫 후보 JSON.parse 가 "Unexpected token" 으로 실패하던 회귀 차단.
 *    - CRLF/CR 개행을 LF 로 정규화 — Windows 경로에서 넘어온 응답이 `\r` 때문에
 *      펜스 정규식(`\n?`) 을 통과하지 못해 본문 앞뒤에 지저분한 `\r` 가 남던 문제.
 *    - 언어 태그 허용 문자 확장: `json`, `json5`, `json+ld` 처럼 `.` 또는 `+` 를
 *      포함한 태그도 인식. 과거 정규식(`[a-zA-Z0-9_-]*`) 은 `+` 를 만나면 태그
 *      전체를 놓치고 `+ld\n` 가 본문에 섞여 들어왔다.
 */
export function stripCodeFences(text: string): string {
  if (!text) return '';
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-zA-Z0-9_+\-.]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/~~~[a-zA-Z0-9_+\-.]*\n?/g, '')
    .replace(/~~~/g, '');
}

/**
 * 문자열/이스케이프를 인식하며 균형 잡힌 `{...}` 후보들을 차례로 수집한다.
 * 중첩된 객체는 바깥쪽만 반환(inner 는 outer 안에 자연히 포함되므로 별도 후보 불요).
 * 빈 문자열·매칭 없음은 [] 반환.
 */
export function findBalancedJsonCandidates(text: string): string[] {
  const src = stripCodeFences(text);
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== '{') { i++; continue; }
    // 균형 잡힌 블록 하나를 끝까지 스캔한다.
    let depth = 0;
    let inString = false;
    let escape = false;
    const start = i;
    let matched = false;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = false; continue; }
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(start, j + 1));
          i = j + 1;
          matched = true;
          break;
        }
        continue;
      }
    }
    if (!matched) {
      // 균형을 못 찾고 EOF 에 도달했으면 **한 글자만** 전진하고 다음 후보 탐색을
      // 이어간다. 과거 구현은 여기서 `break` 로 완전 종료해 "앞 `{` 가 깨진 채로
      // 열려 있고 뒤에 정상 JSON 이 오는" 경우 후속 후보를 놓쳤다. 본 수정은
      // 최악의 경우에도 O(N²) 이지만, 실제 LLM 응답에서 미닫힘 `{` 가 여러 번
      // 섞이는 시나리오는 드물어 상환 O(N) 에 가깝다.
      i = start + 1;
    }
  }
  return out;
}
