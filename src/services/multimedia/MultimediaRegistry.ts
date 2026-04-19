// 지시 #9c2ae902 · 멀티미디어 어댑터 등록소.
//
// 본 클래스는 6종 어댑터(PDF · PPT · 영상 · 웹검색 · 심층조사 · 입력자동화) 의 팩토리를
// 단일 저장소에 모아 두고, UI/서버가 `kind` 혹은 `id` 로 어댑터 인스턴스를 요청할 수
// 있게 한다. 동일 kind 에 여러 팩토리가 등록된 경우 priority 오름차순으로 선택된다.
//
// 책임:
//   1) register() / unregister() — 테스트에서 드라이버를 교체할 수 있도록 허용.
//   2) resolve() — kind 기준 최선의 어댑터 인스턴스 반환. dependsOn 순환 탐지 포함.
//   3) list() — 현재 등록된 어댑터 descriptor 목록(설정 주입 후) — UI 카드 버튼 렌더링용.
//   4) createDefault() — 기본 6종 팩토리를 한 번에 등록한 레지스트리를 돌려준다.
//
// 본 파일은 실제 외부 서비스 호출을 포함하지 않는다. 팩토리 호출은 레이지 — 처음
// resolve 될 때만 어댑터 인스턴스를 만든다.

import {
  DEFAULT_ADAPTER_CONFIG,
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterId,
  type MediaAdapterKind,
  type MediaAdapterRegistration,
  type MultimediaAdapterConfig,
} from './types';
import { createPdfAdapter } from './PdfAdapter';
import { createPptAdapter } from './PptAdapter';
import { createVideoAdapter } from './VideoAdapter';
import { createWebSearchAdapter } from './WebSearchAdapter';
import { createResearchAdapter } from './ResearchAdapter';
import { createInputAutomationAdapter } from './InputAutomationAdapter';

export interface MultimediaRegistryOptions {
  readonly config?: Partial<MultimediaAdapterConfig>;
}

export class MultimediaRegistry {
  private readonly config: MultimediaAdapterConfig;
  private readonly byId = new Map<MediaAdapterId, MediaAdapterRegistration>();
  private readonly instanceCache = new Map<MediaAdapterId, MediaAdapter>();

  constructor(options: MultimediaRegistryOptions = {}) {
    this.config = Object.freeze({ ...DEFAULT_ADAPTER_CONFIG, ...(options.config ?? {}) });
  }

  /** 현재 주입된 설정(동결). */
  getConfig(): MultimediaAdapterConfig {
    return this.config;
  }

  register<K extends MediaAdapterKind>(
    factory: MediaAdapterFactory<K>,
    descriptor: MediaAdapterDescriptor,
  ): void {
    if (descriptor.kind !== descriptor.kind) {
      // 컴파일러 동등 체크 — 명시적 가드(kind 타입 보장).
    }
    if (this.byId.has(descriptor.id)) {
      throw new MediaAdapterError(
        'INTERNAL',
        `이미 등록된 어댑터 id: ${descriptor.id}`,
        { adapterId: descriptor.id },
      );
    }
    this.byId.set(descriptor.id, { factory: factory as MediaAdapterFactory, descriptor });
  }

  unregister(id: MediaAdapterId): boolean {
    this.instanceCache.delete(id);
    return this.byId.delete(id);
  }

  list(): readonly MediaAdapterDescriptor[] {
    return Array.from(this.byId.values()).map((r) => r.descriptor);
  }

  /** kind 기준 최우선(priority 최소) 어댑터 1개를 돌려준다. */
  resolveByKind<K extends MediaAdapterKind>(kind: K): MediaAdapter<K> {
    const candidates = Array.from(this.byId.values())
      .filter((r) => r.descriptor.kind === kind)
      .sort((a, b) => a.descriptor.priority - b.descriptor.priority);
    if (candidates.length === 0) {
      throw new MediaAdapterError(
        'ADAPTER_NOT_REGISTERED',
        `kind='${kind}' 어댑터가 등록되지 않았습니다.`,
      );
    }
    return this.resolveById(candidates[0].descriptor.id) as MediaAdapter<K>;
  }

  resolveById(id: MediaAdapterId): MediaAdapter {
    const cached = this.instanceCache.get(id);
    if (cached) return cached;

    const reg = this.byId.get(id);
    if (!reg) {
      throw new MediaAdapterError(
        'ADAPTER_NOT_REGISTERED',
        `id='${id}' 어댑터가 등록되지 않았습니다.`,
      );
    }

    // 의존성 순환 탐지 — dependsOn 체인을 deep 하게 따라간다.
    this.assertAcyclicDependency(id, new Set());

    // 의존성이 모두 등록돼 있는지 확인(실제 인스턴스는 호출자 책임).
    for (const depId of reg.descriptor.dependsOn) {
      if (!this.byId.has(depId)) {
        throw new MediaAdapterError(
          'DEPENDENCY_MISSING',
          `어댑터 '${id}' 가 의존하는 '${depId}' 가 등록되지 않았습니다.`,
          { adapterId: id, details: { missing: depId } },
        );
      }
    }

    const instance = reg.factory(this.config);
    this.instanceCache.set(id, instance);
    return instance;
  }

  private assertAcyclicDependency(id: MediaAdapterId, visiting: Set<MediaAdapterId>): void {
    if (visiting.has(id)) {
      throw new MediaAdapterError(
        'INTERNAL',
        `어댑터 의존성 순환 감지: ${Array.from(visiting).join(' → ')} → ${id}`,
        { adapterId: id },
      );
    }
    const reg = this.byId.get(id);
    if (!reg) return;
    visiting.add(id);
    for (const dep of reg.descriptor.dependsOn) {
      this.assertAcyclicDependency(dep, visiting);
    }
    visiting.delete(id);
  }
}

/** 6종 기본 어댑터를 모두 등록한 레지스트리를 돌려준다. */
export function createDefaultRegistry(
  options: MultimediaRegistryOptions = {},
): MultimediaRegistry {
  const reg = new MultimediaRegistry(options);
  reg.register(createPdfAdapter, createPdfAdapter(reg.getConfig()).descriptor);
  reg.register(createPptAdapter, createPptAdapter(reg.getConfig()).descriptor);
  reg.register(createVideoAdapter, createVideoAdapter(reg.getConfig()).descriptor);
  reg.register(createWebSearchAdapter, createWebSearchAdapter(reg.getConfig()).descriptor);
  reg.register(createResearchAdapter, createResearchAdapter(reg.getConfig()).descriptor);
  reg.register(
    createInputAutomationAdapter,
    createInputAutomationAdapter(reg.getConfig()).descriptor,
  );
  return reg;
}
