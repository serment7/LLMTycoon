// ThemeToggle(#e7ba6da5) — 라이트·다크·시스템 3모드 전환기.
//
// 동작 규칙
//   1) 저장값은 localStorage 키 `llmtycoon.theme` (light | dark | system). 미설정은 'system'.
//   2) 'system' 이면 document.documentElement 에 data-theme 속성을 제거해 CSS 의
//      `prefers-color-scheme` 쿼리가 자동 반영되게 한다.
//   3) 'light'/'dark' 는 data-theme 속성을 명시로 찍어 시스템 선호를 덮어쓴다.
//   4) 본 컴포넌트는 마운트 시 1회 저장값을 읽어 DOM 에 적용하고, 이후 사용자 선택마다
//      저장·적용·재렌더를 순서대로 수행한다.
//
// 접근성
//   · `role="radiogroup"` + 각 버튼 `aria-pressed` — 현재 선택을 스크린리더에 고지.
//   · 키보드: Tab 으로 이동, Enter/Space 로 선택(브라우저 기본).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useI18n } from '../i18n';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — Node 테스트에서 직접 호출해 계약을 잠근다.
// ────────────────────────────────────────────────────────────────────────────

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'llmtycoon.theme';

/** localStorage 에서 읽은 값이 유효한 테마인지 판정. 손상/미지는 'system' 으로 수렴. */
export function parseThemePreference(raw: unknown): ThemePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

/**
 * 사용자 선택 + 시스템 선호를 받아 실제 적용할 테마를 해석한다.
 *   preference='system' → systemPrefersDark ? 'dark' : 'light'
 *   preference='light' → 'light'
 *   preference='dark'  → 'dark'
 * 본 함수는 DOM 접근이 없다.
 */
export function resolveAppliedTheme(params: {
  preference: ThemePreference;
  systemPrefersDark: boolean;
}): ResolvedTheme {
  if (params.preference === 'light') return 'light';
  if (params.preference === 'dark') return 'dark';
  return params.systemPrefersDark ? 'dark' : 'light';
}

/**
 * documentElement 의 data-theme 속성을 어떻게 바꿀지 기술한다.
 *   preference='system' → 속성 제거('remove') — CSS 의 prefers-color-scheme 이 자동 반영
 *   그 외 → 'set' + value
 * 실제 DOM 조작은 호출자(또는 applyThemeToDocument)가 수행.
 */
export function deriveThemeAttribute(preference: ThemePreference):
  | { action: 'remove' }
  | { action: 'set'; value: ResolvedTheme } {
  if (preference === 'system') return { action: 'remove' };
  return { action: 'set', value: preference };
}

/** DOM 에 적용하는 얇은 side-effect 래퍼. 브라우저 외 환경에서는 no-op. */
export function applyThemeToDocument(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const decision = deriveThemeAttribute(preference);
  if (decision.action === 'remove') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.setAttribute('data-theme', decision.value);
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

function readStored(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function writeStored(value: ThemePreference): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, value); }
  catch { /* 시크릿 모드 등은 조용히 무시 */ }
}

export interface ThemeToggleProps {
  className?: string;
}

const OPTION_ICONS: Record<ThemePreference, React.ReactElement> = {
  light: <Sun size={12} aria-hidden="true" />,
  system: <Monitor size={12} aria-hidden="true" />,
  dark: <Moon size={12} aria-hidden="true" />,
};
const OPTION_VALUES: ReadonlyArray<ThemePreference> = ['light', 'system', 'dark'];

export function ThemeToggle({ className }: ThemeToggleProps = {}): React.ReactElement {
  const { t } = useI18n();
  const options = useMemo(
    () => OPTION_VALUES.map(value => ({
      value,
      label: t(`theme.options.${value}`),
      icon: OPTION_ICONS[value],
    })),
    [t],
  );
  const [preference, setPreference] = useState<ThemePreference>(() => readStored());

  // 마운트 시 저장값을 DOM 에 적용.
  useEffect(() => {
    applyThemeToDocument(preference);
  }, [preference]);

  // 시스템 선호 변경 감지 — preference='system' 일 때만 재렌더를 유도할 필요가 있지만,
  // data-theme 를 비워 둔 상태에서는 CSS 미디어 쿼리가 즉시 반영하므로 별도 상태 반영은 불필요.
  // 다만 접근성 라벨 갱신을 위해 aria-label 에 반영하려면 이 지점에서 시스템 변경을 관찰.
  // 현재는 UI 라벨이 'system' 문자열만 표시하므로 불필요 — 추후 미리보기 라벨 추가 시 확장.

  const onSelect = useCallback((value: ThemePreference) => {
    setPreference(value);
    writeStored(value);
    applyThemeToDocument(value);
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label={t('theme.ariaLabel')}
      data-testid="theme-toggle"
      data-tour-anchor="theme-toggle"
      className={`theme-toggle${className ? ` ${className}` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        background: 'var(--color-surface)',
        border: '2px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {options.map(opt => {
        const pressed = preference === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={pressed}
            aria-pressed={pressed}
            aria-label={t('theme.selectAria').replace('{label}', opt.label)}
            data-testid={`theme-toggle-${opt.value}`}
            data-active={pressed ? 'true' : 'false'}
            onClick={() => onSelect(opt.value)}
            className="px-2 py-1 text-[11px] font-bold uppercase flex items-center gap-1"
            style={{
              background: pressed ? 'var(--color-accent)' : 'transparent',
              color: pressed ? 'var(--color-accent-contrast)' : 'var(--color-text-muted)',
              border: '1px solid transparent',
              transition: 'background var(--motion-duration-sm) var(--motion-ease-out), color var(--motion-duration-sm) var(--motion-ease-out)',
              cursor: 'pointer',
            }}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
