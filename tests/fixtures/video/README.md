# tests/fixtures/video — VideoAdapter 공급자별 응답 샘플

- 작성: QA · 2026-04-19
- 연결 계약: `docs/qa/video-adapter-acceptance.md` §2 · §5
- 대상 어댑터: `src/services/multimedia/adapters/VideoAdapter.ts` (Thanos 구현 중)

---

## 0. 바인딩 방법

모든 JSON 파일은 **공급자별 HTTP 응답 본문** 이다. 파일 상단의 `_meta` 블록에 메타(공급자·상태 코드·시나리오 id) 가 기록돼 있고, 어댑터는 이 필드를 무시하며 실제 공급자 스키마만 읽는다.

```json
{
  "_meta": {
    "provider": "runway" | "pika" | "stability",
    "httpStatus": 200,
    "contentType": "application/json",
    "scenarios": ["A-02", "W-01"]
  },
  "...": "공급자 스키마 그대로"
}
```

### undici MockAgent 예시

```ts
import { MockAgent, setGlobalDispatcher } from 'undici';
import jobSuccess from './tests/fixtures/video/runway.job-success.json' with { type: 'json' };

const agent = new MockAgent();
agent.disableNetConnect();  // 비용 안전 — 실제 네트워크 금지
setGlobalDispatcher(agent);
const client = agent.get('https://api.runwayml.com');
client.intercept({ path: '/v1/jobs/job_abc', method: 'GET' }).reply(200, jobSuccess);
```

### BudgetLimiter 세팅 예시 (테스트 셋업)

```ts
const budget = new BudgetLimiter({ maxCents: 0, now: () => 0 });
const adapter = new VideoAdapter(config, {
  settings: { runway: { apiKey: 'TEST' }, fetch: fetchStub },
  budgetLimiter: budget,
});
// maxCents=0 이므로 어떤 실 호출도 차단 — 샘플만 통과.
```

---

## 1. 파일 인벤토리

| 파일 | 공급자 | 상태코드 | 시나리오 |
| --- | --- | ---: | --- |
| `runway.job-queued.json` | Runway | 200 | A-01 |
| `runway.job-running.json` | Runway | 200 | A-02 |
| `runway.job-success.json` | Runway | 200 | A-02, W-01 |
| `runway.webhook-success.json` | Runway | 200 | A-03, E-02, E-06 |
| `runway.webhook-invalid-sig.json` | Runway | 401 | E-07 |
| `runway.429.json` | Runway | 429 | F-03 |
| `runway.5xx.json` | Runway | 503 | B-03 |
| `runway.cancel.json` | Runway | 200 | E-05 |
| `pika.job-success.json` | Pika | 200 | F-02, F-03 |
| `pika.job-success-no-wm.json` | Pika | 200 | A-05 |
| `stability.job-success.json` | Stability | 200 | F-04 |
| `runway.mp4-meta.json` | Runway | N/A | W-04(ffprobe 출력 흉내) |

---

## 2. 라이선스

- 모든 샘플은 **자작(CC0)**. 실제 Runway/Pika/Stability 응답 복사가 아닌 **스키마 필드명만 맞춘 가짜 데이터**.
- 등장 URL(`https://cdn.example.invalid/...`) 은 존재하지 않는 호스트(`.invalid` TLD) 로 고정 — 실수로 fetch 돼도 DNS 해상 실패.
- 샘플 MP4 가 필요한 시나리오(W-04)는 **파일 자체를 커밋하지 않고** ffprobe 출력만 JSON 으로 기록.

---

## 3. 비용 안전 체크리스트

- [ ] `agent.disableNetConnect()` 가 모든 테스트 setup 에 포함
- [ ] `BudgetLimiter.maxCents` 가 테스트 명시적으로 설정(기본 0)
- [ ] 실제 공급자 엔드포인트 도메인(`api.runwayml.com`, `api.pika.art`, `api.stability.ai`) 에 대한 intercept 가 **모두** 등록된 시나리오 이외의 요청은 MockAgent 가 자동 차단
- [ ] `npm test` 가 `CI=1` 일 때 `process.env.RUNWAY_API_KEY` 등을 clear 해 실수 누출 방지
