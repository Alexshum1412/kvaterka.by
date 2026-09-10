'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * Full navigation on success, not client routing: the session cookie was
 * just cleared and every server component — starting with the header
 * itself — needs to re-read that before it renders again.
 */
export function LogoutButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);

  async function logOut() {
    setBusy(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // The session may already be gone (expired, revoked elsewhere) — a
      // failed logout call still means the visitor should land signed out.
    }
    window.location.assign('/');
  }

  return (
    <button
      type="button"
      className="sh__icon-link lgo"
      aria-label={label}
      title={label}
      onClick={logOut}
      disabled={busy}
    >
      <Icon name="logOut" size={20} />
      <style>{`
        .lgo { border: 0; background: none; cursor: pointer; font: inherit; }
        .lgo:disabled { opacity: 0.5; cursor: default; }
      `}</style>
    </button>
  );
}
