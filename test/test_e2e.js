// ============================================================================
// Hela kedjan mot den riktiga Dispatch-testservern (repot dispatch bredvid, eller DISPATCH_DIR):
// falsk nmcli, falsk rtl_sdr och falsk rtl_fm, mottagaren körs som i Pi:n (src/main.js) men utan sudo och på en annan port.
//  1. inget nät efter start: hotspoten startar; fel lösenord: hotspoten tillbaka; rätt lösenord: ansluten
//  2. Dispatch-adressen på inställningssidan → anmälan med kod → godkänns i Dispatch
//  3. frekvens i Dispatch → rtl_sdr startar inom en sekund (0.4.0, Signalstyrka), inspelningar kommer fram och går att ladda ner
//     (0.2.0) FFSK-skuren (Aurora, påhittade värden) avkodas och syns som Radio 90 i Dispatch; inspelning och avkodning av;
//     (0.3.0) avkodning med squelchen stängd; (0.4.0) signalstyrkan i dBm i Dispatch, livssignalens brusgolv
//  4. förstärkning ändras → rtl_sdr startas om med -g; squelch ändras → startas inte om; (0.4.0) Ställ in förstärkning
//     automatiskt (resultatet i Dispatch), Endast ljud → rtl_fm, tillbaka till Signalstyrka;
//     (0.4.1) källan Serieport: en $PNIGPS-rad från J3 (FIFO som port) syns som Radio 90 med mottagaren (J3)
//  5. Starta om programmet (avslutas, startas igen med samma nyckel), Uppdatera (resultatet kommer tillbaka)
//  6. mottagaren tystnar → Tyst i Dispatch och i aktivitetsloggen, tillbaka → kontakt igen
//  7. borttagen i Dispatch → anmäler sig igen med en ny kod
//   node test/test_e2e.js
// ============================================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readWav } = require('../src/wav');

const DISPATCH = process.env.DISPATCH_DIR || path.join(__dirname, '..', '..', 'dispatch');
if (!fs.existsSync(path.join(DISPATCH, 'test', 'testserver.js'))) { console.log('HOPPAR ÖVER: Dispatch-repot saknas (DISPATCH_DIR)'); process.exit(0); }
const T = require(path.join(DISPATCH, 'test', 'testserver.js'));

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 600))); if (!ok) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + (ms || 10000); for (;;) { let v; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(step || 150); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mottagare-e2e-'));
const STATE = path.join(tmp, 'state'), RUN = path.join(tmp, 'run'), NM = path.join(tmp, 'nm');
fs.mkdirSync(NM);
fs.writeFileSync(path.join(NM, 'state.json'), JSON.stringify({ mode: 'none', saved: {} }));
const RTL_LOG = path.join(tmp, 'rtl.log'), SDR_LOG = path.join(tmp, 'sdr.log');
const PORTAL = 8191;
const F = path.join(__dirname, 'falska');
const SDEV = path.join(tmp, 'dev');
fs.mkdirSync(SDEV);
const rtlArgs = () => { try { return fs.readFileSync(RTL_LOG, 'utf8').trim().split('\n'); } catch (e) { return []; } };
const sdrArgs = () => { try { return fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n'); } catch (e) { return []; } };
const nmCalls = () => { try { return fs.readFileSync(path.join(NM, 'calls.log'), 'utf8'); } catch (e) { return ''; } };
const nmState = () => JSON.parse(fs.readFileSync(path.join(NM, 'state.json'), 'utf8'));

let proc = null, lastExit = null, out = '';
function startPi() {
    lastExit = null;
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js')], {
        env: Object.assign({}, process.env, {
            MOTTAGARE_STATE_DIR: STATE, MOTTAGARE_RUN_DIR: RUN, MOTTAGARE_PORTAL_PORT: String(PORTAL), MOTTAGARE_PORTAL_OPEN: '1',
            MOTTAGARE_SUDO: '', MOTTAGARE_NMCLI: path.join(F, 'nmcli'), MOTTAGARE_RTL_FM: path.join(F, 'rtl_fm'), MOTTAGARE_RTL_SDR: path.join(F, 'rtl_sdr'), MOTTAGARE_SERIAL_DEVDIR: SDEV, MOTTAGARE_STTY: path.join(F, 'stty'), MOTTAGARE_UPDATER: path.join(F, 'uppdatera'), MOTTAGARE_TIMEDATECTL: path.join(F, 'timedatectl'),
            MOTTAGARE_HW_ID: '10000000e2e0ab12', MOTTAGARE_HB_MS: '1000', MOTTAGARE_BOOT_MS: '1500', MOTTAGARE_NET_TICK_MS: '300', MOTTAGARE_OK_MS: '500',
            FAKE_NM_DIR: NM, FAKE_RTL_LOG: RTL_LOG, FAKE_SDR_LOG: SDR_LOG,
            MOTTAGARE_SCAN_GAINS: '0.9,30,36.4,40.2,49.6', MOTTAGARE_SCAN_SKIP_MS: '200', MOTTAGARE_SCAN_MEASURE_MS: '500'
        }), stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', (code) => { lastExit = code; });
}
const portal = (p, opts) => fetch(`http://127.0.0.1:${PORTAL}${p}`, Object.assign({ redirect: 'manual' }, opts || {}));
const pstat = async () => (await portal('/status.json')).json();
const form = (p, o) => portal(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

(async () => {
    const s = await T.start(8952, { env: { PEI_DEVICE: 'off', MOTTAGARE_POLL_MS: '3000', MOTTAGARE_SILENT_MS: '3000', MOTTAGARE_SWEEP_MS: '400' } });
    const ADM = s.tokens.admin;
    const list = async () => (await s.request('GET', '/api/admin/mottagare', undefined, ADM)).json.receivers;
    try {
        startPi();
        // 1. Nätet
        const up = await until(async () => (await portal('/')).status === 200, 8000);
        check('inställningssidan svarar', !!up, out.slice(-500));
        let html = await (await portal('/')).text();
        check('sidan säger att Dispatch-adress saknas', html.includes('Ingen Dispatch-adress'));
        const hs = await until(async () => (await pstat()).net.hotspot, 8000);
        check('inget nät efter start: hotspoten startar', !!hs && /connection up dispatch-mottagare-hotspot/.test(nmCalls()), nmCalls());
        check('hotspoten heter Dispatch-mottagare-AB12 och har WPA2', /ssid Dispatch-mottagare-AB12 .*wpa-psk/.test(nmCalls()));
        html = await (await portal('/')).text();
        check('näten runt mottagaren listas (sökta före hotspoten, : i namnet, inte det dolda)', html.includes('Hemma (80 %)') && html.includes('Grannen:5G') && html.includes('Kafe (30 %, öppet)'), html.slice(0, 0));
        let r = await form('/wifi', { ssid: 'Hemma', psk: 'fel-losenord' });
        check('Spara och anslut ger 303 till sidan', r.status === 303);
        await until(async () => /Kunde inte ansluta/.test(await (await portal('/')).text()), 8000);
        html = await (await portal('/')).text();
        check('fel lösenord: beskedet visas', html.includes('Kunde inte ansluta till Hemma'));
        check('fel lösenord: hotspoten startar igen', !!(await until(async () => (await pstat()).net.hotspot, 5000)));
        r = await form('/wifi', { ssid: '', ssid_manual: 'Hemma', psk: 'ratt-losenord' });
        const conn = await until(async () => { const n = (await pstat()).net; return n.wifi && n.wifi.connected && !n.hotspot ? n : null; }, 8000);
        check('rätt lösenord (namnet skrivet för hand): ansluten till Hemma', conn && conn.wifi.ssid === 'Hemma', conn);
        check('nätet är sparat med autoconnect', Object.values(nmState().saved).some(c => c.ssid === 'Hemma' && c.psk === 'ratt-losenord'));
        r = await form('/wifi', { ssid: 'Hemma', psk: 'kort' });
        html = await (await portal('/')).text();
        check('för kort lösenord avvisas', html.includes('8–63 tecken'));

        // 2. Dispatch
        r = await form('/dispatch', { url: 'inte en adress med mellanslag' });
        html = await (await portal('/')).text();
        check('ogiltig adress avvisas', html.includes('inte giltig'));
        r = await form('/dispatch', { url: s.base });
        const pend = await until(async () => { const j = await pstat(); return j.dispatch.state === 'pending' && j.dispatch.pair_code ? j : null; }, 8000);
        check('mottagaren anmäler sig och visar en kod', !!pend, out.slice(-800));
        const code = pend && pend.dispatch.pair_code;
        let L = await list();
        check('Dispatch visar den väntande mottagaren med samma kod', L.length === 1 && L[0].state === 'pending' && L[0].pair_code === code && L[0].hw_id === '10000000e2e0ab12', L);
        const id = L[0].id;
        r = await s.request('POST', `/api/admin/mottagare/${id}/approve`, { name: 'Mottagare Ljusdal' }, ADM);
        check('godkänd', r.status === 200, r.json);
        check('mottagaren märker godkännandet direkt', !!(await until(async () => (await pstat()).dispatch.state === 'approved', 3000)));
        html = await (await portal('/')).text();
        check('sidan visar det nya namnet', html.includes('Mottagare Ljusdal'));
        const st0 = await until(async () => { const x = (await list())[0]; return x.status && x.status.sdr ? x : null; }, 5000);
        check('livssignalen: version, nät och ingen frekvens', st0 && st0.version === require('../package.json').version && st0.status.net.type === 'wifi' && st0.status.net.ssid === 'Hemma' && st0.status.sdr.state === 'no_freq', st0 && st0.status);
        check('livssignalen har hotspotens namn och lösenord', st0 && st0.status.hotspot.ssid === 'Dispatch-mottagare-AB12' && /^[a-z0-9]{12}$/.test(st0.status.hotspot.psk || ''), st0 && st0.status.hotspot);

        // 3. Frekvens och inspelningar
        const t0 = Date.now();
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { freq_hz: 69718750 } }, ADM);
        check('frekvensen sparas', r.status === 200, r.json);
        const started = await until(() => sdrArgs().some(l => /^-f 69778750 -s 240000 -b 16384 -g 40\.2 -$/.test(l)), 3000, 50);
        check('rtl_sdr startar med kanalen + 60 kHz och fast förstärkning inom 1,5 s', !!started && Date.now() - t0 < 1500, { ms: Date.now() - t0, args: sdrArgs() });
        const running = await until(async () => { const x = (await list())[0]; return x.status.sdr.state === 'running' && x.config_applied ? x : null; }, 5000);
        check('Dispatch: Lyssnar och inställningarna är hämtade', !!running, running && running.status);
        const rec = await until(async () => { const j = (await s.request('GET', `/api/admin/mottagare/${id}/recordings`, undefined, ADM)).json; return j.recordings && j.recordings.length ? j.recordings : null; }, 12000, 300);
        check('en inspelning kommer fram', !!rec, out.slice(-600));
        if (rec) {
            const x = rec[rec.length - 1];
            check('inspelningen har frekvens, längd och nivå', x.freq_hz === 69718750 && x.duration_ms >= 900 && x.duration_ms <= 2200 && x.level_db > 10, x);
            const w = await fetch(`${s.base}/api/admin/mottagare/recordings/${x.id}/wav`, { headers: { authorization: 'Bearer ' + ADM } });
            const wavFile = readWav(Buffer.from(await w.arrayBuffer()));
            check('WAV-filen: 24 kHz och samma längd', wavFile.rate === 24000 && Math.abs(wavFile.samples.length / 24 - x.duration_ms) < 30, { rate: wavFile.rate, n: wavFile.samples.length });
        }

        // 3b. Radio 90: FFSK-skuren avkodas i Pi:n och tolkas i Dispatch
        const r90 = await until(async () => { const j = (await s.request('GET', '/api/karta/radio90', undefined, ADM)).json; return (j.items || []).find(i => i.id === '12345'); }, 12000, 300);
        check('Radio 90: radion 12345 med position i Dispatch', r90 && r90.fix && Math.abs(r90.position.lat - (59 + 20.1234 / 60)) < 1e-5 && Math.abs(r90.position.lon - (18 + 4.5678 / 60)) < 1e-5
              && r90.speed_kmh === 4.5 && r90.status === '33' && r90.receivers.includes('Mottagare Ljusdal'), r90 || out.slice(-600));
        const dec = await until(async () => { const x = (await list())[0]; return x.status.decoder && x.status.decoder.count > 0 ? x.status.decoder : null; }, 5000);
        check('livssignalen: avkodarens läge', dec && dec.enabled && dec.last_id === '12345' && dec.incomplete === 0, dec);
        // 0.4.0: den falska stickan sänder med −95 dBm (dBFS = dBm + förstärkning + 30)
        check('Radio 90: signalstyrkan i dBm', r90 && Math.abs(r90.position.signal_dbm - (-95)) < 1.5 && r90.position.level_db > 10, r90 && r90.position);
        const sd = await until(async () => { const x = (await list())[0].status.sdr; return x.noise_dbfs !== null && x.noise_dbfs !== undefined ? x : null; }, 6000);
        check('livssignalen: Signalstyrka, förstärkning, brusgolv och klippning', sd && sd.mode === 'iq' && sd.gain_db === 40.2 && sd.noise_dbfs < -40 && sd.clip_pct === 0 && sd.quant_dbfs < -60, sd);
        const clk = await until(async () => { const x = (await list())[0]; return x.status.clock && x.status.clock.synced === true ? x.status.clock : null; }, 5000);
        check('livssignalen: klockan synkad och rätt', clk && Math.abs(clk.offset_s) < 3, clk);
        // Inspelning av: meddelandena kommer ändå, inga nya inspelningar
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { record: false } }, ADM);
        await until(async () => (await list())[0].config_applied, 4000);
        await sleep(800);
        const nRec = (await s.request('GET', `/api/admin/mottagare/${id}/recordings`, undefined, ADM)).json.recordings.length;
        const heard0 = (await s.request('GET', '/api/admin/radio90', undefined, ADM)).json.radios.find(i => i.id === '12345').heard;
        const more = await until(async () => (await s.request('GET', '/api/admin/radio90', undefined, ADM)).json.radios.find(i => i.id === '12345').heard > heard0, 8000, 300);
        check('inspelning av: meddelandena kommer ändå', !!more);
        check('inspelning av: inga nya inspelningar', (await s.request('GET', `/api/admin/mottagare/${id}/recordings`, undefined, ADM)).json.recordings.length === nRec);
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { record: true, decode: false } }, ADM);
        await until(async () => (await list())[0].config_applied, 4000);
        await sleep(800);
        const heard1 = (await s.request('GET', '/api/admin/radio90', undefined, ADM)).json.radios.find(i => i.id === '12345').heard;
        await sleep(3500);
        check('avkodning av: inga nya meddelanden', (await s.request('GET', '/api/admin/radio90', undefined, ADM)).json.radios.find(i => i.id === '12345').heard === heard1);
        check('avkodning av: livssignalen säger avstängd', (await list())[0].status.decoder.enabled === false);
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { decode: true } }, ADM);
        // 0.3.0: avkodaren lyssnar hela tiden, även när squelchen inte öppnar (40 dB)
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { squelch_db: 40 } }, ADM);
        const outside = await until(async () => { const d = (await list())[0].status.decoder; return d && d.enabled && d.outside_squelch > 0 ? d : null; }, 10000, 300);
        check('squelch 40 dB: avkodas ändå, räknas som utanför squelchen', !!outside, (await list())[0].status.decoder);

        // 4. Ändringar
        const nArgs = sdrArgs().length;
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { squelch_db: 12, cal_db: 2 } }, ADM);
        await sleep(1500);
        check('squelch och kalibrering ändras utan att rtl_sdr startas om', sdrArgs().length === nArgs, sdrArgs());
        // 0.4.0: Ställ in förstärkning automatiskt
        r = await s.request('POST', `/api/admin/mottagare/${id}/command`, { cmd: 'gain_scan' }, ADM);
        const scanning = await until(async () => (await list())[0].status.sdr.state === 'scanning', 5000, 100);
        check('mätningen: läget Mäter förstärkningen i Dispatch', !!scanning);
        const gs = await until(async () => { const g = (await list())[0].gain_scan; return g && g.done_at ? g : null; }, 20000, 300);
        check('mätningen: resultatet med förslaget 40,2 dB i Dispatch', gs && gs.ok && gs.result && gs.result.steps.length === 5 && gs.result.suggestion.gain === 40.2, gs);
        check('mätningen: ett rtl_sdr per steg', ['0.9', '30', '36.4', '40.2', '49.6'].every(g => sdrArgs().some(l => l.includes(`-g ${g} `))), sdrArgs());
        check('mätningen: mottagningen igång igen', !!(await until(async () => (await list())[0].status.sdr.state === 'running', 6000)));
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { gain: 30.7, ppm: -3 } }, ADM);
        check('förstärkning och ppm: rtl_sdr startas om med -g 30.7 -p -3', !!(await until(() => sdrArgs().slice(-1)[0].includes('-g 30.7 -p -3'), 3000, 50)), sdrArgs());
        // Endast ljud (reserven): rtl_fm, ingen signalstyrka
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { rx_mode: 'fm' } }, ADM);
        check('Endast ljud: rtl_fm startar', !!(await until(() => rtlArgs().some(l => /^-f 69718750 -M fm -s 24000 -E dc -g 30\.7 -p -3 -$/.test(l)), 3000, 50)), rtlArgs());
        const fm = await until(async () => { const x = (await list())[0].status.sdr; return x.mode === 'fm' && x.state === 'running' ? x : null; }, 5000);
        check('Endast ljud: livssignalen utan brusgolv', fm && fm.noise_dbfs === null, fm);
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { rx_mode: 'iq' } }, ADM);
        check('tillbaka till Signalstyrka: rtl_sdr', !!(await until(async () => (await list())[0].status.sdr.mode === 'iq', 5000)));
        // 0.4.1: källan Serieport (J3 på en Aurora). Porten är en FIFO; testet skriver det radion skulle skriva.
        const port = path.join(SDEV, 'ttyUSB0');
        require('child_process').execFileSync('mkfifo', [port]);
        const wfd = fs.openSync(port, fs.constants.O_RDWR);
        const ports = await until(async () => { const sp = (await list())[0].status.serial; return sp && sp.ports.some(x => x.path === port) ? sp.ports : null; }, 5000);
        check('Serieport: porten syns i livssignalen', !!ports, (await list())[0].status.serial);
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { source: 'serial', serial_port: port } }, ADM);
        const ser = await until(async () => { const x = (await list())[0].status; return x.source === 'serial' && x.serial.state === 'running' && x.sdr.state === 'off' ? x : null; }, 6000);
        check('Serieport: porten läses och stickan stängs', !!ser, (await list())[0].status);
        const nmea = (b) => { let x = 0; for (const c of b) x ^= c.charCodeAt(0); return `$${b}*${x.toString(16).toUpperCase().padStart(2, '0')}`; };
        fs.writeSync(wfd, nmea('PNIGPS,234560,34,,5921.0000,N,01805.0000,E,,,061.5,,,,,,') + '\r\n' + nmea('GPRMC,1') + '\r\n');
        const j3 = await until(async () => { const j = (await s.request('GET', '/api/karta/radio90', undefined, ADM)).json; return (j.items || []).find(i => i.id === '23456'); }, 8000, 300);
        check('Serieport: positionen i Dispatch med mottagaren (J3)', j3 && j3.position && Math.abs(j3.position.lat - (59 + 21 / 60)) < 1e-6 && j3.speed_kmh === 61.5 && j3.status === '34'
              && j3.receivers.includes('Mottagare Ljusdal (J3)'), j3);
        const sst = await until(async () => { const x = (await list())[0].status.serial; return x.ok >= 1 && x.types.GPRMC === 1 ? x : null; }, 5000);
        check('Serieport: livssignalen räknar raderna och typerna', !!sst, (await list())[0].status.serial);
        r = await s.request('PUT', `/api/admin/mottagare/${id}`, { config: { source: 'sdr' } }, ADM);
        check('tillbaka till RTL-SDR', !!(await until(async () => { const x = (await list())[0].status; return x.source === 'sdr' && x.sdr.state === 'running'; }, 6000)));
        fs.closeSync(wfd);

        // 5. Kommandon
        r = await s.request('POST', `/api/admin/mottagare/${id}/command`, { cmd: 'restart' }, ADM);
        check('Starta om programmet: programmet avslutas med 0', (await until(() => lastExit !== null, 5000)) && lastExit === 0, { lastExit });
        let cmd = (await list())[0].commands[0];
        check('kommandot är kvitterat', cmd && cmd.cmd === 'restart' && cmd.done_at && cmd.ok === true, cmd);
        const tokenBefore = JSON.parse(fs.readFileSync(path.join(STATE, 'state.json'), 'utf8')).token;
        startPi();   // som systemd gör
        check('efter omstarten: godkänd med samma nyckel, inställningarna gäller utan Dispatch', !!(await until(async () => (await pstat()).dispatch.state === 'approved', 8000))
              && JSON.parse(fs.readFileSync(path.join(STATE, 'state.json'), 'utf8')).token === tokenBefore && sdrArgs().slice(-1)[0].includes('-g 30.7'));
        check('inget nytt kommando körs efter omstarten', (await list())[0].commands[0].cmd === 'restart' && (await list())[0].commands.length === 2);
        r = await s.request('POST', `/api/admin/mottagare/${id}/command`, { cmd: 'update' }, ADM);
        cmd = await until(async () => { const c = (await list())[0].commands[0]; return c.cmd === 'update' && c.done_at ? c : null; }, 12000, 300);
        check('Uppdatera: resultatet kommer tillbaka', cmd && cmd.ok === true && /Redan senaste/.test(cmd.message), cmd);
        const lu = await until(async () => { const x = (await list())[0]; return x.status.last_update ? x.status.last_update : null; }, 4000);
        check('senaste uppdateringen står i livssignalen', lu && lu.ok === true, lu);

        // 6. Tyst
        proc.kill('SIGKILL');
        const silent = await until(async () => !(await list())[0].online, 8000, 200);
        check('mottagaren tystnar: inte ansluten i Dispatch', !!silent);
        let a = (await s.request('GET', '/api/admin/audit?action=mottagare', undefined, ADM)).json;
        check('aktivitetsloggen: har inte hörts av', (a.rows || []).some(x => /Mottagare Ljusdal har inte hörts av sedan/.test(x.summary)), (a.rows || []).map(x => x.summary));
        startPi();
        check('tillbaka: ansluten igen', !!(await until(async () => (await list())[0].online, 8000)));
        a = await until(async () => { const j = (await s.request('GET', '/api/admin/audit?action=mottagare', undefined, ADM)).json; return (j.rows || []).some(x => /har kontakt igen/.test(x.summary)) ? j : null; }, 4000);
        check('aktivitetsloggen: har kontakt igen', !!a);

        // 7. Borttagen
        r = await s.request('DELETE', `/api/admin/mottagare/${id}`, undefined, ADM);
        const again = await until(async () => { const j = await pstat(); return j.dispatch.state === 'pending' && j.dispatch.pair_code && j.dispatch.pair_code !== code ? j : null; }, 8000);
        check('borttagen i Dispatch: anmäler sig igen med en ny kod', !!again, again);
        L = await list();
        check('Dispatch har en ny väntande mottagare', L.length === 1 && L[0].state === 'pending' && L[0].id !== id, L);
        r = await s.request('POST', `/api/admin/mottagare/${L[0].id}/approve`, {}, ADM);
        L = await list();
        check('samma Pi utan namn: heter värddatorns namn', L[0].name === os.hostname(), L[0].name);
    } catch (e) {
        check('inget undantag', false, e.stack);
    } finally {
        if (proc) proc.kill('SIGKILL');
        s.stop();
        if (fails) console.log('\n--- mottagarens logg ---\n' + out.slice(-3000));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
    process.exit(fails ? 1 : 0);
})();
