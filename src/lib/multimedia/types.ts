// 지시 #c82b4df9 — 멀티미디어 처리 1차 공용 타입.
//
// 목적
//   PDF / PPTX / 영상 생성처럼 서로 다른 원시 데이터가 한 파이프라인에 들어오는데,
//   각각이 자기만의 파서·에러 코드·진행률을 가지면 UI 가 파일 타입마다 분기로
//   부풀어오른다. 본 모듈은 그 경계를 다음 두 축으로 굳힌다:
//
//     1) `MultimediaHandler<TResult>` — 입력 Blob 을 받아 구조화된 결과를 돌려주는
//        "추출기" 의 최소 계약. 추후 PPT 파서·영상 프레임 추출기도 같은 인터페이스를
//        구현하도록 한다. 호출자는 handler.id 로 어떤 엔진이 돌았는지만 로깅하면 된다.
//
//     2) `MultimediaExtractionResult` — 모든 핸들러가 최소한 돌려줘야 하는 공통 모양
//        (텍스트 본문 + 메타데이터 + 크기 정보). 타입별 고유 필드는 제네릭 확장으로
//        더한다(PDF 의 pageCount, 영상의 durationMs 등).
//
//   기존 `src/utils/mediaLoaders.ts` 는 서버 업로드 경로를 전담하고, 본 모듈은
//   브라우저 로컬에서 파싱을 끝내 프로젝트 파일 저장소에 그대로 기록하는 경로다.

import type { ProjectFileRecord } from '../../store/projectFiles';

/** 진행률 단계 — UI 프로그레스바에 그대로 매핑된다. */
export type MultimediaProgressPhase = 'open' | 'parse' | 'persist' | 'finalize';

export interface MultimediaProgressEvent {
  phase: MultimediaProgressPhase;
  /** 0 이상의 현재 처리량(페이지 수·바이트 수 등 phase 별 의미). */
  current: number;
  /** 0 이상의 총량. 알 수 없으면 0. */
  total: number;
}

export interface MultimediaExtractionResult {
  /** 핸들러가 찾아낸 평문 본문. 에이전트 프롬프트 주입·검색 인덱스 모두 이 필드를 읽는다. */
  text: string;
  /** 원본 바이트 크기. File.size 를 그대로 담는다. */
  sizeBytes: number;
  /**
   * 타입별 부가 메타데이터(페이지 수·저자·제목 등). 핸들러가 추출 못 한 값은
   * `undefined` 로 남겨 상위가 "N/A" UI 로 표시하도록 한다.
   */
  metadata: MultimediaMetadata;
}

export interface MultimediaMetadata {
  title?: string;
  author?: string;
  pageCount?: number;
  /** 영상·오디오 확장 대비. PDF 에서는 undefined. */
  durationMs?: number;
  /** 추출기가 본문 분할한 페이지 단위 텍스트. UI 가 페이지 미리보기로 쓸 수 있다. */
  pageTexts?: string[];
  /** 핸들러 고유 키값을 담는 확장 슬롯. 예: PDF 의 Producer/CreationDate. */
  extra?: Readonly<Record<string, string | number | boolean>>;
}

export interface MultimediaParseOptions {
  /** 진행률 보고. 호출자는 prog.phase 로 UI 단계 아이콘을 바꾼다. */
  onProgress?: (ev: MultimediaProgressEvent) => void;
  /** 파싱 중단. 호출자 컴포넌트의 언마운트·취소 버튼과 연결. */
  signal?: AbortSignal;
  /** 텍스트 길이 상한(바이트 단위 근사). 초과분은 잘려서 반환된다. 기본 5MB. */
  maxTextBytes?: number;
}

/**
 * 1차 파서 공용 계약. PPT·영상 모듈은 이 인터페이스를 구현해 같은 파이프라인에
 * 접속한다. 핸들러는 파일 저장소를 몰라도 되며, 저장은 `MultimediaImportService`
 * 가 책임진다.
 */
export interface MultimediaHandler<TResult extends MultimediaExtractionResult = MultimediaExtractionResult> {
  /** 텔레메트리·로그에서 구분하는 키. 예: 'pdf' / 'pptx' / 'video'. */
  readonly id: string;
  /** 브라우저 파일 선택창의 `accept` 에 그대로 넣을 수 있는 문자열. */
  readonly accept: string;
  /** 핸들러별 용량 상한(바이트). DirectivePrompt · PdfImportPanel 공통 가드. */
  readonly maxBytes: number;
  /** 입력 Blob/File 을 해석해 공통 결과 타입으로 돌려준다. */
  parse(input: Blob, opts?: MultimediaParseOptions): Promise<TResult>;
}

/**
 * 프로젝트 파일 저장소에 저장된 import 결과물. 원본 Blob 기록과 텍스트 사이드카
 * 기록을 한 쌍으로 반환해 호출자가 "어느 파일이 어떤 원본에서 나왔는지" 를 곧바로
 * UI 에 붙일 수 있게 한다.
 */
export interface MultimediaImportOutcome {
  /** 원본(예: .pdf) 파일 레코드. */
  originalRecord: ProjectFileRecord;
  /**
   * 추출 텍스트를 .txt 로 저장한 사이드카 레코드. 에이전트 컨텍스트 주입은 이
   * 레코드를 읽어서 한다. 텍스트 추출이 비어 있으면 null.
   */
  extractedTextRecord: ProjectFileRecord | null;
  /** 원본 파싱 결과 — 진행률이 끝난 직후 상위에서 즉시 보여 줄 수 있게 돌려준다. */
  result: MultimediaExtractionResult;
}

/** 공용 에러 코드. UI 는 errorMessages.mapMediaParseError 로 매핑한다. */
export type MultimediaImportErrorCode =
  | 'MULTIMEDIA_FILE_TOO_LARGE'
  | 'MULTIMEDIA_UNSUPPORTED_FORMAT'
  | 'MULTIMEDIA_PARSE_FAILED'
  | 'MULTIMEDIA_PARSE_ABORTED'
  | 'MULTIMEDIA_PERSIST_FAILED';

export class MultimediaImportError extends Error {
  readonly code: MultimediaImportErrorCode;
  readonly cause?: unknown;
  constructor(code: MultimediaImportErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'MultimediaImportError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
