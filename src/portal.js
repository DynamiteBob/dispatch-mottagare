// ============================================================================
// Inställningssidan (http, port 80)
//
// På mottagarens eget wifi (anropet kommer till 10.42.0.1) går det att välja wifi-nät och ange Dispatch-adressen.
// Alla andra adresser och namn skickas dit, så att telefonen öppnar sidan av sig själv (captive portal).
// Från det vanliga nätet (nätkabel eller wifi) visar sidan bara läget: inställningarna görs i Dispatch eller på hotspoten.
// Sidan har inga skript (fungerar i telefonernas inloggningsfönster) och laddar om sig själv medan något pågår.
// MOTTAGARE_PORTAL_PORT byter porten och MOTTAGARE_PORTAL_OPEN=1 visar formulären oavsett adress (testerna).
// ============================================================================
'use strict';

const http = require('http');
const { HOTSPOT_IP } = require('./net');
const { normalizeUrl } = require('./dispatch');
const log = require('./log')('SIDA');

const PORT = parseInt(process.env.MOTTAGARE_PORTAL_PORT, 10) || 80;
const OPEN = process.env.MOTTAGARE_PORTAL_OPEN === '1';

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SDR_TEXT = {
    no_freq: 'Ingen frekvens är inställd. Den ställs in i Dispatch.',
    no_device: 'Ingen RTL-SDR-sticka hittades.',
    starting: 'Startar mottagningen …',
    running: 'Lyssnar',
    error: 'Fel i mottagningen',
    scanning: 'Mäter förstärkningen …',
    off: 'Källan är serieporten (J3) på en Aurora; stickan används inte.'
};
const CSS = `body{font:16px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;margin:0;background:#0f1419;color:#e6e8eb}
main{max-width:34rem;margin:0 auto;padding:1rem}h1{font-size:1.3rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:0 0 .6rem}
section{background:#1a2027;border:1px solid #2c343d;border-radius:12px;padding:1rem;margin:0 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem .8rem;margin:0}dt{color:#9aa4ae}dd{margin:0}
label{display:block;margin:.6rem 0 .25rem;color:#9aa4ae;font-size:.9rem}
input,select{width:100%;box-sizing:border-box;font:inherit;padding:.65rem .7rem;border-radius:8px;border:1px solid #3a444f;background:#0f1419;color:inherit}
button{font:inherit;padding:.7rem 1rem;border-radius:8px;border:0;background:#2f6feb;color:#fff;margin-top:.8rem;min-height:44px}
button.sec{background:#2c343d}button.del{background:transparent;color:#ff7b72;border:1px solid #5a3333;margin:0;padding:.35rem .7rem;min-height:36px}
.code{font:600 1.6rem ui-monospace,Menlo,monospace;letter-spacing:.08em}.ok{color:#56d364}.bad{color:#ff7b72}.wait{color:#e3b341}.hint{color:#9aa4ae;font-size:.88rem}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid #2c343d}`;

function createPortal({ version, hwId, net, dispatch, sdr, stateGet }) {
    function setupAllowed(req) {
        if (OPEN) return true;
        const a = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
        return a === HOTSPOT_IP;
    }
    function page(req, flash, n) {
        const setup = setupAllowed(req);
        const d = dispatch.info();
        const sd = sdr.status();
        const s = stateGet();
        const name = s.name || d.name || 'Mottagare';
        let disp;
        if (!d.url) disp = '<span class="wait">Ingen Dispatch-adress är angiven.</span>';
        else if (!d.state) disp = `<span class="wait">Anmäler sig till ${esc(d.url)} …</span>`;
        else if (d.state === 'pending') disp = `<span class="wait">Väntar på godkännande.</span><div class="code">${esc(d.pair_code)}</div>
            <p class="hint">Godkänn mottagaren i Dispatch: Adminportalen → Mottagare. Kontrollera att koden är densamma.</p>`;
        else disp = `<span class="ok">Godkänd i Dispatch.</span>`;
        if (d.last_error) disp += `<div class="bad">${esc(d.last_error)}</div>`;
        let netText;
        if (n.eth) netText = '<span class="ok">Nätkabel</span>';
        else if (n.wifi && n.wifi.connected) netText = `<span class="ok">Wifi ${esc(n.wifi.ssid || n.wifi.connection || '')}</span>${n.wifi.signal ? ` (${n.wifi.signal} %)` : ''}`;
        else if (n.hotspot) netText = `<span class="wait">Eget wifi ${esc(n.ssid)}</span> (ingen anslutning till internet)`;
        else netText = '<span class="bad">Ingen anslutning</span>';
        const sdrText = `${esc(SDR_TEXT[sd.state] || sd.state)}${sd.state === 'running' && sd.freq_hz ? ` på ${(sd.freq_hz / 1e6).toFixed(5)} MHz` : ''}${sd.error && sd.state !== 'running' ? `<div class="bad">${esc(sd.error)}</div>` : ''}`;
        const busy = n.busy || (n.message && n.message.ok === null) || d.state === 'pending' || (d.url && !d.state);
        let body = `<h1>Dispatch-mottagare: ${esc(name)}</h1>`;
        if (flash) body += `<section><span class="${flash.ok ? 'ok' : 'bad'}">${esc(flash.text)}</span></section>`;
        body += `<section><h2>Läge</h2><dl>
            <dt>Dispatch</dt><dd>${disp}</dd>
            <dt>Nät</dt><dd>${netText}</dd>
            <dt>Mottagning</dt><dd>${sdrText}</dd>
            <dt>Version</dt><dd>${esc(version)}</dd>
            <dt>Serienummer</dt><dd>${esc(hwId)}</dd></dl></section>`;
        if (!setup) {
            body += `<section><p class="hint">Inställningarna ändras i Dispatch (Adminportalen → Mottagare). Wifi och Dispatch-adress ändras på mottagarens eget wifi
                ${esc(n.ssid)}, som startar när mottagaren inte har någon anslutning.</p></section>`;
            return html(body, busy ? 10 : 0);
        }
        // Wifi
        const msg = n.message ? `<p class="${n.message.ok === null ? 'wait' : n.message.ok ? 'ok' : 'bad'}">${esc(n.message.text)}</p>` : '';
        const opts = n.networks.map(w => `<option value="${esc(w.ssid)}">${esc(w.ssid)} (${w.signal} %${w.secure ? '' : ', öppet'})</option>`).join('');
        body += `<section><h2>Wifi</h2>${msg}
            <form method="post" action="/wifi">
              <label for="ssid">Nät</label>
              <select id="ssid" name="ssid">${opts}<option value="">Annat nät (skriv namnet nedan)</option></select>
              <label for="ssid2">Nätets namn (om det inte finns i listan)</label>
              <input id="ssid2" name="ssid_manual" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="32">
              <label for="psk">Lösenord</label>
              <input id="psk" name="psk" type="password" autocomplete="off" maxlength="63">
              <button type="submit">Spara och anslut</button>
            </form>
            <p class="hint">Mottagaren lämnar sitt eget wifi när den ansluter, och telefonen tappar då kontakten med den här sidan.
              Misslyckas anslutningen startar mottagarens wifi igen inom en minut.</p>
            <form method="post" action="/sok"><button class="sec" type="submit">Sök efter nät igen</button></form>
            ${savedHtml(n)}</section>`;
        body += `<section><h2>Dispatch</h2>
            <form method="post" action="/dispatch">
              <label for="url">Dispatch-adress</label>
              <input id="url" name="url" value="${esc(d.url)}" placeholder="https://dispatch.exempel.se" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="url">
              <button type="submit">Spara</button>
            </form>
            <p class="hint">Byts adressen anmäler sig mottagaren på nytt och måste godkännas igen.</p></section>`;
        return html(body, busy ? 5 : 0);
    }
    function savedHtml(n) {
        if (!n.savedList || !n.savedList.length) return '';
        return `<h2 style="margin-top:1rem">Sparade nät</h2><ul>${n.savedList.map(s => `<li><span>${esc(s.ssid)}</span>
            <form method="post" action="/wifi/ta-bort"><input type="hidden" name="name" value="${esc(s.name)}"><button class="del" type="submit">Ta bort</button></form></li>`).join('')}</ul>`;
    }
    function html(body, refresh) {
        return `<!DOCTYPE html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            ${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>Dispatch-mottagare</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
    }
    function readForm(req) {
        return new Promise((resolve) => {
            let b = '';
            req.on('data', c => { b += c; if (b.length > 8192) req.destroy(); });
            req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
            req.on('error', () => resolve({}));
        });
    }
    const send = (res, code, text, headers) => { res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", 'X-Frame-Options': 'DENY' }, headers || {})); res.end(text); };
    const redirect = (res, to) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
    let flash = null;   // ett besked efter ett formulär (visas en gång)

    const server = http.createServer(async (req, res) => {
        try {
            const setup = setupAllowed(req);
            if (setup) net.touch();
            const host = String(req.headers.host || '').replace(/:\d+$/, '');
            const u = new URL(req.url, 'http://x');
            // Captive portal: andra namn och adresser på hotspoten skickas till sidan
            if (setup && !OPEN && host && host !== HOTSPOT_IP) return redirect(res, `http://${HOTSPOT_IP}/`);
            if (req.method === 'GET' && u.pathname === '/') {
                const n = net.info();
                if (setup) { try { n.savedList = await net.savedNetworks(); } catch (e) { n.savedList = []; } }
                const f = flash; flash = null;
                return send(res, 200, page(req, f, n));
            }
            if (req.method === 'GET' && u.pathname === '/status.json') {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                const d = dispatch.info();
                return res.end(JSON.stringify({ version, dispatch: { url: d.url, state: d.state, pair_code: d.pair_code, last_error: d.last_error }, sdr: sdr.status(),
                    net: (({ eth, hotspot, wifi, ssid }) => ({ eth, hotspot, wifi, ssid }))(net.info()) }));
            }
            if (req.method === 'POST' && setup) {
                const f = await readForm(req);
                if (u.pathname === '/wifi') {
                    const ssid = String(f.ssid_manual || '').trim() || String(f.ssid || '').trim();
                    const psk = String(f.psk || '');
                    if (!ssid || ssid.length > 32) flash = { ok: false, text: 'Välj ett nät eller skriv nätets namn.' };
                    else if (psk && (psk.length < 8 || psk.length > 63)) flash = { ok: false, text: 'Lösenordet ska vara 8–63 tecken.' };
                    else if (!net.saveWifi(ssid, psk)) flash = { ok: false, text: 'Vänta, mottagaren håller på med nätet.' };
                    return redirect(res, '/');
                }
                if (u.pathname === '/wifi/ta-bort') {
                    const ok = await net.removeWifi(String(f.name || ''));
                    flash = ok ? { ok: true, text: 'Nätet är borttaget.' } : { ok: false, text: 'Nätet kunde inte tas bort.' };
                    return redirect(res, '/');
                }
                if (u.pathname === '/sok') {
                    try { const l = await net.rescan(); flash = { ok: true, text: `${l.length} nät hittades.` }; }
                    catch (e) { flash = { ok: false, text: 'Sökningen misslyckades.' }; }
                    return redirect(res, '/');
                }
                if (u.pathname === '/dispatch') {
                    const url = normalizeUrl(f.url);
                    if (url === null || url === '') flash = { ok: false, text: 'Adressen är inte giltig. Skriv till exempel https://dispatch.exempel.se' };
                    else { dispatch.setUrl(url); flash = { ok: true, text: `Dispatch-adressen är sparad. Mottagaren anmäler sig till ${url}.` }; log(`ny Dispatch-adress ${url}`); }
                    return redirect(res, '/');
                }
            }
            if (setup && !OPEN) return redirect(res, `http://${HOTSPOT_IP}/`);
            send(res, 404, html('<p>Sidan finns inte. <a href="/">Till mottagaren</a></p>', 0));
        } catch (e) {
            log('fel:', e.message);
            if (!res.headersSent) send(res, 500, html('<p>Något gick fel.</p>', 0));
        }
    });
    function listen() {
        server.once('error', (e) => { log(`port ${PORT} kunde inte öppnas (${e.code}), försöker igen om 30 s`); setTimeout(listen, 30000).unref(); });
        server.listen(PORT, () => log(`inställningssidan på port ${PORT}`));
    }
    listen();
    return server;
}

module.exports = { createPortal };
