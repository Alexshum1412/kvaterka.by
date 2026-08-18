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

import type { Channel } from '../services/notification-service.ts';

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
 * Reads the same names `runtime.ts` validates. There is no client behind either
 * external channel yet, so both refuse — and they refuse differently depending
 * on whether the address is missing or the client is unimplemented, because an
 * operator who has set SMTP_URL and still sees failures needs to know the
 * address arrived and the code did not.
 */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env): ProviderSet {
  const email: DeliveryProvider = env.SMTP_URL
    ? unconfiguredProvider('EMAIL', 'адрес SMTP задан, но клиент не реализован')
    : unconfiguredProvider('EMAIL', 'SMTP_URL не задан');

  const telegram: DeliveryProvider = env.TELEGRAM_BOT_TOKEN
    ? unconfiguredProvider('TELEGRAM', 'токен задан, но клиент бота не реализован')
    : unconfiguredProvider('TELEGRAM', 'TELEGRAM_BOT_TOKEN не задан');

  const byChannel = { IN_APP: inAppProvider(), EMAIL: email, TELEGRAM: telegram } as const;

  return {
    byChannel,
    liveChannels: (Object.keys(byChannel) as Channel[]).filter((c) => byChannel[c].configured),
  };
}
