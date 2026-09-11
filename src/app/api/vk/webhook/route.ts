/**
 * VK Callback API webhook.
 *
 * VK's own onboarding for a community's Callback API has a step this route
 * exists to satisfy: on first save, VK POSTs `{"type":"confirmation", ...}`
 * and refuses to enable the callback until the exact string configured in
 * the community's admin panel comes back as the plain-text body —
 * VK_CONFIRMATION_CODE below. Every other event must get back the literal
 * string "ok" (not JSON) or VK treats it as failed and retries.
 *
 * The only event this route understands is `message_new` where the message
 * text is the phone-verification token `/verify-phone` minted — VK's
 * community-bot messaging API has no equivalent of Telegram's
 * `request_contact` button (see the long comment on
 * `NotificationService`'s phone-verification methods for why VK's proof is
 * "controls this VK account", not a phone number). Everything else gets
 * "ok" and no other action, the same "not a real chatbot" posture the
 * Telegram webhook takes.
 *
 * `secret` is VK's own optional shared-secret field, echoed on every
 * callback once configured in the community's Callback API settings —
 * checked when VK_CALLBACK_SECRET is set, skipped otherwise, the same
 * "no other credential a webhook caller could present" reasoning the
 * Telegram webhook documents for having no auth of its own.
 */

import { readyServices } from '@/server/runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface VkCallback {
  readonly type?: string;
  readonly group_id?: number;
  readonly secret?: string;
  readonly object?: {
    readonly message?: {
      readonly from_id?: number;
      readonly text?: string;
    };
  };
}

const OK = new Response('ok', { status: 200 });

async function reply(vkUserId: number, text: string): Promise<void> {
  const token = process.env.VK_GROUP_TOKEN;
  if (!token) return;
  try {
    const params = new URLSearchParams({
      user_id: String(vkUserId),
      message: text,
      random_id: String(Math.floor(Math.random() * 2 ** 31)),
      access_token: token,
      v: '5.199',
    });
    await fetch(`https://api.vk.com/method/messages.send?${params.toString()}`, { method: 'POST' });
  } catch {
    // Best-effort, same reasoning as the Telegram webhook's reply(): the
    // verification itself already succeeded or failed by the time this runs.
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const update = (await request.json()) as VkCallback;

    const expectedSecret = process.env.VK_CALLBACK_SECRET;
    if (expectedSecret && update.secret !== expectedSecret) return OK;

    if (update.type === 'confirmation') {
      const code = process.env.VK_CONFIRMATION_CODE;
      // No code configured: nothing safe to answer with, so this deployment
      // has not finished VK setup yet. VK will keep the callback disabled
      // and retry the confirmation step itself on the next save — not this
      // route's job to guess a code nobody supplied.
      return code ? new Response(code, { status: 200 }) : OK;
    }

    if (update.type === 'message_new') {
      const fromId = update.object?.message?.from_id;
      const text = update.object?.message?.text?.trim();
      if (typeof fromId === 'number' && text) {
        try {
          await (await readyServices()).notifications.completePhoneVerificationVk(text, fromId);
          await reply(fromId, 'Готово — номер телефона подтверждён через VK.');
        } catch {
          // An unrecognised or expired token: this is the "somebody typed
          // random text at the bot" case, not an error worth logging.
          await reply(fromId, 'Код недействителен или устарел. Начните подтверждение заново на сайте.');
        }
      }
    }

    return OK;
  } catch {
    // Malformed body, an unexpected throw — still "ok", or VK redelivers the
    // same event forever.
    return OK;
  }
}
