/**
 * Notification delivery — the half that needs no database.
 *
 * `smtpProvider` and `renderBody` are pure logic wrapped around one external
 * client: given a transport and an error, what status comes out; given a
 * category and a payload, what string comes out. Neither question needs a
 * user row, a queue, or a job run, so — same reasoning as
 * `pg10-migrations.static.test.ts` — this is its own file rather than a
 * corner of `notification-delivery.integration.test.ts`: it runs in
 * milliseconds, on every machine, with no PGlite instance to spin up.
 *
 * `smtpProvider(smtpUrl, mailFrom)` builds its own transporter from `smtpUrl`
 * with no way to intercept it, so every test here uses the optional third
 * parameter added for exactly this: a transporter to inject. Production never
 * passes one and keeps building the real thing from `smtpUrl`; these tests
 * pass nodemailer's own `jsonTransport: true` (delivered) or a stub whose
 * `sendMail` rejects with a shaped error (failed), so the assertions below
 * exercise `smtpProvider`'s actual send()/error-mapping code, not a
 * reimplementation of it.
 */

import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { smtpProvider } from '@/server/delivery/provider.ts';
import { renderBody } from '@/server/services/delivery-service.ts';

/* ================================================================== *
 * smtpProvider
 * ================================================================== */

const SMTP_URL = 'smtp://someone:hunter2-the-secret-password@mail.example.com:587';
const FROM = 'Кватэрка.by <noreply@kvaterka.by>';

const message = {
  notificationId: 'notif-1',
  userId: 'user-1',
  channel: 'EMAIL' as const,
  address: 'tenant@example.com',
  category: 'SECURITY',
  subject: 'Кватэрка.by',
  body: 'Подтвердите почту, перейдя по ссылке: http://localhost:3000/verify-email?token=abc',
};

describe('smtpProvider', () => {
  it('a successful send maps to DELIVERED', async () => {
    // jsonTransport never opens a socket: it "delivers" by serializing the
    // envelope to JSON and returning success, deterministically.
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const provider = smtpProvider(SMTP_URL, FROM, transporter);

    const result = await provider.send(message);

    expect(result.status).toBe('DELIVERED');
    expect(result.reference).toBeTruthy();
  });

  it('an auth-style rejection maps to PERMANENT', async () => {
    const authError = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    const transporter = { sendMail: async () => Promise.reject(authError) } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >;
    const provider = smtpProvider(SMTP_URL, FROM, transporter);

    const result = await provider.send(message);

    expect(result.status).toBe('PERMANENT');
    expect(result.detail).toContain('учётные данные');
  });

  it('a connection-style failure maps to TRANSIENT', async () => {
    const connError = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
    const transporter = { sendMail: async () => Promise.reject(connError) } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >;
    const provider = smtpProvider(SMTP_URL, FROM, transporter);

    const result = await provider.send(message);

    expect(result.status).toBe('TRANSIENT');
    expect(result.detail).toContain('недоступен');
  });

  it('a 5xx SMTP response maps to PERMANENT and a 4xx maps to TRANSIENT', async () => {
    const refused = Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 });
    const greylisted = Object.assign(new Error('Try again later'), { responseCode: 450 });

    const refusing = { sendMail: async () => Promise.reject(refused) } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >;
    const stalling = { sendMail: async () => Promise.reject(greylisted) } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >;

    expect((await smtpProvider(SMTP_URL, FROM, refusing).send(message)).status).toBe('PERMANENT');
    expect((await smtpProvider(SMTP_URL, FROM, stalling).send(message)).status).toBe('TRANSIENT');
  });

  it('describe() never contains the SMTP password', () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const provider = smtpProvider(SMTP_URL, FROM, transporter);

    expect(provider.describe()).not.toContain('hunter2-the-secret-password');
    // The host is expected to be there — only the credential is the secret.
    expect(provider.describe()).toContain('mail.example.com');
  });

  it('a thrown failure detail never contains the SMTP password either', async () => {
    const authError = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    const transporter = { sendMail: async () => Promise.reject(authError) } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >;
    const result = await smtpProvider(SMTP_URL, FROM, transporter).send(message);

    expect(result.detail).not.toContain('hunter2-the-secret-password');
  });
});

/* ================================================================== *
 * renderBody
 * ================================================================== */

const BASE_URL = 'http://localhost:3000';

describe('renderBody', () => {
  it('a REGISTRATION_CODE payload renders the code and the /verify-email link', () => {
    const body = renderBody(
      'SECURITY',
      { kind: 'REGISTRATION_CODE', code: '123456', identifier: 'user@example.by' },
      BASE_URL,
    );

    expect(body).toContain('123456');
    expect(body).toContain(`${BASE_URL}/verify-email?identifier=user%40example.by&code=123456`);
  });

  it('a PASSWORD_RESET payload renders the /password-reset link with the token', () => {
    const body = renderBody('SECURITY', { kind: 'PASSWORD_RESET', token: 'tok-456' }, BASE_URL);

    expect(body).toContain(`${BASE_URL}/password-reset?token=tok-456`);
  });

  it('respects a publicBaseUrl with a trailing slash already stripped by the caller', () => {
    // DeliveryService strips the trailing slash before ever calling renderBody
    // (see its constructor) — renderBody itself does no normalizing, so a
    // caller that skipped that step would get a doubled slash. Documented here
    // rather than re-tested, since that stripping lives in DeliveryService.
    const body = renderBody(
      'SECURITY',
      { kind: 'REGISTRATION_CODE', code: '654321', identifier: 'u@example.by' },
      'https://kvaterka.by',
    );
    expect(body).toContain('https://kvaterka.by/verify-email?identifier=u%40example.by&code=654321');
  });

  it('an unrelated category (BOOKING_REQUEST) is unchanged: title plus /trips or /dashboard, no token logic', () => {
    const withBooking = renderBody('BOOKING_REQUEST', { bookingId: 'b-1' }, BASE_URL);
    const withoutBooking = renderBody('BOOKING_REQUEST', {}, BASE_URL);

    expect(withBooking).toBe('Новый запрос на бронирование. Откройте Кватэрка.by, чтобы посмотреть: /trips');
    expect(withoutBooking).toBe('Новый запрос на бронирование. Откройте Кватэрка.by, чтобы посмотреть: /dashboard');
    // publicBaseUrl is a parameter the pre-feature signature did not have, but
    // it must not leak into a body that was never a link before this feature.
    expect(withBooking).not.toContain(BASE_URL);
  });

  it('a SECURITY payload with a token but no recognised kind falls through to the generic body', () => {
    // The branch keys on payload.kind, not on category — a token alone, or a
    // kind this file does not recognise, must not accidentally produce a link.
    const body = renderBody('SECURITY', { token: 'tok-789', kind: 'SOMETHING_ELSE' }, BASE_URL);

    expect(body).not.toContain('tok-789');
    expect(body).toBe('Безопасность аккаунта. Откройте Кватэрка.by, чтобы посмотреть: /dashboard');
  });

  it('an unmapped category falls back to the generic title', () => {
    const body = renderBody('SOME_FUTURE_CATEGORY', {}, BASE_URL);
    expect(body).toBe('Обновление. Откройте Кватэрка.by, чтобы посмотреть: /dashboard');
  });
});
