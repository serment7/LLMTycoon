// 지시 #d7caa7af · 코드 컨벤션/규칙 설정 타입.
//
// 프로젝트 관리 메뉴의 "코드 컨벤션·규칙 설정" 패널이 저장/로드하는 최소 스키마.
// 기존 codeRulesStore(#87cbd107) 는 에이전트 프롬프트 주입용 확장 스키마지만,
// 본 타입은 UI 에서 직접 편집하는 범위만 단순하게 잠근다.

export type IndentationStyle = 'space' | 'tab';
export type QuoteStyle = 'single' | 'double';
export type SemicolonPolicy = 'required' | 'omit';
export type FilenameConvention = 'camelCase' | 'kebab-case' | 'PascalCase';
export type CodeConventionScope = 'local' | 'global';

export interface CodeConventionIndentation {
  readonly style: IndentationStyle;
  /** 공백 스타일일 때 단위 크기. 탭이어도 에디터 표시용 폭으로 유효. 1~8 범위. */
  readonly size: number;
}

export interface CodeConvention {
  readonly indentation: CodeConventionIndentation;
  readonly quotes: QuoteStyle;
  readonly semicolons: SemicolonPolicy;
  readonly filenameConvention: FilenameConvention;
  /** 자유 기술 필드 — 위 항목에 담기 힘든 팀 고유 규칙을 그대로 기록. */
  readonly customRules: string;
}

/** 저장 레코드 — 실제 값에 스코프/프로젝트 정보와 갱신 시각이 얹힌 봉투. */
export interface CodeConventionRecord {
  readonly scope: CodeConventionScope;
  /** scope === 'local' 일 때만 설정. 전역이면 undefined. */
  readonly projectId?: string;
  readonly convention: CodeConvention;
  /** epoch ms. 병합·가시성 판단에 쓰는 표식. */
  readonly updatedAt: number;
}

export const DEFAULT_CODE_CONVENTION: CodeConvention = Object.freeze({
  indentation: Object.freeze({ style: 'space', size: 2 }) as CodeConventionIndentation,
  quotes: 'single',
  semicolons: 'required',
  filenameConvention: 'camelCase',
  customRules: '',
}) as CodeConvention;

export const INDENTATION_SIZE_MIN = 1;
export const INDENTATION_SIZE_MAX = 8;

export const QUOTE_STYLES: readonly QuoteStyle[] = Object.freeze(['single', 'double']) as readonly QuoteStyle[];
export const SEMICOLON_POLICIES: readonly SemicolonPolicy[] = Object.freeze(['required', 'omit']) as readonly SemicolonPolicy[];
export const FILENAME_CONVENTIONS: readonly FilenameConvention[] = Object.freeze(['camelCase', 'kebab-case', 'PascalCase']) as readonly FilenameConvention[];
export const INDENTATION_STYLES: readonly IndentationStyle[] = Object.freeze(['space', 'tab']) as readonly IndentationStyle[];
