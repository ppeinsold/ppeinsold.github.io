#!/usr/bin/env node
'use strict';
/**
 * Cita Previa Extranjeria - availability watcher.
 *
 * Walks the public icpplus booking wizard exactly like a human does
 * (provincia -> oficina -> tramite -> "Presentacion sin Cl@ve" -> NIE + nombre
 * -> "Solicitar cita") and reports whether the last page says
 * "En este momento no hay citas disponibles." If it does not, an email goes out.
 *
 * It never books anything - it only looks.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  loadEnvFile, norm, squash, inWindows, localTime, readJson, writeJson, stamp, pruneDir,
} = require('./lib.js');

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, '.env'));

const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(`--${name}`);
const env = (key, dflt = '') => (process.env[key] === undefined || process.env[key] === '' ? dflt : process.env[key]);

const CFG = {
  base:        env('ICP_BASE_URL', 'https://icp.administracionelectronica.gob.es/icpplus'),
  provincia:   env('ICP_PROVINCIA', 'Barcelona'),
  tramite:     env('ICP_TRAMITE', 'POLICIA - CERTIFICADO DE REGISTRO DE CIUDADANO DE LA UE'),
  nie:         env('ICP_NIE'),
  nombre:      env('ICP_NOMBRE'),
  oficinas:    env('ICP_OFICINAS').split(',').map((s) => s.trim()).filter(Boolean),
  windows:     env('ICP_WINDOWS', '07:45-08:30,13:00-13:10,17:00-17:10,20:30-20:40'),
  tz:          env('ICP_TZ', 'Europe/Madrid'),
  cooldownMin: Number(env('ICP_COOLDOWN_MIN', '45')),
  officeTtlH:  Number(env('ICP_OFFICE_CACHE_HOURS', '24')),
  delayMs:     Number(env('ICP_DELAY_MS', '4000')),
  timeoutMs:   Number(env('ICP_TIMEOUT_MS', '30000')),
  errorStreak: Number(env('ICP_ERROR_STREAK_ALERT', '6')),
  keepDebug:   Number(env('ICP_KEEP_DEBUG', '20')),
  headed:      flag('headed') || env('ICP_HEADED', '0') === '1',
  userAgent:   env('ICP_USER_AGENT',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'),
  mail: {
    host: env('SMTP_HOST', 'smtp.gmail.com'),
    port: Number(env('SMTP_PORT', '465')),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM'),
    to:   env('MAIL_TO'),
  },
  push: {
    ntfyServer:    env('NTFY_SERVER', 'https://ntfy.sh'),
    ntfyTopic:     env('NTFY_TOPIC'),
    ntfyToken:     env('NTFY_TOKEN'),
    pushoverToken: env('PUSHOVER_TOKEN'),
    pushoverUser:  env('PUSHOVER_USER'),
  },
};

const STATE_FILE = path.join(ROOT, 'state.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

const ACCEPT_BUTTONS = [
  '#btnAceptar', '#btnEnviar', '#btnSubmit',
  'input[type=submit][value*="Aceptar" i]', 'input[type=button][value*="Aceptar" i]',
  'button:has-text("Aceptar")', 'a:has-text("Aceptar")',
];
const NO_SLOTS = [
  /NO HAY CITAS DISPONIBLES/, /NO EXISTEN CITAS DISPONIBLES/,
  /NO SE HAN ENCONTRADO CITAS/, /NO HAY CITAS PARA/,
];
const HARD_ERRORS = [
  /SU SESION HA CADUCADO/, /LA SESION HA EXPIRADO/, /SE HA PRODUCIDO UN ERROR/,
  /SERVICIO NO (ESTA )?DISPONIBLE/, /INTENTELO DE NUEVO MAS TARDE/,
  /ERROR EN LA APLICACION/, /ACCESO NO AUTORIZADO/,
];

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

class FlowError extends Error {
  constructor(step, message) { super(`${step}: ${message}`); this.step = step; }
}

/* ------------------------------------------------------------------ page helpers */

const bodyText = (page) => page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');

/** Every <select> on the page with its options, addressable by DOM order. */
const readSelects = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('select')).map((el, idx) => ({
    idx,
    id: el.id || '',
    name: el.name || '',
    value: el.value,
    options: Array.from(el.options).map((o) => ({ value: o.value, text: (o.textContent || '').trim() })),
  })));

/** Options that are real choices, not the "Seleccione ..." placeholder. */
const realOptions = (sel) => sel.options.filter(
  (o) => o.value !== '' && o.value !== '-1' && !/^SELECCION/.test(squash(o.text).slice(0, 10)) && squash(o.text));

/** Tell the oficina select apart from the tramite select. */
function classifySelects(selects) {
  const key = (s) => squash(`${s.id} ${s.name}`);
  let tramite = selects.find((s) => /TRAMITE/.test(key(s)))
    || selects.find((s) => s.options.some((o) => /^POLICIA/.test(squash(o.text))));
  let sede = selects.find((s) => /SEDE|OFICINA/.test(key(s)))
    || selects.find((s) => s !== tramite && realOptions(s).length > 0);
  return { sede: sede || null, tramite: tramite || null };
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: CFG.timeoutMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** Click the first candidate selector that actually exists and is visible. */
async function clickFirst(page, candidates, what) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 10000 });
        await settle(page);
        return sel;
      }
    }
  }
  throw new FlowError(what, `no clickable element among ${candidates.join(' | ')}`);
}

async function fillFirst(page, candidates, value, what) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
      await loc.fill(value);
      return sel;
    }
  }
  throw new FlowError(what, `no input among ${candidates.join(' | ')}`);
}

/* ------------------------------------------------------------------ wizard steps */

async function newSession(browser) {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    timezoneId: CFG.tz,
    userAgent: CFG.userAgent,
    viewport: { width: 1366, height: 900 },
  });
  ctx.setDefaultTimeout(CFG.timeoutMs);
  return { ctx, page: await ctx.newPage() };
}

/** Step 1: open the wizard and pick the provincia. Lands on the oficina/tramite page. */
async function selectProvincia(page) {
  await page.goto(`${CFG.base}/index`, { waitUntil: 'domcontentloaded', timeout: CFG.timeoutMs });
  await settle(page);

  const wanted = squash(CFG.provincia);
  let hit = null;
  for (const sel of await readSelects(page)) {
    const opt = sel.options.find((o) => squash(o.text) === wanted)
      || sel.options.find((o) => squash(o.text).includes(wanted));
    if (opt) { hit = { sel, opt }; break; }
  }
  if (!hit) throw new FlowError('provincia', `"${CFG.provincia}" not found in any dropdown`);

  await page.locator('select').nth(hit.sel.idx).selectOption(hit.opt.value);
  await settle(page);
  if (!classifySelects(await readSelects(page)).tramite) {
    try {
      await clickFirst(page, ACCEPT_BUTTONS, 'provincia-accept');
    } catch (err) {
      log('  provincia: no Aceptar button, relying on onchange navigation');
    }
  }

  // Fallback: some builds carry the target URL in the option value itself.
  if (!classifySelects(await readSelects(page)).sede && /^[./]|^https?:/.test(hit.opt.value)) {
    const url = new URL(hit.opt.value, `${CFG.base}/`).toString();
    log(`  provincia: falling back to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);
  }

  const { sede } = classifySelects(await readSelects(page));
  if (!sede) throw new FlowError('provincia', 'oficina dropdown never appeared');
  return sede;
}

/** Pick an oficina; the page reloads itself to repopulate the tramite list. */
async function selectOficina(page, sedeIdx, value) {
  await page.locator('select').nth(sedeIdx).selectOption(value);
  await settle(page);
  const selects = await readSelects(page);
  const { sede, tramite } = classifySelects(selects);
  if (sede && sede.value !== value) {
    // Reload dropped the selection - set it again without re-triggering the loop.
    await page.locator('select').nth(sede.idx).selectOption(value);
    await settle(page);
    return classifySelects(await readSelects(page));
  }
  return { sede, tramite };
}

/** All oficinas in the provincia together with the tramites each one offers. */
async function enumerateOffices(page) {
  const sede = await selectProvincia(page);
  const out = [];
  for (const opt of realOptions(sede)) {
    const { tramite } = await selectOficina(page, sede.idx, opt.value);
    const tramites = tramite ? realOptions(tramite).map((o) => o.text) : [];
    out.push({ value: opt.value, name: opt.text, tramites });
    log(`  ${opt.text} -> ${tramites.length} tramite(s)`);
  }
  return out;
}

const offersTramite = (office) => office.tramites.some((t) => squash(t).includes(squash(CFG.tramite)));

/** Steps 2-6 for one oficina. Returns 'NO_SLOTS' | 'AVAILABLE'. */
async function checkOffice(browser, office) {
  const { ctx, page } = await newSession(browser);
  try {
    const sede = await selectProvincia(page);
    const opt = realOptions(sede).find((o) => office.value && o.value === office.value)
      || realOptions(sede).find((o) => squash(o.text) === squash(office.name))
      || realOptions(sede).find((o) => squash(o.text).includes(squash(office.name)));
    if (!opt) throw new FlowError('oficina', `"${office.name}" is gone from the dropdown`);

    const { tramite } = await selectOficina(page, sede.idx, opt.value);
    if (!tramite) throw new FlowError('tramite', 'tramite dropdown missing');
    const wanted = realOptions(tramite).find((o) => squash(o.text).includes(squash(CFG.tramite)));
    if (!wanted) return { verdict: 'NO_TRAMITE', page, ctx };

    await page.locator('select').nth(tramite.idx).selectOption(wanted.value);
    await settle(page);
    await clickFirst(page, ACCEPT_BUTTONS, 'tramite-accept');

    // "Presentacion sin Cl@ve" - only present when the tramite also allows Cl@ve login.
    const sinClave = [
      '#btnEntrar',
      'input[value*="sin Cl" i]', 'button:has-text("sin Cl")', 'a:has-text("sin Cl")',
      'input[value="Entrar" i]', 'button:has-text("Entrar")',
    ];
    try {
      await clickFirst(page, sinClave, 'sin-clave');
    } catch {
      log('  no "sin Cl@ve" button on this page, continuing');
    }

    await fillIdentity(page);
    await clickFirst(page, ACCEPT_BUTTONS, 'identity-accept');
    await clickSolicitarCita(page);

    const text = norm(await bodyText(page));
    if (NO_SLOTS.some((re) => re.test(text))) return { verdict: 'NO_SLOTS', page, ctx };
    const hard = HARD_ERRORS.find((re) => re.test(text));
    if (hard) throw new FlowError('resultado', `site error page (${hard})`);
    return { verdict: 'AVAILABLE', page, ctx };
  } catch (err) {
    return { verdict: 'ERROR', error: err, page, ctx };
  }
}

async function fillIdentity(page) {
  // Some variants ask for the document type first.
  for (const sel of ['#rdbTipoDocNie', 'input[type=radio][value="N"]', 'input[type=radio][id*="Nie" i]']) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
      await loc.check().catch(() => {});
      await settle(page);
      break;
    }
  }
  await fillFirst(page, ['#txtIdCitado', 'input[name="txtIdCitado"]', 'input[id*="Citado" i][id*="Id" i]'],
    CFG.nie, 'identity-nie');
  await fillFirst(page, ['#txtDesCitado', 'input[name="txtDesCitado"]', 'input[id*="Des" i][id*="Citado" i]'],
    CFG.nombre, 'identity-nombre');
}

/** Walk from the identity form to the availability page (there can be a confirmation step). */
async function clickSolicitarCita(page) {
  const solicitar = [
    'input[value*="Solicitar" i]', 'button:has-text("Solicitar")', 'a:has-text("Solicitar")', '#btnEnviar',
  ];
  for (let hop = 0; hop < 4; hop += 1) {
    const text = norm(await bodyText(page));
    const hard = HARD_ERRORS.find((re) => re.test(text));
    if (hard) throw new FlowError('solicitar-cita', `site error page (${hard})`);
    if (NO_SLOTS.some((re) => re.test(text))) return;              // answered early
    try {
      const used = await clickFirst(page, solicitar, 'solicitar-cita');
      if (/Solicitar/i.test(used)) return;                          // the real button, we are on the answer page
    } catch (err) {
      const stuck = await page.locator('#txtIdCitado, input[name="txtIdCitado"]').count().catch(() => 0);
      if (hop === 0 && stuck) throw err;
      return;
    }
  }
  throw new FlowError('solicitar-cita', 'never reached the availability page');
}

/* ------------------------------------------------------------------ notification */

async function sendMail({ subject, text, attachments = [] }) {
  const { host, port, user, pass, from, to } = CFG.mail;
  if (!user || !pass || !to) return false;
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transport.sendMail({ from: from || user, to, subject, text, attachments });
  log(`>> email sent to ${to}`);
  return true;
}

/** ntfy.sh push - free, no account, works with the ntfy iOS app. */
async function sendNtfy({ subject, text, url, urgent }) {
  const { ntfyServer, ntfyTopic, ntfyToken } = CFG.push;
  if (!ntfyTopic) return false;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: subject,
    Priority: urgent ? 'urgent' : 'default',
    Tags: urgent ? 'rotating_light' : 'warning',
  };
  if (url) headers.Click = url;
  if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;
  const res = await fetch(`${ntfyServer.replace(/\/$/, '')}/${ntfyTopic}`, { method: 'POST', headers, body: text });
  if (!res.ok) throw new Error(`ntfy ${res.status} ${await res.text()}`);
  log('>> ntfy push sent');
  return true;
}

/** Pushover - paid once, but delivers reliably and can bypass the iPhone silent switch. */
async function sendPushover({ subject, text, url, urgent }) {
  const { pushoverToken, pushoverUser } = CFG.push;
  if (!pushoverToken || !pushoverUser) return false;
  const body = new URLSearchParams({
    token: pushoverToken, user: pushoverUser, title: subject, message: text,
    priority: urgent ? '1' : '0', sound: urgent ? 'persistent' : 'pushover',
  });
  if (url) { body.set('url', url); body.set('url_title', 'Open cita previa'); }
  const res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body });
  if (!res.ok) throw new Error(`pushover ${res.status} ${await res.text()}`);
  log('>> pushover push sent');
  return true;
}

/**
 * Fan out to every configured channel. Push first - it is what actually wakes
 * a phone at 07:46 - and never let one dead channel swallow the others.
 */
async function notify(msg) {
  const channels = [['pushover', sendPushover], ['ntfy', sendNtfy], ['email', sendMail]];
  let delivered = 0;
  for (const [name, send] of channels) {
    try {
      if (await send(msg)) delivered += 1;
    } catch (err) {
      log(`!! ${name} notification failed: ${err.message}`);
    }
  }
  if (!delivered) {
    log('!! no notification channel configured or all failed - printing instead');
    log(`   ${msg.subject}\n${msg.text}`);
  }
  return delivered;
}

async function saveDebug(page, tag) {
  const dir = path.join(DEBUG_DIR, `${stamp()}_${squash(tag).slice(0, 40) || 'page'}`);
  fs.mkdirSync(dir, { recursive: true });
  const shot = path.join(dir, 'page.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  await fs.promises.writeFile(path.join(dir, 'page.html'), await page.content().catch(() => ''), 'utf8');
  await fs.promises.writeFile(path.join(dir, 'page.txt'), await bodyText(page), 'utf8');
  await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ url: page.url(), tag }, null, 2));
  pruneDir(DEBUG_DIR, CFG.keepDebug);
  return { dir, shot: fs.existsSync(shot) ? shot : null };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const state = readJson(STATE_FILE, { notified: {}, errorStreak: 0, offices: null, officesAt: 0 });

  if (flag('test-email') || flag('test-notify')) {
    const n = await notify({
      subject: 'Cita checker: test',
      text: 'If you can read this, the notification channel works.',
      url: `${CFG.base}/index`,
    });
    log(`${n} channel(s) delivered`);
    return 0;
  }
  for (const [key, val] of Object.entries({ ICP_NIE: CFG.nie, ICP_NOMBRE: CFG.nombre })) {
    if (!val) { console.error(`Missing ${key} - copy .env.example to .env and fill it in.`); return 2; }
  }
  if (!flag('force') && !flag('list-offices') && !inWindows(CFG.windows, CFG.tz)) {
    log(`outside active windows (${CFG.windows}, now ${localTime(CFG.tz)} ${CFG.tz}) - nothing to do`);
    return 0;
  }

  const browser = await chromium.launch({
    headless: !CFG.headed,
    executablePath: env('ICP_CHROMIUM_PATH') || undefined,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  let exitCode = 0;
  try {
    // --- which oficinas offer the tramite? cached, they change rarely.
    let offices;
    const cacheAge = (Date.now() - (state.officesAt || 0)) / 3600000;
    if (CFG.oficinas.length) {
      offices = CFG.oficinas.map((name) => ({ value: null, name, tramites: [CFG.tramite] }));
      log(`using ${offices.length} pinned oficina(s) from ICP_OFICINAS`);
    } else if (state.offices && cacheAge < CFG.officeTtlH && !flag('refresh-offices') && !flag('list-offices')) {
      offices = state.offices;
      log(`using ${offices.length} cached oficina(s) (${cacheAge.toFixed(1)}h old)`);
    } else {
      log(`enumerating oficinas in ${CFG.provincia} ...`);
      const { ctx, page } = await newSession(browser);
      const all = await enumerateOffices(page);
      await ctx.close();
      offices = all.filter(offersTramite);
      state.offices = offices;
      state.officesAt = Date.now();
      writeJson(STATE_FILE, state);
      log(`${all.length} oficina(s), ${offices.length} offer "${CFG.tramite}"`);
      if (flag('list-offices')) {
        for (const o of all) console.log(`${offersTramite(o) ? '*' : ' '} ${o.name}`);
        console.log('\n(* = offers the tramite)');
        return 0;
      }
    }
    if (!offices.length) throw new Error(`no oficina in ${CFG.provincia} offers "${CFG.tramite}"`);

    // --- run the full wizard per oficina until one has slots.
    const problems = [];
    for (const [i, office] of offices.entries()) {
      if (i) await new Promise((r) => setTimeout(r, CFG.delayMs));
      log(`checking: ${office.name}`);
      const { verdict, error, page, ctx } = await checkOffice(browser, office);
      try {
        if (verdict === 'NO_SLOTS') {
          log('  no citas disponibles');
        } else if (verdict === 'NO_TRAMITE') {
          log('  tramite not offered here any more');
        } else if (verdict === 'AVAILABLE') {
          log(`  *** POSSIBLE APPOINTMENT at ${office.name}`);
          exitCode = 10;
          const last = state.notified[office.name] || 0;
          if (Date.now() - last < CFG.cooldownMin * 60000) {
            log(`  (already emailed < ${CFG.cooldownMin} min ago, staying quiet)`);
          } else {
            const { dir, shot } = await saveDebug(page, office.name);
            const excerpt = (await bodyText(page)).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40).join('\n');
            await notify({
              urgent: true,
              url: `${CFG.base}/index`,
              subject: `CITA DISPONIBLE - ${office.name}`,
              text: [
                `Oficina:   ${office.name}`,
                `Tramite:   ${CFG.tramite}`,
                `Provincia: ${CFG.provincia}`,
                `Hora:      ${new Date().toLocaleString('es-ES', { timeZone: CFG.tz })} (${CFG.tz})`,
                '',
                'The result page did NOT say "no hay citas disponibles".',
                `Book it now: ${CFG.base}/index`,
                '',
                '--- page text ---',
                excerpt,
                '',
                `(debug copy: ${dir})`,
              ].join('\n'),
              attachments: shot ? [{ filename: 'cita.png', path: shot }] : [],
            });
            state.notified[office.name] = Date.now();
            writeJson(STATE_FILE, state);
          }
        } else {
          problems.push(`${office.name}: ${error && error.message}`);
          log(`  !! ${error && error.message}`);
          await saveDebug(page, `error_${office.name}`);
        }
      } finally {
        await ctx.close();
      }
    }

    // --- tell me if the checker itself has been broken for a while.
    if (problems.length === offices.length) {
      state.errorStreak = (state.errorStreak || 0) + 1;
      exitCode = exitCode || 1;
      if (state.errorStreak === CFG.errorStreak) {
        await notify({
          subject: 'Cita checker is failing',
          text: `${state.errorStreak} runs in a row failed for every oficina:\n\n${problems.join('\n')}\n\nSee ${DEBUG_DIR}.`,
        });
      }
    } else {
      state.errorStreak = 0;
    }
    writeJson(STATE_FILE, state);
  } finally {
    await browser.close();
  }
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
