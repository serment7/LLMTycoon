// 지시 #82bd96f7 — .pptx 를 프로젝트 파일 저장소로 적재하는 서비스 계층.
//
// 책임
//   1) 원본 .pptx Blob 을 `projectFileStorage` 에 업로드해 cascade(프로젝트 삭제
//      시 일괄 정리) 정책을 다른 업로드 경로와 공유한다.
//   2) pptParser 로 추출한 슬라이드·노트를 (a) `.extracted.txt` 사이드카에, (b) 에이전트
//      참조용 마크다운 요약본 `.summary.md` 에 각각 저장한다. 에이전트는 .md 만 읽어도
//      슬라이드 순서/노트/미디어 목록을 한눈에 파악할 수 있다.
//   3) 진행률 이벤트는 parser 의 open/parse + persist 단계를 단일 스트림으로 상위에
//      중계한다. UI 는 가중치 매핑(PdfImportPanel 과 동일 규칙)으로 100MB 경계 파일도
//      반응성을 유지한다(parse 70% 구간이 가장 긴 구간).
//   4) 실패는 `MultimediaImportError` 한 축으로 수렴시켜 errorMessages.mapUnknownError
//      가 그대로 UI 문구를 매핑하게 한다.
//
// 호출자 경계
//   · 본 모듈은 `src/services/` 아래에 둔다(지시 §3 경로 지정). 파서는 `src/lib/multimedia/`
//     아래에서 불러오며, 저장소(projectFileStorage)는 store 계층을 그대로 쓴다.
//   · React 의존 0 — Node 단위 테스트에서 stub parser + 메모리 저장소로 전 계약 잠금.

import {
  createProjectFileStore,
  type ProjectFileRecord,
  type ProjectFileStore,
} from '../store/projectFiles';
import {
  MultimediaImportError,
  type MultimediaHandler,
  type MultimediaParseOptions,
  type MultimediaProgressEvent,
} from '../lib/multimedia/types';
import { createPptParser, type PptExtractionResult } from '../lib/multimedia/pptParser';

export interface PptImportServiceOptions {
  store?: ProjectFileStore;
  /** 주입 가능한 파서. 생략 시 pptx 기본 파서. */
  parser?: MultimediaHandler<PptExtractionResult>;
  /** 사이드카 텍스트 파일명. 기본은 원본명 + '.extracted.txt'. */
  buildSidecarName?: (originalName: string) => string;
  /** 요약 마크다운 파일명. 기본은 원본명 + '.summary.md'. */
  buildSummaryName?: (originalName: string) => string;
}

export interface PptImportRequest {
  projectId: string;
  file: File;
  onProgress?: (ev: MultimediaProgressEvent) => void;
  signal?: AbortSignal;
  /** 추출 텍스트 절단 상한(바이트). 기본은 parser 기본값. */
  maxTextBytes?: number;
}

export interface PptImportOutcome {
  originalRecord: ProjectFileRecord;
  extractedTextRecord: ProjectFileRecord | null;
  summaryRecord: ProjectFileRecord | null;
  result: PptExtractionResult;
}

export interface PptImportService {
  importPpt(req: PptImportRequest): Promise<PptImportOutcome>;
  readonly accept: string;
  readonly maxBytes: number;
}

function defaultSidecarName(originalName: string): string {
  const base = originalName.replace(/\.pptx$/i, '').replace(/\s+/g, '-');
  return `${base.length > 0 ? base : 'presentation'}.extracted.txt`;
}

function defaultSummaryName(originalName: string): string {
  const base = originalName.replace(/\.pptx$/i, '').replace(/\s+/g, '-');
  return `${base.length > 0 ? base : 'presentation'}.summary.md`;
}

/**
 * 에이전트가 한눈에 읽도록 설계된 마크다운 요약본. 슬라이드 번호·제목·노트·미디어
 * 목록·썸네일 유무를 체계적으로 보여 주고, 원본 본문은 .extracted.txt 로 분리해
 * 맥락 주입 시 토큰 낭비를 줄인다.
 */
export function renderSummaryMarkdown(originalName: string, result: PptExtractionResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.metadata.title ?? originalName}`);
  lines.push('');
  if (result.metadata.author) lines.push(`- 저자: ${result.metadata.author}`);
  lines.push(`- 슬라이드 수: ${result.slides.length}`);
  if (result.mediaFiles.length > 0) lines.push(`- 내장 미디어: ${result.mediaFiles.length}개`);
  lines.push(`- 썸네일: ${result.thumbnailName ? result.thumbnailName : '없음'}`);
  lines.push('');
  for (const slide of result.slides) {
    lines.push(`## 슬라이드 ${slide.index + 1}`);
    if (slide.text) {
      lines.push(slide.text);
    } else {
      lines.push('_(본문 텍스트 없음)_');
    }
    if (slide.notes) {
      lines.push('');
      lines.push('**노트**');
      lines.push(slide.notes);
    }
    lines.push('');
  }
  if (result.mediaFiles.length > 0) {
    lines.push('## 내장 미디어');
    for (const name of result.mediaFiles) lines.push(`- ${name}`);
  }
  return lines.join('\n').trim() + '\n';
}

export function createPptImportService(options: PptImportServiceOptions = {}): PptImportService {
  const store = options.store ?? createProjectFileStore();
  const parser = options.parser ?? createPptParser();
  const buildSidecar = options.buildSidecarName ?? defaultSidecarName;
  const buildSummary = options.buildSummaryName ?? defaultSummaryName;

  async function importPpt(req: PptImportRequest): Promise<PptImportOutcome> {
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
        `PPT 크기 ${req.file.size}B 가 상한 ${parser.maxBytes}B 를 초과합니다.`,
      );
    }

    const parseOpts: MultimediaParseOptions = {
      onProgress: req.onProgress,
      signal: req.signal,
      maxTextBytes: req.maxTextBytes,
    };

    // 1) 파싱 — 실패하면 저장소에 아무 것도 남기지 않는다.
    const result = await parser.parse(req.file, parseOpts);

    // 2) 원본 저장.
    req.onProgress?.({ phase: 'persist', current: 0, total: 3 });
    let originalRecord: ProjectFileRecord;
    try {
      originalRecord = await store.upload(req.projectId, req.file);
    } catch (err) {
      throw new MultimediaImportError(
        'MULTIMEDIA_PERSIST_FAILED',
        `원본 PPT 저장 실패: ${(err as Error).message}`,
        err,
      );
    }
    req.onProgress?.({ phase: 'persist', current: 1, total: 3 });

    // 3) .extracted.txt 사이드카(본문이 있을 때만 저장).
    let extractedTextRecord: ProjectFileRecord | null = null;
    if (result.text.length > 0) {
      const sidecarName = buildSidecar(req.file.name);
      const sidecarFile = new File([result.text], sidecarName, {
        type: 'text/plain;charset=utf-8',
      });
      try {
        extractedTextRecord = await store.upload(req.projectId, sidecarFile);
      } catch (err) {
        throw new MultimediaImportError(
          'MULTIMEDIA_PERSIST_FAILED',
          `추출 텍스트 저장 실패: ${(err as Error).message}`,
          err,
        );
      }
    }
    req.onProgress?.({ phase: 'persist', current: 2, total: 3 });

    // 4) .summary.md 마크다운 요약본(슬라이드 0장 특수 케이스는 저장 생략).
    let summaryRecord: ProjectFileRecord | null = null;
    if (result.slides.length > 0) {
      const md = renderSummaryMarkdown(req.file.name, result);
      const mdFile = new File([md], buildSummary(req.file.name), {
        type: 'text/markdown;charset=utf-8',
      });
      try {
        summaryRecord = await store.upload(req.projectId, mdFile);
      } catch (err) {
        throw new MultimediaImportError(
          'MULTIMEDIA_PERSIST_FAILED',
          `요약 마크다운 저장 실패: ${(err as Error).message}`,
          err,
        );
      }
    }
    req.onProgress?.({ phase: 'persist', current: 3, total: 3 });
    req.onProgress?.({ phase: 'finalize', current: 1, total: 1 });

    return { originalRecord, extractedTextRecord, summaryRecord, result };
  }

  return {
    importPpt,
    accept: parser.accept,
    maxBytes: parser.maxBytes,
  };
}
