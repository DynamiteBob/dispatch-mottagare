// ============================================================================
// Avkodning av hela ljudströmmen (0.3.0)
//
// Avkodaren lyssnar hela tiden, oberoende av squelchen, så att också sändningar som är för svaga för att öppna
// squelchen kommer med. Ljudet från rtl_fm avkodas i fönster om WINDOW_S (2,0 s) som flyttas STEP_S (1,4 s) åt gången,
// alltså med OVERLAP_S (0,6 s) överlapp. Varje fönster "äger" de ramar vars synkord börjar i
// [fönstrets början + MARGIN_S, fönstrets slut − OVERLAP_S + MARGIN_S). Delarna lägger sig kant i kant, så varje ram
// räknas i exakt ett fönster, och den har minst OVERLAP_S − MARGIN_S (0,55 s) kvar i fönstret. En ram med åtta kodord
// tar 0,44 s. MARGIN_S ger diskriminatorn tid att svänga in i början av fönstret.
// För säkerhets skull kastas också samma data som redan rapporterats inom DUP_MS (150 ms).
// För varje ram anges om squelchen var öppen och hur mycket bruset var nedtryckt (info() vid push).
// 0.4.0: med rtl_sdr ger info() också effekten i kanalen (power_dbfs) och klippningen (clip) för blocket. Ramen får
// signal_dbfs = medianen av blocken under ramen och clipped = true när något block under ramen klippte.
// ============================================================================
'use strict';

const ffsk = require('./ffsk');

const WINDOW_S = 2.0;
const STEP_S = 1.4;
const OVERLAP_S = WINDOW_S - STEP_S;
const MARGIN_S = 0.05;
const DUP_MS = 150;

class FfskStream {
    // onFrames(list): list = [{ at, at_ms, payload, address, sync, inverted, codewords, squelch_open, level_db, signal_dbfs, clipped }]
    // info(): { open, quiet, power_dbfs, clip } just nu (squelchens läge, effekten och klippningen när ljudet kom)
    constructor({ rate, onFrames, info, now, onError }) {
        this.rate = rate;
        this.W = Math.round(WINDOW_S * rate);
        this.step = Math.round(STEP_S * rate);
        this.overlap = this.W - this.step;
        this.margin = Math.round(MARGIN_S * rate);
        this.onFrames = onFrames || (() => {});
        this.onError = onError || (() => {});
        this.info = info || (() => ({ open: false, quiet: null }));
        this.now = now || (() => Date.now());
        this.reset();
    }
    reset() {
        this.buf = new Int16Array(this.W * 2);
        this.len = 0;          // antal sampel i buf
        this.bufStart = 0;     // absolut index för buf[0]
        this.total = 0;        // antal sampel sedan reset
        this.nextEnd = this.W; // absolut slut på nästa fönster
        this.first = true;
        this.marks = [];       // [absolut index, open, quiet, power_dbfs, clip]
        this.recent = [];      // [ms, payload]
        this.windows = 0;
    }
    // Ljud från rtl_fm: Buffer (16 bitar little endian) eller Int16Array
    push(data) {
        const n = Buffer.isBuffer(data) ? data.length >> 1 : data.length;
        if (!n) return;
        const inf = this.info() || {};
        this.marks.push([this.total, !!inf.open, Number.isFinite(inf.quiet) ? inf.quiet : null,
            Number.isFinite(inf.power_dbfs) ? inf.power_dbfs : null, Number(inf.clip) || 0]);
        if (this.len + n > this.buf.length) {
            const nb = new Int16Array(Math.max(this.buf.length * 2, this.len + n));
            nb.set(this.buf.subarray(0, this.len));
            this.buf = nb;
        }
        if (Buffer.isBuffer(data)) for (let i = 0; i < n; i++) this.buf[this.len + i] = data.readInt16LE(i * 2);
        else this.buf.set(data, this.len);
        this.len += n;
        this.total += n;
        const nowMs = this.now();
        while (this.total >= this.nextEnd) {
            this.window(this.nextEnd, nowMs);
            this.nextEnd += this.step;
            this.first = false;
        }
    }
    window(end, nowMs) {
        const start = end - this.W;
        const a = start - this.bufStart;
        const samples = this.buf.subarray(a, a + this.W);
        const ownFrom = this.first ? 0 : this.margin;
        const ownTo = this.W - this.overlap + this.margin;
        this.windows++;
        let frames = [];
        try { frames = ffsk.decode(samples, this.rate); } catch (e) { this.onError(e); }
        const out = [];
        for (const fr of frames) {
            const off = Math.round(fr.at_s * this.rate);
            if (off < ownFrom || off >= ownTo) continue;
            const abs = start + off;
            const ms = Math.round(nowMs - (this.total - abs) * 1000 / this.rate);
            if (this.recent.some(([t, p]) => p === fr.payload && Math.abs(t - ms) < DUP_MS)) continue;
            this.recent.push([ms, fr.payload]);
            // squelchens läge mitt i ramen
            const mid = abs + Math.round((16 + fr.codewords * 64) / 2 / 1200 * this.rate);
            const endAbs = abs + Math.round((16 + fr.codewords * 64) / 1200 * this.rate);
            let mk = null;
            const pw = [];
            let clipped = false;
            for (let k = 0; k < this.marks.length; k++) {
                const m = this.marks[k];
                if (m[0] <= mid) mk = m;
                const to = k + 1 < this.marks.length ? this.marks[k + 1][0] : this.total;
                if (to > abs && m[0] < endAbs) { if (m[3] !== null) pw.push(m[3]); if (m[4] > 0) clipped = true; }
            }
            pw.sort((x, y) => x - y);
            out.push({ at: new Date(ms).toISOString(), at_ms: ms, payload: fr.payload, address: fr.address, sync: fr.sync, inverted: fr.inverted,
                       codewords: fr.codewords, squelch_open: !!(mk && mk[1]), level_db: mk && mk[2] !== null ? Math.round(mk[2] * 10) / 10 : null,
                       signal_dbfs: pw.length ? Math.round(pw[Math.floor(pw.length / 2)] * 10) / 10 : null, clipped });
        }
        // Behåll det som nästa fönster behöver
        const keepFrom = end + this.step - this.W;
        const drop = keepFrom - this.bufStart;
        if (drop > 0) {
            this.buf.copyWithin(0, drop, this.len);
            this.len -= drop;
            this.bufStart = keepFrom;
        }
        while (this.marks.length > 1 && this.marks[1][0] <= keepFrom) this.marks.shift();
        const cut = nowMs - 5000;
        while (this.recent.length && this.recent[0][0] < cut) this.recent.shift();
        if (out.length) this.onFrames(out);
    }
}

module.exports = { FfskStream, WINDOW_S, STEP_S, OVERLAP_S };
