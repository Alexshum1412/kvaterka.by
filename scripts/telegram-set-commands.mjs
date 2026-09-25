#!/usr/bin/env node
/**
 * Registers the bot's command list with Telegram.
 *
 * Telegram's own "/" command menu inside a chat is populated by calling the
 * Bot API's `setMyCommands` method — nothing in this app does that on its
 * own, so a freshly created bot (or one whose commands changed) shows an
 * empty menu to anyone who taps it, even though `src/app/api/telegram/
 * webhook/route.ts` already understands `/start`, `/status`, `/unlink` and
 * `/help`. This is the one-time call that tells Telegram those commands
 * exist, the same shape as docs/OPERATIONS.md §5bis's `setWebhook` step and meant
 * to be run right alongside it — see that section for when.
 *
 *   TELEGRAM_BOT_TOKEN=... node scripts/telegram-set-commands.mjs
 *
 * No dependencies, plain Node and fetch, same posture as scripts/run-jobs.mjs
 * — this is a tiny, rarely-run operator tool, not something worth a build
 * step or a framework for. Re-run it whenever the command list below changes;
 * docs/OPERATIONS.md §5bis carries the same list so the two stay in sync by hand.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'TELEGRAM_BOT_TOKEN is not set; there is no bot to register commands against.',
    }),
  );
  process.exit(2);
}

/* Keep this list identical to the branches `webhook/route.ts` actually
   handles, and to docs/OPERATIONS.md §5bis's copy of it — Telegram will happily
   advertise a command nothing answers, or leave a real one off the menu,
   and neither mistake is visible from inside this script. */
const commands = [
  { command: 'start', description: 'Привязать Telegram или подтвердить номер телефона' },
  { command: 'status', description: 'Статус привязки этого чата' },
  { command: 'unlink', description: 'Отвязать Telegram от аккаунта' },
  { command: 'help', description: 'Что умеет этот бот' },
];

const response = await fetch(`https://api.telegram.org/bot${TOKEN}/setMyCommands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ commands }),
});

let body;
try {
  body = await response.json();
} catch {
  body = { ok: false, description: `HTTP ${response.status}, non-JSON body` };
}

console.log(
  JSON.stringify({
    level: body.ok ? 'info' : 'error',
    status: response.status,
    commands: commands.map((c) => c.command),
    result: body,
  }),
);

// A non-zero exit is the only thing a deploy script or an operator's shell
// reliably checks — see scripts/run-jobs.mjs for the same reasoning.
process.exit(body.ok ? 0 : 1);
