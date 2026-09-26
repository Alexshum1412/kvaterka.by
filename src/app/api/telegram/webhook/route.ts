/**
 * Telegram webhook.
 *
 * Telegram calls this URL with an Update object whenever a person messages
 * the bot — there is no other way in, the platform never polls Telegram, it
 * is called. This route understands:
 *
 *   - `/start <token>` for NOTIFICATION linking — the deep link
 *     `TelegramLink` (src/ui/telegram-link.tsx) builds around the one-time
 *     token `beginTelegramLink` mints.
 *   - `/start <token>` for PHONE VERIFICATION (0018) — the same shape, a
 *     DIFFERENT token (`beginPhoneVerification`'s, purpose `PHONE_OTP`), from
 *     `/verify-phone`. Tried first since it is the security-relevant flow;
 *     falls through to notification-linking so one `/start` handler serves
 *     both without the two token spaces ever needing to know about each
 *     other.
 *   - A `contact` message — step two of phone verification, arriving after
 *     the bot's own `request_contact` button prompt. Matched by chat id
 *     against whichever user that chat already linked in step one, so no
 *     token travels a second time.
 *   - `/status`, `/unlink`, `/help` — the three commands DECISIONS.md
 *     DEC-078 added so the bot is a real menu (registered with Telegram via
 *     `scripts/telegram-set-commands.mjs`, see docs/OPERATIONS.md §5bis) rather
 *     than a bare linking mechanism a person can only use once. All three
 *     are answered from the chat id alone via `telegramLinkState`, the same
 *     way the `contact` handler already resolves "whose chat is this".
 *
 * Everything else gets a short, fixed reply. This is deliberately not a
 * general chatbot — there is nothing here for a free-form conversation to be
 * about; the fixed command set above is the whole surface.
 *
 * It sits outside the JSON route table on purpose, the same reasoning as
 * `src/app/api/uploads/route.ts`: that dispatcher expects an authenticated
 * caller and a body this codebase defined, and this endpoint is called by
 * Telegram's servers with a body Telegram defined.
 *
 * NO AUTH HERE, DELIBERATELY. Telegram is the caller and has no credential to
 * present that this route could check — knowing the URL is all a webhook
 * caller ever has. That is fine because the actual security boundary is
 * `completeTelegramLink`'s/`unlinkTelegram`'s own checks: a POST claiming an
 * invalid or already-consumed token links nobody, and `/status`/`/unlink`
 * only ever act on the account THIS chat is already linked to — a chat can
 * never ask about, or disconnect, anyone else's account. Nothing sensitive is
 * read or decided in this file; every decision that matters happens inside
 * an already-tested service method.
 *
 * ALWAYS 200. Telegram retries a webhook call that does not answer 200 —
 * repeatedly, and with the same Update — so a bug that would otherwise be one
 * failed request becomes an unbounded retry loop against this endpoint.
 * Every path through this handler, including the catch-all, returns 200.
 *
 * CONTENT-FREE REPLIES (see DECISIONS.md LEGAL-015): every reply this route
 * ever sends says that a link/unlink/status check succeeded, failed, or what
 * its own state is — never anything about a booking, a message, or any other
 * account content. `/status`'s reply is about the CHAT'S OWN linkage state,
 * which is squarely inside that boundary, not an exception to it. The inline
 * "Открыть кабинет"/"Открыть сайт" buttons this route now attaches are plain
 * navigation, not content, for the same reason a link in an email's template
 * is not content — they carry no booking id, amount or message text, only a
 * fixed URL. This is deliberately NOT extended to the notification queue's
 * own messages (delivery-service.ts's `renderBody`/`telegramProvider`): that
 * channel sends unattended, automated pings at a much higher volume and for
 * many more categories, and LEGAL-015's mitigation was written and reviewed
 * against ITS payload shape specifically — widening what that channel sends
 * is a legal-register change, not a bot-visuals one. This route's own direct
 * replies are a narrower, human-triggered channel (one reply per command a
 * person just typed) and were already content-free before this change.
 */

import { env, readyServices } from '@/server/runtime.ts';
import { DomainError } from '@/server/services/errors.ts';
import type { Services } from '@/server/services/container.ts';
import { isAuthenticTelegramWebhook } from '@/server/delivery/telegram.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TelegramUpdate {
  readonly message?: {
    readonly text?: string;
    readonly chat?: { readonly id?: number };
    readonly from?: { readonly id?: number; readonly username?: string };
    readonly contact?: { readonly phone_number?: string; readonly user_id?: number };
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

/**
 * Same as `reply()`, plus one inline URL button under the message — Telegram's
 * `reply_markup.inline_keyboard`, attached to this one message rather than to
 * the chat's persistent keyboard (unlike `requestContact`'s reply keyboard
 * below, which has to stay live across whatever the person does next). Used
 * for the handful of replies that are otherwise a dead end — `/status` and
 * `/help` told a person a fact and then left them nowhere to go, when the
 * actual next step, every time, is "go look at the site".
 */
async function replyWithLink(
  botToken: string,
  chatId: number,
  text: string,
  buttonText: string,
  url: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: [[{ text: buttonText, url }]] },
      }),
    });
  } catch {
    // See reply() above.
  }
}

/** Step one of phone verification ends here: a button that hands the bot the
 *  account's OWN phone number, already verified by Telegram itself — no
 *  typing, no code to transcribe. `one_time_keyboard` removes it after use. */
async function requestContact(botToken: string, chatId: number): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Осталось подтвердить номер телефона — нажмите кнопку ниже, чтобы поделиться контактом.',
        reply_markup: {
          keyboard: [[{ text: 'Поделиться номером телефона', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }),
    });
  } catch {
    // See reply() above.
  }
}

/**
 * `/status` — whether this chat is linked, and whether the phone behind it is
 * verified. Answered purely from `telegramLinkState`, which is why this is
 * safe within LEGAL-015: it is a fact about the chat's own linkage, nothing
 * about any booking or message that account has.
 */
async function replyStatus(
  botToken: string,
  chatId: number,
  services: Services,
  publicBaseUrl: string,
): Promise<void> {
  const state = await services.notifications.telegramLinkState(chatId);
  const text = !state
    ? 'Этот чат ни к какому аккаунту Кватэрка.by не привязан. Привязать Telegram можно в личном кабинете на сайте, в разделе уведомлений.'
    : state.phoneVerified
      ? 'Telegram привязан к вашему аккаунту, номер телефона подтверждён. Уведомления о бронированиях и сообщениях приходят в этот чат.'
      : 'Telegram привязан к вашему аккаунту, уведомления приходят в этот чат — но номер телефона ещё не подтверждён. Начните подтверждение заново на странице /verify-phone на сайте.';
  await replyWithLink(botToken, chatId, text, 'Открыть кабинет', `${publicBaseUrl}/dashboard`);
}

/**
 * `/unlink` — disconnects this chat from whatever account it is linked to.
 * Resolves the account from the chat id the same way `/status` and the
 * `contact` handler already do, so a chat can only ever unlink ITSELF, never
 * an account named some other way.
 */
async function replyUnlink(botToken: string, chatId: number, services: Services): Promise<void> {
  const state = await services.notifications.telegramLinkState(chatId);
  if (!state) {
    await reply(botToken, chatId, 'Этот чат и так не привязан ни к одному аккаунту — отвязывать нечего.');
    return;
  }
  try {
    await services.notifications.unlinkTelegram(state.userId);
    await reply(
      botToken,
      chatId,
      'Готово — Telegram отвязан от аккаунта. Уведомления в этот чат больше приходить не будут. Привязать заново можно в личном кабинете на сайте.',
    );
  } catch (error) {
    // unlinkTelegram throws notFound() only if the link vanished between the
    // read above and this call (another /unlink, or the website's own unlink
    // button, racing this one) — a real but narrow race, not worth a retry.
    const message =
      error instanceof DomainError ? error.message : 'Не удалось отвязать Telegram. Попробуйте ещё раз.';
    await reply(botToken, chatId, message);
  }
}

/** `/help` — what the bot is for, and where the rest of the product lives.
 *  Fixed, closed vocabulary, same as everything else this route says: there
 *  is nothing here for a free-form conversation to be about. */
async function replyHelp(botToken: string, chatId: number, publicBaseUrl: string): Promise<void> {
  const text = [
    'Кватэрка.by — бот для уведомлений о бронированиях и сообщениях, и для подтверждения номера телефона.',
    '',
    '/status — привязан ли этот чат, и подтверждён ли телефон',
    '/unlink — отвязать Telegram от аккаунта',
    '/help — эта подсказка',
    '',
    'Само бронирование, переписка и профиль — на сайте.',
  ].join('\n');
  await replyWithLink(botToken, chatId, text, 'Открыть сайт', publicBaseUrl);
}

export async function POST(request: Request): Promise<Response> {
  /* Only Telegram may speak here. This endpoint used to accept any POST from
   * anyone, and it is where a phone number becomes "verified": two forged
   * requests — a /start carrying the caller's own verification token, then a
   * "contact" with any +375 number — marked that number verified on the
   * caller's account without Telegram ever being involved, which is the gate
   * listing publication stands on (DEC-076). The same hole let anyone unlink
   * another user's chat, or point their own notifications at a stranger's.
   * Telegram sends the secret registered with setWebhook in this header;
   * without a bot token there is no bot, and nothing to accept. */
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (
    !botToken ||
    !isAuthenticTelegramWebhook(botToken, request.headers.get('x-telegram-bot-api-secret-token'))
  ) {
    return new Response(null, { status: 401 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;
    const contact = update.message?.contact;

    if (typeof chatId === 'number' && typeof text === 'string' && text.startsWith(START_PREFIX)) {
      const token = text.slice(START_PREFIX.length).trim();
      const services = await readyServices();
      const publicBaseUrl = env().PUBLIC_BASE_URL.replace(/\/$/, '');

      // Phone verification first: it is the security-relevant flow, and its
      // token space (PHONE_OTP) is disjoint from notification-linking's
      // (TELEGRAM_LINK), so a token belongs to exactly one of these two calls
      // and the other always throws UNAUTHENTICATED for it.
      try {
        await services.notifications.beginTelegramPhoneLink(token, chatId, update.message?.from?.username);
        await requestContact(botToken, chatId);
      } catch (first) {
        // The token is fine but the chat is already linked to another account. Say
        // that: falling through to the notification-link attempt below would fail on
        // the same token (it is a PHONE_OTP one) and report it as "invalid or expired".
        if (first instanceof DomainError && first.code === 'CONFLICT') {
          await reply(botToken, chatId, first.message);
          return new Response(null, { status: 200 });
        }
        try {
          await services.notifications.completeTelegramLink(token, chatId, update.message?.from?.username);
          // Telegram defaults ON the moment this link exists (DEC-070) —
          // there is no separate opt-in step left to explain, so this reply
          // says what actually happens next instead, and points at /help
          // now that there is more than one command worth knowing about.
          await replyWithLink(
            botToken,
            chatId,
            'Готово — Telegram привязан к вашему аккаунту Кватэрка.by. Уведомления о бронированиях и сообщениях теперь будут приходить в этот чат. Список команд — /help.',
            'Открыть кабинет',
            `${publicBaseUrl}/dashboard`,
          );
        } catch (error) {
          // Both calls already validate their own token and throw a
          // DomainError with a message safe to show; anything else is
          // unexpected and gets a generic line rather than an internal string.
          const message =
            error instanceof DomainError
              ? error.message
              : 'Ссылка недействительна или устарела. Попробуйте снова.';
          await reply(botToken, chatId, message);
        }
      }
    } else if (typeof chatId === 'number' && contact?.phone_number) {
      /* A contact card is not proof of a number unless it is the sender's own.
         Telegram lets anyone forward any contact from their address book; only
         the request_contact button shares the sender's, and Telegram marks that
         by setting contact.user_id to the sender's id. Anything else would let
         a person verify a number that belongs to somebody else. */
      if (!contact.user_id || contact.user_id !== update.message?.from?.id) {
        await reply(
          botToken,
          chatId,
          'Нужен ваш собственный номер — нажмите кнопку «Поделиться номером телефона» под сообщением бота.',
        );
        return new Response(null, { status: 200 });
      }
      const services = await readyServices();
      let linked: string | null;
      try {
        linked = await services.notifications.completePhoneVerificationTelegramContact(
          chatId,
          contact.phone_number,
        );
      } catch (error) {
        // The number is already verified on another account: the one refusal with a
        // message worth showing (it is about this person's own number, shared by them).
        // Anything else stays the silent 200 below, or Telegram redelivers it for ever.
        if (error instanceof DomainError && error.code === 'CONFLICT') {
          await reply(botToken, chatId, error.message);
          return new Response(null, { status: 200 });
        }
        throw error;
      }
      await reply(
        botToken,
        chatId,
        linked
          ? 'Готово — номер телефона подтверждён.'
          : 'Не нашли ожидающую привязку для этого чата. Начните подтверждение заново на сайте.',
      );
    } else if (typeof chatId === 'number' && text === '/status') {
      const services = await readyServices();
      await replyStatus(botToken, chatId, services, env().PUBLIC_BASE_URL.replace(/\/$/, ''));
    } else if (typeof chatId === 'number' && text === '/unlink') {
      const services = await readyServices();
      await replyUnlink(botToken, chatId, services);
    } else if (typeof chatId === 'number' && text === '/help') {
      await replyHelp(botToken, chatId, env().PUBLIC_BASE_URL.replace(/\/$/, ''));
    } else if (typeof chatId === 'number') {
      // Anything else a person sends the bot: one fixed, unhelpful-on-purpose
      // reply. Building out a real conversation here is explicitly out of
      // scope — the bot exists to deliver one-way pings and answer its own
      // fixed command set (/status, /unlink, /help), not to talk back.
      await reply(botToken, chatId, 'Эта команда не распознана. Список команд — /help.');
    }
  } catch {
    // Malformed body, an unexpected throw — still 200, or Telegram redelivers
    // the same update forever.
  }

  return new Response(null, { status: 200 });
}
