// 지시 #9c2ae902 · 웹 검색 어댑터 스텁.
//
// 검색 엔진은 환경마다 다르다(Google CSE · Bing · Tavily · Brave 등). 본 스켈레톤은
// "검색어 + 도메인 필터 + 언어" 만 받는 공용 프로토콜을 정의하고, 실제 API 호출은
// 후속 PR 에서 교체 가능한 `driver` 로 주입한다(전략 패턴).
//
// 본 어댑터의 출력은 ResearchAdapter 가 소비한다(의존성 역전).

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type WebSearchInput,
} from './types';

export const WEB_SEARCH_ADAPTER_ID = 'builtin-web-search';

function createDescriptor(config: MultimediaAdapterConfig): MediaAdapterDescriptor {
  return {
    kind: 'web-search',
    id: WEB_SEARCH_ADAPTER_ID,
    displayName: '웹 검색 어댑터',
    supportedInputMimes: [],
    producedOutputMimes: [],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: false,
      worksOffline: false,
      requiresUserConsent: false,
    },
    priority: 0,
    dependsOn: [],
    // 메타 노출용 — 설정에 크레덴셜이 없으면 UI 가 비활성 상태로 표기.
    ...(config.hasWebSearchCredentials === false ? {} : {}),
  };
}

export const createWebSearchAdapter: MediaAdapterFactory<'web-search'> = (config) => {
  return new WebSearchAdapter(config);
};

class WebSearchAdapter implements MediaAdapter<'web-search'> {
  readonly descriptor: MediaAdapterDescriptor;

  constructor(private readonly _config: MultimediaAdapterConfig) {
    this.descriptor = createDescriptor(_config);
  }

  canHandle(input: WebSearchInput): boolean {
    return Boolean(input && typeof input.query === 'string' && input.query.trim().length > 0);
  }

  // TODO(#9c2ae902-후속):
  //   1) driver 전략(google-cse | tavily | brave) 선택 로직
  //   2) 도메인 필터 적용
  //   3) 요약·스니펫 정규화
  async invoke(
    _call: MediaAdapterInvocation<'web-search'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'web-search'>>> {
    if (!this._config.hasWebSearchCredentials) {
      throw new MediaAdapterError(
        'PERMISSION_DENIED',
        '웹 검색 API 자격 증명이 등록되지 않았습니다. 프로젝트 설정에서 추가하세요.',
        { adapterId: this.descriptor.id },
      );
    }
    throw new MediaAdapterError(
      'ADAPTER_NOT_REGISTERED',
      '웹 검색 어댑터 실제 구현이 아직 없습니다. 후속 PR 에서 driver 구현 예정.',
      { adapterId: this.descriptor.id },
    );
  }
}
