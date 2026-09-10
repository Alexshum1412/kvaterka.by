/**
 * Notification delivery providers.
 *
 * A domain service never calls an email or Telegram API. It writes a
 * `notification` row and returns; the worker reads that row, resolves an
 * address, and hands it to one of these. That split is what keeps a failing
 * third party from rolling back a booking.
 *
 * THREE OUTCOMES, NOT TWO
 *
 * `send()` never throws for an expected failure. It returns one of three
 * results, because the difference between them decides what the worker does
 * next and getting it wrong is how a queue destroys itself:
 *
 *   DELIVERED  — the provider accepted it. Not a promise it was read.
 *   TRANSIENT  — try again later: a timeout, a 5xx, a rate limit. Retryable.
 *   PERMANENT  — trying again will fail identically: no address on file, an
 *                address the provider rejects, a blocked chat. Retrying is
 *                pure cost and, at scale, an accidental denial of service
 *                against a provider that has already said no.
 *
 * Collapsing these into a boolean means either retrying what can never succeed,
 * or discarding what a five-second outage would have delivered.
 *
 * WHY AN UNCONFIGURED PROVIDER REFUSES
 *
 * No credentials exist for any channel. A provider that returned DELIVERED
 * because it had nothing to do would let the worker write `status='SENT'` —
 * and `SENT` is a claim to a person that they were told something. The queue
 * would drain, every dashboard would look healthy, and nobody would receive
 * anything. That failure is silent, permanent, and only discovered when a
 * landlord asks why they were never told their flat was booked.
 *
 * So an unconfigured provider returns PERMANENT with a stated reason, the row
 * ends as FAILED with that reason legible, and the console can say plainly that
 * this deployment cannot send. Same posture as the object store: refusing is
 * the feature.
 */

import nodemailer, { type NodemailerError, type Transporter } from 'nodemailer';

import type { Channel } from '../services/notification-service.ts';
import { telegramProvider } from './telegram.ts';

export type DeliveryStatus = 'DELIVERED' | 'TRANSIENT' | 'PERMANENT';

export interface DeliveryResult {
  readonly status: DeliveryStatus;
  /** Short, stable, safe to store. Never the message body, never a credential. */
  readonly detail: string;
  /** Provider-side id, when there is one. Useful for support enquiries. */
  readonly reference?: string;
}

export const delivered = (detail = 'ok', reference?: string): DeliveryResult =>
  reference === undefined ? { status: 'DELIVERED', detail } : { status: 'DELIVERED', detail, reference };
export const transient = (detail: string): DeliveryResult => ({ status: 'TRANSIENT', detail });
export const permanent = (detail: string): DeliveryResult => ({ status: 'PERMANENT', detail });

/**
 * What the worker hands a provider.
 *
 * `address` is resolved at send time from the user's current record, never read
 * from the notification payload. A payload is written when the event happens
 * and delivered later; if it carried the address, a person who corrected their
 * email would still receive the old queue at the old address. Resolving late
 * also means a channel that has since been unlinked simply has no address.
 */
export interface DeliveryMessage {
  readonly notificationId: string;
  readonly userId: string;
  readonly channel: Channel;
  readonly address: string;
  readonly category: string;
  readonly subject: string;
  readonly body: string;
  /**
   * The branded HTML rendering of `body`, EMAIL only. Optional because
   * TELEGRAM and IN_APP have no use for markup — Telegram's `sendMessage`
   * takes plain text (or its own limited entity syntax, not HTML5), and
   * IN_APP already renders `body` inside the inbox's own layout. Only
   * `deliverOne` decides when to set it; a provider that ignores it for a
   * non-EMAIL channel is doing the right thing, not skipping a feature.
   */
  readonly html?: string;
}

export interface DeliveryProvider {
  readonly channel: Channel;
  /** Whether real credentials are present. False means every send is PERMANENT. */
  readonly configured: boolean;
  /** For the console and the job report. Never a credential. */
  readonly describe: () => string;
  send(message: DeliveryMessage): Promise<DeliveryResult>;
}

/* ================================================================== *
 * The implementations that ship
 * ================================================================== */

/**
 * A provider with no credentials.
 *
 * PERMANENT rather than TRANSIENT on purpose. A missing bot token is not a
 * condition that resolves by waiting, and returning TRANSIENT would keep every
 * notification in the queue retrying for ever against a provider that will
 * never exist — the retry storm this module is shaped to prevent.
 */
export function unconfiguredProvider(channel: Channel, why: string): DeliveryProvider {
  return {
    channel,
    configured: false,
    describe: () => `${channel}: ${why}`,
    async send() {
      return permanent(`Канал не настроен: ${why}`);
    },
  };
}

/**
 * IN_APP is real, and it is the only channel that is.
 *
 * The row in `notification` IS the in-app message: the inbox reads that table
 * directly. There is nothing external to call, so marking it delivered is a
 * true statement rather than a convenient one — which is exactly what separates
 * it from the two channels below.
 */
export function inAppProvider(): DeliveryProvider {
  return {
    channel: 'IN_APP',
    configured: true,
    describe: () => 'IN_APP: сохраняется в базе, читается в личном кабинете',
    async send() {
      return delivered('stored');
    },
  };
}

/**
 * Development adapter: records what WOULD have been sent, deterministically.
 *
 * Used only when explicitly asked for. It reports DELIVERED, which is a lie
 * about the outside world and true about itself — nothing left the machine and
 * the record says so. That is acceptable for a local walkthrough and would not
 * be acceptable in production, which is why `documentedProviders()` never
 * returns it unless the environment opts in by name.
 */
export interface RecordedDelivery extends DeliveryMessage {
  readonly at: Date;
}

export function recordingProvider(channel: Channel, sink: RecordedDelivery[]): DeliveryProvider {
  return {
    channel,
    configured: true,
    describe: () => `${channel}: локальный журнал разработчика, наружу ничего не уходит`,
    async send(message) {
      sink.push({ ...message, at: new Date() });
      return delivered('recorded (dev)');
    },
  };
}

/**
 * EMAIL, for real.
 *
 * `nodemailer.createTransport(smtpUrl)` already understands `smtp://user:pass@host:port`
 * and `smtps://...` on its own; hand-parsing that URL here would just be a second,
 * worse copy of logic nodemailer gets right, and a second place for a stray
 * character in a password to go silently mangled. The transport is built once,
 * when the provider is constructed, and reused for every send — nodemailer owns
 * the connection lifecycle from there.
 *
 * WHY THE ERROR MAPPING LOOKS LIKE THIS
 *
 * A thrown error from `sendMail()` is nodemailer's word for "the server did not
 * accept it," and the shape of that error is the only signal available for
 * sorting it into TRANSIENT or PERMANENT:
 *
 *   `responseCode` is the SMTP status the *server itself* replied with, so it is
 *   checked first. 5xx is the server refusing this message on its own terms —
 *   an unknown mailbox, a policy rule — and will refuse it identically on retry:
 *   PERMANENT. 4xx is the server saying "not now": a full mailbox, greylisting,
 *   a momentary block. TRANSIENT.
 *
 *   `code` is nodemailer's own classification for failures that never reached an
 *   SMTP conversation to get a response code from. EAUTH means the credentials
 *   embedded in `smtpUrl` are wrong — retrying with the same wrong password
 *   produces the same wrong password, so PERMANENT, and this is exactly the kind
 *   of failure that will sit retrying forever if it is misjudged. ECONNECTION and
 *   ETIMEDOUT mean the network or the remote host was unreachable for *this*
 *   attempt, which says nothing about the next one: TRANSIENT.
 *
 * Anything else defaults to TRANSIENT, per this file's own rule at the top: an
 * unexpected throw is not evidence that trying again is futile, only that this
 * attempt did not go as planned.
 *
 * `detail` is built from the error's own `message`/`code`, which is safe to
 * store — nodemailer does not echo the auth password back into its errors. What
 * must never happen, and is why `host` is computed once via `new URL(smtpUrl)`
 * up front, is `smtpUrl` itself reaching `detail` or `describe()`: that string
 * carries the password and this file's job is to make sure nothing here ever
 * writes it anywhere.
 *
 * `transporter` defaults to the real one built from `smtpUrl` — every call site
 * in this codebase omits it and gets exactly that. The parameter exists so a
 * test can hand in nodemailer's own `jsonTransport: true` double (never touches
 * the network, deterministic) and exercise the actual `send()`/error-mapping
 * logic above instead of re-implementing it against a mock.
 */
export function smtpProvider(
  smtpUrl: string,
  mailFrom: string,
  transporter: Transporter = nodemailer.createTransport(smtpUrl),
): DeliveryProvider {
  const host = new URL(smtpUrl).hostname;

  return {
    channel: 'EMAIL',
    configured: true,
    describe: () => `EMAIL: SMTP настроен (${host})`,
    async send(message) {
      try {
        const info = await transporter.sendMail({
          from: mailFrom,
          to: message.address,
          subject: message.subject,
          text: message.body,
          html: message.html,
        });
        return delivered(info.messageId ?? 'sent', info.messageId);
      } catch (err) {
        const error = err as NodemailerError;
        const reason = error.message || error.code || 'unknown SMTP error';

        if (error.responseCode !== undefined) {
          return error.responseCode >= 500
            ? permanent(`SMTP ${error.responseCode}: ${reason}`)
            : transient(`SMTP ${error.responseCode}: ${reason}`);
        }
        if (error.code === 'EAUTH') {
          return permanent(`SMTP отклонил учётные данные: ${reason}`);
        }
        if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
          return transient(`SMTP недоступен: ${reason}`);
        }
        return transient(`SMTP: ${reason}`);
      }
    },
  };
}

/* ================================================================== *
 * Resolution
 * ================================================================== */

export interface ProviderSet {
  readonly byChannel: Readonly<Record<Channel, DeliveryProvider>>;
  /** Channels that could actually reach a person from this deployment. */
  readonly liveChannels: readonly Channel[];
}

/**
 * The providers this deployment has.
 *
 * Reads the same names `runtime.ts` validates. EMAIL turns real once both
 * SMTP_URL and MAIL_FROM are set — `runtime.ts` already refuses to boot with
 * one and not the other, but this function checks both anyway rather than
 * trusting that upstream validation always ran, because a provider that reads
 * `env.MAIL_FROM` as a non-null string it never confirmed is one bad
 * deployment script away from mailing from `"undefined"`. TELEGRAM turns real
 * the same way EMAIL does — on the presence of its one credential — and
 * refuses with a message that names the missing variable when it is absent,
 * because an operator staring at a stalled backlog needs to know which env
 * var to set.
 */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env): ProviderSet {
  const email: DeliveryProvider = env.SMTP_URL
    ? env.MAIL_FROM
      ? smtpProvider(env.SMTP_URL, env.MAIL_FROM)
      : unconfiguredProvider('EMAIL', 'адрес SMTP задан, но MAIL_FROM отсутствует')
    : unconfiguredProvider('EMAIL', 'SMTP_URL не задан');

  const telegram: DeliveryProvider = env.TELEGRAM_BOT_TOKEN
    ? telegramProvider(env.TELEGRAM_BOT_TOKEN)
    : unconfiguredProvider('TELEGRAM', 'TELEGRAM_BOT_TOKEN не задан');

  const byChannel = { IN_APP: inAppProvider(), EMAIL: email, TELEGRAM: telegram } as const;

  return {
    byChannel,
    liveChannels: (Object.keys(byChannel) as Channel[]).filter((c) => byChannel[c].configured),
  };
}
