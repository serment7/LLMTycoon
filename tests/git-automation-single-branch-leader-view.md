# Git 자동화 · 단일 브랜치 리더 주도 통합 뷰 시안 (2026-04-18)

대상 컴포넌트: `src/components/GitAutomationPanel.tsx`, `src/components/GitAutomationStageBadge.tsx`, `src/components/AgentContextBubble.tsx`

시안 이미지: `tests/git-automation-single-branch-leader-view.svg`

## 전환 배경

단일 브랜치 운영(main) 정책으로 바뀌면서, 기존의 "에이전트별 브랜치 + 에이전트별 색상" 뷰는
머지 충돌과 시선 분산을 유발한다. 리더 Kai 가 여러 팀원의 커밋을 한 파이프라인으로 묶어
직접 진행하는 흐름에 맞춰, 스테이지 뱃지·브랜치 표시 영역을 리더 앵커로 재구성한다.

## 핵심 결정

1. **브랜치 칩 1개**: `⎇ main` 시안 테두리 단일 칩으로 교체. 에이전트별 브랜치 행 삭제.
2. **리더 색상 통일**: 시안(`#0891b2` / `#7fd4ff`) 을 파이프라인 앵커 톤으로 고정. 팀원 색(노랑/보라/분홍) 은 기여 아바타에만 남긴다.
3. **가로 타임라인**: 커밋 → 푸시 → PR → 완료 4단계를 수평 타임라인으로 묶고, 연결선 색이 이전 단계 상태를 그대로 계승(`data-prev-state`).
4. **기여 아바타 스택**: 이번 턴에 커밋한 에이전트를 16px 원형 도트로 수평 누적. 리더는 시안 테두리로 구분.
5. **AgentContextBubble 이원화**:
   - 리더 버블 → 통합 브랜치 칩 + 3뱃지 + 기여 아바타 전체 노출.
   - 팀원 버블 → 14px 도트 축약 + "리더 상세 참조" 문구로 이중 진실(DoT) 제거.
6. **상태 팔레트 불변**: `index.css` 의 `--git-stage-*` 토큰/글리프(`○ ◔ ◉ ✕`) 는 그대로. 톤 스펙 재사용만 한다.

## 구현 시 유의

- `GitAutomationStageBadge` 의 `compact` 변형을 팀원 버블 14px 도트 모드로 확장(추가 prop `variant="dot"`)하는 후속 이슈가 필요.
- `AgentContextBubble` 의 `gitAutomation` prop 은 리더에게만 전체 배열을 넘기고, 팀원에게는 `pickLatestByStage` 결과만 축약해 전달하는 식으로 부하를 줄일 수 있다.
- `AutoFlowProgressBar` 의 `git` 단계 글로우 애니메이션은 4번째 "완료" 스텝과 시각 규칙이 같아야 한다(전원 완료 순간 시안 halo).

## 후속 단계

1. Kai 승인 후 `GitAutomationPanel` 의 FLOW_OPTIONS 3카드를 "리더 주도 통합 타임라인"으로 흡수할지 별건 검토.
2. `CollabTimeline` 와 색상 계약 재조정 — 팀원 색은 기여 아바타 외부에서는 쓰지 않는다.
3. 접근성 회귀: 통합 뷰에서도 `aria-label` 이 "단계 · 상태" 형식을 유지하는지 확인.
