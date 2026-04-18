/**
 * 오피스 플로어 상단 메뉴에 현재 선택된 프로젝트 이름을 띄우는 뱃지.
 *
 * App.tsx 의 전역 header(확대/에이전트/프로젝트 수 등 메트릭 칩이 나열된 영역)에서
 * selectedProjectId 에 해당하는 ManagedProject 의 name 을 props 로 받아
 * 동일한 .bg-black/30 스타일의 칩으로 렌더한다.
 *
 * 프로젝트 미선택( null / '' / 공백만 )인 경우에는 placeholder 로 "프로젝트 미선택"
 * 을 표시한다 — App.tsx 의 `!selectedProjectId` 분기에서 EmptyProjectPlaceholder 가
 * 뜨는 상황과 시각적으로 짝을 이룬다.
 */
interface CurrentProjectBadgeProps {
  projectName?: string | null;
}

export const CURRENT_PROJECT_PLACEHOLDER = '프로젝트 미선택';

export function CurrentProjectBadge({ projectName }: CurrentProjectBadgeProps) {
  const trimmed = typeof projectName === 'string' ? projectName.trim() : '';
  const hasProject = trimmed.length > 0;
  const display = hasProject ? trimmed : CURRENT_PROJECT_PLACEHOLDER;
  return (
    <div
      className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)] text-[var(--pixel-accent)]"
      data-testid="current-project-badge"
      data-has-project={hasProject ? 'true' : 'false'}
      aria-label={hasProject ? `현재 프로젝트: ${display}` : CURRENT_PROJECT_PLACEHOLDER}
      title={hasProject ? `현재 프로젝트: ${display}` : CURRENT_PROJECT_PLACEHOLDER}
    >
      프로젝트: {display}
    </div>
  );
}
