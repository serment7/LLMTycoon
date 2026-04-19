// 멀티미디어 "생성" 축의 공용 팩토리. 입력 축(mediaProcessor.ts) 과 쌍을 이루어
// 공동 목표 구현이 끝난 뒤 리더·QA 가 PDF 리포트·PPT 덱·영상 결과물을 만들어
// 팀 축 타임라인과 프로젝트 자료 축에 영속화할 수 있게 한다.
//
// 세 축(지시 #b425328e §1):
//   - `generatePdfReport(assets, template)` — 입력 MediaAsset 들과 간단한 템플릿을
//     받아 pdf-lib 기반(또는 mock) PDF 를 만들어 MediaAsset 으로 래핑한다.
//   - `generatePptxDeck(slides)` — pptxgenjs 기반(또는 mock) PPT 덱을 만든다.
//   - `VideoGenAdapter` 인터페이스는 mediaProcessor.ts 의 것을 그대로 재사용한다.
//     본 모듈은 외부 영상 생성 API 를 대체할 `MockVideoGenAdapter` 와 `exhausted`
//     세션 상태 가드(지시 §4) 를 함께 제공한다.
//
// 설계 메모
//   - 실제 라이브러리(pdf-lib, pptxgenjs) 의 동적 import 는 어댑터 레이어로 분리해
//     테스트 환경(의존성 미설치) 에서도 mock 어댑터만 주입하면 전체 경로가 동작한다.
//   - 생성된 결과는 "바이트 + 메타" 로 돌려주고, 상위(server.ts) 가 최종 MediaAsset
//     레코드를 `mediaAssetStore` 에 저장한다. 바이트를 파일시스템/객체 스토리지에
//     올릴지는 본 모듈의 책임이 아니다.
//   - `sessionStatusProvider` 를 생성자에 주입하면 `generateVideo` 호출 시점마다
//     최신 세션 상태를 조회해, Joker 가 구현한 token_exhausted 폴백(=외부 API 차단)
//     과 한 곳에서 연동된다.

import type { MediaAsset, ClaudeSessionStatus } from '../types';
import { getVideoGenAdapter, type VideoGenAdapter } from './mediaProcessor';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ────────────────────────────────────────────────────────────────────────────

export interface PdfReportSection {
  heading: string;
  body: string;
}

export interface PdfReportTemplate {
  title: string;
  sections: readonly PdfReportSection[];
}

export interface PptxSlide {
  title: string;
  body?: string;
}

/**
 * 어댑터가 돌려주는 "바이트 + 메타" 결과. 서버 계층이 이걸 MediaAsset 레코드로
 * 래핑하고 저장소에 적재한다.
 */
export interface GeneratedMediaResult {
  kind: MediaAsset['kind'];
  buffer: Uint8Array;
  mimeType: string;
  suggestedName: string;
}

export interface PdfGeneratorAdapter {
  readonly id: string;
  generate(input: {
    assets: readonly MediaAsset[];
    template: PdfReportTemplate;
    projectId: string;
  }): Promise<GeneratedMediaResult>;
}

export interface PptxGeneratorAdapter {
  readonly id: string;
  generate(input: {
    slides: readonly PptxSlide[];
    projectId: string;
  }): Promise<GeneratedMediaResult>;
}

/**
 * 세션이 `exhausted` 일 때 외부 영상 생성 API 호출을 차단했다는 사실을 상위에
 * 전달하기 위한 전용 에러. 서버 라우트는 본 에러를 잡아 503 등 적절한 코드로
 * 수렴시킨다(UI 는 "세션 소진" 배너 경로로 동일 문구를 낭독).
 */
export class ExhaustedBlockedError extends Error {
  readonly category = 'session_exhausted' as const;
  constructor(reason?: string) {
    super(reason ?? '세션이 소진되어 외부 영상 생성 호출이 차단되었습니다.');
    this.name = 'ExhaustedBlockedError';
  }
}

export interface MediaGeneratorOptions {
  /**
   * 현재 Claude 세션 상태를 실시간으로 알려주는 Supplier. `exhausted` 면 외부 호출
   * 축(현재는 영상 생성 어댑터) 이 차단된다. 로컬 라이브러리 기반 PDF/PPT 생성은
   * 차단 대상이 아니다 — 사용자는 세션 소진 상태에서도 이미 수집한 자료로
   * 리포트를 뽑을 수 있어야 한다.
   */
  sessionStatusProvider?: () => ClaudeSessionStatus;
  pdf?: PdfGeneratorAdapter;
  pptx?: PptxGeneratorAdapter;
}

export interface MediaGenerator {
  generatePdfReport(input: {
    assets: readonly MediaAsset[];
    template: PdfReportTemplate;
    projectId: string;
  }): Promise<MediaAsset>;
  generatePptxDeck(input: {
    slides: readonly PptxSlide[];
    projectId: string;
  }): Promise<MediaAsset>;
  /**
   * 영상 생성. `sessionStatusProvider()` 가 'exhausted' 면 즉시 ExhaustedBlockedError
   * 를 던진다. 어댑터 미등록 시에는 기존 Joker 스켈레톤과 동일하게 Error.
   */
  generateVideo(input: { prompt: string; projectId: string }): Promise<MediaAsset>;
}

// ────────────────────────────────────────────────────────────────────────────
// Mock 어댑터 (테스트 기본값 · 의존성 미설치 환경 폴백)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 실제 pdf-lib 호출 없이 placeholder 바이트만 돌려주는 mock. 회귀 테스트와
 * 의존성 미설치 CI 에서 전체 파이프라인을 빠르게 검증하는 용도다.
 */
export const mockPdfGenerator: PdfGeneratorAdapter = {
  id: 'pdf-mock',
  async generate({ template, projectId, assets }) {
    const body = [
      `%PDF-mock`,
      `# ${template.title}`,
      `project=${projectId}`,
      `attached-assets=${assets.length}`,
      ...template.sections.map(s => `## ${s.heading}\n${s.body}`),
    ].join('\n');
    return {
      kind: 'pdf',
      buffer: new TextEncoder().encode(body),
      mimeType: 'application/pdf',
      suggestedName: safeFileName(template.title, 'pdf'),
    };
  },
};

export const mockPptxGenerator: PptxGeneratorAdapter = {
  id: 'pptx-mock',
  async generate({ slides, projectId }) {
    const body = [
      'pptx-mock',
      `project=${projectId}`,
      ...slides.map((s, i) => `#${i + 1} ${s.title}\n${s.body ?? ''}`),
    ].join('\n---\n');
    return {
      kind: 'pptx',
      buffer: new TextEncoder().encode(body),
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      suggestedName: `deck-${Date.now()}.pptx`,
    };
  },
};

/**
 * 외부 영상 생성 서비스의 자리 대체 mock. server 기동 시 registerVideoGenAdapter
 * 로 이걸 등록해 두면 `/api/media/generate` 가 503 대신 mock 결과를 돌려 준다.
 */
export const mockVideoGenAdapter: VideoGenAdapter = {
  id: 'video-mock',
  async generate({ prompt, projectId }) {
    const now = new Date().toISOString();
    return {
      id: `mock-video-${Date.now()}`,
      projectId,
      kind: 'video',
      name: `${safeFileName(prompt.slice(0, 24) || 'video', 'mp4')}`,
      mimeType: 'video/mp4',
      sizeBytes: 0,
      createdAt: now,
      generatedBy: { adapter: 'video-mock', prompt },
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 팩토리
// ────────────────────────────────────────────────────────────────────────────

export function createMediaGenerator(options: MediaGeneratorOptions = {}): MediaGenerator {
  const pdf = options.pdf ?? mockPdfGenerator;
  const pptx = options.pptx ?? mockPptxGenerator;
  const status = () => options.sessionStatusProvider?.() ?? 'active';

  return {
    async generatePdfReport(input) {
      const result = await pdf.generate(input);
      return wrapAsMediaAsset(result, input.projectId, {
        adapter: pdf.id,
        prompt: input.template.title,
      });
    },
    async generatePptxDeck(input) {
      const result = await pptx.generate(input);
      return wrapAsMediaAsset(result, input.projectId, {
        adapter: pptx.id,
        prompt: `slides:${input.slides.length}`,
      });
    },
    async generateVideo(input) {
      // 지시 §4: exhausted 세션에서는 외부 영상 API 호출을 차단한다. 로컬 생성
      // 경로(PDF/PPT) 는 대상이 아님 — 사용자는 세션 소진 중에도 내부 자산으로
      // 리포트·덱을 뽑아야 하기 때문이다.
      if (status() === 'exhausted') {
        throw new ExhaustedBlockedError();
      }
      const adapter = getVideoGenAdapter();
      if (!adapter) {
        throw new Error('영상 생성 어댑터가 등록되어 있지 않습니다.');
      }
      return adapter.generate({ prompt: input.prompt, projectId: input.projectId });
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 내부 유틸
// ────────────────────────────────────────────────────────────────────────────

function wrapAsMediaAsset(
  result: GeneratedMediaResult,
  projectId: string,
  generatedBy: { adapter: string; prompt: string },
): MediaAsset {
  return {
    id: `${result.kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    projectId,
    kind: result.kind,
    name: result.suggestedName,
    mimeType: result.mimeType,
    sizeBytes: result.buffer.byteLength,
    createdAt: new Date().toISOString(),
    generatedBy,
  };
}

function safeFileName(raw: string, ext: string): string {
  const trimmed = raw.trim() || 'untitled';
  // 파일시스템/URL 에서 안전하지 않은 문자 제거 + 공백 → 하이픈.
  const cleaned = trimmed.replace(/[^0-9A-Za-z가-힣._ -]/g, '').replace(/\s+/g, '-');
  return `${cleaned || 'untitled'}.${ext}`;
}
