// 지시 #c82b4df9 — PDF 파일을 프로젝트 파일 저장소로 적재하는 서비스 계층.
//
// 책임
//   1) 원본 PDF Blob 을 `projectFileStorage` 에 업로드해 cascade 정책을 공유한다.
//   2) pdfParser 로 본문을 추출하고, 추출 텍스트를 .txt 사이드카 파일로 동반 저장한다.
//      에이전트는 이 .txt 만 읽어도 PDF 내용을 참조할 수 있다.
//   3) 진행률 이벤트를 상위(PdfImportPanel) 에 단일 스트림으로 중계한다. UI 는
//      parser 의 'open/parse' 단계와 저장소의 'persist' 단계를 이어붙여 한 번에 본다.
//   4) 실패를 `MultimediaImportError` 한 축으로 수렴해 errorMessages.mapUnknownError
//      가 그대로 UI 메시지를 찍을 수 있게 한다.
//
// 본 모듈은 React 의존 0. Node 환경에서 메모리 어댑터·stub 파서로 전 계약을 잠근다.

import {
  createProjectFileStore,
  type ProjectFileRecord,
  type ProjectFileStore,
} from '../../store/projectFiles';
import {
  MultimediaImportError,
  type MultimediaHandler,
  type MultimediaImportOutcome,
  type MultimediaParseOptions,
  type MultimediaProgressEvent,
} from './types';
import { createPdfParser } from './pdfParser';

export interface PdfImportServiceOptions {
  /** 주입 가능한 저장소. 생략하면 모듈 싱글턴 ProjectFileStore 를 만든다. */
  store?: ProjectFileStore;
  /** 주입 가능한 파서. 생략하면 기본 pdfjs-dist 파서. 테스트는 stub 를 넣는다. */
  parser?: MultimediaHandler;
  /** 추출 텍스트 사이드카 파일명을 결정. 기본은 원본명 + '.extracted.txt'. */
  buildSidecarName?: (originalName: string) => string;
}

export interface PdfImportRequest {
  projectId: string;
  file: File;
  onProgress?: (ev: MultimediaProgressEvent) => void;
  signal?: AbortSignal;
  /** 초과 시 절단. 기본은 parser 기본값(5MB). */
  maxTextBytes?: number;
}

export interface PdfImportService {
  /** PDF 원본 + 추출 텍스트 사이드카를 저장소에 적재하고 결과를 돌려준다. */
  importPdf(req: PdfImportRequest): Promise<MultimediaImportOutcome>;
  /** UI 에서 accept 속성에 그대로 쓰도록 재노출. */
  readonly accept: string;
  /** 용량 가드. UploadDropzone 와 공유. */
  readonly maxBytes: number;
}

function defaultSidecarName(originalName: string): string {
  // 확장자가 .pdf 라면 제거 후 .extracted.txt 를 붙인다. 공백은 '-' 로 안전 치환.
  const base = originalName.replace(/\.pdf$/i, '').replace(/\s+/g, '-');
  const safe = base.length > 0 ? base : 'document';
  return `${safe}.extracted.txt`;
}

export function createPdfImportService(options: PdfImportServiceOptions = {}): PdfImportService {
  const store = options.store ?? createProjectFileStore();
  const parser = options.parser ?? createPdfParser();
  const buildSidecar = options.buildSidecarName ?? defaultSidecarName;

  async function importPdf(req: PdfImportRequest): Promise<MultimediaImportOutcome> {
    if (!req.projectId) {
      throw new MultimediaImportError('MULTIMEDIA_PARSE_FAILED', 'projectId 가 비어 있습니다.');
    }
    if (!req.file) {
      throw new MultimediaImportError('MULTIMEDIA_PARSE_FAILED', '파일이 비어 있습니다.');
    }
    if (req.signal?.aborted) {
      throw new MultimediaImportError('MULTIMEDIA_PARSE_ABORTED', 'import 가 시작 전에 취소되었습니다.');
    }
    if (req.file.size > parser.maxBytes) {
      throw new MultimediaImportError(
        'MULTIMEDIA_FILE_TOO_LARGE',
        `PDF 크기 ${req.file.size}B 가 상한 ${parser.maxBytes}B 를 초과합니다.`,
      );
    }

    const parseOpts: MultimediaParseOptions = {
      onProgress: req.onProgress,
      signal: req.signal,
      maxTextBytes: req.maxTextBytes,
    };

    // 1) 본문 추출 — 실패 시 저장소에 아무 것도 남기지 않는다.
    const result = await parser.parse(req.file, parseOpts);

    // 2) 원본 PDF 저장 — persist 진행률 이벤트로 감싼다.
    req.onProgress?.({ phase: 'persist', current: 0, total: 2 });
    let originalRecord: ProjectFileRecord;
    try {
      originalRecord = await store.upload(req.projectId, req.file);
    } catch (err) {
      throw new MultimediaImportError(
        'MULTIMEDIA_PERSIST_FAILED',
        `원본 PDF 저장 실패: ${(err as Error).message}`,
        err,
      );
    }
    req.onProgress?.({ phase: 'persist', current: 1, total: 2 });

    // 3) 추출 텍스트가 있을 때만 사이드카 .txt 저장. 빈 텍스트는 저장하지 않는다
    //    — 에이전트 컨텍스트에 빈 파일이 노이즈로 섞이는 걸 막는다.
    let extractedTextRecord: ProjectFileRecord | null = null;
    if (result.text.length > 0) {
      const sidecarName = buildSidecar(req.file.name);
      const sidecarFile = new File([result.text], sidecarName, {
        type: 'text/plain;charset=utf-8',
      });
      try {
        extractedTextRecord = await store.upload(req.projectId, sidecarFile);
      } catch (err) {
        // 사이드카 실패는 "이미 저장된 원본" 을 롤백하지 않는다 — 원본은 유지하고
        // 에이전트 참조 계약만 실패 코드로 알린다. UI 는 원본 리스트 갱신 + 경고 토스트.
        throw new MultimediaImportError(
          'MULTIMEDIA_PERSIST_FAILED',
          `추출 텍스트 저장 실패: ${(err as Error).message}`,
          err,
        );
      }
    }
    req.onProgress?.({ phase: 'persist', current: 2, total: 2 });
    req.onProgress?.({ phase: 'finalize', current: 1, total: 1 });

    return { originalRecord, extractedTextRecord, result };
  }

  return {
    importPdf,
    accept: parser.accept,
    maxBytes: parser.maxBytes,
  };
}
