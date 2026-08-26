# Cita previa watcher — POLICÍA / Certificado de registro de ciudadano de la UE

Watches the public [icpplus](https://icp.administracionelectronica.gob.es/icpplus/index)
booking wizard for Barcelona and sends an email the moment the result page stops
saying *"En este momento no hay citas disponibles."*

It walks exactly the path a human walks:

```
provincia = Barcelona
  → oficina (every police station that offers the trámite, one after another)
  → trámite = POLICÍA - CERTIFICADO DE REGISTRO DE CIUDADANO DE LA UE
  → Aceptar
  → Presentación sin Cl@ve
  → NIE + nombre → Aceptar
  → Solicitar cita
  → read the answer
```

It **only looks**. It never books, never fills in a phone number, never submits
anything beyond the identification the wizard demands to show availability.

## Where to run it

**Not on an iPhone.** iOS gives no app a background process that may wake every
few minutes, and there is no headless browser an automation can drive. Shortcuts
can fire on a schedule but cannot carry the wizard's session through six chained
form posts. What the iPhone *can* do is receive the alert — see *Phone push* below.

Realistic hosts, in order of how well they work:

| Where | Notes |
| --- | --- |
| **Raspberry Pi at home** | Best answer. ~2 W, your own Spanish residential IP — the same IP the site already trusts from your browser. One-off ~50 €, then free. `crontab.example` + `run.sh`. |
| **Any always-on machine at home** | Old laptop with sleep disabled, Mac mini, NAS with Docker. Same IP advantage. |
| **VPS hosted in Spain** | Clouding.io (Barcelona), Stackscale, Arsys — a few euros a month. Datacenter IP, so it *may* still be blocked; test with the one-liner below before paying for a year. |
| **Your MacBook** | Works, but only while it is awake — which is the problem you are trying to solve. |
| **GitHub Actions / any US cloud** | Blocked. See below. |

Two-minute test for any candidate host, before installing anything:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://icp.administracionelectronica.gob.es/icpplus/index
```

`200` means go ahead. `000` (connection reset) or `403` means that host is blocked.

> ⚠️ **The booking host blocks datacenter IPs.** Verified from a cloud container:
> `icp.administracionelectronica.gob.es` closes the TCP connection outright and the
> mirror `sede.administracionespublicas.gob.es` answers `403 Forbidden` — for plain
> curl *and* for a real headless Chrome. GitHub Actions runners will hit the same wall.
> Run this **on your own machine in Spain** (or a Spanish VPS). That is what
> `install-macos.sh` is for.

## Setup (macOS, 5 minutes)

```bash
cd cita-checker
npm install                 # also downloads a private Chromium via Playwright
cp .env.example .env        # then edit .env
```

Fill in `.env`:

| Key | What |
| --- | --- |
| `ICP_NIE`, `ICP_NOMBRE` | your identification, exactly as on the card |
| `MAIL_TO` | where the alert goes |
| `SMTP_USER` / `SMTP_PASS` | Gmail address + a **[16-character app password](https://myaccount.google.com/apppasswords)** (not your normal password — needs 2FA enabled) |
| `NTFY_TOPIC` | optional, but the one that actually reaches your phone — see below |
| `ICP_WINDOWS` | when to look, local Madrid time |

### Phone push

Email can sit in a queue for minutes, and these slots go in seconds. Two push
channels are built in; configure either or both and they fire *before* the email:

- **ntfy** — free, no account. Install the [ntfy iOS app](https://apps.apple.com/app/ntfy/id1625396347),
  subscribe to a private topic name (treat it like a password — anyone who guesses
  it can read your alerts), set `NTFY_TOPIC` to the same string.
- **Pushover** — 5 € once, [pushover.net](https://pushover.net). Set `PUSHOVER_TOKEN`
  and `PUSHOVER_USER`. More reliable, and its `persistent` sound gets through a
  silenced phone.

Appointment alerts go out at urgent priority and tapping the notification opens
the booking page. `npm run test-notify` fires a test through every configured
channel. A channel that fails is logged and the others still go out.

Then verify each piece:

```bash
npm run test-notify         # do email and phone push arrive?
npm run offices             # which Barcelona oficinas offer the trámite? (* = yes)
node check.js --force --headed   # watch one real run in a visible browser
```

`--headed` is the important one: it shows you the actual pages, so if the site
changed a label you see it immediately.

Finally install the scheduler:

```bash
./install-macos.sh          # launchd agent, fires every 3 minutes
tail -f logs/checker.log
```

The agent runs all day but `check.js` exits within milliseconds outside
`ICP_WINDOWS`, so the site only sees traffic during 07:45–08:30 and the three
short midday/evening windows. On Linux use `crontab.example` instead, or the
`Dockerfile` on a VPS.

## What you get

A push notification and an email per oficina that looks free, subject
`CITA DISPONIBLE - <oficina>`,
containing the oficina name, the timestamp, the first 40 lines of the result
page and a full-page screenshot. `ICP_COOLDOWN_MIN` (default 45) stops the same
oficina from mailing you on every single run.

If **every** oficina errors out `ICP_ERROR_STREAK_ALERT` runs in a row (default 6),
you get a *"Cita checker is failing"* alert — so a silently broken scraper does not
look like "no appointments available".

Exit codes: `0` nothing free · `10` appointment found · `1` all oficinas errored · `2` misconfigured.

## When the site changes

It will. Every unexpected page is dumped to `debug/<timestamp>_<oficina>/` as
`page.html`, `page.txt`, `page.png` and `meta.json` (last 20 kept). That folder
is what to look at first — and what to hand over when asking for a fix.

Selectors are deliberately forgiving: dropdowns are found by their *contents*
(the select containing "Barcelona", the select containing the trámite), buttons
by a list of candidate ids **and** visible text, and trámite names are compared
with accents, punctuation and spacing stripped — so `POLICÍA-CERTIFICADO ... DE LA U.E.`
still matches `POLICIA - CERTIFICADO ... DE LA UE`.

`test/mock-icp.js` is a local stand-in for the wizard with the same element ids
and the same reload-on-oficina-change behaviour:

```bash
./test/run-mock-test.sh     # PASS = the walker still handles the whole flow
```

Use it to check changes without touching the government site.

## Configuration reference

Everything lives in `.env` (see `.env.example`). Beyond the table above:

| Key | Default | Meaning |
| --- | --- | --- |
| `ICP_OFICINAS` | *(empty)* | pin oficinas by substring instead of auto-detecting |
| `ICP_OFFICE_CACHE_HOURS` | `24` | how long the detected oficina list is reused |
| `ICP_DELAY_MS` | `4000` | pause between oficinas |
| `ICP_TIMEOUT_MS` | `30000` | per-action Playwright timeout |
| `ICP_KEEP_DEBUG` | `20` | debug folders to retain |
| `ICP_BASE_URL` | icpplus | swap in the `sede.administracionespublicas.gob.es` mirror if the main host is down |
| `ICP_CHROMIUM_PATH` | *(empty)* | use a system Chromium instead of Playwright's |

CLI flags: `--force` (ignore the time windows) · `--headed` · `--list-offices` ·
`--refresh-offices` · `--test-notify`.

## Not in this repo

`.env`, `state.json`, `debug/` and `logs/` are gitignored. **Never commit them** —
this repository is published at `ppeinsold.github.io`, so anything committed here
is world-readable.
