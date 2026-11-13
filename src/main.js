// ============================================================================
// Dispatch-mottagare: startar delarna och kopplar ihop dem
//  - state.js     sparade uppgifter (Dispatch-adress, nyckel, inställningar)
//  - net.js       nätet och mottagarens eget wifi (hotspot)
//  - portal.js    inställningssidan på port 80
//  - dispatch.js  anmälan, inställningar och kommandon från Dispatch, livssignal, uppladdning
//  - sdr.js       rtl_fm och squelchen (squelch.js), inspelningarna läggs i kön (queue.js)
//  - ffsk.js      (0.2.0) avkodar FFSK i varje avsnitt som squelchen släpper igenom; aurora.js tolkar Aurora-meddelandet.
//                 Meddelandena läggs i msgqueue.js och skickas till Dispatch (POST /api/mottagare/messages).
// Kommandon från Dispatch: restart (programmet avslutas och systemd startar det igen), reboot (sudo reboot) och
// update (bin/uppdatera.sh körs som en egen systemd-enhet, så att den överlever att tjänsten startas om).
// Efter 15 s skrivs <körmapp>/ok med versionen; uppdateringen väntar på den filen innan den godkänner en ny version.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const VERSION = require('../package.json').version;
const state = require('./state');
const system = require('./system');
const { Queue } = require('./queue');
const { MsgQueue } = require('./msgqueue');
const ffsk = require('./ffsk');
const aurora = require('./aurora');
const { Sdr } = require('./sdr');
const { wav } = require('./wav');
const { NetManager } = require('./net');
const { DispatchClient, normalizeUrl } = require('./dispatch');
const { createPortal } = require('./portal');
const log = require('./log')('MOTTAGARE');

const SUDO = process.env.MOTTAGARE_SUDO !== undefined ? process.env.MOTTAGARE_SUDO : 'sudo';
const UPDATE_RESULT = path.join(state.DIR, 'uppdatering.json');
const UPDATE_TIMEOUT_MS = 10 * 60000;

state.load();
const hwId = system.hwId();
const model = system.model();
log(`version ${VERSION} startar (${model}, serienummer ${hwId})`);

// Dispatch-adressen kan ges vid installationen (install.sh skriver den med kommandoraden) eller i miljön
if (!state.get().dispatch_url && process.env.MOTTAGARE_DISPATCH_URL) {
    const u = normalizeUrl(process.env.MOTTAGARE_DISPATCH_URL);
    if (u) state.set({ dispatch_url: u });
}

const queue = new Queue(path.join(state.DIR, 'kö'));
const msgs = new MsgQueue(state.DIR);
const decoded = { count: 0, last_at: null, last_id: null, errors: 0 };
const cfg = () => state.get().config || {};
const sdr = new Sdr({
    onRecording: (r) => {
        // Avkoda varje avsnitt (även korta och när inspelning är avstängd)
        if (cfg().decode !== false) {
            try {
                const frames = ffsk.decode(r.samples, r.rate);
                const t0 = Date.parse(r.at);
                const list = frames.map(fr => {
                    const p = aurora.parse(fr.payload);
                    return { at: new Date(t0 + Math.round(fr.at_s * 1000)).toISOString(), freq_hz: r.freq_hz, level_db: r.level_db, sync: fr.sync,
                             inverted: fr.inverted, codewords: fr.codewords, address: fr.address, payload: fr.payload, id: p.id, fix: p.fix };
                });
                if (list.length) {
                    msgs.add(list);
                    decoded.count += list.length;
                    decoded.last_at = list[list.length - 1].at;
                    decoded.last_id = list[list.length - 1].id;
                    for (const m of list) log(`avkodat: ID ${m.id || '?'}${m.fix ? '' : ' (ingen GPS-fix)'} ${m.payload}`);
                    client.uploadMessages();
                }
            } catch (e) { decoded.errors++; log('avkodningen misslyckades:', e.message); }
        }
        if (cfg().record === false || r.short) return;
        const meta = { at: r.at, duration_ms: r.duration_ms, freq_hz: r.freq_hz, level_db: r.level_db, cut: !!r.cut };
        queue.add(meta, wav(r.samples, r.rate));
        log(`inspelning ${r.duration_ms} ms${r.cut ? ' (max längd)' : ''}, ${r.level_db} dB under bruset`);
    }
});

const ssid = () => `Dispatch-mottagare-${String(hwId).slice(-4).toUpperCase()}`;
const psk = () => { const s = state.get(); return (s.config && s.config.hotspot_psk) || s.hotspot_psk; };
const net = new NetManager({ ssidFn: ssid, pskFn: psk, runDir: state.RUN_DIR });

let lastUpdate = state.get().last_update || null;
function statusFn() {
    const n = net.info();
    const s = sdr.status();
    return {
        version: VERSION, uptime_s: system.uptimeS(), temp_c: system.tempC(), ip: system.ips(), hostname: system.hostname(), model,
        disk_free_mb: system.diskFreeMb(state.DIR),
        net: n.eth ? { type: 'eth', ssid: null, signal: null } : n.wifi && n.wifi.connected ? { type: 'wifi', ssid: n.wifi.ssid, signal: n.wifi.signal } : { type: n.hotspot ? 'hotspot' : 'none' },
        hotspot: { active: n.hotspot, ssid: ssid(), psk: psk() },
        sdr: { state: s.state, error: s.error, freq_hz: s.freq_hz, noise_db: s.noise_db === undefined ? null : s.noise_db, level_db: s.level_db === undefined ? null : s.level_db,
               open: !!s.open, recordings: s.recordings, devices: s.devices },
        queue: Object.assign(queue.stats(), { messages: msgs.length }), last_update: lastUpdate,
        decoder: { enabled: cfg().decode !== false, count: decoded.count, last_at: decoded.last_at, last_id: decoded.last_id, errors: decoded.errors }
    };
}

async function onConfig(cfg) {
    const before = state.get().applied_psk;
    sdr.apply(cfg);
    const p = psk();
    if (before !== p) { state.set({ applied_psk: p }); if (before) await net.restartHotspotIfActive(); }
}

const client = new DispatchClient({ version: VERSION, hwId, model, hostname: system.hostname(), statusFn, onConfig, queue, msgs,
    onCommand: (c) => runCommand(c).catch(e => log('kommandot misslyckades:', e.message)) });

async function runCommand(c) {
    log(`kommando ${c.cmd} (${c.id})`);
    if (c.cmd === 'restart') {
        await client.commandDone(c.id, true, 'Programmet startar om.');
        setTimeout(() => shutdown(0), 300);
    } else if (c.cmd === 'reboot') {
        await client.commandDone(c.id, true, 'Pi:n startar om.');
        setTimeout(() => execFile(SUDO || '/usr/sbin/reboot', SUDO ? ['-n', '/usr/sbin/reboot'] : [], (e) => { if (e) log('reboot misslyckades:', e.message); }), 300);
    } else if (c.cmd === 'update') {
        state.set({ pending_update: { id: c.id, at: new Date().toISOString(), from: VERSION } });
        try { fs.unlinkSync(UPDATE_RESULT); } catch (e) { /* ingen tidigare */ }
        const test = process.env.MOTTAGARE_UPDATER;
        const cmd = test || SUDO;
        const args = test ? [] : ['-n', '/usr/bin/systemd-run', '--unit=dispatch-mottagare-uppdatering', '--collect', '/usr/local/sbin/dispatch-mottagare-uppdatera'];
        const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
        p.on('error', (e) => { state.set({ pending_update: undefined }); client.commandDone(c.id, false, `Uppdateringen kunde inte startas: ${e.message}`); });
        p.unref();
    } else {
        await client.commandDone(c.id, false, 'Okänt kommando.');
    }
}

// Resultatet av en uppdatering (skrivs av bin/uppdatera.sh) skickas som svar på kommandot
async function checkUpdate() {
    const pend = state.get().pending_update;
    if (!pend) return;
    let res = null;
    try { res = JSON.parse(fs.readFileSync(UPDATE_RESULT, 'utf8')); } catch (e) { /* inte klar */ }
    if (res && res.at && res.at >= pend.at) {
        lastUpdate = { at: res.at, ok: !!res.ok, message: String(res.message || '').slice(0, 200), from: res.from || pend.from, to: res.to || null };
        state.set({ last_update: lastUpdate });
        if (await client.commandDone(pend.id, !!res.ok, lastUpdate.message)) state.set({ pending_update: undefined });
    } else if (Date.now() - Date.parse(pend.at) > UPDATE_TIMEOUT_MS) {
        if (await client.commandDone(pend.id, false, 'Uppdateringen gav inget svar inom 10 minuter.')) state.set({ pending_update: undefined });
    }
}
setInterval(() => checkUpdate().catch(() => {}), 5000).unref();

if (state.get().config) sdr.apply(state.get().config);
if (!state.get().applied_psk) state.set({ applied_psk: psk() });
net.start();
client.start();
createPortal({ version: VERSION, hwId, net, dispatch: client, sdr, stateGet: state.get });

// Uppdateringen väntar på den här filen innan den godkänner en ny version
setTimeout(() => {
    try { fs.mkdirSync(state.RUN_DIR, { recursive: true }); fs.writeFileSync(path.join(state.RUN_DIR, 'ok'), VERSION + '\n'); } catch (e) { log('kunde inte skriva ok-filen:', e.message); }
}, parseInt(process.env.MOTTAGARE_OK_MS, 10) || 15000).unref();

function shutdown(code) {
    log('avslutar');
    try { sdr.shutdown(); } catch (e) { /* ignoreras */ }
    client.stop();
    net.stop();
    setTimeout(() => process.exit(code), 200);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
