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
    const taken = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'TAKE' },
      { token: admin.token },
    );
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

    const taken = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'TAKE' },
      { token: support.token },
    );
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
    const res = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'TAKE' },
      { token: verifier.token },
    );
    expect(res.status).toBe(403);

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM support_ticket WHERE id=$1`, [
      ticketId,
    ]);
    expect(rows[0]!.status).toBe('OPEN');
  });

  // problem.ts had a branch mapping IllegalDisputeTransitionError to a clean
  // 409, but no equivalent for IllegalTicketTransitionError - so an illegal
  // ticket move (TAKE only exists from OPEN, not IN_PROGRESS) fell through
  // to a generic, unmapped 500 instead of "this is no longer available".
  it('answers a repeated TAKE with a clean 409, not a 500', async () => {
    const { ticketId } = await openTicket();
    const admin = await staffWith('ADMIN');

    const first = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'TAKE' },
      { token: admin.token },
    );
    expect(first.status).toBe(200);

    const second = await api.post(
      `/admin/tickets/${ticketId}/actions`,
      { action: 'TAKE' },
      { token: admin.token },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

/* ==================================================================== *
 * GAP 3 — the OWNER's own endpoints (`/me/tickets*`). These carry no
 * `permission` at all: ownership is the entire gate, enforced by the
 * `WHERE ... AND opened_by = $2` inside `TicketService`. Nothing exercised
 * that a wrong id and somebody else's ticket answer identically, that a
 * non-owner cannot write into another person's thread, or that either
 * `/me/tickets` route works at all.
 * ==================================================================== */

describe('GET /me/tickets/:id — ownership decides access, not a permission', () => {
  it('answers a nonexistent id and somebody else’s real ticket identically: 404, nothing leaked', async () => {
    const { ticketId, tenant } = await openTicket('У меня не открывается страница объявления, помогите разобраться.');
    const stranger = await api.signUp();

    const notMine = await api.get(`/me/tickets/${ticketId}`, { token: stranger.token });
    expect(notMine.status).toBe(404);
    expect(notMine.errorCode).toBe('NOT_FOUND');
    expect(JSON.stringify(notMine.body)).not.toContain(tenant.email);

    const noSuchId = await api.get(`/me/tickets/${crypto.randomUUID()}`, { token: tenant.token });
    expect(noSuchId.status).toBe(404);
    expect(noSuchId.errorCode).toBe('NOT_FOUND');
  });

  it('refuses an anonymous caller before it refuses anything else', async () => {
    const { ticketId } = await openTicket();
    expect((await api.get(`/me/tickets/${ticketId}`)).status).toBe(401);
  });

  it('returns the caller’s own ticket, its thread, and never an internal staff note', async () => {
    const summary = 'После смены номера телефона не приходит код подтверждения входа.';
    const { ticketId, tenant } = await openTicket(summary);
    const support = await staffWith('SUPPORT');
    const note = await api.post(
      `/admin/tickets/${ticketId}/notes`,
      { note: 'Секретная внутренняя заметка для коллег, не для автора.' },
      { token: support.token },
    );
    expect(note.status).toBe(201);

    const res = await api.get(`/me/tickets/${ticketId}`, { token: tenant.token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ticketId);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.category).toBe('ACCOUNT');
    expect(res.body.summary).toBe(summary);
    expect(res.body.canReply).toBe(true);
    expect(res.body.resolution).toBeNull();

    // The author's own account of the problem is there ...
    expect(res.body.messages.some((m: any) => m.note === summary && m.fromAuthor === true)).toBe(true);
    // ... the staff-only note is not, in any form.
    expect(JSON.stringify(res.body)).not.toContain('Секретная внутренняя заметка');
  });
});

describe('POST /me/tickets/:id/reply — the same ownership guard, on a write', () => {
  it('refuses a non-owner and leaves no trace of the attempted reply', async () => {
    const { ticketId } = await openTicket();
    const stranger = await api.signUp();

    const { rows: before } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ticket_event WHERE ticket_id=$1`,
      [ticketId],
    );

    const res = await api.post(
      `/me/tickets/${ticketId}/reply`,
      { message: 'Это не моё обращение, но давайте попробуем.' },
      { token: stranger.token },
    );
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('NOT_FOUND');

    const { rows: after } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ticket_event WHERE ticket_id=$1`,
      [ticketId],
    );
    expect(after[0]!.c).toBe(before[0]!.c);
  });

  it('refuses a reply against an id that names no ticket at all', async () => {
    const { tenant } = await openTicket();
    const res = await api.post(
      `/me/tickets/${crypto.randomUUID()}/reply`,
      { message: 'Сообщение в никуда.' },
      { token: tenant.token },
    );
    expect(res.status).toBe(404);
  });

  it('lets the owner reply, and the reply lands in their own thread', async () => {
    const { ticketId, tenant } = await openTicket();
    const message = 'Уточняю: проблема появилась после обновления приложения.';

    const res = await api.post(`/me/tickets/${ticketId}/reply`, { message }, { token: tenant.token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ticketId);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.eventId).toBeTruthy();

    const { rows } = await db.query<{ note: string; actor_user_id: string; visibility: string }>(
      `SELECT note, actor_user_id, visibility FROM ticket_event WHERE ticket_id=$1 AND event_type='USER_REPLY'`,
      [ticketId],
    );
    expect(rows[0]!.note).toBe(message);
    expect(rows[0]!.actor_user_id).toBe(tenant.userId);
    expect(rows[0]!.visibility).toBe('PARTIES');
  });
});

describe('POST /me/tickets — always opens under the caller’s own id', () => {
  it('creates a fresh OPEN ticket owned by whoever is signed in, and refuses signed-out callers', async () => {
    const tenant = await api.signUp();
    const summary = 'Объявление не сохраняется на последнем шаге формы, выдаёт пустую ошибку.';

    const res = await api.post(
      '/me/tickets',
      { category: 'LISTING', summary },
      { token: tenant.token },
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.reference).toBeTruthy();

    const { rows } = await db.query<{ opened_by: string; status: string; category: string; summary: string }>(
      `SELECT opened_by, status, category, summary FROM support_ticket WHERE id=$1`,
      [res.body.id],
    );
    expect(rows[0]!.opened_by).toBe(tenant.userId);
    expect(rows[0]!.status).toBe('OPEN');
    expect(rows[0]!.category).toBe('LISTING');
    expect(rows[0]!.summary).toBe(summary);

    const anon = await api.post('/me/tickets', { category: 'OTHER', summary });
    expect(anon.status).toBe(401);
  });
});

describe('GET /me/tickets — scoped to the caller, never to anybody else’s', () => {
  it('lists only the tickets this caller themselves opened', async () => {
    const { tenant: alice, ticketId: aliceTicket1 } = await openTicket('У Алисы не проходит оплата аренды картой.');
    const alice2 = await api.post(
      '/me/tickets',
      { category: 'SAFETY', summary: 'Ещё одно обращение от Алисы, другого рода.' },
      { token: alice.token },
    );
    expect(alice2.status).toBe(201);

    const { tenant: bob, ticketId: bobTicket } = await openTicket('У Боба не приходит письмо для верификации.');

    const aliceRes = await api.get('/me/tickets', { token: alice.token });
    expect(aliceRes.status).toBe(200);
    const aliceIds = aliceRes.body.map((t: any) => t.id).sort();
    expect(aliceIds).toEqual([aliceTicket1, alice2.body.id].sort());
    expect(aliceIds).not.toContain(bobTicket);

    const bobRes = await api.get('/me/tickets', { token: bob.token });
    expect(bobRes.status).toBe(200);
    expect(bobRes.body.map((t: any) => t.id)).toEqual([bobTicket]);
  });
});

/* ==================================================================== *
 * GAP 4 — the rest of the staff console. `/admin/tickets` (the queue) and
 * `/admin/tickets/:id/notes` and `/admin/tickets/:id/assign` each declare
 * their own `permission`, but none of them had a test proving that gate is
 * real on THIS route — `staff-operations.integration.test.ts` only ever
 * drove `/admin/tickets/:id` and `/admin/tickets/:id/actions`.
 * ==================================================================== */

describe('GET /admin/tickets — the queue needs case.view', () => {
  it('refuses an anonymous caller, a caller with no staff role, and one with a staff role that lacks case.view', async () => {
    const { ticketId } = await openTicket();

    expect((await api.get('/admin/tickets')).status).toBe(401);

    const stranger = await api.signUp();
    expect((await api.get('/admin/tickets', { token: stranger.token })).status).toBe(403);

    const verifier = await staffWith('VERIFIER');
    const verifierRes = await api.get('/admin/tickets', { token: verifier.token });
    expect(verifierRes.status).toBe(403);
    expect(JSON.stringify(verifierRes.body)).not.toContain(ticketId);
  });

  it('succeeds for every role holding case.view and lists the ticket', async () => {
    const { ticketId } = await openTicket();

    for (const role of ['SUPPORT', 'MODERATOR', 'ADMIN']) {
      const staff = await staffWith(role);
      const res = await api.get('/admin/tickets', { token: staff.token });
      expect(res.status, role).toBe(200);
      expect(res.body.items.map((t: any) => t.id), role).toContain(ticketId);
    }
  });
});

describe('POST /admin/tickets/:id/notes — case.handle, and never reaches the author', () => {
  it('refuses a staff role that holds no case.handle, and writes nothing', async () => {
    const { ticketId } = await openTicket();
    const verifier = await staffWith('VERIFIER');

    const res = await api.post(
      `/admin/tickets/${ticketId}/notes`,
      { note: 'Заметка от того, у кого нет прав её оставлять.' },
      { token: verifier.token },
    );
    expect(res.status).toBe(403);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ticket_event WHERE ticket_id=$1 AND event_type='INTERNAL_NOTE'`,
      [ticketId],
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('lets a case.handle holder add an internal note, recorded INTERNAL and attributed to them', async () => {
    const { ticketId } = await openTicket();
    const support = await staffWith('SUPPORT');
    const text = 'Проверил логи, похоже на известный баг с кириллицей в форме.';

    const res = await api.post(`/admin/tickets/${ticketId}/notes`, { note: text }, { token: support.token });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(ticketId);

    const { rows } = await db.query<{ note: string; visibility: string; actor_user_id: string }>(
      `SELECT note, visibility, actor_user_id FROM ticket_event WHERE ticket_id=$1 AND event_type='INTERNAL_NOTE'`,
      [ticketId],
    );
    expect(rows[0]!.note).toBe(text);
    expect(rows[0]!.visibility).toBe('INTERNAL');
    expect(rows[0]!.actor_user_id).toBe(support.userId);
  });
});

describe('POST /admin/tickets/:id/assign — case.handle', () => {
  it('refuses a staff role that holds no case.handle, and leaves the ticket unassigned', async () => {
    const { ticketId } = await openTicket();
    const verifier = await staffWith('VERIFIER');
    const target = await staffWith('SUPPORT');

    const res = await api.post(
      `/admin/tickets/${ticketId}/assign`,
      { assigneeId: target.userId },
      { token: verifier.token },
    );
    expect(res.status).toBe(403);

    const { rows } = await db.query<{ assigned_to: string | null }>(
      `SELECT assigned_to FROM support_ticket WHERE id=$1`,
      [ticketId],
    );
    expect(rows[0]!.assigned_to).toBeNull();
  });

  it('lets a case.handle holder assign the ticket to valid staff, then unassign it', async () => {
    const { ticketId } = await openTicket();
    const moderator = await staffWith('MODERATOR');
    const target = await staffWith('SUPPORT');

    const assigned = await api.post(
      `/admin/tickets/${ticketId}/assign`,
      { assigneeId: target.userId },
      { token: moderator.token },
    );
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignedTo).toBe(target.userId);

    const { rows: afterAssign } = await db.query<{ assigned_to: string }>(
      `SELECT assigned_to FROM support_ticket WHERE id=$1`,
      [ticketId],
    );
    expect(afterAssign[0]!.assigned_to).toBe(target.userId);

    const unassigned = await api.post(
      `/admin/tickets/${ticketId}/assign`,
      { assigneeId: null },
      { token: moderator.token },
    );
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.assignedTo).toBeNull();

    const { rows: afterUnassign } = await db.query<{ assigned_to: string | null }>(
      `SELECT assigned_to FROM support_ticket WHERE id=$1`,
      [ticketId],
    );
    expect(afterUnassign[0]!.assigned_to).toBeNull();
  });
});

describe('GET /admin/tickets/staff — case.handle, staff directory only', () => {
  it('refuses a staff role that holds no case.handle', async () => {
    await staffWith('VERIFIER');
    const verifier2 = await staffWith('VERIFIER');
    const res = await api.get('/admin/tickets/staff', { token: verifier2.token });
    expect(res.status).toBe(403);
  });

  it('lists only staff who actually work cases — never a VERIFIER-only account or an ordinary user', async () => {
    const support = await staffWith('SUPPORT');
    const moderator = await staffWith('MODERATOR');
    const verifier = await staffWith('VERIFIER');
    const nobody = await api.signUp();

    const res = await api.get('/admin/tickets/staff', { token: support.token });
    expect(res.status).toBe(200);

    const ids = res.body.map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining([support.userId, moderator.userId]));
    expect(ids).not.toContain(verifier.userId);
    expect(ids).not.toContain(nobody.userId);

    const entry = res.body.find((s: any) => s.id === support.userId);
    expect(entry.roles).toContain('SUPPORT');
    expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'roles'].sort());
  });
});
