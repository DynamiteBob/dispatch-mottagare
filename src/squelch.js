// ============================================================================
// Brussquelch och inspelning
//
// rtl_fm FM-demodulerar och ger ljud (16 bitar, RATE Hz). Utan bärvåg är ljudet brus över hela bandet; med en bärvåg
// tystnar bruset ("quieting"), och det som finns kvar är tal eller FFSK under 3,4 kHz. Squelchen mäter därför bara
// det som ligger över HP_HZ (6 kHz) i block om 20 ms:
//  - brusnivån (noise_db) följer den nivån när squelchen är stängd: snabbt uppåt, långsamt nedåt
//  - squelchen öppnar när nivån ligger squelch_db under brusnivån i två block i rad (40 ms)
//  - den stänger när nivån varit över gränsen + 3 dB i HANG_MS (300 ms)
// Ett avsnitt börjar PRE_MS (300 ms) före öppningen och slutar när squelchen stänger. Ett avsnitt där squelchen var
// öppen kortare än MIN_MS kastas (en brusspik). Med inspelning avstängd skickas inga avsnitt alls.
// Squelchen styr bara inspelningarna: avkodaren (ffskstream.js) lyssnar på hela strömmen sedan 0.3.0.
// Når avsnittet record_max_s skickas det, och inget mer tas med förrän squelchen har stängt (stuck = true), så att en
// bärvåg som ligger kvar inte fyller Dispatch med inspelningar.
// ============================================================================
'use strict';

const RATE = 24000;
const FRAME = RATE / 50;      // 20 ms
const HP_HZ = 6000;
const PRE_MS = 300;
const HANG_MS = 300;
const MIN_MS = 300;
const OPEN_FRAMES = 2;

// Högpassfilter (biquad, Butterworth, Q = 0,707)
function highpass(fc, fs) {
    const w = 2 * Math.PI * fc / fs, cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = (1 + cw) / 2 / a0, a1 = -2 * cw / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const db = (ms) => 10 * Math.log10(Math.max(ms, 1e-12));

class Squelch {
    constructor(opts) {
        this.rate = (opts && opts.rate) || RATE;
        this.frame = Math.round(this.rate / 50);
        this.onRecording = (opts && opts.onRecording) || (() => {});
        this.now = (opts && opts.now) || (() => Date.now());
        this.setConfig((opts && opts.config) || {});
        this.reset();
    }
    setConfig(c) {
        this.squelchDb = Number.isFinite(Number(c.squelch_db)) ? Number(c.squelch_db) : 10;
        this.record = c.record !== false;
        this.maxSamples = Math.round((Number(c.record_max_s) || 30) * this.rate);
        this.freq = Number(c.freq_hz) || 0;
    }
    reset() {
        this.hp = highpass(HP_HZ, this.rate);
        this.acc = 0; this.accN = 0;
        this.cur = new Int16Array(this.frame); this.curN = 0;
        this.noise = null; this.level = null;
        this.open = false; this.below = 0; this.aboveMs = 0;
        this.pre = []; this.preMax = Math.ceil(PRE_MS / 20);
        this.rec = null; this.stuck = false;
        this.count = 0; this.frames = 0;
    }
    status() {
        const r1 = (v) => v === null ? null : Math.round(v * 10) / 10;
        return { noise_db: r1(this.noise), level_db: r1(this.level), open: this.open, stuck: this.stuck, recordings: this.count };
    }
    // Ljud från rtl_fm: Buffer med 16-bitars little endian
    push(buf) {
        const n = buf.length >> 1;
        for (let i = 0; i < n; i++) {
            const s = buf.readInt16LE(i * 2);
            this.cur[this.curN++] = s;
            const h = this.hp(s / 32768);
            this.acc += h * h; this.accN++;
            if (this.curN === this.frame) this.endFrame();
        }
    }
    pushSamples(arr) {
        for (let i = 0; i < arr.length; i++) {
            const s = arr[i];
            this.cur[this.curN++] = s;
            const h = this.hp(s / 32768);
            this.acc += h * h; this.accN++;
            if (this.curN === this.frame) this.endFrame();
        }
    }
    endFrame() {
        const frame = this.cur;
        this.cur = new Int16Array(this.frame); this.curN = 0;
        const lvl = db(this.acc / this.accN);
        this.acc = 0; this.accN = 0;
        this.level = lvl;
        this.frames++;
        if (this.noise === null) this.noise = lvl;
        const thr = this.noise - this.squelchDb;
        if (!this.open) {
            // brusnivån följer bara när squelchen är stängd: snabbt uppåt, långsamt nedåt
            this.noise += (lvl - this.noise) * (lvl > this.noise ? 0.05 : 0.002);
            if (this.frames > 10 && lvl < thr) this.below++; else this.below = 0;
            if (this.below >= OPEN_FRAMES) this.startOpen();
            else { this.pre.push(frame); if (this.pre.length > this.preMax) this.pre.shift(); }
            if (this.open) this.addFrame(frame, lvl);
        } else {
            this.addFrame(frame, lvl);
            if (lvl > thr + 3) this.aboveMs += 20; else this.aboveMs = 0;
            if (this.aboveMs >= HANG_MS) this.close();
        }
    }
    startOpen() {
        this.open = true; this.aboveMs = 0; this.below = 0;
        if (!this.stuck) {
            const startAt = this.now() - this.pre.length * 20;
            this.rec = { chunks: this.pre.slice(), n: this.pre.length * this.frame, at: startAt, quiet: [], noise: this.noise };
        }
        this.pre = [];
    }
    addFrame(frame, lvl) {
        if (!this.rec) return;
        this.rec.chunks.push(frame);
        this.rec.n += frame.length;
        this.rec.quiet.push(this.rec.noise - lvl);
        if (this.rec.n >= this.maxSamples) { this.finish(true); this.stuck = true; }
    }
    close() {
        this.open = false; this.aboveMs = 0; this.below = 0;
        if (this.rec) this.finish(false);
        this.stuck = false;
    }
    finish(cut) {
        const r = this.rec;
        this.rec = null;
        if (!r) return;
        const samples = new Int16Array(r.n);
        let o = 0;
        for (const c of r.chunks) { samples.set(c, o); o += c.length; }
        const durMs = Math.round(r.n * 1000 / this.rate);
        const short = durMs < MIN_MS + PRE_MS + HANG_MS && !cut;
        const q = r.quiet.slice().sort((a, b) => a - b);
        const quiet = q.length ? q[Math.floor(q.length / 2)] : null;
        if (short || !this.record) return;
        this.count++;
        this.onRecording({ short, at: new Date(r.at).toISOString(), duration_ms: durMs, samples, rate: this.rate, freq_hz: this.freq,
                           level_db: quiet === null ? null : Math.round(quiet * 10) / 10, cut });
    }
}

module.exports = { Squelch, RATE, FRAME, HP_HZ };
