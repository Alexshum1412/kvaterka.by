/**
 * WhatsApp Cloud API webhook (0018 phone verification).
 *
 * Meta's official Cloud API, not an unofficial client. The originally
 * requested approach (whatsapp-web.js / Baileys) puppets a real WhatsApp
 * account through the consumer app's own protocol — against WhatsApp's terms
 * of service, prone to the number being banned with no recourse, and it
 * needs a persistent logged-in browser session (Puppeteer/Chromium) that
 * this project's shared cPanel/LiteSpeed hosting has no way to keep running.
 * The Cloud API is a plain HTTPS webhook plus HTTPS calls to send — it fits
 * this host, and it is the ToS-compliant integration Meta actually offers
 * for exactly this purpose. See the deploy notes for the Meta Business /
 * WhatsApp Business Platform setup this still needs from the operator.
 *
 * GET is Meta's one-time webhook-verification handshake: it must be
 * answered with the raw `hub.challenge` value, and only when
 * `hub.verify_token` matches what this deployment configured in Meta's
 * console (WHATSAPP_VERIFY_TOKEN) — chosen here, not by Meta, so it is a
 * shared secret this route can actually check.
 *
 * POST delivers inbound messages. The only one this route understands is a
 * text message whose body is the phone-verification token `/verify-phone`
 * minted; `messages[].from` is WhatsApp's own verified sender number, so
 * unlike VK this channel captures a real phone number for free — see the
 * long comment on `NotificationService`'s phone-verification methods.
 */

import { readyServices } from '@/server/runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface WhatsappWebhookBody {
  readonly entry?: ReadonlyArray<{
    readonly changes?: ReadonlyArray<{
      readonly value?: {
        readonly messages?: ReadonlyArray<{
          readonly from?: string;
          readonly type?: string;
          readonly text?: { readonly body?: string };
        }>;
      };
    }>;
  }>;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

/** Best-effort session reply — free-form replies are allowed within 24h of
 *  an inbound message, so no pre-approved template is needed here. */
async function reply(to: string, text: string): Promise<void> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
  } catch {
    // The verification itself already succeeded or failed by the time this
    // runs; a reply that fails to send is not worth retrying.
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as WhatsappWebhookBody;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages ?? [];

    for (const message of messages) {
      if (message.type !== 'text' || !message.from) continue;
      const token = message.text?.body?.trim();
      if (!token) continue;

      try {
        await (await readyServices()).notifications.completePhoneVerificationWhatsapp(token, message.from);
        await reply(message.from, 'Готово — номер телефона подтверждён через WhatsApp.');
      } catch {
        // An unrecognised or expired token — not an error worth logging, the
        // same posture the Telegram and VK webhooks take for the same case.
        await reply(message.from, 'Код недействителен или устарел. Начните подтверждение заново на сайте.');
      }
    }
  } catch {
    // Malformed body, an unexpected throw — Meta only retries on a non-2xx,
    // so this still has to return 200.
  }

  return new Response(null, { status: 200 });
}
