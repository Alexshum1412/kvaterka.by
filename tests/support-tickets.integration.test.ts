/**
 * Support tickets: the staff console over the real dispatcher.
 *
 * Two authorisation properties this file exists to prove:
 *
 *   1. `GET /admin/tickets/:id` returns the ticket author's EMAIL
 *      (`openedBy.email`), gated only by `case.view`. A caller without it —
 *      an ordinary account, or a staff role that holds no case permission at
 *      all (VERIFIER) — must never see that address, in any form.
 *
 *   2. `POST /admin/tickets/:id/actions` is declared with the coarse
 *      `case.handle` permission, but RESOLVE and CLOSE specifically cost
 *      `case.resolve` — a permission SUPPORT and MODERATOR do not hold, only
 *      ADMIN does (rbac.ts). The route's own gate is not fine-grained enough
 *      to catch this; the finer check lives inside `TicketService.act()` and
 *      is what this file actually exercises.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';

let db: TestDb;
let api: ApiTestClient;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

async function staffWith(role: string) {
  const user = await api.signUp();
  await api.grantRole(user.userId, role);
  return user;
}

/** A fresh OPEN ticket, filed by an ordinary tenant. */
async function openTicket(summary = 'Не могу зайти в аккаунт после смены номера телефона.') {
  const tenant = await api.signUp();
  const created = await api.post('/me/tickets', { category: 'ACCOUNT', summary }, { token: tenant.token });
  expect(created.status).toBe(201);
  return { tenant, ticketId: created.body.id as string, reference: created.body.reference as string };
}

/* ==================================================================== *
 * GAP 1 — the ticket file leaks the author's email to anyone who can
 * open it at all; `case.view` must be the real gate.
 * ==================================================================== */

describe('ticket file — case.view gates the author’s email', () => {
  it('refuses a caller without case.view and never includes the email in the response', async () => {
    const { ticketId, tenant } = await openTicket();

    // An ordinary account with no staff role whatsoever.
    const stranger = await api.signUp();
    const strangerRes = await api.get(`/admin/tickets/${ticketId}`, { token: stranger.token });
    expect(strangerRes.status).toBe(403);
    expect(JSON.stringify(strangerRes.body)).not.toContain(tenant.email);

    // A genuine staff role that nonetheless holds no case.* permission at
    // all (rbac.ts: VERIFIER gets verification.*/document.read/user.view,
    // nothing about cases).
    const verifier = await staffWith('VERIFIER');
    const verifierRes = await api.get(`/admin/tickets/${ticketId}`, { token: verifier.token });
    expect(verifierRes.status).toBe(403);
    expect(JSON.stringify(verifierRes.body)).not.toContain(tenant.email);

    // The ticket's own author, asking through the STAFF endpoint rather
    // than their own `/me/tickets/:id` — owning the ticket is not
    // `case.view`, and must not become a backdoor to the staff file.
    const ownerRes = await api.get(`/admin/tickets/${ticketId}`, { token: tenant.token });
    expect(ownerRes.status).toBe(403);
    expect(JSON.stringify(ownerRes.body)).not.toContain(tenant.email);
  });

  it('succeeds for every role holding case.view, and the email is present', async () => {
    const { ticketId, tenant } = await openTicket();

    for (const role of ['SUPPORT', 'MODERATOR', 'ADMIN']) {
      const staff = await staffWith(role);
      const res = await api.get(`/admin/tickets/${ticketId}`, { token: staff.token });
      expect(res.status, role).toBe(200);
      expect(res.body.openedBy.email, role).toBe(tenant.email);
    }
  });

  it('refuses an anonymous caller before it refuses anything else', async () => {
    const { ticketId } = await openTicket();
    expect((await api.get(`/admin/tickets/${ticketId}`)).status).toBe(401);
  });
});

/* ==================================================================== *
 * GAP 2 — the route's coarse `case.handle` gate must not be enough to
 * RESOLVE or CLOSE a ticket; only `case.resolve` may.
 * ==================================================================== */

describe('ticket actions — RESOLVE and CLOSE need case.resolve, not merely case.handle', () => {
  it('refuses SUPPORT and MODERATOR, leaves the ticket unchanged, and lets ADMIN through', async () => {
    const { ticketId } = await openTicket();
    const admin = await staffWith('ADMIN');

    // Move it into IN_PROGRESS first — RESOLVE and CLOSE are both legal
    // moves from there, same as OPEN's own CLOSE would be, so this is
    // purely to exercise both actions against one shared ticket.
    const taken = await api.post(`/admin/tickets/${ticketId}/actions`, { action: 'TAKE' }, { token: admin.token });
    expect(taken.status).toBe(200);
    expect(taken.body.status).toBe('IN_PROGRESS');

    for (const role of ['SUPPORT', 'MODERATOR']) {
      const staff = await staffWith(role);

      const resolved = await api.post(
        `/admin/tickets/${ticketId}/actions`,
        { action: 'RESOLVE', resolution: 'Проблема решена, доступ восстановлен.' },
        { token: staff.token },
      );
      expect(resolved.status, `${role} must not resolve`).toBe(403);

      const closed = await api.post(
        `/admin/tickets/${ticketId}/actions`,
        { action: 'CLOSE', resolution: 'Повторное обращение, дубликат.' },
        { token: staff.token },
      );
      expect(closed.status, `${role} must not close`).toBe(403);
    }

    // Neither refusal moved the ticket at all — a 403 must not have a side
    // effect, and the status is still exactly what TAKE left it at.
    const { rows: afterRefusals } = await db.query<{ status: string }>(
      `SELECT status FROM support_ticket WHERE id=$1`,
      [ticketId],
    );
    expect(afterRefusals[0]!.status).toBe('IN_PROGRESS');

    // ADMIN — the one role rbac.ts actually grants case.resolve to — succeeds.
    const resolvedByAdmin = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'RESOLVE', resolution: 'Проблема решена, доступ восстановлен.' },
      { token: admin.token },
    );
    expect(resolvedByAdmin.status).toBe(200);
    expect(resolvedByAdmin.body.status).toBe('RESOLVED');

    const { rows } = await db.query<Record<string, any>>(
      `SELECT status, resolution, resolved_at, resolved_by FROM support_ticket WHERE id=$1`,
      [ticketId],
    );
    expect(rows[0]!.status).toBe('RESOLVED');
    expect(rows[0]!.resolution).toContain('доступ восстановлен');
    expect(rows[0]!.resolved_at).not.toBeNull();
    expect(rows[0]!.resolved_by).toBe(admin.userId);
  });

  it('still lets SUPPORT and MODERATOR do case.handle-level work on the same ticket', async () => {
    // The refusal above is specific to case.resolve — it must not be a
    // blanket lockout of the whole route for these roles.
    const { ticketId } = await openTicket();
    const support = await staffWith('SUPPORT');

    const taken = await api.post(`/admin/tickets/${ticketId}/actions`, { action: 'TAKE' }, { token: support.token });
    expect(taken.status).toBe(200);
    expect(taken.body.status).toBe('IN_PROGRESS');

    const askedForInfo = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'REQUEST_INFO', note: 'Пришлите, пожалуйста, скриншот ошибки.' },
      { token: support.token },
    );
    expect(askedForInfo.status).toBe(200);
    expect(askedForInfo.body.status).toBe('WAITING_ON_USER');
  });

  it('refuses a caller without even case.handle before any transition logic runs', async () => {
    const { ticketId } = await openTicket();
    const verifier = await staffWith('VERIFIER');
    const res = await api.post(`/admin/tickets/${ticketId}/actions`, { action: 'TAKE' }, { token: verifier.token });
    expect(res.status).toBe(403);

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM support_ticket WHERE id=$1`, [ticketId]);
    expect(rows[0]!.status).toBe('OPEN');
  });

  // problem.ts had a branch mapping IllegalDisputeTransitionError to a clean
  // 409, but no equivalent for IllegalTicketTransitionError - so an illegal
  // ticket move (TAKE only exists from OPEN, not IN_PROGRESS) fell through
  // to a generic, unmapped 500 instead of "this is no longer available".
  it('answers a repeated TAKE with a clean 409, not a 500', async () => {
    const { ticketId } = await openTicket();
    const admin = await staffWith('ADMIN');

    const first = await api.post(`/admin/tickets/${ticketId}/actions`, { action: 'TAKE' }, { token: admin.token });
    expect(first.status).toBe(200);

    const second = await api.post(`/admin/tickets/${ticketId}/actions`, { action: 'TAKE' }, { token: admin.token });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ILLEGAL_TRANSITION');
  });
});
