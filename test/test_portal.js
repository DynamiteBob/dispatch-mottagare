// Inställningssidan från det vanliga nätet: bara läget, inga formulär, POST stoppas. Namn från nätet skrivs som text.
'use strict';
process.env.MOTTAGARE_PORTAL_PORT = '8192';
delete process.env.MOTTAGARE_PORTAL_OPEN;
const { createPortal } = require('../src/portal');
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x))); if (!ok) fails++; };
let urlSet = null;
const net = { touch() {}, info: () => ({ eth: false, hotspot: false, wifi: { connected: true, ssid: '<script>x</script>', signal: 50 }, ssid: 'Dispatch-mottagare-AB12', networks: [], message: null }),
              savedNetworks: async () => [], saveWifi() { return true; } };
const dispatch = { info: () => ({ url: 'https://dispatch.exempel.se', state: 'pending', pair_code: 'K7F-29Q', last_error: null }), setUrl(u) { urlSet = u; } };
const sdr = { status: () => ({ state: 'running', freq_hz: 69718750 }) };
const srv = createPortal({ version: '0.1.0', hwId: 'abc', net, dispatch, sdr, stateGet: () => ({ name: 'Ljusdal' }) });
setTimeout(async () => {
    try {
        const r = await fetch('http://127.0.0.1:8192/');
        const html = await r.text();
        check('sidan svarar från det vanliga nätet', r.status === 200);
        check('koden och läget visas', html.includes('K7F-29Q') && html.includes('Lyssnar') && html.includes('69.71875 MHz'));
        check('inga formulär', !html.includes('<form'));
        check('hänvisar till Dispatch och det egna wifi:t', html.includes('Adminportalen → Mottagare') && html.includes('Dispatch-mottagare-AB12'));
        check('nätets namn skrivs som text', html.includes('&lt;script&gt;') && !html.includes('<script>'));
        check('sidan har CSP utan skript', /default-src 'none'/.test(r.headers.get('content-security-policy') || ''));
        const p = await fetch('http://127.0.0.1:8192/dispatch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'url=https://ond.example' });
        check('POST från det vanliga nätet stoppas', p.status === 404 && urlSet === null);
        const j = await (await fetch('http://127.0.0.1:8192/status.json')).json();
        check('status.json har läget men inte lösenordet', j.dispatch.pair_code === 'K7F-29Q' && !JSON.stringify(j).includes('psk'), j);
    } catch (e) { check('inget undantag', false, e.message); }
    srv.close();
    console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
    process.exit(fails ? 1 : 0);
}, 300);
