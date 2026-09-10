/**
 * Telegram webhook.
 *
 * Telegram calls this URL with an Update object whenever a person messages
 * the bot — there is no other way in, the platform never polls Telegram, it
 * is called. The only Update this route understands is `/start <token>`, the
 * deep link `TelegramLink` (src/ui/telegram-link.tsx) builds around the
 * one-time token `beginTelegramLink` mints; everything else gets a short,
 * fixed reply. This is deliberately not a general chatbot — there is nothing
 * here for a conversation to be about.
 *
 * It sits outside the JSON route table on purpose, the same reasoning as
 * `src/app/api/uploads/route.ts`: that dispatcher expects an authenticated
 * caller and a body this codebase defined, and this endpoint is called by
 * Telegram's servers with a body Telegram defined.
 *
 * NO AUTH HERE, DELIBERATELY. Telegram is the caller and has no credential to
 * present that this route could check — knowing the URL is all a webhook
 * caller ever has. That is fine because the actual security boundary is
 * `completeTelegramLink`'s own token check: a POST claiming an invalid or
 * already-consumed token links nobody, exactly as if a stranger typed a
 * random string at the bot. Nothing sensitive is read or decided in this
 * file; every decision that matters happens inside that one already-tested
 * method.
 *
 * ALWAYS 200. Telegram retries a webhook call that does not answer 200 —
 * repeatedly, and with the same Update — so a bug that would otherwise be one
 * failed request becomes an unbounded retry loop against this endpoint.
 * Every path through this handler, including the catch-all, returns 200.
 *
 * CONTENT-FREE REPLIES (see DECISIONS.md LEGAL-015): the two confirmations
 * this route ever sends back say that a link succeeded or failed and nothing
 * about the account itself — the same rule every other message this platform
 * puts on Telegram already follows (delivery-service.ts's `renderBody`).
 */

import { readyServices } from '@/server/runtime.ts';
import { DomainError } from '@/server/services/errors.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TelegramUpdate {
  readonly message?: {
    readonly text?: string;
    readonly chat?: { readonly id?: number };
    readonly from?: { readonly username?: string };
  };
}

const START_PREFIX = '/start ';

/** Best-effort: by the time this runs, the link itself already succeeded or
 *  failed. A confirmation message that fails to send is not worth retrying —
 *  Telegram would just redeliver the same /start update, not this reply. */
async function reply(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // See above.
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const update = (await request.json()) as TelegramUpdate;
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (typeof chatId === 'number' && typeof text === 'string' && text.startsWith(START_PREFIX)) {
      const token = text.slice(START_PREFIX.length).trim();
      const services = await readyServices();
      try {
        await services.notifications.completeTelegramLink(token, chatId, update.message?.from?.username);
        if (botToken) {
          await reply(botToken, chatId, 'Готово — Telegram привязан к вашему аккаунту Кватэрка.by.');
        }
      } catch (error) {
        // completeTelegramLink already validated the token and threw a
        // DomainError with a message safe to show; anything else is
        // unexpected and gets a generic line rather than an internal string.
        const message =
          error instanceof DomainError ? error.message : 'Не удалось подключить Telegram. Попробуйте снова.';
        if (botToken) await reply(botToken, chatId, message);
      }
    } else if (typeof chatId === 'number' && botToken) {
      // Anything else a person sends the bot: one fixed, unhelpful-on-purpose
      // reply. Building out a real conversation here is explicitly out of
      // scope — the bot exists to deliver one-way pings, not to talk back.
      await reply(botToken, chatId, 'Эта команда не распознана.');
    }
  } catch {
    // Malformed body, an unexpected throw — still 200, or Telegram redelivers
    // the same update forever.
  }

  return new Response(null, { status: 200 });
}
