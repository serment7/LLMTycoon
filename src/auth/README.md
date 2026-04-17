# Auth 모듈

로그인 / 회원가입 / 세션 발급을 담당한다. 모드 스위칭은 모두 환경변수로 제어.

## 환경변수

| 키 | 기본 | 역할 |
| --- | --- | --- |
| `DEV_MODE` | `false` | `true` 시 로그인 우회, 임시 `dev` 사용자로 접근 |
| `ON_PREMISE` | `true` | `true` → MongoDB 회원 관리, `false` → OAuth |
| `AUTH_PROVIDER` | `github` | `github` 또는 `gitlab` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub OAuth 앱 자격 |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | — | GitLab OAuth 앱 자격 |
| `OAUTH_REDIRECT_URL` | `http://localhost:3000/api/auth/callback` | OAuth 콜백 URL |
| `MONGODB_URI` / `MONGODB_DB` | 기존 값 | 온프레미스 회원 컬렉션 위치 |
| `SESSION_SECRET` | `change-me` | 세션 토큰 HMAC 용 |

## 스위칭 매트릭스

| DEV_MODE | ON_PREMISE | 동작 |
| --- | --- | --- |
| true  | — | 로그인 화면 없이 즉시 앱 진입 (`dev` 사용자 고정) |
| false | true  | Mongo `users` 컬렉션 기반 ID/PW 로그인·회원가입 |
| false | false | GitHub 또는 GitLab OAuth 로그인 (최초 로그인 시 자동 가입) |

## 파일 구성

- `authConfig.ts` — 환경변수 파싱 / 모드 판정
- `authService.ts` — 파사드 (DEV/On-prem/OAuth 분기)
- `providers/mongoProvider.ts` — 온프레미스 구현 (MongoDB)
- `providers/oauthProvider.ts` — GitHub/GitLab OAuth 구현
- `authRoutes.ts` — Express 라우터 (`/api/auth/*`)
- `../components/AuthGate.tsx` — 클라이언트 게이트
- `../components/LoginForm.tsx`, `../components/SignupForm.tsx` — UI

## TODO (연구원에게 인계)

1. `mongoProvider` 의 `hashPassword`/`verifyPassword` 를 **bcrypt** 로 교체.
2. `authRoutes` 의 in-memory `sessions` 를 영구 세션 스토어(예: Mongo `sessions` 컬렉션)로 이동.
3. `server.ts` 에 `app.use(createAuthRouter(new AuthService()))` 마운트 및 기존 API 에 세션 가드 추가.
4. `App.tsx` 루트를 `<AuthGate>` 로 감싸기.
5. `.env.example` 에 추가된 값들을 실제 `.env` 에 반영, OAuth 앱 등록.
