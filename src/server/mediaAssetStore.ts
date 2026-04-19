// 서버 메모리 기반 MediaAsset 저장소. `claudeTokenUsageStore` 와는 **완전히 분리된**
// 축으로, 토큰 사용량 집계가 빠르게 회전하는 메트릭 저장소라면 이쪽은 "이번 프로젝트
// 에 어떤 자료가 쌓였는가" 를 보여 주는 자료 축이다. 두 저장소를 합치면 다음 문제가
// 생긴다:
//   1. 할당 한도가 다르다 — 토큰 메트릭은 일자별 쿼터 관리가 핵심이지만 MediaAsset 은
//      프로젝트 전 기간 누적이 기본.
//   2. 직렬화 경로가 다르다 — 토큰은 localStorage/DB 둘 다, MediaAsset 은 파일 시스템/
//      객체 스토리지까지 다층.
//   3. 책임자가 다르다 — 토큰 쪽은 ClaudeTokenUsage 전용 팀이 정리 중이라 인터페이스가
//      자주 바뀐다. 섞어 두면 본 스토어가 끌려 다닌다.
//
// 본 구현은 **1차 스켈레톤** 으로 인메모리 싱글톤만 제공한다. Mongo 컬렉션으로 옮기는
// 것은 후속 사이클이며, 인터페이스(`MediaAssetStore`) 를 고정해 그때도 호출부는 그대로
// 둘 수 있게 한다.

import type { MediaAsset } from '../types';

export interface MediaAssetStore {
  /** 신규 자산을 저장(id 중복 시 덮어쓰기). 저장된 레코드를 그대로 돌려 준다. */
  save(asset: MediaAsset): MediaAsset;
  /** 동일 프로젝트에 속한 자산을 신규 순서로 돌려 준다(최신이 앞). */
  listByProject(projectId: string): readonly MediaAsset[];
  /** id 로 단건 조회. 없으면 null. */
  get(id: string): MediaAsset | null;
  /** id 로 단건 삭제. 존재하지 않으면 false. */
  delete(id: string): boolean;
  /** 테스트/재기동 초기화. */
  clear(): void;
}

export function createMediaAssetStore(): MediaAssetStore {
  const byId = new Map<string, MediaAsset>();
  const byProject = new Map<string, MediaAsset[]>();
  return {
    save(asset) {
      byId.set(asset.id, asset);
      const arr = byProject.get(asset.projectId) ?? [];
      // id 중복이면 기존 항목을 제거 후 가장 앞으로 재삽입 — "최신 저장 = 가장 앞" 을
      // 자연스럽게 보장하는 동시에, 호출자가 같은 id 로 재생성한 경우의 일관성을 유지.
      const existingIdx = arr.findIndex(a => a.id === asset.id);
      if (existingIdx >= 0) arr.splice(existingIdx, 1);
      arr.unshift(asset);
      byProject.set(asset.projectId, arr);
      return asset;
    },
    listByProject(projectId) {
      return byProject.get(projectId) ?? [];
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    delete(id) {
      const existing = byId.get(id);
      if (!existing) return false;
      byId.delete(id);
      const arr = byProject.get(existing.projectId);
      if (arr) {
        const idx = arr.findIndex(a => a.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) byProject.delete(existing.projectId);
      }
      return true;
    },
    clear() {
      byId.clear();
      byProject.clear();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 서버 전역 싱글톤
// ────────────────────────────────────────────────────────────────────────────
// server.ts 가 기동 시 본 함수를 한 번 호출해 전역 저장소를 확보한다. 테스트는
// `resetMediaAssetStore()` 로 초기 상태를 확보한 뒤 `getMediaAssetStore()` 를 다시
// 받아오면 된다(Mongo 시대가 오면 본 싱글톤은 DB 어댑터로 교체된다).

let singleton: MediaAssetStore | null = null;

export function getMediaAssetStore(): MediaAssetStore {
  if (!singleton) singleton = createMediaAssetStore();
  return singleton;
}

export function resetMediaAssetStore(): void {
  singleton = null;
}
