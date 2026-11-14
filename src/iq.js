// ============================================================================
// FM-demodulering av radiosignalen från rtl_sdr (0.4.0)
//
// rtl_sdr ger I och Q som osignerade byte (0–255, mitten 127,5) i IQ_RATE (240 000) sampel per sekund. Stickan ställs in
// OFFSET_HZ (60 kHz, en fjärdedel av samplingstakten) över kanalen, så att stickans likspänningsspik hamnar utanför kanalen.
// Kedjan:
//  1. Byten görs om till −1…1 (fullt utslag = 0 dBFS) och flyttas upp 60 kHz (multiplikation med 1, j, −1, −j).
//  2. Kanalfilter (FIR, Blackman, CHANNEL_HZ = 10 kHz) och decimering 10 gånger till 24 000 sampel per sekund.
//  3. FM-diskriminator (vinkeln mellan två sampel), skalad som i rtl_fm: π = 16 384. Ljudet är samma som från
//     rtl_fm -M fm -s 24000, så squelchen och FFSK-avkodaren fungerar som förut.
//  4. Ljudet lämnas i block om 20 ms (480 sampel) med blockets effekt i kanalen (dBFS) och antalet byte som slog i
//     taket eller golvet (0 eller 255), som visar att stickan är överstyrd.
// Effekten i kanalen räknas efter kanalfiltret: en signal med fullt utslag ger 0 dBFS. Utan signal är det brusgolvet.
// ============================================================================
'use strict';

const IQ_RATE = 240000;
const AUDIO_RATE = 24000;
const DECIM = IQ_RATE / AUDIO_RATE;
const OFFSET_HZ = IQ_RATE / 4;
const CHANNEL_HZ = 10000;
const TAPS = 161;
const BLOCK = AUDIO_RATE / 50;
// Kvantiseringsbruset från 8-bitars omvandlaren i kanalen (vitt brus, steg 1/127,5 i I och Q): ungefär −60,7 dBFS.
// Ett brusgolv nära det värdet betyder att förstärkningen är för låg.
const QUANT_DBFS = Math.round((10 * Math.log10(2 * Math.pow(1 / 127.5, 2) / 12) + 10 * Math.log10(2 * CHANNEL_HZ / IQ_RATE)) * 10) / 10;

function lowpassTaps(n, fc, fs) {
    const h = new Float64Array(n);
    const m = (n - 1) / 2;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const x = i - m;
        const sinc = x === 0 ? 2 * fc / fs : Math.sin(2 * Math.PI * fc / fs * x) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
        h[i] = sinc * w;
        sum += h[i];
    }
    for (let i = 0; i < n; i++) h[i] /= sum;
    return Float32Array.from(h);
}
const dbfs = (p) => 10 * Math.log10(Math.max(p, 1e-12));

class IqDemod {
    // onBlock(audio: Int16Array(480), { power_dbfs, clip, samples })
    constructor({ onBlock }) {
        this.onBlock = onBlock || (() => {});
        this.h = lowpassTaps(TAPS, CHANNEL_HZ, IQ_RATE);
        this.reset();
    }
    reset() {
        this.ri = new Float32Array(TAPS * 2);   // ringbuffert, varje sampel skrivs två gånger så att filtret läser i en följd
        this.rq = new Float32Array(TAPS * 2);
        this.pos = 0;
        this.n = 0;             // sampel sedan start (för blandningen och decimeringen)
        this.half = null;       // en ensam byte (I) som väntar på sin Q
        this.pi = 0; this.pq = 0;
        this.audio = new Int16Array(BLOCK); this.an = 0;
        this.pw = 0; this.clip = 0; this.raw = 0;
    }
    push(buf) {
        let i = 0;
        const len = buf.length;
        if (this.half !== null && len) { this.sample(this.half, buf[0]); this.half = null; i = 1; }
        for (; i + 1 < len; i += 2) this.sample(buf[i], buf[i + 1]);
        if (i < len) this.half = buf[i];
    }
    sample(bi, bq) {
        this.raw++;
        if (bi === 0 || bi === 255) this.clip++;
        if (bq === 0 || bq === 255) this.clip++;
        let x = (bi - 127.5) / 127.5, y = (bq - 127.5) / 127.5;
        // Upp 60 kHz: (x + jy) · j^n
        let re, im;
        switch (this.n & 3) {
            case 0: re = x; im = y; break;
            case 1: re = -y; im = x; break;
            case 2: re = -x; im = -y; break;
            default: re = y; im = -x;
        }
        const p = this.pos;
        this.ri[p] = this.ri[p + TAPS] = re;
        this.rq[p] = this.rq[p + TAPS] = im;
        this.pos = p + 1 === TAPS ? 0 : p + 1;
        this.n++;
        if (this.n % DECIM) return;
        // Filtret: äldsta sampel först (ri[pos] … ri[pos + TAPS − 1])
        const h = this.h, ri = this.ri, rq = this.rq, o = this.pos;
        let a = 0, b = 0;
        for (let k = 0; k < TAPS; k++) { const c = h[k]; a += c * ri[o + k]; b += c * rq[o + k]; }
        this.pw += a * a + b * b;
        // Diskriminatorn: vinkeln av z · konj(z föregående)
        const r = a * this.pi + b * this.pq, q = b * this.pi - a * this.pq;
        this.pi = a; this.pq = b;
        let s = Math.round(Math.atan2(q, r) / Math.PI * 16384);
        if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
        this.audio[this.an++] = s;
        if (this.an === BLOCK) {
            const out = this.audio;
            const info = { power_dbfs: dbfs(this.pw / BLOCK), clip: this.clip, samples: this.raw * 2 };
            this.audio = new Int16Array(BLOCK); this.an = 0; this.pw = 0; this.clip = 0; this.raw = 0;
            this.onBlock(out, info);
        }
    }
}

module.exports = { IqDemod, IQ_RATE, AUDIO_RATE, OFFSET_HZ, CHANNEL_HZ, QUANT_DBFS, lowpassTaps };
