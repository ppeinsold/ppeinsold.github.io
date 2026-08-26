'use strict';
/**
 * Stand-in for the icpplus wizard, modelled on the real page structure
 * (same element ids, same "changing the oficina reloads the page" behaviour).
 *
 * It lets us regression-test check.js without touching the government site:
 *   node test/mock-icp.js 8099 &
 *   ICP_BASE_URL=http://127.0.0.1:8099/icpplus node check.js --force
 *
 * Oficina A and C offer the tramite; C is the one with a free appointment.
 */
const http = require('http');

const CERT = 'POLICÍA-CERTIFICADO DE REGISTRO DE CIUDADANO DE LA U.E.';
const OFFICES = {
  A: { label: 'CNP MALLORCA-GRANADOS, MALLORCA, 213', tramites: [CERT, 'POLICÍA-AUTORIZACIÓN DE REGRESO'], free: false },
  B: { label: 'CNP RAMBLA GUIPUSCOA, RAMBLA GUIPUSCOA 74', tramites: ['POLICÍA-TOMA DE HUELLAS'], free: false },
  C: { label: 'CNP BALMES, BALMES 192', tramites: [CERT], free: true },
};

const page = (title, body) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

const options = (items, selected) => items
  .map(({ value, text }) => `<option value="${value}"${value === selected ? ' selected' : ''}>${text}</option>`)
  .join('');

function indexPage() {
  return page('Sede electrónica - Cita previa', `
<form action="/icpplus/acInfo" method="post">
  <label for="form">Seleccione la provincia</label>
  <select id="form" name="form">
    ${options([{ value: '', text: 'Seleccione provincia' }, { value: '5', text: 'Álava' },
      { value: '8', text: 'Barcelona' }, { value: '28', text: 'Madrid' }])}
  </select>
  <input type="submit" id="btnAceptar" value="Aceptar">
</form>`);
}

function acInfoPage(sede) {
  const tramites = sede && OFFICES[sede] ? OFFICES[sede].tramites : [];
  return page('Barcelona - Selección de oficina y trámite', `
<form action="/icpplus/acInfo" method="post">
  <input type="hidden" name="form" value="8">
  <label for="sede">Seleccione la oficina</label>
  <select id="sede" name="sede" onchange="this.form.submit()">
    ${options([{ value: '', text: 'Seleccione oficina' },
      ...Object.entries(OFFICES).map(([value, o]) => ({ value, text: o.label }))], sede)}
  </select>
  <label for="tramiteGrupo[1]">Seleccione trámites disponibles</label>
  <select id="tramiteGrupo[1]" name="tramiteGrupo[1]">
    ${options([{ value: '', text: 'Seleccione trámites disponibles' },
      ...tramites.map((t, i) => ({ value: String(i), text: t }))])}
  </select>
  <input type="submit" id="btnAceptar" value="Aceptar">
</form>`);
}

const acEntradaPage = (sede) => page('Presentación de solicitud', `
<form action="/icpplus/acEntrada" method="post">
  <input type="hidden" name="sede" value="${sede}">
  <fieldset><legend>Acceso con Cl@ve</legend><input type="submit" id="btnClave" value="Acceder con Cl@ve"></fieldset>
  <fieldset><legend>Presentación sin Cl@ve</legend><input type="submit" id="btnEntrar" value="Entrar"></fieldset>
</form>`);

const identityPage = (sede) => page('Identificación', `
<form action="/icpplus/acValidarEntrada" method="post">
  <input type="hidden" name="sede" value="${sede}">
  <input type="radio" id="rdbTipoDocNie" name="rdbTipoDoc" value="N" checked><label for="rdbTipoDocNie">N.I.E.</label>
  <label for="txtIdCitado">N.I.E.</label><input type="text" id="txtIdCitado" name="txtIdCitado" maxlength="9">
  <label for="txtDesCitado">Nombre y apellidos</label><input type="text" id="txtDesCitado" name="txtDesCitado">
  <input type="submit" id="btnEnviar" value="Aceptar">
</form>`);

const confirmPage = (sede, nie, nombre) => page('Solicitud de cita', `
<p>N.I.E.: ${nie} &nbsp; Nombre: ${nombre}</p>
<p>Oficina: ${OFFICES[sede].label}</p>
<form action="/icpplus/acCitar" method="post">
  <input type="hidden" name="sede" value="${sede}">
  <input type="submit" id="btnEnviar" value="Solicitar Cita">
</form>`);

const resultPage = (sede) => (OFFICES[sede].free
  ? page('Citas disponibles', `<p>Seleccione una de las citas disponibles:</p>
<form><label><input type="radio" name="hueco" value="1"> Lunes 01/09/2026 09:20</label>
<label><input type="radio" name="hueco" value="2"> Lunes 01/09/2026 09:40</label>
<input type="submit" id="btnSiguiente" value="Siguiente"></form>`)
  : page('Citas', '<p>En este momento no hay citas disponibles.</p>'));

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw));
    const url = new URL(req.url, 'http://localhost');
    const sede = body.sede || '';
    let html;
    switch (url.pathname) {
      case '/icpplus/index': html = indexPage(); break;
      case '/icpplus/acInfo': html = body['tramiteGrupo[1]'] ? acEntradaPage(sede) : acInfoPage(sede); break;
      case '/icpplus/acEntrada': html = identityPage(sede); break;
      case '/icpplus/acValidarEntrada':
        html = confirmPage(sede, body.txtIdCitado || '?', body.txtDesCitado || '?'); break;
      case '/icpplus/acCitar': html = resultPage(sede); break;
      default: res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

server.listen(Number(process.argv[2] || 8099), '127.0.0.1', () => {
  console.log(`mock icpplus on http://127.0.0.1:${server.address().port}/icpplus/index`);
});
