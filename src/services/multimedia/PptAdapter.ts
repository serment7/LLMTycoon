// 지시 #9c2ae902 · PPT 어댑터 스켈레톤. PdfAdapter 와 대칭 구조.
// 실제 구현 연결은 후속 PR — 파싱은 src/services/media/pptLoader.ts::extractPptx,
// 생성은 src/utils/mediaExporters.ts::exportPptxDeck.

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

export const PPT_ADAPTER_ID = 'builtin-pptx';

const SUPPORTED_MIMES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const PRODUCED_MIMES: readonly string[] = SUPPORTED_MIMES;

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'pptx',
    id: PPT_ADAPTER_ID,
    displayName: 'PPTX 어댑터',
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

export const createPptAdapter: MediaAdapterFactory<'pptx'> = (config) => {
  return new PptAdapter(config);
};

class PptAdapter implements MediaAdapter<'pptx'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();

  constructor(private readonly _config: MultimediaAdapterConfig) {}

  canHandle(input: MediaFileInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (input.mimeType && !SUPPORTED_MIMES.includes(input.mimeType)) return false;
    if (input.fileName && !input.fileName.toLowerCase().endsWith('.pptx') && !input.mimeType) {
      return false;
    }
    if (typeof input.sizeBytes === 'number' && input.sizeBytes > this._config.maxBytes) {
      return false;
    }
    return true;
  }

  // TODO(#9c2ae902-후속): pptLoader/exportPptxDeck 로 위임.
  async invoke(
    _call: MediaAdapterInvocation<'pptx'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'pptx'>>> {
    throw new MediaAdapterError(
      'ADAPTER_NOT_REGISTERED',
      'PPTX 어댑터 실제 구현이 아직 없습니다. 후속 PR 에서 pptLoader 와 연결 예정.',
      { adapterId: this.descriptor.id },
    );
  }
}
