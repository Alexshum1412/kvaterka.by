// Passenger/LSNode's Node.js Selector expects a startup file that binds to
// process.env.PORT itself — `next start` is a CLI command, not a requirable
// file, so shared cPanel hosting needs this thin wrapper around Next's own
// programmatic server. See docs/OPERATIONS.md §4bis.
import { createServer } from 'node:http';
import next from 'next';

const port = process.env.PORT || 3000;
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

// No top-level await: OpenLiteSpeed's lsnode.js loads this file with a
// synchronous require(), which Node refuses for an ESM graph that contains
// a top-level await (ERR_REQUIRE_ASYNC_MODULE) — found by reading the
// account's actual stderr.log, which also showed the host runs lsnode, not
// Passenger as originally assumed.
app.prepare().then(() => {
  createServer((req, res) => {
    handle(req, res);
  }).listen(port, () => {
    console.log(`> Ready on port ${port}`);
  });
});
