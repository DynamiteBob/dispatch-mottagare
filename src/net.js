// ============================================================================
// Nätet via NetworkManager (nmcli, med sudo eftersom programmet inte kör som root)
//
// Regler (tick() var tionde sekund):
//  - Nätkabel ansluten: ingen hotspot (en hotspot som är igång stängs).
//  - Ansluten till wifi: ingen hotspot.
//  - Ingen anslutning: efter BOOT_MS (2 min) om mottagaren aldrig varit ansluten sedan start, annars efter LOST_MS (10 min),
//    startar mottagarens eget wifi "Dispatch-mottagare-XXXX" (WPA2, 10.42.0.1). Där finns inställningssidan.
//  - Hotspoten har varit igång RETRY_MS (10 min) och ingen har använt inställningssidan på 5 min: hotspoten stängs i en minut
//    så att NetworkManager kan prova de sparade näten. Lyckas det inte startar hotspoten igen.
//  - Sparat wifi från inställningssidan: hotspoten stängs och mottagaren ansluter. Misslyckas det startar hotspoten igen
//    och felet visas på inställningssidan.
// Telefoner som ansluter till hotspoten får inställningssidan av sig själva: NetworkManagers dnsmasq svarar 10.42.0.1 på
// alla namn (/etc/NetworkManager/dnsmasq-shared.d/dispatch-mottagare.conf, från install.sh).
// MOTTAGARE_NMCLI och MOTTAGARE_SUDO byter programmen i testerna, MOTTAGARE_BOOT_MS/LOST_MS/RETRY_MS tiderna.
// ============================================================================
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./log')('NÄT');

const NMCLI = process.env.MOTTAGARE_NMCLI || '/usr/bin/nmcli';
const SUDO = process.env.MOTTAGARE_SUDO !== undefined ? process.env.MOTTAGARE_SUDO : 'sudo';
const BOOT_MS = parseInt(process.env.MOTTAGARE_BOOT_MS, 10) || 120000;
const LOST_MS = parseInt(process.env.MOTTAGARE_LOST_MS, 10) || 600000;
const RETRY_MS = parseInt(process.env.MOTTAGARE_RETRY_MS, 10) || 600000;
const TRY_MS = parseInt(process.env.MOTTAGARE_TRY_MS, 10) || 60000;
const PORTAL_QUIET_MS = 5 * 60000;
const TICK_MS = parseInt(process.env.MOTTAGARE_NET_TICK_MS, 10) || 10000;
const HOTSPOT_CON = 'dispatch-mottagare-hotspot';
const WIFI_PREFIX = 'dispatch-wifi-';
const HOTSPOT_IP = '10.42.0.1';

function nmcli(args, timeout) {
    const cmd = SUDO ? SUDO : NMCLI;
    const a = SUDO ? ['-n', NMCLI].concat(args) : args;
    return new Promise((resolve) => {
        execFile(cmd, a, { timeout: timeout || 30000, env: Object.assign({}, process.env, { LANG: 'C', LC_ALL: 'C' }) }, (err, out, errOut) => {
            resolve({ ok: !err, code: err ? (err.code || 1) : 0, out: String(out || ''), err: String(errOut || (err && err.message) || '').trim() });
        });
    });
}
// nmcli -t skriver fälten med : emellan och \: i texten
function terse(line) {
    const out = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
        if (c === ':') { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    out.push(cur);
    return out;
}
const lines = (s) => s.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);

async function devices() {
    const r = await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
    return lines(r.out).map(terse).map(([device, type, st, connection]) => ({ device, type, state: st, connection }));
}
async function status() {
    const devs = await devices();
    const eth = devs.some(d => d.type === 'ethernet' && /^connected/.test(d.state));
    const w = devs.find(d => d.type === 'wifi');
    const hotspot = !!(w && w.connection === HOTSPOT_CON && /^connected/.test(w.state));
    const out = { eth, hotspot, wifi: w ? { device: w.device, connected: /^connected/.test(w.state) && !hotspot, connection: w.connection || null, ssid: null, signal: null } : null };
    if (out.wifi && out.wifi.connected) {
        const r = await nmcli(['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'no']);
        const act = lines(r.out).map(terse).find(f => f[0] === 'yes');
        if (act) { out.wifi.ssid = act[1] || null; out.wifi.signal = Number(act[2]) || null; }
    }
    return out;
}
async function scan(ownSsid) {
    const r = await nmcli(['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], 25000);
    const best = new Map();
    for (const [ssid, sig, sec] of lines(r.out).map(terse)) {
        if (!ssid || ssid === ownSsid) continue;
        const s = Number(sig) || 0;
        if (!best.has(ssid) || best.get(ssid).signal < s) best.set(ssid, { ssid, signal: s, secure: !!(sec && sec !== '--') });
    }
    return [...best.values()].sort((a, b) => b.signal - a.signal);
}
async function saved() {
    const r = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
    const out = [];
    for (const [name, type] of lines(r.out).map(terse)) {
        if (!/wireless|wifi/.test(type) || name === HOTSPOT_CON) continue;
        const s = await nmcli(['-t', '-g', '802-11-wireless.ssid,802-11-wireless.mode', 'connection', 'show', name]);
        const [ssid, mode] = lines(s.out).length > 1 ? lines(s.out) : terse(lines(s.out)[0] || '');
        if (mode === 'ap') continue;
        out.push({ name, ssid: ssid || name, ours: name.startsWith(WIFI_PREFIX) });
    }
    return out;
}

class NetManager {
    constructor({ ssidFn, pskFn, runDir }) {
        this.ssidFn = ssidFn; this.pskFn = pskFn; this.runDir = runDir;
        this.startedAt = Date.now();
        this.everConnected = false;
        this.lostSince = null;
        this.hotspotSince = null;
        this.tryingUntil = 0;
        this.portalTouched = 0;
        this.busy = false;
        this.networks = [];
        this.message = null;   // { ok, text } till inställningssidan
        this.last = null;
    }
    start() { this.tick(); this.timer = setInterval(() => this.tick(), TICK_MS); }
    stop() { clearInterval(this.timer); }
    touch() { this.portalTouched = Date.now(); }
    info() {
        const s = this.last || {};
        return { eth: !!s.eth, hotspot: !!s.hotspot, wifi: s.wifi || null, ssid: this.ssidFn(), psk: this.pskFn(), ip: HOTSPOT_IP,
                 networks: this.networks, message: this.message, busy: this.busy };
    }
    async tick() {
        if (this.busy) return;
        try {
            const st = await status();
            this.last = st;
            const now = Date.now();
            const forced = this.runDir && fs.existsSync(path.join(this.runDir, 'hotspot'));
            if (forced) { try { fs.unlinkSync(path.join(this.runDir, 'hotspot')); } catch (e) { /* ignoreras */ } }
            if (st.hotspot) {
                if (!this.hotspotSince) this.hotspotSince = now;
                if (st.eth) { log('nätkabel ansluten, stänger hotspoten'); await this.stopHotspot(); return; }
                if (now - this.hotspotSince >= RETRY_MS && now - this.portalTouched >= PORTAL_QUIET_MS && (await saved()).length) {
                    log('provar de sparade näten');
                    this.tryingUntil = now + TRY_MS;
                    await this.stopHotspot();
                }
                return;
            }
            this.hotspotSince = null;
            const connected = st.eth || (st.wifi && st.wifi.connected);
            if (connected) { this.everConnected = true; this.lostSince = null; this.tryingUntil = 0; if (!forced) return; }
            if (!st.wifi) return;   // inget wifi i datorn: ingen hotspot
            if (this.tryingUntil && now < this.tryingUntil && !forced) return;
            if (!this.lostSince) this.lostSince = this.everConnected ? now : this.startedAt;
            const limit = this.everConnected ? LOST_MS : BOOT_MS;
            if (forced || this.tryingUntil || now - this.lostSince >= limit) {
                this.tryingUntil = 0;
                await this.startHotspot(forced ? 'begärd från kommandoraden' : this.everConnected ? 'ingen anslutning på länge' : 'inget nät efter start');
            }
        } catch (e) { log('fel:', e.message); }
    }
    async startHotspot(why) {
        const w = this.last && this.last.wifi;
        if (!w) return false;
        this.busy = true;
        try {
            // Näten runt mottagaren läses innan hotspoten startar (det går sämre medan den är igång)
            try { this.networks = await scan(this.ssidFn()); } catch (e) { /* ignoreras */ }
            log(`startar hotspoten ${this.ssidFn()} (${why})`);
            await nmcli(['connection', 'delete', HOTSPOT_CON]);
            const add = await nmcli(['connection', 'add', 'type', 'wifi', 'ifname', w.device, 'con-name', HOTSPOT_CON, 'autoconnect', 'no',
                'ssid', this.ssidFn(), '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg',
                'ipv4.method', 'shared', 'ipv4.addresses', `${HOTSPOT_IP}/24`, 'ipv6.method', 'disabled',
                'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', this.pskFn()]);
            if (!add.ok) { log('hotspoten kunde inte skapas:', add.err); return false; }
            const up = await nmcli(['--wait', '30', 'connection', 'up', HOTSPOT_CON], 40000);
            if (!up.ok) { log('hotspoten startade inte:', up.err); return false; }
            this.hotspotSince = Date.now();
            this.last = await status();
            return true;
        } finally { this.busy = false; }
    }
    async stopHotspot() {
        await nmcli(['connection', 'down', HOTSPOT_CON]);
        this.hotspotSince = null;
        this.last = await status().catch(() => this.last);
    }
    async restartHotspotIfActive() {
        if (this.last && this.last.hotspot) { await this.stopHotspot(); await this.startHotspot('nytt lösenord'); }
    }
    async savedNetworks() { return saved(); }
    async rescan() { if (!(this.last && this.last.hotspot)) this.networks = await scan(this.ssidFn()); return this.networks; }
    // Spara ett wifi-nät och anslut. Svarar direkt; resultatet hamnar i message (inställningssidan visar det).
    saveWifi(ssid, psk) {
        if (this.busy) return false;
        this.busy = true;
        this.message = { ok: null, text: `Ansluter till ${ssid} …` };
        (async () => {
            try {
                const name = WIFI_PREFIX + ssid.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40);
                for (const s of await saved()) if (s.ssid === ssid && s.ours) await nmcli(['connection', 'delete', s.name]);
                const args = ['connection', 'add', 'type', 'wifi', 'con-name', name, 'ssid', ssid, 'connection.autoconnect', 'yes',
                    'connection.autoconnect-priority', '10'];
                if (psk) args.push('wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', psk);
                const add = await nmcli(args);
                if (!add.ok) { this.message = { ok: false, text: `Nätet kunde inte sparas: ${add.err}` }; return; }
                const wasHotspot = this.last && this.last.hotspot;
                if (wasHotspot) await nmcli(['connection', 'down', HOTSPOT_CON]);
                const up = await nmcli(['--wait', '40', 'connection', 'up', name], 50000);
                if (up.ok) {
                    this.message = { ok: true, text: `Ansluten till ${ssid}.` };
                    this.everConnected = true; this.lostSince = null; this.hotspotSince = null;
                    log(`ansluten till ${ssid}`);
                } else {
                    this.message = { ok: false, text: `Kunde inte ansluta till ${ssid}. Kontrollera lösenordet. Nätet är sparat och provas igen senare.` };
                    log(`kunde inte ansluta till ${ssid}: ${up.err}`);
                    this.busy = false;
                    if (wasHotspot) await this.startHotspot('anslutningen misslyckades');
                }
            } finally { this.busy = false; this.last = await status().catch(() => this.last); }
        })();
        return true;
    }
    async removeWifi(name) {
        if (!String(name).startsWith(WIFI_PREFIX) && !(await saved()).some(s => s.name === name)) return false;
        const r = await nmcli(['connection', 'delete', name]);
        return r.ok;
    }
}

module.exports = { NetManager, HOTSPOT_IP, HOTSPOT_CON, terse, nmcli };
