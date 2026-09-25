# Эксплуатация

Развёртывание, резервные копии и перенос базы, подключение почты. Раньше DEPLOYMENT.md, docs/DATABASE_MIGRATION.md и docs/EMAIL_PRODUCTION.md. Пошаговое обновление работающего сайта — в [HOW_TO_UPDATE_THE_SITE.md](../HOW_TO_UPDATE_THE_SITE.md).

## Содержание

- Развёртывание
- Резервные копии и перенос базы
- Почта в production

---

## Развёртывание

How Kvaterka.by is deployed, and what the first deployment must be: **closed staging on the real
domain**, not a launch.

Nothing here was invented for a hypothetical platform. Every command was run against a real
PostgreSQL **10.23** — the version the target host offers — under a **non-superuser role with no
extensions installed**, and against a real production build of this application, before being
written down.

> **This file was rewritten once already, and the reason is worth keeping.** It used to say the
> application required PostgreSQL 16 with five extensions, and concluded that the purchased tariff
> could not host it. That was true of the schema as it stood. The schema was then changed rather
> than the hosting: every extension has been replaced by something core PostgreSQL already had, and
> the whole suite now runs on 10.23. Where this document still says "16", it is wrong; report it.

---

### 1. What this application actually needs

| Requirement | Value | Why it is not negotiable |
|---|---|---|
| **PostgreSQL** | **10.23 or newer. No extensions. No superuser.** The database must be `UTF8` with a **UTF-8 locale** — `ru_RU.UTF-8`, `be_BY.UTF-8`, `en_US.UTF-8` or `C.UTF-8`. Plain `C` will not do. | The schema is verified by CI against a real 10.23 under an unprivileged role, and runs unchanged on 16 and 18. `LC_CTYPE=C` is the one setting that breaks the product without raising a single error: `lower('МИНСК')` returns `'МИНСК'`, and Russian search silently finds nothing. Migration `0001` refuses to apply to such a database. MySQL and MariaDB cannot run this schema at all — see DEC-062. |
| **Node.js** | **20.11+** (developed and verified on 24) | `package.json` `engines`. The migration CLI needs `--experimental-transform-types`, which is Node 22.7+. |
| **Process model** | one long-lived Node process | Next.js App Router with `force-dynamic` on every page. This is server-side rendering, not static files: there is no `out/` directory to upload. |
| **Reverse proxy** | nginx or equivalent, terminating TLS | The app binds loopback; nginx is what the internet talks to. |
| **Scheduler** | anything that can run a command every 15 minutes | Three background jobs exist and **none of them runs unless something calls it**. |
| **Writable disk** | until object storage exists | Uploaded photographs land in `.media/`. See §8 — this is a blocker, not a solution. |

#### Two possible homes on HostFly, and how to tell which one works

The public tariff page for «Хостинг сайтов» advertises only «Базы данных MYSQL» and a list of PHP
CMSs, which reads like a refusal. **The actual cPanel on the purchased account says otherwise**: it
offers «Базы данных PostgreSQL», phpPgAdmin, «Настройка Node.js приложений», Terminal, SSH access,
cron and Git — with PostgreSQL databases limited to ∞, 4 GB of memory and 150 processes.

So shared hosting is **not** ruled out by inspection. Three questions decide it — and on the
account as purchased, they have now been answered by looking:

> ### VERDICT ON THE PURCHASED TARIFF — REVISED, AND THE REVISION IS THE POINT
>
> **This block used to end "this tariff cannot host Kvaterka.by". That is no longer true, and it
> stopped being true because the schema changed, not because the hosting did.**
>
> What was found by looking, and still stands: the account's default server `ultra.hostflyby.net`
> runs **PostgreSQL 9.6.22**, read from phpPgAdmin's own header. Node.js is not a problem — the
> cPanel selector offers **22.23.2 and 24.18.1**, both above the project's floor.
>
> What has changed: the two blockers were `CREATE EXTENSION` (needs a superuser the account is not)
> and `GENERATED ALWAYS AS ... STORED` (PostgreSQL 12+). **Both are gone from the schema.** There
> are no extensions at all, and `nights` is maintained by a trigger. The whole suite — 1135 tests —
> now passes against a real **PostgreSQL 10.23** under a `NOSUPERUSER NOCREATEROLE NOCREATEDB`
> role with zero extensions installed, and CI runs that configuration on every push.
>
> **So the question to ask support is no longer "will you install five extensions". It is one
> question: put this account on a server offering PostgreSQL 10.23 or newer.** The host has
> confirmed 10.23 is available. Nothing else is needed from them.
>
> Whether **9.6.22** itself would work has **not been tested and is not claimed.** Nothing in the
> schema obviously requires a feature newer than 9.6 — no generated columns, no identity columns, no
> `MERGE`, no extensions — but "nothing obviously requires it" is not a test result, and this file
> does not print guesses as facts. If 9.6 is the only option, that is a separate afternoon with a
> 9.6 server and the existing test suite, which would answer it in an hour.

For any other account, the questions are now shorter, and answerable in five minutes from
cPanel → Terminal:

| Question | Why it decides everything |
|---|---|
| **PostgreSQL server version?** | 10.23 or newer. Verified by CI at exactly 10.23; runs unchanged on 16 and 18. |
| **What is the database's `LC_CTYPE`?** | Must be a UTF-8 locale. Under plain `C` the database cannot lower-case Cyrillic, and Russian search silently returns nothing — with no error anywhere. Migration `0001` refuses such a database rather than let it ship. |
| **Which Node.js versions does the selector offer?** | 20.11 minimum; 22.7+ for the migration CLI's `--experimental-transform-types`. |

There is deliberately **no** question about `CREATE EXTENSION` any more. The schema uses none, and
`tests/pg10-compatibility.test.ts` fails the build if one reappears.

```bash
# cPanel → Terminal. Read-only; changes nothing.
node -v; ls -d /opt/cpanel/ea-nodejs*/ 2>/dev/null
free -m | head -2; nproc
```

Then, once a PostgreSQL database and user exist (cPanel → «Базы данных PostgreSQL»):

```bash
psql -h localhost -U <db_user> -d <db_name> -c 'SHOW server_version'
# Must print a UTF-8 locale and 'минск' in lower case. If it prints 'МИНСК',
# the database must be recreated — the locale cannot be changed in place.
psql -h localhost -U <db_user> -d <db_name> -c "SELECT current_setting('lc_ctype'), lower('МИНСК')"
```

**A HostFly Cloud VPS runs all of it with no questions asked.** Root access, Ubuntu, 2–4 GB RAM,
from 32.99 BYN/month. It is the certain path; shared hosting is the cheap one that has to be
proven.

---

### 2. Sizing

The application and the database share one machine for staging.

| Tariff | Verdict |
|---|---|
| CloudVPS-1 — 1 core, 2 GB | **Enough for closed staging.** Tight: a Next.js build wants ~1.5 GB on its own, so build elsewhere or add swap (§4). |
| CloudVPS-2 — 2 cores, 4 GB | **Recommended.** Builds on the box without drama, and leaves PostgreSQL room to cache. |

Nothing larger is justified before there are real users.

---

### 2bis. Your own machine at home

An unused desktop is a legitimate host for **closed staging**, and on raw hardware it beats the VPS
tariffs outright: an i5-6400 is four cores against CloudVPS-2's two, and 8 GB against its 4. Nothing
in §4 changes — the same Ubuntu, the same PostgreSQL, the same systemd units.

What decides it is not the machine. It is whether the internet can reach it. **Three checks, in
order; the first failure is the answer.**

#### 1. Do you have a public IP at all?

```bash
curl -s ifconfig.me; echo
ip -4 addr show scope global | grep inet
```

If the first address is not the same as the second, you are behind **CGNAT** — the ISP shares one
public address between many subscribers and no port forwarding is possible from your side. A
`100.64.x.x`–`100.127.x.x` local address is CGNAT by definition.

#### 2. Is it the same address tomorrow?

Most residential connections give a **dynamic** address. A DNS `A` record pointing at yesterday's
address is a site that is down and looks like a bug. Either ask the ISP for a static address
(usually a small monthly fee), or run a dynamic-DNS updater and accept the propagation gap.

#### 3. Are ports 80 and 443 open?

Many ISPs block them on residential plans specifically to discourage hosting. Forward both to the
machine in the router, then verify **from outside** — testing from inside the house proves nothing,
because the router will happily answer itself.

```bash
# From any machine NOT on your home network:
curl -sI http://ВАШ_IP | head -1
```

#### If all three pass

Use it. Point `kvaterka.by`'s `A` record at the address and follow §4 unchanged.

#### If any fails

Two honest options, and they are not equivalent:

- **A tunnel** (Cloudflare Tunnel, `cloudflared`) reaches a machine with no public IP and no open
  ports at all, and terminates TLS for you. It also means every request and every page of this
  product passes through a third party outside Belarus — which is exactly the question **LEGAL-003**
  is about, and not one this file can answer.
- **A VPS**, which sidesteps all three checks by having a real address.

#### What a home machine is not

Fine for staging; not the same thing as a launch. No SLA on power or the ISP. Uptime is the
household's uptime. Residential upload is the narrow direction, and photographs go that way. A
machine exposed to the internet sits **inside your home network**, so a compromise is a compromise
of everything on that LAN — put it on an isolated VLAN or guest network if it stays.

---

### 3. The shape of it

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
        PostgreSQL 10.23+ (localhost, kvaterka_staging)
                 │
        systemd timer every 15 min ──▶ scripts/run-jobs.mjs
                                        (machine credential, three job routes)
```

---

### 4. First deployment, step by step

Run as root on a fresh Ubuntu 24.04 VPS.

#### 4.1 Base packages

**Check the Ubuntu release first — it decides which PostgreSQL you get:**

```bash
lsb_release -a
```

| Ubuntu | `apt-get install postgresql` gives | Verdict |
|---|---|---|
| 24.04 LTS | PostgreSQL **16** | Fine — install straight from the distribution |
| 22.04 LTS | PostgreSQL **14** | **Too old.** Add the PGDG repository below |
| older | 13 or less | **Too old.** Add the PGDG repository below |

On 24.04:

```bash
apt-get update && apt-get install -y curl ca-certificates gnupg git nginx postgresql postgresql-contrib
```

On 22.04 or older, take PostgreSQL from the project's own repository instead — installing the
distribution's version and discovering it is 14 halfway through migration `0003` is the exact trap
the HostFly shared hosting fell into:

```bash
apt-get update && apt-get install -y curl ca-certificates gnupg git nginx
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt-get update && apt-get install -y postgresql-17 postgresql-contrib-17
```

Either way, confirm before going further — this single number has already cost one deployment:

```bash
sudo -u postgres psql -tAc 'SHOW server_version'
```

Node 24 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
```

On a 2 GB machine, add swap so the build does not get killed:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

#### 4.2 The database

```bash
sudo -u postgres createuser --pwprompt kvaterka
sudo -u postgres createdb --owner=kvaterka kvaterka_staging
```

**No extensions are installed, and none may be.** The schema uses none, and
`tests/pg10-compatibility.test.ts` fails the build if anyone reintroduces one.
There is nothing to run here — which is the point of the whole exercise.

Two properties of the database itself do matter, and both are set at creation
time and cannot be changed afterwards without recreating it:

```bash
sudo -u postgres createuser --pwprompt kvaterka
sudo -u postgres createdb --owner=kvaterka   --encoding=UTF8 --lc-collate=ru_RU.UTF-8 --lc-ctype=ru_RU.UTF-8   --template=template0 kvaterka_staging
```

If `ru_RU.UTF-8` is not generated on the machine, `C.UTF-8` and `en_US.UTF-8`
both work. Plain `C` does **not**: under it `lower('МИНСК')` returns `'МИНСК'`
unchanged, nothing errors anywhere, and Russian search silently returns nothing
for everyone who does not capitalise their city. Migration `0001` refuses to
apply to such a database rather than let that ship.

Confirm the version and the locale together:

```bash
sudo -u postgres psql -tAc 'SHOW server_version'
sudo -u postgres psql -d kvaterka_staging -tAc "SELECT current_setting('lc_ctype'), lower('МИНСК')"
# must print a UTF-8 locale, and 'минск' in lower case
```

Anything from **10.23** upwards will do. The role needs no special rights: it
owns its own database and nothing else, which is exactly what shared hosting
gives you, and what CI tests with.

#### 4.3 The application user and the code

```bash
adduser --system --group --home /srv/kvaterka kvaterka
git clone https://github.com/Alexshum1412/kvaterka.by.git /srv/kvaterka
chown -R kvaterka:kvaterka /srv/kvaterka
```

#### 4.4 Configuration

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

#### 4.5 Build

```bash
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && npm ci && npm run build'
```

#### 4.6 Schema

```bash
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && set -a && . /etc/kvaterka/kvaterka.env && set +a && npm run db:migrate'
```

Expected: `Applied 15 migration(s)`. Re-running says `Schema is current` — it is idempotent, and it
**refuses** to run if an already-applied migration file was edited.

**Seeding is for staging only.** `npm run db:seed` writes demonstration accounts with known
passwords and **refuses to run when `NODE_ENV=production`**. That refusal is deliberate and must not
be worked around. To seed a staging database, run it with `NODE_ENV` unset — and never against a
database that will later hold real people.

#### 4.7 Services

```bash
cp /srv/kvaterka/deploy/kvaterka.service /srv/kvaterka/deploy/kvaterka-jobs.service /srv/kvaterka/deploy/kvaterka-jobs.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kvaterka kvaterka-jobs.timer
systemctl status kvaterka --no-pager
```

#### 4.8 The staging gate, then nginx and TLS

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

#### 4.9 Firewall

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

PostgreSQL is **not** opened. It listens on localhost and nothing outside the machine has any
business reaching it.

---

### 4bis. If shared cPanel hosting turns out to be viable

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
   cd ~/kvaterka && git clone https://github.com/Alexshum1412/kvaterka.by.git . && npm install --include=dev && npm run db:migrate
   ```
   **Do not run `npm run build` here.** On this host (CloudLinux LVE) the build dies with the SWC
   `ThreadPoolBuildError`; the `.next` folder is built on your own machine and uploaded as a zip —
   the whole loop is in [HOW_TO_UPDATE_THE_SITE.md](../HOW_TO_UPDATE_THE_SITE.md) §2.4–2.8. Until the
   first zip is extracted there is no `.next` and the app will not start.
4. **Environment variables** go in the Node.js application screen, not in a file — cPanel injects
   them into the process. Same list as §5.
5. **cPanel → «Задания cron»**, every 15 minutes. **Both variables, spelled out, on the line:**
   ```
   */15 * * * * cd ~/kvaterka && BASE_URL=http://127.0.0.1:3000 JOB_RUNNER_TOKEN=... /opt/cpanel/ea-nodejs22/bin/node scripts/run-jobs.mjs >> ~/jobs.log 2>&1
   ```
   The version of this line that stood here before omitted `JOB_RUNNER_TOKEN`, and would have run
   every fifteen minutes for ever without executing a single job. Two traps, both worth naming:

   - **cron has almost no environment.** It does not inherit the variables cPanel injects into the
     application process, so a line that works when you paste it into a shell can do nothing at all
     under cron. `scripts/run-jobs.mjs` exits 2 and says which variable is missing rather than
     reporting an empty queue — but only if somebody reads `~/jobs.log`.
   - **`$PORT` is not set under cron either.** It was `http://127.0.0.1:$PORT`, which expands to
     `http://127.0.0.1:` and connects to nothing. Write the number.

   The token is a secret. It belongs in the cron line or a file only this account can read — never
   in the repository, and never in a screenshot of the cron screen.
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

### 5. Environment variables

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
| `SMTP_URL` | no | **yes** | Real SMTP delivery once set (DEC-066) — see §7. `MAIL_FROM` must be set alongside it |
| `MAIL_FROM` | no | no | e.g. `Кватэрка.by <noreply@kvaterka.by>` — required together with `SMTP_URL` |
| `TELEGRAM_BOT_TOKEN` | no | **yes** | Notification delivery AND phone verification (0018) once set — see §5bis for the webhook-registration step this token requires |
| `TELEGRAM_BOT_USERNAME` | no | no | Not secret — ships to the browser for the `t.me` deep link |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | secret is | "Sign in with Google" — OAuth Client in Google Cloud Console, redirect URI `<PUBLIC_BASE_URL>/api/auth/google/callback` |
| `MEDIA_BUCKET_URL` | no | no | Unset — see §8 |
| `DOCUMENTS_BUCKET_URL` | no | no | Unset. Property-ownership documents are gated on LEGAL-004 (identity documents were retired in 0018, not merely gated); the process refuses to start if this equals `MEDIA_BUCKET_URL` |

Nothing in this table belongs in the repository. `.env*` files are gitignored except
`.env.example`, and the only tracked one contains placeholders.

---

### 5bis. Telegram bot setup

Setting `TELEGRAM_BOT_TOKEN` alone is not enough — Telegram will not send this
app anything until you register the webhook URL with Telegram's own API, and
the bot's own "/" command menu stays empty until you register that
separately too. Nothing in the app does either for you automatically. Four
steps, done once per bot token:

1. Create the bot (skip if you already have one): message
   [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, follow the
   prompts. It replies with the bot token — this is `TELEGRAM_BOT_TOKEN`. The
   username it asks you to choose (without the `@`) is `TELEGRAM_BOT_USERNAME`.
2. Set both env vars (§5 above) and restart the app so it picks them up.
3. Register the webhook **with its secret**, once `PUBLIC_BASE_URL` is live
   and reachable over HTTPS:

   ```
   TELEGRAM_BOT_TOKEN=<token> PUBLIC_BASE_URL=https://kvaterka.by npm run telegram:webhook
   ```

   It prints `{"ok":true,"description":"Webhook was set",...}` on success.
   The webhook route refuses (401) every delivery that does not carry the
   secret this registers, so the old plain `setWebhook?url=...` link is not
   enough any more: registered that way, Telegram sends no secret and every
   `/start` and contact share is refused — phone verification and linking stop
   working until this command is run. (The refusal is the point: before it,
   anyone could POST a forged update and verify a phone number they do not
   own — DEC-085.) Nothing new to configure: the secret is derived from the
   bot token by the same function the route checks against. `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getMe`
   confirms the token itself is valid if that response is instead
   `{"ok":false,"error_code":401,...}` — a 401 here means the token was
   mistyped (a capital `O` and a digit `0` are easy to confuse copying it out
   of BotFather's message by hand), not that anything else is wrong.
4. Register the command menu (0021/DEC-078 — `/start`, `/status`, `/unlink`,
   `/help`) so it shows up when someone taps the "/" button in the chat:

   ```
   TELEGRAM_BOT_TOKEN=<token> node scripts/telegram-set-commands.mjs
   ```

   Prints `{"ok":true,...}` on success. The command list lives in that
   script, kept in sync by hand with what `src/app/api/telegram/webhook/
   route.ts` actually answers — re-run this step whenever either changes.

Re-run step 3 whenever `PUBLIC_BASE_URL` changes (a new domain, moving off
staging) or the bot token is rotated — the webhook URL and its secret are
registered by value, not re-derived on every request. Step 4 only needs re-running when the command list
itself changes, not on every deploy.

---

### 6. Domain and DNS

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

### 7. Email — infrastructure blocker

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

### 8. Media — storage blocker

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

### 9. Verifying the deployment

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

### 10. Updating

```bash
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && git pull && npm ci && npm run build'
sudo -u kvaterka bash -lc 'cd /srv/kvaterka && set -a && . /etc/kvaterka/kvaterka.env && set +a && npm run db:migrate'
systemctl restart kvaterka
```

Migrations run **before** the restart. Data survives: it is in PostgreSQL, not in the deployment
directory. Uploaded photographs survive only because `.media` is inside that directory and `git
pull` does not touch it — which is the storage blocker in §8 wearing a different hat.

---

### 11. Backups

HostFly includes backups of the **virtual machine**. That is not a database backup: restoring a
whole VM to recover one table is not a procedure anybody wants at the moment they need it.

The release checklist asks for a **rehearsed restore**, not a taken backup. A backup nobody has
restored is a hypothesis — and the one line that used to stand here was exactly that. It has been
replaced by the section «Резервные копии и перенос базы» further down this file, where every command has
been run against a real PostgreSQL 10.23 under an unprivileged role and the result verified row by
row.

Three findings from that rehearsal belong here, because each one turns a backup into a
non-backup:

1. **A full `pg_restore` fails under a normal role.** It stops on
   `COMMENT ON EXTENSION plpgsql`, which only a superuser may issue, and PostgreSQL 10 has neither
   `pg_dump --no-comments` nor `pg_restore --no-comments` — those arrived in 11. So **the schema is
   rebuilt by migrations and the dump carries only data.** That is the procedure, not a workaround.

2. **`property_occupancy` is excluded from the dump**, along with the three tables the migrations
   populate. Its rows are rebuilt by the triggers when the bookings land; including them makes the
   restore collide with its own primary key. Verified: 11 rows in the source, 0 in the dump, 11 in
   the restored database, fingerprints matching.

3. **`pg_dump` must not be newer than the target server.** A dump taken with `pg_dump` 16 will not
   load into PostgreSQL 10, and `pg_dump` 10 refuses to connect to a 16 server at all. Use the
   version matching the target.

```bash
# The dump that can actually be restored. See «Резервные копии и перенос базы», §1.
pg_dump "$DATABASE_URL" --format=custom --compress=9 --data-only   --exclude-table=schema_migration --exclude-table=amenity   --exclude-table=feature_flag --exclude-table=property_occupancy   --file="/var/backups/kvaterka-$(date +%F).dump"

# Prove it is readable without restoring it.
pg_restore --list "/var/backups/kvaterka-$(date +%F).dump" | wc -l

# Prove a restore is faithful. Prints counts and hashes, never personal data.
DATABASE_URL="<source>" npm run db:validate -- --compare "<target>" --fingerprint
```

---

### 12. What this deployment is not

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

---

## Резервные копии и перенос базы

Этот документ описывает **отрепетированную** процедуру, а не предполагаемую.
Каждая команда ниже была выполнена на настоящем PostgreSQL 10.23 под
непривилегированной ролью, и результат сверен построчно. Там, где что-то
сломалось, это написано прямо — потому что именно эти места ломаются и у вас.

> **Ничего из этого не выполняйте на production без отдельного подтверждения
> владельца.** Раздел 8 (переключение) сознательно оставлен неисполненным.

---

### 0. Что нужно знать до первой команды

**Схему создают миграции, а не дамп.**

Это главное решение всего документа. Дамп несёт данные; структуру строит
`npm run db:migrate`. Причин три, и все три проверены:

1. **Дамп схемы не восстанавливается под обычной ролью.** Полный
   `pg_restore` падает на первой же строке:

   ```
   pg_restore: [archiver (db)] could not execute query: ОШИБКА: нужно быть
   владельцем расширения plpgsql
       Command was: COMMENT ON EXTENSION plpgsql IS 'PL/pgSQL procedural language';
   ```

   На shared-хостинге владельцем `plpgsql` является суперпользователь, которым
   вы не являетесь. В PostgreSQL 10 нет ни `pg_dump --no-comments`, ни
   `pg_restore --no-comments` — их добавили в 11. Обойти нечем.

2. **Схема в git и защищена контрольными суммами.** Миграции применяются
   ровно один раз, а изменённый после применения файл `migrate()` отвергает.
   Дамп схемы — это вторая копия правды, которая рано или поздно разойдётся с
   первой.

3. **Миграции переносимы между версиями.** Одна и та же история
   разворачивается на PostgreSQL 10, 16 и 18. Дамп схемы, снятый с 16-й,
   на 10-ю не встанет вообще.

**Из дампа данных исключаются четыре таблицы.** Три наполняют сами миграции,
одну целиком строят триггеры:

| Таблица | Почему исключена |
|---|---|
| `schema_migration` | Ведёт `migrate()`. Восстановление поверх даст дубли и сломает контрольные суммы. |
| `amenity` | Справочник, его наполняет миграция 0002. |
| `feature_flag` | То же, миграция 0006. |
| `property_occupancy` | **Производная.** Триггеры пересоздают её из броней и блокировок. |

Последняя строка — не оптимизация, а необходимость. При вставке брони срабатывает
триггер `booking_occupancy` и сам занимает ночи; если те же строки придут ещё и
из дампа, восстановление упадёт с нарушением первичного ключа. Исключив таблицу,
вы получаете её обратно бесплатно и заведомо согласованной с бронями.

Проверено: в источнике 11 строк занятости, в дампе — ноль, в восстановленной
базе — снова 11.

**Триггеры мешать не будут.** Все append-only триггеры объявлены как
`BEFORE UPDATE OR DELETE` — вставку они не трогают. Поэтому
`--disable-triggers` (которому нужен суперпользователь) не нужен.

---

### 1. Резервная копия

Две копии, у каждой своя задача.

#### 1.1. Полная — для аварийного восстановления на такой же сервер

```bash
pg_dump "$DATABASE_URL" \
  --format=custom --compress=9 \
  --no-owner --no-privileges \
  --file="kvaterka-full-$(date +%F-%H%M).dump"
```

Годится, чтобы поднять базу там, где у вас есть суперпользователь. На shared-
хостинге как источник восстановления она не сработает — см. раздел 0.

#### 1.2. Данные — та, которой переносят

```bash
pg_dump "$DATABASE_URL" \
  --format=custom --compress=9 --data-only \
  --exclude-table=schema_migration \
  --exclude-table=amenity \
  --exclude-table=feature_flag \
  --exclude-table=property_occupancy \
  --file="kvaterka-data-$(date +%F-%H%M).dump"
```

`pg_dump` напечатает предупреждение о том, что при `--data-only` он не
выключает триггеры. Так и задумано: см. раздел 0, вставку они не блокируют.

#### 1.3. Версия `pg_dump` имеет значение

`pg_dump` умеет читать сервер **своей версии или старше**, но не новее. Дамп,
снятый `pg_dump` 16-й версии, в PostgreSQL 10 не загрузится, а `pg_dump` 10-й
версии откажется подключаться к серверу 16-й:

```
pg_dump: server version: 16.2; pg_dump version: 10.23
pg_dump: aborting because of server version mismatch
```

Практическое правило: **берите `pg_dump` той же версии, что и целевой сервер.**
Для переноса на PostgreSQL 10.23 это `pg_dump` 10.x. Проверить:

```bash
pg_dump --version
psql "$DATABASE_URL" -Atc "SHOW server_version"
```

Если источник новее цели и другого пути нет, дамп должен быть текстовым, с
`--inserts`, и его придётся читать глазами. Это последнее средство, а не план.

---

### 2. Проверка копии, не восстанавливая её

Файл может быть создан и при этом быть нечитаемым. Оглавление читается без
базы данных и без риска:

```bash
pg_restore --list kvaterka-data-2026-08-23-1048.dump | head
pg_restore --list kvaterka-data-2026-08-23-1048.dump | wc -l
```

Пустой или обрывающийся список — копии нет. Проверяйте это **сразу после
снятия**, а не в тот день, когда она понадобится.

---

### 3. Восстановление

```bash
# 3.1. Пустая база. Кодировка и локаль обязательны — см. раздел 6.
createdb --encoding=UTF8 --lc-collate=ru_RU.UTF-8 --lc-ctype=ru_RU.UTF-8 \
  --template=template0 kvaterka_restored

# 3.2. Схему строят миграции
DATABASE_URL=postgres://user:pass@host:5432/kvaterka_restored npm run db:migrate

# 3.3. Данные
pg_restore --dbname="postgres://user:pass@host:5432/kvaterka_restored" \
  --data-only --exit-on-error --single-transaction \
  kvaterka-data-2026-08-23-1048.dump
```

`--single-transaction` вместе с `--exit-on-error`: либо все данные, либо
никаких. Половина восстановленной базы хуже, чем пустая, потому что выглядит
рабочей.

---

### 4. Проверка того, что получилось

```bash
DATABASE_URL="<источник>" npm run db:validate -- \
  --compare "<цель>" --fingerprint
```

Скрипт `scripts/db-validate.ts`:

* **не пишет** — сессия открывается `default_transaction_read_only = on`,
  так что ошибка в самом скрипте будет отвергнута сервером;
* **не печатает персональные данные** — только количества, даты самой старой и
  самой новой строки и хеши. Ни адреса, ни имени, ни сообщения, ни ключа
  документа. Так сделано специально: вывод такой команды обычно попадает в чат
  или в тикет.

Что он проверяет:

| Проверка | Что означает срабатывание |
|---|---|
| количество строк по каждой таблице | копия неполна |
| `--fingerprint` — md5 по идентификаторам | строк столько же, но это **другие** строки |
| сироты по каждому внешнему ключу | связи порваны; выводится из `pg_constraint`, поэтому новый ключ покрывается сам |
| дубли email без учёта регистра | уникальный индекс `lower(email)` отсутствует или невалиден |
| `nights` не совпадает с датами | триггер не отработал |
| подтверждённая бронь не держит все свои ночи | **календарь врёт, ночи можно продать дважды** |
| ночи держит отменённая бронь | ночи не продать никогда, и никто их не освободит |
| занятость на чужом объекте или вне дат брони | строки занятости повреждены |
| подтверждение без замороженных условий | доказательство для спора неполно |
| `COMPLETED` без даты завершения | невозможное состояние FSM |

Ожидаемый результат сверки:

```
  table                           source    target    diff    fingerprint
  ------------------------------------------------------------------------------
  app_user                        8         8         ok      match
  booking                         1         1         ok      match
  calendar_block                  1         1         ok      match
  property                        6         6         ok      match
  property_occupancy              11        11        ok
  ...
  The two databases agree on every table.

  No structural problems found.
```

Обратите внимание на `property_occupancy`: её не было в дампе, и она совпала.
Это и есть доказательство, что триггеры восстановили её правильно.

Код возврата — `1`, если найдена хоть одна фатальная проблема или разошлись
количества. Годится для конвейера.

---

### 5. Права: чего у вас не будет

Проверено на PostgreSQL 10.23 под ролью `NOSUPERUSER NOCREATEROLE NOCREATEDB`:

| Операция | Работает? |
|---|---|
| `npm run db:migrate` с нуля | **да**, все 14 миграций |
| повторный `db:migrate` | **да**, «Schema is current», ноль применений |
| `pg_dump` своей базы | да |
| `pg_restore --data-only` | да |
| `pg_restore` полного дампа | **нет** — `COMMENT ON EXTENSION plpgsql` |
| `CREATE EXTENSION` | **нет** — «нужно быть суперпользователем» |
| `--disable-triggers` | нет, и не нужен |
| `ALTER SYSTEM`, `COPY FROM PROGRAM` | нет, и нигде не используются |

Не добавляйте `--no-owner` бездумно «чтобы прошло»: он не чинит право
владения, он лишь пропускает `ALTER ... OWNER TO`. Если объект должен
принадлежать вашей роли, он и так ей принадлежит — вы его создали.

---

### 6. Кодировка и локаль — обязательны

База обязана быть `UTF8`, а `LC_CTYPE` — настоящей UTF-8 локалью.

При `LC_CTYPE=C` функция `lower('МИНСК')` возвращает `'МИНСК'` без изменений.
Ошибки не будет **нигде**: все запросы отработают, все английские тесты
пройдут, а поиск по-русски перестанет находить что-либо для всех, кто не пишет
город с заглавной буквы.

Замерено на живом PostgreSQL 10.23:

| | `LC_CTYPE=C` | `LC_CTYPE=ru-RU` |
|---|---|---|
| `lower('МИНСК')` | `МИНСК` | `минск` |
| `lower('Минск') = lower('МИНСК')` | **false** | true |
| запрос «минск» находит «Минска» | **false** | true |
| английский поиск | работает | работает |

Поэтому миграция `0001_foundation.sql` начинается с проверки и **отказывается
применяться** на такой базе. Это единственный способ поймать поломку, у которой
нет других симптомов.

Подходят `ru_RU.UTF-8`, `be_BY.UTF-8`, `en_US.UTF-8`, `C.UTF-8`.
Не подходят `C` и `POSIX`.

---

### 7. Перенос: полный порядок

```
ИСТОЧНИК
   │
   ├─ 1. npm run db:validate                 запомнить количества
   ├─ 2. pg_dump --data-only (4 исключения)  раздел 1.2
   ├─ 3. pg_restore --list                   копия читается
   │
ЦЕЛЬ (staging, не production)
   │
   ├─ 4. createdb  UTF8 + UTF-8 локаль       раздел 6
   ├─ 5. npm run db:migrate                  схему строят миграции
   ├─ 6. pg_restore --data-only --single-transaction
   ├─ 7. npm run db:validate -- --compare --fingerprint
   ├─ 8. smoke-тест приложением
   │
   └─ 9. ПЕРЕКЛЮЧЕНИЕ — только после отдельного подтверждения владельца
```

Шаги 1–8 безопасны и повторяемы: они ничего не трогают в источнике и работают
с отдельной базой на цели. Шаг 9 в этом документе не выполняется.

#### Переключение (подготовлено, не выполнено)

1. Включить режим обслуживания или закрыть доступ (basic-auth уже стоит в
   `deploy/nginx.conf`).
2. Остановить планировщик — иначе задание запишет в базу, которую вы сейчас
   копируете. `systemctl stop kvaterka-jobs.timer`, либо убрать строку cron.
3. Снять **финальный** дамп данных с источника.
4. Повторить шаги 4–7 на целевой базе.
5. Поменять `DATABASE_URL`, перезапустить приложение.
6. Smoke-тест: вход, поиск, карточка объявления, календарь, запрос брони.
7. Вернуть планировщик.
8. Источник **не удалять** минимум неделю.

---

### 8. Откат

| Что пошло не так | Что делать |
|---|---|
| миграция упала на цели | Ничего не переключено. Целевую базу удалить, разобраться, повторить. Источник не тронут. |
| `pg_restore` упал | `--single-transaction` уже всё откатил. Цель пуста. Повторить. |
| сверка разошлась | **Не переключать.** Разница в количествах — это потерянные или лишние строки. |
| приложение падает после переключения | Вернуть `DATABASE_URL` на источник, перезапустить. Одна переменная, один рестарт. |
| бронирование ведёт себя неправильно | Вернуть `DATABASE_URL`. Затем `npm run db:validate` на цели — проверки занятости покажут, права ли база. |
| деградация скорости | Вернуть `DATABASE_URL`, затем `ANALYZE` на цели: без статистики планировщик угадывает. |

Откат возможен ровно потому, что источник остаётся нетронутым: ни один шаг
1–8 в него не пишет. Это и есть план отката — не удалять источник.

---

### 9. Регулярные копии

```bash
# ежедневно, хранить 14 дней
0 3 * * * cd /home/USER/kvaterka && pg_dump "$DATABASE_URL" \
  --format=custom --compress=9 --data-only \
  --exclude-table=schema_migration --exclude-table=amenity \
  --exclude-table=feature_flag --exclude-table=property_occupancy \
  --file="$HOME/backups/kvaterka-$(date +\%F).dump" \
  && find "$HOME/backups" -name 'kvaterka-*.dump' -mtime +14 -delete
```

**Копия, которую ни разу не восстанавливали, — это гипотеза.**
`MVP_RELEASE_CHECKLIST.md` требует отрепетированного восстановления, а не
снятой копии. Раз в месяц проходите разделы 3 и 4 на отдельной базе. Это
занимает меньше времени, чем один разговор о том, почему копия не подошла.

Хранить копии на том же диске, что и базу, не имеет смысла: диск — это ровно та
вещь, от потери которой копия защищает.

---

### 10. Персональные данные в копии

Дамп содержит всё: адреса электронной почты, телефоны, переписку, точные
координаты квартир, ссылки на документы. Он не менее чувствителен, чем сама
база, а лежит обычно в куда менее защищённом месте.

* не кладите копии в репозиторий — `.gitignore` перекрывает `*.dump`, но
  полагаться на это не стоит;
* не пересылайте копии в мессенджерах и не прикладывайте к тикетам;
* для диагностики есть `npm run db:validate`, который по построению не выводит
  ничего персонального;
* сроки хранения самих копий — часть LEGAL-003 и решаются владельцем, а не
  этим документом.

---

## Почта в production

Ничего из описанного здесь **не подключено**. Это требования и порядок
действий на тот момент, когда владелец решит подключать платного провайдера.
Пока `SMTP_URL` не задан, ни одно письмо не уходит и не может уйти.

---

### 1. Что уже есть, и что это значит

Абстракция доставки существует и работает: `src/server/delivery/provider.ts`.
Доменная служба никогда не обращается к почтовому API — она пишет строку в
`notification` и возвращает управление. Отдельный воркер читает эту строку,
разрешает адрес и отдаёт провайдеру. Разделение сделано ровно для того, чтобы
упавший внешний сервис не откатывал бронирование.

Провайдер возвращает один из трёх результатов, а не «да/нет»:

| Результат | Значение | Что делает воркер |
|---|---|---|
| `DELIVERED` | провайдер принял письмо | помечает `SENT` |
| `TRANSIENT` | таймаут, 5xx, лимит частоты | повторит с задержкой |
| `PERMANENT` | адреса нет, адрес отвергнут, ящик заблокирован | помечает `FAILED` с причиной |

Разница между `TRANSIENT` и `PERMANENT` — не педантизм. Свести их к булеву
значению означает либо бесконечно повторять то, что не может получиться, либо
выбрасывать то, что доставилось бы через пять секунд.

**Ненастроенный провайдер возвращает `PERMANENT`, а не `DELIVERED`.** Это
сделано осознанно: `SENT` — это утверждение, что человеку сообщили. Провайдер,
который отвечает «доставлено», потому что ему нечего делать, оставил бы очередь
пустой, все панели зелёными и никого не оповещённым. Такую поломку замечают в
тот день, когда арендодатель спрашивает, почему ему не сказали о брони.

**Чего нет:** ни одного клиента. Задать `SMTP_URL` недостаточно — под него
нужно написать реализацию. Переменная без реализации ничего не включает, и
отчёт задания говорит об этом прямо, а не притворяется.

---

### 2. Требования к провайдеру

| Требование | Почему |
|---|---|
| SMTP с аутентификацией или HTTP API | Через абстракцию подойдёт любой из двух |
| Собственный домен отправителя | Письма от `kvaterka.by`, не от `provider.example` |
| Поддержка SPF, DKIM, DMARC | Без них письма уходят в спам, и это не настраивается «потом» |
| Обработка возвратов (bounce) | Нужны, чтобы помечать адрес недоставляемым |
| Обработка жалоб (FBL) | Жалоба — это отзыв согласия, её нельзя игнорировать |
| Данные в ЕС или РБ | Взаимодействует с LEGAL-003, решает владелец |
| Логи доставки и их срок хранения | Часть периметра персональных данных |

Отдельно: провайдер должен позволять **отключить трекинг открытий и кликов**.
Пиксель отслеживания в письме — это сбор данных о поведении, которого продукт
не декларировал. Включённый по умолчанию трекинг — типичное поведение почтовых
сервисов, и его надо выключать руками.

---

### 3. Переменные окружения

```
SMTP_URL=smtp://user:password@smtp.example.com:587
PUBLIC_BASE_URL=https://kvaterka.by
```

`SMTP_URL` — **секрет**. Он содержит пароль. Никогда не в репозиторий, не в
README, не в отчёт, не в чат, не в скриншот.

`PUBLIC_BASE_URL` секретом не является, но ошибка в нём заметнее всех: каждая
ссылка в каждом письме будет вести на `localhost`.

Обратите внимание, что планировщик читает **`BASE_URL`**, а не
`PUBLIC_BASE_URL` — см. `.env.example`. Это разные вещи, и заданной должна быть
каждая.

---

### 4. DNS

Три записи, и все три обязательны. Настраиваются один раз, до первого письма.

#### SPF

Одна запись `TXT` на корне домена. Их не может быть две — два SPF-записи
означают отсутствие SPF.

```
kvaterka.by.  TXT  "v=spf1 include:_spf.PROVIDER.example ~all"
```

`~all` (softfail) на время запуска, `-all` (hardfail) — когда убедитесь, что
письма шлёт только этот провайдер.

#### DKIM

Пару ключей выдаёт провайдер; публикуется публичная половина.

```
SELECTOR._domainkey.kvaterka.by.  TXT  "v=DKIM1; k=rsa; p=<публичный ключ>"
```

Селектор задаёт провайдер. Приватный ключ остаётся у провайдера; в репозитории
ему делать нечего.

#### DMARC

```
_dmarc.kvaterka.by.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@kvaterka.by; fo=1"
```

Начинать с `p=none`: это режим наблюдения, он ничего не блокирует и присылает
отчёты о том, кто шлёт письма от вашего имени. Через несколько недель отчётов —
`p=quarantine`, затем `p=reject`. Начинать сразу с `p=reject` означает молча
потерять почту, пока SPF и DKIM ещё не устоялись.

Адрес в `rua=` должен существовать и кем-то читаться.

#### Проверка

```bash
dig +short TXT kvaterka.by
dig +short TXT SELECTOR._domainkey.kvaterka.by
dig +short TXT _dmarc.kvaterka.by
```

Отправьте письмо на почтовый ящик, который показывает заголовки, и убедитесь,
что в `Authentication-Results` стоит `spf=pass` и `dkim=pass`. Не полагайтесь
на то, что письмо просто дошло: в собственный ящик доходит почти всё.

---

### 5. Возвраты и жалобы

Пока не реализовано; описано, чтобы не было сюрпризом.

**Жёсткий возврат** (ящика не существует) обязан приводить к тому, что адрес
помечается недоставляемым и письма на него больше не уходят. Иначе репутация
домена падает, и страдают все остальные адресаты.

**Мягкий возврат** (ящик переполнен, временный отказ) — это `TRANSIENT`.

**Жалоба на спам** — это отзыв согласия. Канал `EMAIL` для этого получателя
должен быть выключен, независимо от его настроек в профиле. Продолжать слать
после жалобы нельзя.

Технически всё это — веб-хук от провайдера. У маршрута должна быть проверка
подписи: без неё любой желающий сможет отключить чужие уведомления, отправив
поддельный «возврат».

---

### 6. Чего делать нельзя

* **Не подключайте платного провайдера без подтверждения владельца.**
* **Не отправляйте письма реальным людям с seed-данных.** В базе есть
  демонстрационные учётные записи с правдоподобными адресами. Подключённый
  провайдер и незакрытая очередь — и они получат почту.
* **Не включайте почту раньше, чем настроите DNS.** Первые письма с
  непроверенного домена — самый быстрый способ испортить репутацию домена,
  который потом придётся восстанавливать месяцами.
* **Не логируйте тело письма и `SMTP_URL`.** Поле `detail` в
  `DeliveryResult` описано как «короткое, стабильное, безопасное для
  хранения» — там не должно быть ни текста сообщения, ни учётных данных.

---

### 7. Порядок подключения, когда решение принято

1. Владелец выбирает провайдера и подтверждает расходы.
2. Настраиваются SPF, DKIM, DMARC (`p=none`). Ждём отчёты.
3. Пишется клиент под `DeliveryProvider` — три исхода, не два.
4. Тестовая отправка **только на собственные адреса**, с проверкой
   `Authentication-Results`.
5. Веб-хук возвратов и жалоб с проверкой подписи.
6. `SMTP_URL` выставляется в окружении хоста. Не в репозитории.
7. Очередь открывается на небольшом объёме, отчёт задания читается глазами.
8. DMARC переводится в `p=quarantine`, позже в `p=reject`.
