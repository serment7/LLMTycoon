// KeyboardShortcutCheatsheet(#0dceedcd) — SettingsDrawer 가 노출하는 단축키 카탈로그.
//
// 설계 — 본 컴포넌트는 `keyboardShortcuts` 레지스트리의 `GLOBAL_SHORTCUT_CATEGORIES`
// 를 그대로 읽어 섹션별로 렌더한다. 항목이 추가되면 자동으로 목록에 들어온다.
// 프롭으로 `extra` 를 받으면 커스텀 섹션을 추가 가능하다(상위 테스트에서 주입).

import React from 'react';

import {
  GLOBAL_SHORTCUT_CATEGORIES,
  type ShortcutBinding,
  type ShortcutCategory,
} from '../utils/keyboardShortcuts';

export interface KeyboardShortcutCheatsheetProps {
  categories?: ReadonlyArray<ShortcutCategory>;
  className?: string;
}

/** 치트시트에 나열될 단축키 바인딩이 모두 유효한 키 조합 + 한국어 설명을 가졌는지 검증. */
export function validateCheatsheetBindings(
  bindings: ReadonlyArray<ShortcutBinding<string>>,
): { ok: true } | { ok: false; invalid: ReadonlyArray<string> } {
  const invalid: string[] = [];
  for (const b of bindings) {
    if (!b.keys || typeof b.keys !== 'string' || b.keys.trim().length === 0) invalid.push(`${b.id}:empty-keys`);
    if (!b.description || b.description.trim().length === 0) invalid.push(`${b.id}:empty-description`);
  }
  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}

/** "Alt+P" 같은 조합 문자열을 <kbd> 세그먼트 배열로 분할한다. */
export function splitCombo(combo: string): ReadonlyArray<string> {
  return combo.split('+').map(s => s.trim()).filter(Boolean);
}

export function KeyboardShortcutCheatsheet({
  categories = GLOBAL_SHORTCUT_CATEGORIES,
  className,
}: KeyboardShortcutCheatsheetProps = {}): React.ReactElement {
  return (
    <section
      aria-label="키보드 단축키 치트시트"
      data-testid="shortcut-cheatsheet"
      className={`shortcut-cheatsheet${className ? ` ${className}` : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-md)',
      }}
    >
      {categories.map(cat => (
        <div key={cat.title} data-testid="shortcut-cheatsheet-category" data-title={cat.title}>
          <h4
            className="text-[11px] uppercase tracking-wider"
            style={{ color: 'var(--color-text-muted)', marginBottom: 'var(--space-xs)' }}
          >
            {cat.title}
          </h4>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
            {cat.shortcuts.map(s => (
              <li
                key={s.id}
                data-testid="shortcut-cheatsheet-item"
                data-shortcut-id={s.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}
              >
                <div style={{ display: 'flex', gap: 2 }}>
                  {splitCombo(s.keys).map((seg, i, arr) => (
                    <React.Fragment key={i}>
                      <kbd
                        style={{
                          fontSize: 'var(--font-size-xs)',
                          padding: '1px 6px',
                          background: 'var(--color-surface-elevated)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--color-text)',
                        }}
                      >
                        {seg}
                      </kbd>
                      {i < arr.length - 1 ? (
                        <span aria-hidden="true" style={{ color: 'var(--color-text-subtle)' }}>
                          +
                        </span>
                      ) : null}
                    </React.Fragment>
                  ))}
                </div>
                <div style={{ flex: 1, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                  {s.description}
                  {s.a11yHint ? (
                    <span
                      aria-label={s.a11yHint}
                      style={{ display: 'block', fontSize: 'var(--font-size-xxs)', color: 'var(--color-text-subtle)' }}
                    >
                      {s.a11yHint}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
