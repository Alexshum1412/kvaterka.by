/**
 * TELEGRAM, for real.
 *
 * No SDK: the Bot API is one HTTP endpoint per method, and pulling in a
 * client library to POST a JSON body and read a JSON body back would be a
 * dependency for something `fetch` already does. `sendMessage` is the only
 * call this platform ever makes — the product does not read anything back
 * from Telegram except the reply to that one call, and the webhook route
 * (`src/app/api/telegram/webhook/route.ts`) that receives `/start` is a
 * separate, unrelated use of the same API.
 *
 * WHY THE ERROR MAPPING LOOKS LIKE THIS
 *
 * Same shape as `smtpProvider` above, and for the same reason: the shape of
 * the failure is the only signal available for sorting it into TRANSIENT or
 * PERMANENT, and getting that sort wrong is how a queue destroys itself.
 *
 *   A 403 means Telegram itself refuses to deliver to this chat — almost
 *   always because the person blocked the bot. A 400 whose description says
 *   "chat not found" means the chat id on file no longer resolves to anything
 *   — a stale id from a connection that was never actually completed.  Both
 *   are permanent facts about THIS RECIPIENT, not about this attempt: the
 *   next attempt will fail identically, and retrying it forever is the exact
 *   retry storm this module's sibling was built to avoid — worse here,
 *   because it is also a real, ongoing load against someone else's API.
 *
 *   A network failure (the request never reached Telegram at all), a 429
 *   (Telegram's own rate limit) and a 5xx (Telegram's own outage) all say
 *   something about the platform or the network RIGHT NOW and nothing about
 *   whether the next attempt succeeds: TRANSIENT.
 *
 * `describe()` never contains the bot token, the same discipline
 * `smtpProvider` applies to the SMTP password — there is no non-secret
 * fragment of a bot token worth printing (unlike an SMTP host), so it simply
 * never appears anywhere this provider writes a string.
 *
 * CONTENT-FREE, BY LAW NOT BY TASTE (see DECISIONS.md LEGAL-015 and
 * `retention.ts`'s `telegram_connection` entry): sending anything over
 * Telegram is a cross-border transfer whose legality is unresolved, and the
 * product's adopted mitigation is that nothing it sends ever says who, what,
 * or how much. This file does not enforce that — `renderBody` in
 * delivery-service.ts is where the message text is built, and it already
 * only ever produces the spare, content-free line this provider forwards
 * verbatim. This provider's job is only to deliver whatever text it is
 * handed and classify the result; it has no opinion on what the text says.
 */

import { delivered, permanent, transient, type DeliveryProvider } from './provider.ts';

interface TelegramApiResponse {
  readonly ok: boolean;
  readonly error_code?: number;
  readonly description?: string;
  readonly result?: { readonly message_id?: number };
}

export function telegramProvider(botToken: string): DeliveryProvider {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return {
    channel: 'TELEGRAM',
    configured: true,
    describe: () => 'TELEGRAM: бот настроен',
    async send(message) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.address,
            text: `${message.subject}\n\n${message.body}`,
          }),
        });
      } catch (err) {
        // Never reached Telegram at all — DNS, timeout, a dropped connection.
        // Says nothing about the next attempt.
        const reason = err instanceof Error ? err.message : 'сеть недоступна';
        return transient(`Telegram недоступен: ${reason}`);
      }

      let payload: TelegramApiResponse | null = null;
      try {
        payload = (await response.json()) as TelegramApiResponse;
      } catch {
        payload = null;
      }

      if (response.ok && payload?.ok) {
        const messageId = payload.result?.message_id;
        return messageId !== undefined
          ? delivered(String(messageId), String(messageId))
          : delivered();
      }

      const description = payload?.description ?? `HTTP ${response.status}`;

      if (response.status === 403 || (response.status === 400 && /chat not found/i.test(description))) {
        return permanent(`Telegram отклонил чат: ${description}`);
      }

      return transient(`Telegram: ${description}`);
    },
  };
}
