/**
 * Registers this deployment's webhook with Telegram — with the secret.
 *
 *   TELEGRAM_BOT_TOKEN=... PUBLIC_BASE_URL=https://kvaterka.by npm run telegram:webhook
 *
 * `src/app/api/telegram/webhook/route.ts` answers 401 to any delivery that
 * does not carry `X-Telegram-Bot-Api-Secret-Token`, because before it did,
 * anyone could POST a forged update and verify a phone number they do not own.
 * Telegram only sends that header if the webhook was registered with
 * `secret_token`, so the plain `setWebhook?url=...` link docs/OPERATIONS.md used to
 * give is no longer enough: run this once per bot token, and again whenever
 * PUBLIC_BASE_URL or the token changes. The secret is derived from the token
 * by the same function the route checks against, so there is nothing new to
 * configure and nothing to keep in sync by hand.
 *
 * Never prints the token or the secret.
 */

import { telegramWebhookSecret } from '../src/server/delivery/telegram.ts';

const token = process.env['TELEGRAM_BOT_TOKEN'];
const base = process.env['PUBLIC_BASE_URL']?.replace(/\/$/, '');

if (!token || !base) {
  console.error('Set TELEGRAM_BOT_TOKEN and PUBLIC_BASE_URL (https://...) first.');
  process.exit(2);
}
if (!base.startsWith('https://')) {
  console.error('Telegram delivers webhooks over HTTPS only; PUBLIC_BASE_URL must start with https://.');
  process.exit(2);
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${base}/api/telegram/webhook`,
    secret_token: telegramWebhookSecret(token),
    // The route only ever reads `message`; nothing else needs to reach it.
    allowed_updates: ['message'],
  }),
});
const body = (await response.json()) as { ok?: boolean; description?: string };
console.log(JSON.stringify({ ok: body.ok === true, description: body.description ?? null, url: `${base}/api/telegram/webhook` }));
process.exit(body.ok === true ? 0 : 1);
