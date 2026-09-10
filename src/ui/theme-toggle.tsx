'use client';

import { useRouter } from 'next/navigation';
import { Icon } from '@/ui/icons.tsx';

const THEME_COOKIE = 'theme';

/**
 * Light/dark, explicit and opt-in (DEC-023 — the tokens in globals.css are
 * complete, but nothing sets `data-theme` on its own; this is the one thing
 * that does).
 *
 * The preference lives in a plain (non-HttpOnly, JS-writable) cookie rather
 * than localStorage, so the SERVER can read it and render `<html
 * data-theme="dark">` on the first response — no flash of the wrong theme
 * while a client script catches up. `router.refresh()` re-runs the server
 * component tree against the new cookie without a full page reload.
 */
export function ThemeToggle({ theme, label }: { theme: 'light' | 'dark'; label: string }) {
  const router = useRouter();

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.refresh();
  }

  return (
    <button type="button" className="sh__icon-link tgl" aria-label={label} title={label} onClick={toggle}>
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={20} />
      <style>{`
        .tgl { border: 0; background: none; cursor: pointer; font: inherit; }
      `}</style>
    </button>
  );
}
