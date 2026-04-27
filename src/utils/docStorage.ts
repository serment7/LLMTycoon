// 프로젝트별 문서(`docs/`) 저장 위치 모드.
//
// 두 가지 모드를 지원한다:
//   - 'workspace': 기존 동작. 에이전트가 만드는 docs/는 프로젝트의 workspacePath
//                  안에 그대로 쌓인다. git 저장소면 트래킹 대상이 된다.
//   - 'central'  : LLMTycoon 저장소 루트의 .llmtycoon/projects/<id>/docs/ 로
//                  격리한다. 사용자 프로젝트 트리를 더럽히지 않고 임시·사인오프
//                  문서를 별도 보관하고 싶을 때 선택한다.
//
// 설정은 Project.settingsJson.docStorage 에 자유 형식으로 저장되며, 여기서
// 해석·기본값 보정·경로 결정을 모두 담당한다. UI/서버/agent 측이 이 모듈만
// 거치도록 강제해 모드 해석이 한곳으로 수렴되게 한다.

import path from 'path';

export type DocStorageMode = 'workspace' | 'central';

export const DOC_STORAGE_MODE_VALUES: readonly DocStorageMode[] = ['workspace', 'central'] as const;

export interface DocStorageSettings {
  mode: DocStorageMode;
}

export const DEFAULT_DOC_STORAGE: DocStorageSettings = { mode: 'workspace' };

/**
 * settingsJson 자유 형식 객체에서 docStorage 설정을 안전하게 추출한다. 누락/형식
 * 오류는 모두 'workspace' 모드로 폴백해, 기존 프로젝트가 새 코드 경로에서 깨지지
 * 않도록 한다.
 */
export function extractDocStorage(settingsJson: unknown): DocStorageSettings {
  if (!settingsJson || typeof settingsJson !== 'object' || Array.isArray(settingsJson)) {
    return { ...DEFAULT_DOC_STORAGE };
  }
  const raw = (settingsJson as Record<string, unknown>).docStorage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_DOC_STORAGE };
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === 'central') return { mode: 'central' };
  return { mode: 'workspace' };
}

/**
 * settingsJson 에 docStorage 모드를 머지해 새 객체를 돌려준다. PATCH /api/projects/:id
 * 호출자가 다른 키를 보존하면서 모드만 갱신할 수 있도록 한다. mode 가 기본값
 * ('workspace') 이면 키 자체를 빼서 객체를 깔끔하게 유지한다.
 */
export function mergeDocStorage(
  settingsJson: Record<string, unknown> | undefined,
  next: DocStorageSettings,
): Record<string, unknown> {
  const base = settingsJson && typeof settingsJson === 'object' && !Array.isArray(settingsJson)
    ? { ...settingsJson }
    : {};
  if (next.mode === 'workspace') {
    delete base.docStorage;
    return base;
  }
  base.docStorage = { mode: next.mode };
  return base;
}

/**
 * central 모드에서 사용할 docs 루트 절대경로. LLMTycoon 저장소 루트(repoRoot)
 * 아래 .llmtycoon/projects/<projectId>/docs 로 고정. 프로젝트 ID 가 비어있으면
 * 빈 문자열을 돌려 호출자가 분기할 수 있게 한다(서버는 ctx 생성 시 검증).
 */
export function resolveCentralDocsRoot(repoRoot: string, projectId: string): string {
  if (!projectId) return '';
  return path.resolve(repoRoot, '.llmtycoon', 'projects', projectId, 'docs');
}
