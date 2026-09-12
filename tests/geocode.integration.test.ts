/**
 * The address-geocoding proxy (`GET /api/geocode`, DEC-077).
 *
 * It exists so the listing wizard can pre-fill the location pin from a typed
 * address instead of always starting from a blank map — but it must NEVER
 * turn a Nominatim hiccup into a wizard-blocking error, since manual pin
 * placement is the well-established fallback this route sits in front of.
 * That "always degrade to nothing-found" contract is most of what this file
 * checks; the rest is the User-Agent/Referer Nominatim's usage policy
 * requires, which is invisible from the wizard and would only ever be
 * noticed by silently getting the app rate-limited in production.
 *
 * No real network call is made — `global.fetch` is mocked for every case, in
 * both directions (a shaped response, and a rejected promise for the
 * network-failure/timeout case).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ current: null as { userId: string; displayName: string } | null }));

vi.mock('@/server/session.ts', () => ({
  currentUser: async () => session.current,
}));

const { GET } = await import('@/app/api/geocode/route.ts');

function request(q: string): Request {
  return new Request(`http://localhost/api/geocode?q=${encodeURIComponent(q)}`);
}

beforeEach(() => {
  session.current = { userId: 'u1', displayName: 'Тэставы Гаспадар' };
});

afterEach(() => {
  vi.restoreAllMocks();
  session.current = null;
});

/* ================================================================== */

describe('a real match', () => {
  it('forwards an identifying User-Agent and Referer, and parses a typical Nominatim response', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([{ lat: '53.902300', lon: '27.561900', display_name: 'Минск, Беларусь' }]),
        { status: 200 },
      ),
    );

    const response = await GET(request('пр. Победителей 1, Минск'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { latitude: number; longitude: number; displayName: string } | null };
    expect(body.result).toEqual({ latitude: 53.9023, longitude: 27.5619, displayName: 'Минск, Беларусь' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('https://nominatim.openstreetmap.org/search');
    expect(String(calledUrl)).toContain('countrycodes=by');

    // Nominatim's usage policy requires a real identifying User-Agent or
    // Referer — a generic fetch default satisfies neither and risks a silent
    // block, so this is the one behaviour that matters even though nothing
    // in the wizard would ever surface a header to a reviewer manually.
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('user-agent')).toMatch(/Kvaterka/i);
    expect(headers.get('referer')).toBeTruthy();
    expect(headers.get('user-agent')).not.toBe('');
  });

  it('falls back to the query text when Nominatim omits display_name', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ lat: '52.4242', lon: '31.0141' }]), { status: 200 }),
    );

    const response = await GET(request('Гомель, Беларусь'));
    const body = (await response.json()) as { result: { displayName: string } | null };
    expect(body.result?.displayName).toBe('Гомель, Беларусь');
  });
});

describe('graceful degradation — never a blocking error', () => {
  it('returns a null result, not an error, when Nominatim finds nothing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const response = await GET(request('несуществующий адрес ыыыыы'));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBeNull();
  });

  it('returns a null result when Nominatim is unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    const response = await GET(request('улица Ленина 5, Гомель'));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBeNull();
  });

  it('returns a null result when Nominatim rate-limits the request (429)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

    const response = await GET(request('улица Ленина 5, Гомель'));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBeNull();
  });

  it('returns a null result when Nominatim answers with malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    const response = await GET(request('улица Ленина 5, Гомель'));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBeNull();
  });

  it('drops a result outside Belarus as a sanity check even if Nominatim returns one', async () => {
    // countrycodes=by should already prevent this upstream; the route checks
    // again itself rather than trusting that filter blindly.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ lat: '48.8566', lon: '2.3522', display_name: 'Paris, France' }]), {
        status: 200,
      }),
    );

    const response = await GET(request('some ambiguous query'));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBeNull();
  });
});

describe('refused before ever calling Nominatim', () => {
  it('refuses an anonymous caller and never touches the network', async () => {
    session.current = null;
    const fetchMock = vi.spyOn(global, 'fetch');

    const response = await GET(request('улица Ленина 5, Гомель'));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a query too short to be worth a lookup', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const response = await GET(request('м'));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
