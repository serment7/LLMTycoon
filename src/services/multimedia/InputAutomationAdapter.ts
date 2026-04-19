// 지시 #9c2ae902 · 입력 자동화(키보드/마우스 위임) 어댑터 스텁.
//
// 본 어댑터는 사용자가 명시적으로 허용한 권한 범위 안에서만 브라우저 DOM 혹은 OS
// 수준 키보드/마우스 시퀀스를 실행한다. 보안·접근성 관점에서 아래 3중 가드를 지킨다:
//   1) `capabilities.requiresUserConsent === true` — 레지스트리가 호출 전 사용자 확인 필수.
//   2) `config.inputAutomationMaxPermission` 를 초과하는 요청은 즉시 PERMISSION_DENIED.
//   3) `humanRationale` 가 비어 있으면 INPUT_INVALID — "왜 필요한지" 문장이 없으면 UX 가
//      사용자에게 설명할 수 없으므로 실행을 거절.
//
// 실제 실행은 Playwright/Puppeteer 또는 브라우저 확장 메시징으로 후속 PR 에서 구현.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type InputAutomationInput,
} from './types';

export const INPUT_AUTOMATION_ADAPTER_ID = 'builtin-input-automation';

const PERMISSION_RANK: Readonly<Record<InputAutomationInput['requestedPermission'], number>> = {
  display: 0,
  interact: 1,
  system: 2,
};

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'input-automation',
    id: INPUT_AUTOMATION_ADAPTER_ID,
    displayName: '입력 자동화 어댑터',
    supportedInputMimes: [],
    producedOutputMimes: [],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: true,
      requiresUserConsent: true,
    },
    priority: 0,
    dependsOn: [],
  };
}

export const createInputAutomationAdapter: MediaAdapterFactory<'input-automation'> = (config) => {
  return new InputAutomationAdapter(config);
};

class InputAutomationAdapter implements MediaAdapter<'input-automation'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();

  constructor(private readonly _config: MultimediaAdapterConfig) {}

  canHandle(input: InputAutomationInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (!Array.isArray(input.steps) || input.steps.length === 0) return false;
    if (typeof input.humanRationale !== 'string' || input.humanRationale.trim().length === 0) {
      return false;
    }
    const maxAllowed = this._config.inputAutomationMaxPermission ?? 'display';
    return PERMISSION_RANK[input.requestedPermission] <= PERMISSION_RANK[maxAllowed];
  }

  // TODO(#9c2ae902-후속):
  //   1) Playwright 세션 획득(브라우저 자동화 모드) 또는 postMessage 채널로 확장 호출
  //   2) 단계 간 3ms 최소 간격 + signal 취소 즉시 stop
  //   3) 실행 로그를 감사 저장소에 남김
  async invoke(
    call: MediaAdapterInvocation<'input-automation'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'input-automation'>>> {
    const maxAllowed = this._config.inputAutomationMaxPermission ?? 'display';
    if (PERMISSION_RANK[call.input.requestedPermission] > PERMISSION_RANK[maxAllowed]) {
      throw new MediaAdapterError(
        'PERMISSION_DENIED',
        `요청 권한(${call.input.requestedPermission})이 허용 최대치(${maxAllowed})를 초과합니다.`,
        { adapterId: this.descriptor.id },
      );
    }
    throw new MediaAdapterError(
      'ADAPTER_NOT_REGISTERED',
      '입력 자동화 어댑터 실제 구현이 아직 없습니다. 후속 PR 에서 Playwright 연결 예정.',
      { adapterId: this.descriptor.id },
    );
  }
}
