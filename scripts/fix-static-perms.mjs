// One-off repair for shared-hosting deploys: unzip on this host defaults an
// implied parent directory (one never given its own zip entry) to mode 000
// instead of something sane, which makes Next's own recursive readdir at
// boot fail with EACCES. Fix it top-down so read/exec is restored before
// descending, whatever the actual nesting turns out to be.
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function fix(dir) {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      fix(full);
    } else {
      chmodSync(full, 0o644);
    }
  }
}

fix('.next');
console.log('Permissions fixed under .next/');
