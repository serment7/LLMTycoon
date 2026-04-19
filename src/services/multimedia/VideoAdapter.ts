// 지시 #9c2ae902 · 영상 생성 어댑터 스텁.
//
// 영상 생성은 단일 HTTP 왕복이 아니라 "작업 큐 등록 → 폴링/웹훅 → 완료 자산 수집" 의
// 3단 파이프라인이다. 본 스텁은 "jobId 를 즉시 돌려주되 상태는 pending" 형태의 골격만
// 고정해, UI 허브 §2.1 세그먼트 바가 phase='upload' → 'finalize' 로 전이하는 동안
// 그 이후의 폴링 루프를 붙일 수 있도록 준비한다.
//
// 후속 PR 에서 연결 대상:
//   · src/utils/mediaExporters.ts::exportVideo — 서버 /api/media/generate 호출
//   · 작업 큐: 서버 측 VideoGenerationJob — 본 PR 에 포함하지 않는다
//
// 권한·크레딧 처리는 서버에서 검증 — 본 어댑터는 "큐 등록" 계약만 책임진다.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type VideoGenerationInput,
} from './types';

export const VIDEO_ADAPTER_ID = 'builtin-video';

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'video',
    id: VIDEO_ADAPTER_ID,
    displayName: '영상 생성 어댑터',
    supportedInputMimes: [],
    producedOutputMimes: ['video/mp4', 'video/webm'],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: false,
      requiresUserConsent: false,
    },
    priority: 0,
    dependsOn: [],
  };
}

export const createVideoAdapter: MediaAdapterFactory<'video'> = (config) => {
  return new VideoAdapter(config);
};

class VideoAdapter implements MediaAdapter<'video'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();

  constructor(private readonly _config: MultimediaAdapterConfig) {}

  canHandle(input: VideoGenerationInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) return false;
    if (typeof input.durationSeconds === 'number' && input.durationSeconds <= 0) return false;
    return true;
  }

  // TODO(#9c2ae902-후속):
  //   1) /api/media/generate 호출 — exportVideo 위임
  //   2) 응답의 jobId 를 VideoGenerationJobQueue 에 등록
  //   3) onProgress 로 단계별 상태(대기/생성/완료) 를 흘려 보낸다
  async invoke(
    _call: MediaAdapterInvocation<'video'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'video'>>> {
    throw new MediaAdapterError(
      'ADAPTER_NOT_REGISTERED',
      '영상 생성 어댑터 실제 구현이 아직 없습니다. 후속 PR 에서 작업 큐와 연결 예정.',
      { adapterId: this.descriptor.id },
    );
  }
}
