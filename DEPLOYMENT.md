# DEPLOYMENT.md

How Kvaterka.by is deployed, and what the first deployment must be: **closed staging on the real
domain**, not a launch.

Nothing here was invented for a hypothetical platform. Every command was run against a real
PostgreSQL 16 and a real production build of this application before being written down.

---

## 1. What this application actually needs

| Requirement | Value | Why it is not negotiable |
|---|---|---|
| **PostgreSQL** | **16+**, with `btree_gist`, `pg_trgm`, `citext`, `cube`, `earthdistance` | `btree_gist` carries the `EXCLUDE USING gist` constraint that makes double booking impossible. Without these extensions the schema does not build — migration `0001` fails on line one. MySQL cannot run this schema at all. |
| **Node.js** | **20.11+** (developed and verified on 24) | `package.json` `engines`. The migration CLI needs `--experimental-transform-types`, which is Node 22.7+. |
| **Process model** | one long-lived Node process | Next.js App Router with `force-dynamic` on every page. This is server-side rendering, not static files: there is no `out/` directory to upload. |
| **Reverse proxy** | nginx or equivalent, terminating TLS | The app binds loopback; nginx is what the internet talks to. |
| **Scheduler** | anything that can run a command every 15 minutes | Three background jobs exist and **none of them runs unless something calls it**. |
| **Writable disk** | until object storage exists | Uploaded photographs land in `.media/`. See §8 — this is a blocker, not a solution. |

### Two possible homes on HostFly, and how to tell which one works

The public tariff page for «Хостинг сайтов» advertises only «Базы данных MYSQL» and a list of PHP
CMSs, which reads like a refusal. **The actual cPanel on the purchased account says otherwise**: it
offers «Базы данных PostgreSQL», phpPgAdmin, «Настройка Node.js приложений», Terminal, SSH access,
cron and Git — with PostgreSQL databases limited to ∞, 4 GB of memory and 150 processes.

So shared hosting is **not** ruled out by inspection. Three questions decide it — and on the
account as purchased, they have now been answered by looking:

> ### VERDICT ON THE PURCHASED TARIFF (Cloud Бизнес, server `ultra.hostflyby.net`)
>
> **PostgreSQL is 9.6.22** — read from phpPgAdmin's own header while connected as the account user.
> That version was released in 2016 and has been end-of-life since November 2021. This schema needs
> **16+**, and it fails on 9.6 in two independent ways, neither of which is a permissions problem:
>
> 1. `db/migrations/0001_foundation.sql:12` — `CREATE EXTENSION btree_gist`. Trusted extensions,
>    which let a database owner create an extension without superuser rights, arrived in
>    **PostgreSQL 13**. On 9.6 an unprivileged account cannot create any extension at all.
> 2. `db/migrations/0003_bookings.sql:49` — `nights integer GENERATED ALWAYS AS (...) STORED`. A
>    generated stored column is **PostgreSQL 12+** syntax. On 9.6 it is a parse error, and no
>    administrator can grant it away.
>
> The first could in principle be solved by asking support to install five extensions. **The second
> cannot.** It needs a newer server.
>
> Node.js is not the problem: the cPanel selector offers **22.23.2 and 24.18.1**, both above the
> project's floor and above the 22.7 the migration CLI wants.
>
> **Therefore: this tariff cannot host Kvaterka.by.** The route is either a HostFly Cloud VPS
> (§2–§4), or shared hosting on a server whose PostgreSQL is 16 or newer — worth one question to
> support before spending anything.

For any other account, the same three questions, answered in five minutes from cPanel → Terminal:

| Question | Why it decides everything |
|---|---|
| **PostgreSQL server version?** | The schema needs a server new enough to carry the extensions below. cPanel installations are often several major versions behind. |
| **Can this account `CREATE EXTENSION`?** | `btree_gist`, `pg_trgm`, `citext`, `cube`, `earthdistance`. On PostgreSQL 13+ the first four are *trusted*, so a database owner may create them without superuser rights; `earthdistance` is **not** trusted and needs an administrator. Without `btree_gist` migration `0001` fails and there is no product. |
| **Which Node.js versions does the selector offer?** | 20.11 minimum; 22.7+ for the migration CLI's `--experimental-transform-types`. |

```bash
# cPanel → Terminal. Read-only; changes nothing.
node -v; ls -d /opt/cpanel/ea-nodejs*/ 2>/dev/null
psql --version
free -m | head -2; nproc
```

Then, once a PostgreSQL database and user exist (cPanel → «Базы данных PostgreSQL»):

```bash
psql -h localhost -U <db_user> -d <db_name> -c 'SHOW server_version'
psql -h localhost -U <db_user> -d <db_name> -c 'CREATE EXTENSION IF NOT EXISTS btree_gist'
psql -h localhost -U <db_user> -d <db_name> -c 'CREATE EXTENSION IF NOT EXISTS earthdistance CASCADE'
```

If `btree_gist` succeeds, shared hosting is viable and §4bis applies. If it is refused, ask HostFly
support to install the five extensions — this is a normal request, and they can do it in minutes. If
they will not, the answer is a **Cloud VPS** and §4 applies unchanged.

**A HostFly Cloud VPS runs all of it with no questions asked.** Root access, Ubuntu, 2–4 GB RAM,
from 32.99 BYN/month. It is the certain path; shared hosting is the cheap one that has to be
proven.

---

## 2. Sizing

The application and the database share one machine for staging.

| Tariff | Verdict |
|---|---|
| CloudVPS-1 — 1 core, 2 GB | **Enough for closed staging.** Tight: a Next.js build wants ~1.5 GB on its own, so build elsewhere or add swap (§4). |
| CloudVPS-2 — 2 cores, 4 GB | **Recommended.** Builds on the box without drama, and leaves PostgreSQL room to cache. |

Nothing larger is justified before there are real users.

---

## 3. The shape of it

```
        kvaterka.by (DNS A → VPS IPv4)
                 │
                 ▼
        nginx :443  ── TLS (Let's Encrypt, certbot)
                 │    ── basic auth: THE STAGING GATE
                 ▼
        Next.js :3000 (loopback only, systemd: kvaterka.service)
                 │
                 ▼
        PostgreSQL 16 (localhost, kvaterka_staging)
                 │
        systemd timer every 15 min ──▶ scripts/run-jobs.mjs
                                        (machine credential, three job routes)
```

---

## 4. First deployment, step by step

Run as root on a fresh Ubuntu 24.04 VPS.

### 4.1 Base packages

```bash
apt-get update && apt-get install -y curl ca-certificates gnupg git nginx postgresql postgresql-contrib
```

Node 24 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
```

On a 2 GB machine, add swap so the build does not get killed:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 4.2 The database

```bash
sudo -u postgres createuser --pwprompt kvaterka
sudo -u postgres createdb --owner=kvaterka kvaterka_staging
```

The five extensions must be installed **into that database**, by a superuser:

```bash
sudo -u postgres psql -d kvaterka_staging -c 'CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS cube; CREATE EXTENSION IF NOT EXISTS earthdistance;'
```

Confirm PostgreSQL is 16 or newer:

```bash
sudo -u postgres psql -tAc 'SHOW server_version'
```

### 4.3 The application user and the code

```bash
adduser --system --group --home /srv/kvaterka kvaterka
git clone https://github.com/Alexshum1412/kvaterka.by.git /srv/kvaterka
chown -R kvaterka:kvaterka /srv/kvaterka
```

### 4.4 Configuration

```bash
mkdir -p /etc/kvaterka
install -o kvaterka -g kvaterka -m 600 /dev/null /etc/kvaterka/kvaterka.env
```

Then write the variables from §5 into that file. **Mode 600, owned by `kvaterka`** — it holds the
database password and the scheduler token, and it must never be world-readable and never in git.

Generate the scheduler token on the server, so it exists nowhere else:

```bash
openssl rand -base64 48
```

### 4.5 Build

```bash
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && npm ci && npm run build'
```

### 4.6 Schema

```bash
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && set -a && . /etc/kvaterka/kvaterka.env && set +a && npm run db:migrate'
```

Expected: `Applied 15 migration(s)`. Re-running says `Schema is current` — it is idempotent, and it
**refuses** to run if an already-applied migration file was edited.

**Seeding is for staging only.** `npm run db:seed` writes demonstration accounts with known
passwords and **refuses to run when `NODE_ENV=production`**. That refusal is deliberate and must not
be worked around. To seed a staging database, run it with `NODE_ENV` unset — and never against a
database that will later hold real people.

### 4.7 Services

```bash
cp /srv/kvaterka/deploy/kvaterka.service /srv/kvaterka/deploy/kvaterka-jobs.service /srv/kvaterka/deploy/kvaterka-jobs.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kvaterka kvaterka-jobs.timer
systemctl status kvaterka --no-pager
```

### 4.8 The staging gate, then nginx and TLS

Create the password file **before** exposing anything:

```bash
apt-get install -y apache2-utils
htpasswd -c /etc/nginx/kvaterka.htpasswd staging
```

```bash
cp /srv/kvaterka/deploy/nginx.conf /etc/nginx/sites-available/kvaterka
ln -s /etc/nginx/sites-available/kvaterka /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx
```

TLS, once DNS resolves to this machine (§6):

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d kvaterka.by -d www.kvaterka.by --agree-tos --no-eff-email -m <ваш-email>
```

Certbot installs its own renewal timer; check it with `systemctl list-timers certbot*`.

### 4.9 Firewall

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

PostgreSQL is **not** opened. It listens on localhost and nothing outside the machine has any
business reaching it.

---

## 4bis. If shared cPanel hosting turns out to be viable

The same application, arranged the way cPanel expects. Nothing in the codebase changes.

1. **cPanel → «Настройка Node.js приложений» → Create Application.**
   - Application root: `kvaterka`
   - Application URL: `kvaterka.by`
   - Application startup file: `server.js` (see below)
   - Node.js version: the newest offered
2. **cPanel → «Базы данных PostgreSQL»** — create a database and a user, and grant the user ALL on
   the database. Note them for `DATABASE_URL`.
3. **cPanel → Terminal**, then, inside the virtual environment cPanel prints when the app is created:
   ```bash
   cd ~/kvaterka && git clone https://github.com/Alexshum1412/kvaterka.by.git . && npm ci && npm run build && npm run db:migrate
   ```
4. **Environment variables** go in the Node.js application screen, not in a file — cPanel injects
   them into the process. Same list as §5.
5. **cPanel → «Задания cron»**, every 15 minutes:
   ```
   */15 * * * * cd ~/kvaterka && BASE_URL=http://127.0.0.1:$PORT /opt/cpanel/ea-nodejs22/bin/node scripts/run-jobs.mjs >> ~/jobs.log 2>&1
   ```
6. **cPanel → SSL/TLS Certificates** — the account currently carries a **self-signed** certificate
   and cPanel itself warns «Your domain is at risk!». Issue the free AutoSSL/Let's Encrypt
   certificate before anything is exposed.

**What shared hosting cannot give**, and must be stated rather than discovered:

- **No systemd.** Passenger starts the app; a crash loop is less visible, and `deploy/*.service`
  does not apply.
- **Passenger, not `next start`.** cPanel's Node.js hosting expects a startup file that exports a
  server. Next.js supports this through a custom server; it is the one piece of glue this
  arrangement needs, and it must be written and tested rather than assumed.
- **Shared CPU and 150 processes.** Fine for closed staging; the EP limit of 50 is the one to watch.
- **The staging gate** is cPanel → «Конфиденциальность папки» (directory password) rather than the
  nginx basic-auth block in `deploy/nginx.conf`.

---

## 5. Environment variables

Written to `/etc/kvaterka/kvaterka.env`, one `KEY=value` per line, no quotes needed.

| Variable | Required | Secret | Value |
|---|---|---|---|
| `DATABASE_URL` | **yes** | **yes** | `postgres://kvaterka:<пароль>@localhost:5432/kvaterka_staging` |
| `NODE_ENV` | yes | no | `production` — set by the systemd unit, not by this file |
| `PUBLIC_BASE_URL` | yes | no | `https://kvaterka.by` — wrong value means every link in every notification points at localhost |
| `JOB_RUNNER_TOKEN` | **yes** | **yes** | `openssl rand -base64 48`. Minimum 32 characters or the process refuses to start. **Not an admin account**: it authorises three job routes and reads nothing |
| `SITE_INDEXABLE` | no | no | leave **unset** for staging. Setting it to `true` is what lets search engines in, and that is a launch decision |
| `DATABASE_SSL` | no | no | `false` for localhost |
| `DATABASE_POOL_MAX` | no | no | `10` default; `5` is plenty on a 2 GB box |
| `SMTP_URL` | no | **yes** | Unset for now — see §7 |
| `TELEGRAM_BOT_TOKEN` | no | **yes** | Unset. Telegram is gated on LEGAL-015 |
| `MEDIA_BUCKET_URL` | no | no | Unset — see §8 |
| `DOCUMENTS_BUCKET_URL` | no | no | Unset. Identity documents are gated on LEGAL-004; the process refuses to start if this equals `MEDIA_BUCKET_URL` |
| `NEXT_PUBLIC_MAP_STYLE_URL` | no | no | Unset; the map draws real relative positions and says plainly that no tile layer is connected |

Nothing in this table belongs in the repository. `.env*` files are gitignored except
`.env.example`, and the only tracked one contains placeholders.

---

## 6. Domain and DNS

At HostFly, the domain and the DNS zone are managed in the client area; the VPS has its own IPv4.

| Record | Host | Value | Note |
|---|---|---|---|
| `A` | `@` | IPv4 of the VPS | The one that matters |
| `A` | `www` | same IPv4 | nginx redirects it to the bare domain |
| `AAAA` | — | only if the VPS has IPv6 | An `AAAA` pointing nowhere breaks the site for IPv6 clients |
| `MX` | `@` | **do not touch** | Mail for the domain may already be configured. Changing MX breaks it, and this deployment does not need mail to arrive |
| `TXT` | `@` | leave existing | Verification records live here |

Wait for propagation before requesting a certificate — certbot proves control over the name by being
reachable at it:

```bash
dig +short kvaterka.by A
```

---

## 7. Email — infrastructure blocker

**No email leaves this platform, on any deployment, today.** There is no SMTP client: the provider
contract exists and refuses honestly rather than reporting a success it did not achieve.

What that costs, concretely: **password reset does not work.** The screen is built, the endpoints
work, the token is minted — and it is enqueued on the `EMAIL` channel only, so it reaches nobody. A
person locked out of a staging account cannot get back in without database access.

To fix it, a provider is needed and `SMTP_URL` must be set. Until then, `GET /api/health` reports
the undelivered backlog by channel, which is the honest measure.

**Do not** configure an SMTP relay and let the scheduler run against real addresses on a staging
database full of invented people.

---

## 8. Media — storage blocker

Photographs currently land on the VPS disk under `/srv/kvaterka/.media`.

That works and it is **not production storage**:

- a rebuilt or replaced VPS loses every photograph;
- `MEDIA_BUCKET_URL` being set makes `/api/uploads` answer **501** rather than pretend, because no
  bucket client is implemented;
- deleting a photo removes the database row and **not** the bytes, so a deleted photograph remains
  fetchable at its old URL.

For staging with demonstration data this is acceptable and must be **stated**, not quietly relied
on. Before real listings exist, an object store and a client for it are required.

---

## 9. Verifying the deployment

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://kvaterka.by/            # 401 while the staging gate is on
curl -su staging:<пароль> https://kvaterka.by/api/health | head -c 400   # {"status":"ok",...}
systemctl status kvaterka --no-pager
systemctl list-timers kvaterka-jobs --no-pager
journalctl -u kvaterka -n 50 --no-pager
journalctl -u kvaterka-jobs -n 30 --no-pager
```

`/api/health` reports the database driver and latency, the last run of each background job, and the
notification backlog by channel. A `503` there means the application is up and its database is not.

Smoke test, with the staging password:

```
/  /search  /login  /password-reset  /how-it-works  /trust  /host  /host/fees
/terms  /privacy  /support  /api/health  and a deliberate 404
```

---

## 10. Updating

```bash
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && git pull && npm ci && npm run build'
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && set -a && . /etc/kvaterka/kvaterka.env && set +a && npm run db:migrate'
systemctl restart kvaterka
```

Migrations run **before** the restart. Data survives: it is in PostgreSQL, not in the deployment
directory. Uploaded photographs survive only because `.media` is inside that directory and `git
pull` does not touch it — which is the storage blocker in §8 wearing a different hat.

---

## 11. Backups

HostFly includes backups of the **virtual machine**. That is not a database backup: restoring a
whole VM to recover one table is not a procedure anybody wants at the moment they need it.

```bash
sudo -u postgres pg_dump -Fc kvaterka_staging > /var/backups/kvaterka-$(date +%F).dump
```

The release checklist asks for a **rehearsed restore**, not a taken backup. A backup nobody has
restored is a hypothesis.

---

## 12. What this deployment is not

It is **staging**. The basic-auth gate in `deploy/nginx.conf` is what makes it closed, `robots.txt`
disallows everything while `SITE_INDEXABLE` is unset, and the seeded accounts are demonstrations.

It is not a launch, and the things that make it not a launch are not technical:

- **LEGAL-003** — where personal data may physically live. HostFly states publicly that its
  equipment is in a Tier 3 data centre **in Belarus**; that is a marketing statement on
  `hostfly.by/about/who-are-we/`, not a contractual guarantee naming a facility. A lawyer decides
  whether it is sufficient.
- **БелГИЭ** — HostFly's own FAQ carries a section on registering a site with the state
  telecommunications inspectorate. Whether kvaterka.by must be registered, by whom, and at what
  cost is a question for a lawyer and for HostFly's support. **Nothing in this repository asserts an
  answer.**
- **LEGAL-004** (identity documents), **LEGAL-012** (rewards), **LEGAL-015** (Telegram),
  **LEGAL-016** (fee enforceability) — all gated, all off.
- No terms of service and no privacy policy drafted by a Belarus-qualified lawyer. `/terms` and
  `/privacy` say so in as many words.
