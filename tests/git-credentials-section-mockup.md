# GitCredentialsSection · UI 시안 & 카피 스펙 (2026-04-18)

대상: 신규 컴포넌트 `src/components/GitCredentialsSection.tsx`
기존 참고: `src/components/ProjectManagement.tsx` 의 `IntegrationForm` (토큰 입력 패턴), `maskToken`/`redactTokens`/`tokenPrefixMismatch`/`isTokenTooShort` 유틸
시안 이미지: `tests/git-credentials-section-mockup.svg`

## 레이아웃 구성

| 영역 | 폭(px) | 핵심 요소 |
|------|--------|-----------|
| 섹션 헤더 | 전체 | 자물쇠 아이콘 + 타이틀 "Git 자격증명" + 상태 배지(저장됨/미저장) + "서버 AES-256 암호화" 보안 배지 |
| Provider 드롭다운 | 220 | GitHub / GitLab / 자체 호스팅 — 로고 아이콘 + 호스트 힌트 |
| 라벨 입력 | 220 | 최대 80자 · 식별용 표시 이름 |
| 토큰 입력 | 454 | password 타입 + 눈 아이콘 토글 · 실시간 프리픽스/길이 경고 |
| 작업 버튼 | 454 | [암호화 후 저장] accent · [연결 테스트] outline · [삭제] danger |
| 마지막 활동 | 454 | 최근 연결 테스트/사용 시각 + scope 표시 |
| 보안 설명 | 454 | 방패 아이콘 + AES-256-GCM · redactTokens · HTTPS 보호 문구 |

## 색상 체계 (기존 `--pixel-*` 토큰 재사용)

- accent `#00d4ff` — 저장/활성 CTA, 드롭다운 포커스 링
- panel `#0f3460` — 섹션/모달 바탕
- success `#34d399` — 저장됨·암호화 배지·보안 안내
- warn `#fbbf24` — 미저장·프리픽스 경고
- expiring `#fb923c` — 만료 D-7 임박 토큰
- danger `#f87171` — 삭제 버튼·검증 실패·삭제 모달 상단 스트립
- in-flight `#60a5fa` — "암호화 중" 진행 배지 (1.4s 펄스)

## 상태 배지 매트릭스

| 상태 | 배지 | 의미 |
|------|------|------|
| 저장됨 | `✓ 저장됨` (emerald) | 서버 DB 에 암호화 기록됨 |
| 미저장 | `⚠ 미저장` (amber, 1.4s 펄스) | 입력 변경 후 저장 미클릭 |
| 만료 임박 | `⏱ 만료 D-7` (orange) | GitHub 토큰 만료 7일 이내 |
| 검증 실패 | `✕ 401 인증 실패` (red) | 연결 테스트에서 거부 |
| 전송 중 | `◔ 암호화 중…` (sky, 펄스) | POST /api/integrations 진행 |

## 카피 스펙 (보안 커뮤니케이션)

1. **섹션 부제**: "이 프로젝트의 원격 저장소 접근 토큰. 서버 DB 에만 암호화되어 저장되며 UI 에는 절대 노출되지 않습니다."
2. **토큰 입력 하단**: "보안상 원본 토큰은 저장 후 UI 에 다시 노출되지 않습니다. 교체가 필요하면 [재발급 저장] 을 사용하세요."
3. **저장 버튼 라벨**: "💾 암호화 후 저장" — '저장' 단독 대신 '암호화' 를 명시해 처리 과정을 가시화.
4. **보안 안내 박스** (emerald, 방패 아이콘):
   - 토큰은 AES-256-GCM 으로 서버에서만 암호화 저장 · 클라이언트 전송 전 HTTPS 보호
   - UI · 로그 · 에러 메시지 어느 곳에도 원본 토큰을 절대 노출하지 않습니다 (`redactTokens` 적용)
5. **마스킹 표시**: `maskToken` 유틸 재사용 — `ghp_••••(40자)` 형식. 8자 이하 토큰은 전부 `•` 로 치환.

## 삭제 확인 모달

- 백드롭: `rgba(0,0,0,0.75)` · 모달 테두리 `#f87171` 3px · 상단 6px red 스트립으로 "위험" 시각화.
- 경고 항목 3개(불릿 red):
  - 저장된 토큰이 서버에서 영구 삭제됩니다 (복원 불가)
  - 이 연동으로 가져온 N개 프로젝트의 자동 커밋/푸시가 즉시 중단됩니다
  - 되돌리려면 GitHub 에서 새 토큰을 발급해 다시 등록해야 합니다
- **라벨 타이핑 확인**: 연동 라벨 일치 입력 시에만 [삭제] 버튼 활성화. 휴먼 에러 방어책.

## 접근성 (a11y)

- `<label>` 과 `<input>` 을 `htmlFor`/`id` 로 명시 연결. 설명문은 `aria-describedby`.
- 토큰 input: `type="password"` + `autoComplete="off"` + `spellCheck={false}` (기존 패턴 유지).
- 눈 아이콘 토글 버튼: `aria-pressed` + `aria-label="토큰 표시 전환"` · 토큰 노출 시간은 10초 후 자동 재마스킹.
- 상태 배지: `role="status"` + `aria-live="polite"`. 저장 성공/실패 전이 순간 스크린리더 알림.
- 삭제 모달: `role="alertdialog"` · 포커스 트랩 · Escape 로 취소.
- 색각 이상 대응: 모든 배지는 색+아이콘(✓ ⚠ ⏱ ✕ ◔)+텍스트 3중 인코딩.

## 구현 시 주의

- 토큰을 React state 에 원본 보관하지 말고 저장 POST 이후 즉시 `setToken('')` · 컴포넌트는 마스킹된 메타(`tokenMask: 'ghp_••••'`, `tokenLength: 40`)만 props 로 받는다.
- 서버 에러 본문은 반드시 `redactTokens(rawMessage)` 후 onLog/UI 에 전달.
- `maskToken` 의 `prefix(4) + …(N자)` 규약을 그대로 유지해 기존 IntegrationForm 과 시각 일관성 확보.
- 연결 테스트 버튼은 `POST /api/integrations/:id/test` 제안(현재 미구현). 200 OK + scope 목록을 응답으로 받아 "마지막 활동" 블록 갱신.

## 후속 단계

1. Joker 의 구현 검토 — 기존 `IntegrationForm` 을 신규 섹션으로 흡수할지 / 나란히 둘지 결정 필요.
2. 만료 임박 배지용 서버 API: GitHub `GET /user` 의 `x-github-authentication-token-expiration` 헤더 파싱.
3. 토큰 교체 시 이전 토큰의 rotate-out window(30초)를 두어 진행 중 요청이 끊기지 않게 한다.
