/**
 * "Add to calendar" export for a confirmed booking.
 *
 * It sits outside the JSON route table on purpose, the same reasoning as
 * `src/app/api/uploads/route.ts`: that dispatcher answers with a JSON body,
 * and this endpoint answers with an .ics file for Google/Apple/Outlook to
 * open directly. Authentication and the DomainError → HTTP translation are
 * done here explicitly, the same way uploads/route.ts does them.
 *
 * Authorisation mirrors `GET /bookings/:id`
 * (src/server/api/routes/bookings.ts) exactly: a stranger and a booking that
 * does not exist get the same 404, because whether a booking exists is
 * itself information.
 */

import { currentUser } from '@/server/session.ts';
import { env, ready, readyServices } from '@/server/runtime.ts';
import { DomainError, invalid, notFound } from '@/server/services/errors.ts';
import { blocksCalendar } from '@/server/domain/booking/states.ts';

export const dynamic = 'force-dynamic';

function fail(status: number, message: string): Response {
  return Response.json({ error: { code: 'ICAL_FAILED', message } }, { status });
}

/** RFC 5545 §3.3.11: backslash, semicolon and comma are structural; escape them,
 *  plus the newlines a property value must never actually contain. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** 'YYYY-MM-DD' (what `lower()`/`upper()` on the stay_period range yield) to
 *  the DATE value RFC 5545 §3.3.4 wants: 'YYYYMMDD'. */
function toIcsDate(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

/** DTSTAMP is always UTC (RFC 5545 §3.8.7.2): 'YYYYMMDDTHHMMSSZ'. */
function toIcsTimestamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

interface IcsEventInput {
  readonly uid: string;
  readonly summary: string;
  readonly description: string;
  readonly dtStart: string;
  readonly dtEnd: string;
}

function buildIcs({ uid, summary, description, dtStart, dtEnd }: IcsEventInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kvaterka.by//booking//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${toIcsTimestamp(new Date())}`,
    `DTSTART;VALUE=DATE:${toIcsDate(dtStart)}`,
    `DTEND;VALUE=DATE:${toIcsDate(dtEnd)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return fail(401, 'Войдите, чтобы скачать файл календаря');

  try {
    const services = await readyServices();
    const booking = await services.bookings.get(id);

    // Same check as GET /bookings/:id: a stranger gets the same answer as an
    // id that never existed.
    if (booking.tenant_id !== user.userId && booking.landlord_id !== user.userId) {
      throw notFound('Бронирование');
    }

    // Only a booking that actually held the calendar has real stay dates to
    // export — the same states property_occupancy is built from.
    if (!blocksCalendar(booking.status)) {
      throw invalid('Для этого бронирования пока нет подтверждённых дат');
    }

    const database = await ready();
    const { rows } = await database.query<{ title: string; city: string }>(
      `SELECT title, city FROM property WHERE id = $1`,
      [booking.property_id],
    );
    const listing = rows[0];

    const baseUrl = env().PUBLIC_BASE_URL.replace(/\/$/, '');
    const bookingUrl = `${baseUrl}/bookings/${booking.id}`;

    const summary = listing ? `Аренда: ${listing.title}, ${listing.city}` : 'Аренда жилья — Кватэрка.by';
    const description = `Бронирование №${booking.reference}. Подробности и переписка: ${bookingUrl}`;

    const ics = buildIcs({
      uid: `${booking.id}@kvaterka.by`,
      summary,
      description,
      dtStart: booking.stay_from,
      dtEnd: booking.stay_to,
    });

    return new Response(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="kvaterka-${booking.id}.ics"`,
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return fail(error.status, error.message);
    return fail(500, 'Не удалось сформировать файл календаря');
  }
}
