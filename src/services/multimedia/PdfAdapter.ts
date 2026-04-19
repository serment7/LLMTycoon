// 지시 #9c2ae902 · PDF 어댑터 스켈레톤.
//
// 본 파일은 MediaAdapter 계약에 맞춘 PDF 축의 뼈대이며, 실제 파싱/생성 호출은
// 후속 태스크에서 아래 기존 모듈들과 연결한다:
//   · 파싱: src/services/media/pdfLoader.ts::extractPdf
//   · 생성: src/utils/mediaExporters.ts::exportPdfReport
//
// 본 PR 에서는 descriptor/canHandle/invoke 시그니처만 확정해, UI('미디어 허브') 와
// 레지스트리가 타입 단위로 결합 가능한 상태를 만드는 것이 목표다.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MediaFileInput,
  type MultimediaAdapterConfig,
} from './types';

export const PDF_ADAPTER_ID = 'builtin-pdf';

const SUPPORTED_MIMES: readonly string[] = ['application/pdf'];
const PRODUCED_MIMES: readonly string[] = ['application/pdf'];

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'pdf',
    id: PDF_ADAPTER_ID,
    displayName: 'PDF 어댑터',
    supportedInputMimes: SUPPORTED_MIMES,
    producedOutputMimes: PRODUCED_MIMES,
    capabilities: {
      canParse: true,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: true,
      requiresUserConsent: false,
    },
    priority: 0,
    dependsOn: [],
  };
}

export const createPdfAdapter: MediaAdapterFactory<'pdf'> = (config) => {
  return new PdfAdapter(config);
};

class PdfAdapter implements MediaAdapter<'pdf'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();

  constructor(private readonly _config: MultimediaAdapterConfig) {}

  canHandle(input: MediaFileInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (input.mimeType && !SUPPORTED_MIMES.includes(input.mimeType)) return false;
    if (input.fileName && !input.fileName.toLowerCase().endsWith('.pdf') && !input.mimeType) {
      return false;
    }
    if (typeof input.sizeBytes === 'number' && input.sizeBytes > this._config.maxBytes) {
      return false;
    }
    return true;
  }

  // TODO(#9c2ae902-후속): src/services/media/pdfLoader.ts::extractPdf 와 연결해 실제
  //   페이지 추출 결과를 MediaAdapterOutput<'pdf'> 로 변환한다. 현재는 ADAPTER_NOT_REGISTERED
  //   코드로 즉시 실패해 UI 가 "후속 구현 예정" 메시지를 노출하게 한다.
  async invoke(
    _call: MediaAdapterInvocation<'pdf'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'pdf'>>> {
    throw new MediaAdapterError(
      'ADAPTER_NOT_REGISTERED',
      'PDF 어댑터 실제 구현이 아직 없습니다. 후속 PR 에서 pdfLoader 와 연결 예정.',
      { adapterId: this.descriptor.id },
    );
  }
}
