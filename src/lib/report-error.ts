/**
 * Tell the server a page crashed in this browser (DEC-086) — fire and forget.
 *
 * sendBeacon survives the page being torn down and never blocks the error
 * screen; it posts text/plain, which /api/client-errors reads as JSON. Next
 * already strips server-side detail from `message` in production and leaves
 * `digest`, the id that matches the server's own log line.
 */
export function reportClientError(error: Error & { digest?: string }): void {
  try {
    const message = `${error.name}: ${error.message}${error.digest ? ` (digest ${error.digest})` : ''}`;
    navigator.sendBeacon('/api/client-errors', JSON.stringify({ message, path: location.pathname }));
  } catch {
    // Reporting a failure must never be one.
  }
}
