# tests/fixtures/web-search — WebSearchAdapter 공급자별 응답 샘플

- 작성: QA · 2026-04-19
- 연결 계약: `docs/qa/web-search-adapter-acceptance.md` §2 · §5
- 대상 어댑터: `src/services/multimedia/adapters/WebSearchAdapter.ts` (Thanos 진행 중)

---

## 0. 사용 방법

본 디렉토리의 JSON 파일은 **공급자별 HTTP 응답의 본문** 이다. Node `fetch` stub·undici `MockAgent`·`msw` 어느 경로로도 바인딩 가능하도록 다음 3 가지 메타를 각 파일 상단 주석 없이 JSON 안의 `"_meta"` 필드로 기재한다(Thanos 의 어댑터는 `_meta` 를 무시하고 실제 공급자 스키마 필드만 읽는다).

```json
{
  "_meta": {
    "provider": "bing" | "brave" | "duckduckgo",
    "httpStatus": 200,
    "contentType": "application/json",
    "scenarios": ["N-01", "K-01"]
  },
  "...": "공급자 스키마 그대로"
}
```

`_meta.httpStatus` 가 200 이 아니면(예: 429·503), MockAgent 바인딩 시 응답 상태 코드로 그대로 사용한다. 본문은 공급자가 실제로 돌려주는 오류 포맷을 흉내낸다.

### undici MockAgent 예시

```ts
import { MockAgent, setGlobalDispatcher } from 'undici';
import success from './tests/fixtures/web-search/bing.success.json' with { type: 'json' };

const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
const client = agent.get('https://api.bing.microsoft.com');
client.intercept({ path: /\/v7\.0\/search/, method: 'GET' }).reply(200, success);
```

### Thanos 어댑터에 `fetch` 주입 예시

```ts
const fetchStub = async (url: string) => ({
  ok: true,
  status: 200,
  async json() { return (await import('./bing.success.json', { with: { type: 'json' }})).default; },
} as Response);
const adapter = new WebSearchAdapter(config, {
  settings: { bing: { apiKey: 'TEST' }, fetch: fetchStub as typeof fetch },
});
```

---

## 1. 파일 인벤토리

| 파일 | 공급자 | 상태코드 | 주요 시나리오 |
| --- | --- | ---: | --- |
| `bing.success.json` | Bing | 200 | N-01, P-02, K-01 ~ K-05 |
| `bing.empty.json` | Bing | 200 | ER-02 |
| `bing.large.json` | Bing | 200 | N-04 |
| `bing.subdomain.json` | Bing | 200 | F-05 |
| `bing.429.json` | Bing | 429 | R-04, ER-01 |
| `bing.503.json` | Bing | 503 | R-02, R-03 |
| `bing.400.json` | Bing | 400 | R-05 |
| `bing.401.json` | Bing | 401 | T-04 |
| `brave.success.json` | Brave | 200 | P-01, P-04 |
| `brave.partial-fields.json` | Brave | 200 | N-02 |
| `brave.malformed.json` | Brave | 200 | T-05 |
| `brave.mixed-domains.json` | Brave | 200 | N-05 |
| `duckduckgo.success.json` | DuckDuckGo | 200 | P-04 |
| `duckduckgo.malformed.json` | DuckDuckGo | 200 | N-03 |

본 턴은 **Thanos 가 바로 쓸 수 있도록** 핵심 6 종(`bing.success.json`, `bing.empty.json`, `bing.429.json`, `bing.503.json`, `brave.success.json`, `brave.partial-fields.json`, `duckduckgo.success.json`, `duckduckgo.malformed.json`) 을 함께 커밋한다. 나머지(`large`, `subdomain`, `400`, `401`, `malformed`, `mixed-domains`) 는 기본 샘플에서 복제해 값을 조정하는 수준으로 간단하며, Thanos 합류 시 QA 가 추가한다.

---

## 2. 라이선스

- 모든 샘플은 **자작(CC0)** 이다. 실제 Bing/Brave/DuckDuckGo 응답을 그대로 복사한 것이 아니라 **공급자 스키마 필드명만 맞춘 가짜 데이터** 로, API 응답 저작권 이슈가 없다.
- 샘플에 등장하는 URL(`https://example.com/...`) 과 텍스트는 모두 허구 — 외부 네트워크 호출 없이 정규화 로직을 검증할 목적.

---

## 3. 체크리스트

- [ ] 각 파일의 `_meta.provider` 가 실제 스키마 소유 공급자와 일치
- [ ] `_meta.httpStatus` 가 단위 테스트에서 `res.status` 와 같은 값으로 세팅
- [ ] 파일 추가 시 `docs/qa/web-search-adapter-acceptance.md` §5 의 테이블 갱신
- [ ] Thanos 합류 후 본 README 의 "바로 쓸 수 있는 6 종" 을 실제 단위 테스트에서 import 하는지 회귀 확인
