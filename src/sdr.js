// ============================================================================
// RTL-SDR via rtl_fm
//
// rtl_fm ställs in på frekvensen och FM-demodulerar: rtl_fm -f <Hz> -M fm -s 24000 -E dc [-g dB] [-p ppm] [-d <serienummer>] -
// Utdata är 16-bitars ljud i 24 kHz som går till squelchen (squelch.js, inspelningarna) och, när decode inte är av,
// till avkodaren (ffskstream.js, 0.3.0), som lyssnar på hela strömmen oberoende av squelchen. rtl_fm:s egen squelch används inte.
//  - Stickorna listas ur /sys/bus/usb/devices (Realtek 0bda:2838/2832), utan att öppna dem.
//  - Startar inte rtl_fm (fel, stickan saknas eller upptagen) försöker den igen efter 5 s, sedan längre (högst 60 s).
//  - Kommer inget ljud på 10 s startas rtl_fm om (stickor kan sluta leverera utan att processen dör).
// Läget (state): no_freq (ingen frekvens inställd), no_device (ingen sticka), starting, running, error.
// MOTTAGARE_RTL_FM byter programmet och MOTTAGARE_SYSFS_USB mappen i testerna.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Squelch, RATE } = require('./squelch');
const { FfskStream } = require('./ffskstream');
const log = require('./log')('SDR');

const RTL_FM = process.env.MOTTAGARE_RTL_FM || 'rtl_fm';
const USB_DIR = process.env.MOTTAGARE_SYSFS_USB || '/sys/bus/usb/devices';
const STALL_MS = parseInt(process.env.MOTTAGARE_STALL_MS, 10) || 10000;
const RTL_IDS = new Set(['0bda:2838', '0bda:2832']);

function listDevices() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(USB_DIR); } catch (e) { return out; }
    for (const n of names.sort()) {
        const d = path.join(USB_DIR, n);
        const rd = (f) => { try { return fs.readFileSync(path.join(d, f), 'utf8').trim(); } catch (e) { return null; } };
        const id = `${rd('idVendor')}:${rd('idProduct')}`;
        if (!RTL_IDS.has(id)) continue;
        out.push({ serial: rd('serial'), name: [rd('manufacturer'), rd('product')].filter(Boolean).join(' ') || 'RTL-SDR' });
    }
    return out;
}

class Sdr {
    constructor({ onRecording, onFrames, onDecodeError }) {
        this.config = {};
        this.proc = null;
        this.state = 'no_freq';
        this.error = null;
        this.retryMs = 5000;
        this.timer = null;
        this.lastData = 0;
        this.squelch = new Squelch({ rate: RATE, onRecording: (r) => onRecording(r) });
        const sq = this.squelch;
        this.stream = new FfskStream({ rate: RATE, onFrames: (l) => { if (onFrames) onFrames(l, this.config.freq_hz || 0); }, onError: (e) => { if (onDecodeError) onDecodeError(e); },
            info: () => ({ open: sq.open, quiet: sq.noise !== null && sq.level !== null ? sq.noise - sq.level : null }) });
        this.stallTimer = setInterval(() => this.checkStall(), 2000);
        this.stallTimer.unref();
    }
    status() {
        return Object.assign({ state: this.state, error: this.error, freq_hz: this.config.freq_hz || 0, devices: listDevices() },
            this.state === 'running' ? this.squelch.status() : { recordings: this.squelch.count });
    }
    // Nya inställningar från Dispatch. rtl_fm startas om bara när något som rör stickan ändrats.
    apply(config) {
        const old = this.config;
        this.config = Object.assign({}, config);
        this.squelch.setConfig(this.config);
        if ((old.decode !== false) !== (this.config.decode !== false)) this.stream.reset();
        const keys = ['freq_hz', 'gain', 'ppm', 'device'];
        if (this.proc && keys.every(k => old[k] === this.config[k])) return;
        this.retryMs = 5000;
        this.restart();
    }
    args() {
        const c = this.config;
        const a = ['-f', String(c.freq_hz), '-M', 'fm', '-s', String(RATE), '-E', 'dc'];
        if (c.gain !== 'auto' && c.gain !== undefined && c.gain !== null && c.gain !== '') a.push('-g', String(c.gain));
        if (c.ppm) a.push('-p', String(c.ppm));
        if (c.device) a.push('-d', String(c.device));
        a.push('-');
        return a;
    }
    restart() {
        clearTimeout(this.timer);
        this.stop();
        if (!this.config.freq_hz) { this.state = 'no_freq'; this.error = null; return; }
        const devs = listDevices();
        if (!devs.length && !process.env.MOTTAGARE_RTL_FM) { this.state = 'no_device'; this.error = 'Ingen RTL-SDR-sticka hittades.'; this.later(); return; }
        if (this.config.device && devs.length && !devs.some(d => d.serial === this.config.device)) {
            this.state = 'no_device'; this.error = `Stickan med serienummer ${this.config.device} hittades inte.`; this.later(); return;
        }
        this.start();
    }
    start() {
        this.state = 'starting';
        this.error = null;
        this.squelch.reset();
        this.stream.reset();
        const args = this.args();
        log(`startar ${RTL_FM} ${args.join(' ')}`);
        let p;
        try { p = spawn(RTL_FM, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { this.fail(e.message); return; }
        this.proc = p;
        this.lastData = Date.now();
        const errLines = [];
        p.stdout.on('data', (b) => {
            if (this.proc !== p) return;
            this.lastData = Date.now();
            if (this.state !== 'running') { this.state = 'running'; this.retryMs = 5000; }
            const even = b.length & 1 ? b.subarray(0, b.length - 1) : b;
            this.squelch.push(even);
            if (this.config.decode !== false) this.stream.push(even);
        });
        p.stderr.on('data', (b) => { for (const l of String(b).split('\n')) if (l.trim()) { errLines.push(l.trim()); if (errLines.length > 20) errLines.shift(); } });
        p.on('error', (e) => { if (this.proc === p) { this.proc = null; this.fail(e.code === 'ENOENT' ? `${RTL_FM} saknas. Installera paketet rtl-sdr.` : e.message); } });
        p.on('exit', (code, sig) => {
            if (this.proc !== p) return;
            this.proc = null;
            const why = errLines.find(l => /No supported devices|usb_claim_interface|Failed to open|error/i.test(l)) || errLines[errLines.length - 1] || `slutade (${sig || code})`;
            this.fail(/usb_claim_interface/i.test(why) ? 'Stickan används av ett annat program (eller av Linux DVB-drivrutin).' : why);
        });
    }
    fail(msg) {
        this.state = 'error';
        this.error = String(msg).slice(0, 200);
        log(`fel: ${this.error}`);
        this.later();
    }
    later() {
        clearTimeout(this.timer);
        const ms = this.retryMs;
        this.retryMs = Math.min(60000, this.retryMs * 2);
        this.timer = setTimeout(() => this.restart(), ms);
        this.timer.unref();
    }
    checkStall() {
        if (this.proc && Date.now() - this.lastData > STALL_MS) {
            log('inget ljud från rtl_fm, startar om');
            this.fail('Inget ljud från stickan på 10 s.');
            this.stop();
        }
    }
    stop() {
        const p = this.proc;
        this.proc = null;
        if (p) { try { p.kill('SIGTERM'); } catch (e) { /* redan borta */ } setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* ignoreras */ } }, 2000).unref(); }
        if (this.squelch.open) this.squelch.close();
    }
    shutdown() { clearTimeout(this.timer); clearInterval(this.stallTimer); this.stop(); }
}

module.exports = { Sdr, listDevices };
