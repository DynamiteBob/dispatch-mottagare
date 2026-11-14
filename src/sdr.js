// ============================================================================
// RTL-SDR via rtl_sdr (0.4.0) eller rtl_fm
//
// Mottagning: Signalstyrka (rx_mode 'iq', förvalt): rtl_sdr -f <Hz + 60 kHz> -s 240000 -b 16384 [-g dB] [-p ppm] [-d <serienummer>] -
// ger radiosignalen (I och Q), och iq.js FM-demodulerar den själv och mäter effekten i kanalen (dBFS) och klippningen.
// Endast ljud (rx_mode 'fm', reserven): rtl_fm -f <Hz> -M fm -s 24000 -E dc [-g dB] [-p ppm] [-d <serienummer>] - som före 0.4.0,
// utan signalstyrka.
// Ljudet (16 bitar, 24 kHz) går till squelchen (squelch.js, inspelningarna) och, när decode inte är av,
// till avkodaren (ffskstream.js, 0.3.0), som lyssnar på hela strömmen oberoende av squelchen. rtl_fm:s egen squelch används inte.
// Förstärkningen som stickan faktiskt använder läses ur raden "Tuner gain set to 40.20 dB." (gain_db, null med Auto).
// Brusgolvet (noise_dbfs) är den 20:e percentilen av effekten i block om 20 ms den senaste minuten, och clip_pct andelen byte
// som slog i taket eller golvet den senaste minuten.
// Mätning av förstärkningen (kommandot gain_scan, scanGain()): vanliga mottagningen stoppas, och för varje steg i SCAN_GAINS
// startas rtl_sdr med det steget; brusgolv och klippning mäts i MEASURE_MS efter SKIP_MS. suggestGain() väljer den lägsta
// förstärkning där brusgolvet ligger minst RISE_DB över det lägsta brusgolvet (då är det stickans och antennens brus som hörs,
// inte omvandlarens), utan klippning. Inget steg utan klippning: det lägsta. Inget steg som når RISE_DB: det högsta utan klippning.
//  - Stickorna listas ur /sys/bus/usb/devices (Realtek 0bda:2838/2832), utan att öppna dem.
//  - Startar inte rtl_fm (fel, stickan saknas eller upptagen) försöker den igen efter 5 s, sedan längre (högst 60 s).
//  - Kommer inget ljud på 10 s startas rtl_fm om (stickor kan sluta leverera utan att processen dör).
// Läget (state): no_freq (ingen frekvens inställd), no_device (ingen sticka), starting, running, error.
// MOTTAGARE_RTL_FM och MOTTAGARE_RTL_SDR byter programmen och MOTTAGARE_SYSFS_USB mappen i testerna.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Squelch, RATE } = require('./squelch');
const { FfskStream } = require('./ffskstream');
const { IqDemod, IQ_RATE, OFFSET_HZ, QUANT_DBFS } = require('./iq');
const log = require('./log')('SDR');

const RTL_FM = process.env.MOTTAGARE_RTL_FM || 'rtl_fm';
const RTL_SDR = process.env.MOTTAGARE_RTL_SDR || 'rtl_sdr';
const FAKE_TOOLS = !!(process.env.MOTTAGARE_RTL_FM || process.env.MOTTAGARE_RTL_SDR);
// Stegen i R820T/R828D (RTL-SDR Blog v3 och v4); stickan väljer närmaste steg
const GAIN_STEPS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48.0, 49.6];
const SCAN_GAINS = process.env.MOTTAGARE_SCAN_GAINS ? process.env.MOTTAGARE_SCAN_GAINS.split(',').map(Number)
    : [0, 7.7, 14.4, 19.7, 25.4, 28.0, 32.8, 36.4, 38.6, 40.2, 42.1, 43.9, 44.5, 48.0, 49.6];
const SKIP_MS = parseInt(process.env.MOTTAGARE_SCAN_SKIP_MS, 10) || 300;
const MEASURE_MS = parseInt(process.env.MOTTAGARE_SCAN_MEASURE_MS, 10) || 1500;
const RISE_DB = 8;
const CLIP_LIMIT_PCT = 0.05;
const STATS_BLOCKS = 3000;   // 60 s
const r1 = (v) => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;

function suggestGain(steps) {
    const ok = steps.filter(x => x && Number.isFinite(x.noise_dbfs)).sort((a, b) => a.gain - b.gain);
    if (!ok.length) return null;
    const base = Math.min(...ok.map(x => x.noise_dbfs));
    const clean = ok.filter(x => !(x.clip_pct > CLIP_LIMIT_PCT));
    if (!clean.length) return { gain: ok[0].gain, reason: 'clip', base_dbfs: r1(base) };
    const pick = clean.find(x => x.noise_dbfs - base >= RISE_DB);
    if (pick) return { gain: pick.gain, reason: 'ok', base_dbfs: r1(base) };
    return { gain: clean[clean.length - 1].gain, reason: 'low', base_dbfs: r1(base) };
}
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
        this.gainDb = null;
        this.blocks = [];
        this.cur = null;
        this.scanning = null;
        this.demod = new IqDemod({ onBlock: (audio, info) => this.block(audio, info) });
        this.squelch = new Squelch({ rate: RATE, onRecording: (r) => onRecording(r) });
        const sq = this.squelch;
        this.stream = new FfskStream({ rate: RATE, onFrames: (l) => { if (onFrames) onFrames(l, this.config.freq_hz || 0); }, onError: (e) => { if (onDecodeError) onDecodeError(e); },
            info: () => ({ open: sq.open, quiet: sq.noise !== null && sq.level !== null ? sq.noise - sq.level : null,
                           power_dbfs: this.cur ? this.cur.power_dbfs : null, clip: this.cur ? this.cur.clip : 0 }) });
        this.stallTimer = setInterval(() => this.checkStall(), 2000);
        this.stallTimer.unref();
    }
    mode() { return this.config.rx_mode === 'fm' ? 'fm' : 'iq'; }
    status() {
        const st = { state: this.scanning ? 'scanning' : this.state, error: this.error, freq_hz: this.config.freq_hz || 0, devices: listDevices(),
                     mode: this.mode(), gain_db: this.gainDb, quant_dbfs: QUANT_DBFS, noise_dbfs: null, clip_pct: null };
        if (this.scanning) st.scan = { step: this.scanning.step, total: this.scanning.total };
        if (this.state === 'running' && this.mode() === 'iq' && this.blocks.length >= 50) {
            const p = this.blocks.map(b => b[0]).sort((a, b) => a - b);
            let clip = 0, n = 0;
            for (const b of this.blocks) { clip += b[1]; n += b[2]; }
            st.noise_dbfs = r1(pct(p, 0.2));
            st.clip_pct = n ? Math.round(clip / n * 1e5) / 1e3 : 0;
        }
        return Object.assign(st, this.state === 'running' ? this.squelch.status() : { recordings: this.squelch.count });
    }
    // Ett block om 20 ms ljud från iq.js
    block(audio, info) {
        this.cur = info;
        this.blocks.push([info.power_dbfs, info.clip, info.samples]);
        if (this.blocks.length > STATS_BLOCKS) this.blocks.splice(0, this.blocks.length - STATS_BLOCKS);
        this.squelch.pushSamples(audio);
        if (this.config.decode !== false) this.stream.push(audio);
    }
    // Nya inställningar från Dispatch. rtl_fm startas om bara när något som rör stickan ändrats.
    apply(config) {
        const old = this.config;
        this.config = Object.assign({}, config);
        this.squelch.setConfig(this.config);
        if ((old.decode !== false) !== (this.config.decode !== false)) this.stream.reset();
        if (this.scanning) return;   // startas med de nya inställningarna när mätningen är klar
        const keys = ['freq_hz', 'gain', 'ppm', 'device', 'rx_mode'];
        if (this.proc && keys.every(k => old[k] === this.config[k])) return;
        this.retryMs = 5000;
        this.restart();
    }
    fixedGain(g) { return g !== 'auto' && g !== undefined && g !== null && g !== '' && Number.isFinite(Number(g)) ? Number(g) : null; }
    args(gainOverride) {
        const c = this.config;
        const g = gainOverride !== undefined ? gainOverride : this.fixedGain(c.gain);
        const a = gainOverride !== undefined || this.mode() === 'iq'
            ? ['-f', String(c.freq_hz + OFFSET_HZ), '-s', String(IQ_RATE), '-b', '16384']
            : ['-f', String(c.freq_hz), '-M', 'fm', '-s', String(RATE), '-E', 'dc'];
        if (g !== null) a.push('-g', String(g));
        if (c.ppm) a.push('-p', String(c.ppm));
        if (c.device) a.push('-d', String(c.device));
        a.push('-');
        return a;
    }
    prog(iq) { return iq ? RTL_SDR : RTL_FM; }
    restart() {
        clearTimeout(this.timer);
        this.stop();
        if (!this.config.freq_hz) { this.state = 'no_freq'; this.error = null; return; }
        const devs = listDevices();
        if (!devs.length && !FAKE_TOOLS) { this.state = 'no_device'; this.error = 'Ingen RTL-SDR-sticka hittades.'; this.later(); return; }
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
        this.demod.reset();
        this.blocks = [];
        this.cur = null;
        const iq = this.mode() === 'iq';
        const PROG = this.prog(iq);
        this.gainDb = this.fixedGain(this.config.gain);
        const args = this.args();
        log(`startar ${PROG} ${args.join(' ')}`);
        let p;
        try { p = spawn(PROG, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { this.fail(e.message); return; }
        this.proc = p;
        this.lastData = Date.now();
        const errLines = [];
        p.stdout.on('data', (b) => {
            if (this.proc !== p) return;
            this.lastData = Date.now();
            if (this.state !== 'running') { this.state = 'running'; this.retryMs = 5000; }
            if (iq) { this.demod.push(b); return; }
            const even = b.length & 1 ? b.subarray(0, b.length - 1) : b;
            this.squelch.push(even);
            if (this.config.decode !== false) this.stream.push(even);
        });
        p.stderr.on('data', (b) => {
            for (const l of String(b).split('\n')) if (l.trim()) {
                errLines.push(l.trim()); if (errLines.length > 20) errLines.shift();
                const g = /Tuner gain set to ([\d.]+) dB/.exec(l);
                if (g && this.proc === p) this.gainDb = Number(g[1]);
                else if (/Tuner gain set to auto/i.test(l) && this.proc === p) this.gainDb = null;
            }
        });
        p.on('error', (e) => { if (this.proc === p) { this.proc = null; this.fail(e.code === 'ENOENT' ? `${PROG} saknas. Installera paketet rtl-sdr.` : e.message); } });
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
            log('ingen data från stickan, startar om');
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
    // ---------- Mätning av förstärkningen (0.4.0) ----------
    async scanGain() {
        if (this.scanning) throw new Error('En mätning pågår redan.');
        if (!this.config.freq_hz) throw new Error('Ingen frekvens är inställd.');
        clearTimeout(this.timer);
        this.stop();
        this.scanning = { step: 0, total: SCAN_GAINS.length };
        const steps = [];
        try {
            for (const g of SCAN_GAINS) {
                this.scanning.step++;
                steps.push(await this.measure(g));
                if (steps[steps.length - 1].error && steps.filter(x => x.error).length >= 2 && !steps.some(x => !x.error)) break;
            }
        } finally {
            this.scanning = null;
            this.retryMs = 5000;
            this.restart();
        }
        if (!steps.some(x => !x.error)) throw new Error(steps[0] && steps[0].error ? steps[0].error : 'Mätningen gav inga värden.');
        return { steps, suggestion: suggestGain(steps), quant_dbfs: QUANT_DBFS, rise_db: RISE_DB, clip_limit_pct: CLIP_LIMIT_PCT };
    }
    measure(gain) {
        return new Promise((resolve) => {
            const args = this.args(gain);
            const pw = [];
            let clip = 0, n = 0, t0 = null, tuner = null, done = false;
            const errLines = [];
            const demod = new IqDemod({ onBlock: (a, info) => {
                if (done || t0 === null) return;
                const dt = Date.now() - t0;
                if (dt < SKIP_MS) return;
                pw.push(info.power_dbfs); clip += info.clip; n += info.samples;
                if (dt >= SKIP_MS + MEASURE_MS) finish();
            } });
            let p;
            const finish = (err) => {
                if (done) return;
                done = true;
                clearTimeout(tm);
                try { p.kill('SIGTERM'); } catch (e) { /* redan borta */ }
                pw.sort((a, b) => a - b);
                const res = { gain, tuner_gain: tuner };
                if (pw.length < 10) res.error = err || errLines.find(l => /No supported devices|usb_claim_interface|Failed to open|error/i.test(l)) || 'Ingen data från stickan.';
                else Object.assign(res, { noise_dbfs: r1(pct(pw, 0.2)), max_dbfs: r1(pw[pw.length - 1]), clip_pct: n ? Math.round(clip / n * 1e5) / 1e3 : 0 });
                // vänta tills processen släppt stickan innan nästa steg
                if (p.exitCode !== null || p.signalCode !== null) resolve(res); else { p.once('exit', () => resolve(res)); setTimeout(() => resolve(res), 3000).unref(); }
            };
            const tm = setTimeout(() => finish('Ingen data från stickan.'), SKIP_MS + MEASURE_MS + 8000);
            try { p = spawn(RTL_SDR, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { done = true; clearTimeout(tm); resolve({ gain, tuner_gain: null, error: e.message }); return; }
            p.stdout.on('data', (b) => { if (t0 === null) t0 = Date.now(); demod.push(b); });
            p.stderr.on('data', (b) => { for (const l of String(b).split('\n')) if (l.trim()) { errLines.push(l.trim()); const g = /Tuner gain set to ([\d.]+) dB/.exec(l); if (g) tuner = Number(g[1]); } });
            p.on('error', (e) => finish(e.code === 'ENOENT' ? `${RTL_SDR} saknas. Installera paketet rtl-sdr.` : e.message));
            p.on('exit', () => finish());
        });
    }
    shutdown() { clearTimeout(this.timer); clearInterval(this.stallTimer); this.stop(); }
}

module.exports = { Sdr, listDevices, suggestGain, GAIN_STEPS, SCAN_GAINS };
