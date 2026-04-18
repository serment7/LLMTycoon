// Prefixes (normalized to forward slashes, trailing '/') excluded from the code graph.
// .gitignore-style: extend this list to skip more directories in future.
export const EXCLUDED_PATHS: readonly string[] = ['docs/'];

// Paths the Git 자동화 플로우가 절대 `git add` 하지 말아야 하는 접두사.
// 코드그래프 필터와는 독립적이다 — 코드그래프에는 포함되더라도(예: scripts/)
// 일부 경로는 커밋 아티팩트에 섞이면 안 된다. `.git/` 은 git 내부 상태,
// `node_modules/` · `dist/` · `build/` · `coverage/` 는 빌드/리포트 산출물
// (.gitignore 와 1:1), `workspaces/` 는 에이전트가 실험 중인 샌드박스라
// 팀 공용 커밋에 새는 걸 막는다. .gitignore 가 1차로 막지만, 외부에서 주입된
// 스테이징 목록(simple-git 입력 배열)에 대한 2차 방어선.
export const GIT_STAGE_EXCLUDED_PATHS: readonly string[] = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  'workspaces/',
];

function normalize(name: string): string {
  return String(name).replace(/^[./\\]+/, '').replace(/\\/g, '/');
}

// 코드그래프 저장용 정규화. 저장 전에 일관된 포맷으로 다듬어야
// `./Foo.tsx` · `Foo.tsx` · `src\\Foo.tsx` 가 같은 노드로 모이고, 중복 체크가
// 의미있게 동작한다. MCP add_file 이 전달하는 raw 이름을 서버가 다시 정규화.
export function normalizeCodeGraphPath(name: string): string {
  return normalize(name);
}

function matchesPrefix(name: string, prefixes: readonly string[]): boolean {
  const normalized = normalize(name);
  return prefixes.some((prefix) => {
    const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return normalized === p.slice(0, -1) || normalized.startsWith(p);
  });
}

export function isExcludedFromCodeGraph(name: string): boolean {
  return matchesPrefix(name, EXCLUDED_PATHS);
}

export function isExcludedFromGitStaging(name: string): boolean {
  return matchesPrefix(name, GIT_STAGE_EXCLUDED_PATHS);
}

export type CodeFileType = 'component' | 'service' | 'util' | 'style';

// 파일명 → 그래프 노드 타입 추론. FileTooltip / App 스프라이트의 색·글리프는
// file.type 에 결직되어 있으므로, 신규 파일이 아무 타입(util 기본)으로 들어오면
// 시각적으로 분류가 잘못 보인다. 이름/확장자만으로 결정 가능한 수준에서만
// 분류하고, 애매하면 'util' 로 폴백한다.
const STYLE_EXT = /\.(css|scss|sass|less|styl)$/i;
const COMPONENT_EXT = /\.(tsx|jsx)$/i;
const SERVICE_NAME = /\b(server|api|service|client|route|auth)\b|(Service|Api|Client|Provider|Repository)\.[tj]sx?$/;

export function inferFileType(name: string): CodeFileType {
  const normalized = normalize(name);
  if (STYLE_EXT.test(normalized)) return 'style';
  if (SERVICE_NAME.test(normalized)) return 'service';
  if (COMPONENT_EXT.test(normalized)) return 'component';
  return 'util';
}
