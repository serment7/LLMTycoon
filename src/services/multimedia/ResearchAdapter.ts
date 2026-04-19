// 지시 #9c2ae902 · 심층 조사 어댑터 스텁.
//
// Research = 웹검색 결과 + 로컬 파일 맥락 + Claude 요약 을 한 데 묶어 인용 포함 본문을
// 반환하는 고수준 어댑터. 의존성으로 WebSearchAdapter 를 선언하고, 레지스트리가
// 의존성 순환 검증 후 주입한다.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type ResearchInput,
} from './types';
import { WEB_SEARCH_ADAPTER_ID } from './WebSearchAdapter';

export const RESEARCH_ADAPTER_ID = 'builtin-research';

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'research',
    id: RESEARCH_ADAPTER_ID,
    displayName: '심층 조사 어댑터',
    supportedInputMimes: [],
    producedOutputMimes: [],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: false,
      requiresUserConsent: false,
    },
    priority: 0,
    dependsOn: [WEB_SEARCH_ADAPTER_ID],
  };
}

export const createResearchAdapter: MediaAdapterFactory<'research'> = (config) => {
  return new ResearchAdapter(config);
};

class ResearchAdapter implements MediaAdapter<'research'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();

  constructor(private readonly _config: MultimediaAdapterConfig) {}

  canHandle(input: ResearchInput): boolean {
    return Boolean(input && typeof input.topic === 'string' && input.topic.trim().length > 0);
  }

  // TODO(#9c2ae902-후속):
  //   1) 레지스트리에서 web-search 어댑터 해석 (fallback: 검색 생략 · 로컬 컨텍스트만)
  //   2) depth 단계별 질문 확장 → 병렬 검색 → 결과 집약
  //   3) Claude 요약 호출 + 인용 URL 강제 주입
  async invoke(
    _call: MediaAdapterInvocation<'research'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'research'>>> {
    throw new MediaAdapterError(
      'ADAPTER_NOT_REGISTERED',
      '심층 조사 어댑터 실제 구현이 아직 없습니다. 후속 PR 에서 web-search · Claude 요약과 연결 예정.',
      { adapterId: this.descriptor.id },
    );
  }
}
