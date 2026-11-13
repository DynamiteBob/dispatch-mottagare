// ============================================================================
// FFSK-avkodare för Ericsson Aurora (C50) med MPT1327-liknande signalering (se docs/aurora-ffsk.md)
//
// Ljudet kommer från rtl_fm (FM-demodulerat, 24 kHz). 1 200 bit/s, 1 200 Hz = 1 och 1 800 Hz = 0.
//  1. Blanda ner kring 1 500 Hz till basband (I/Q) och lågpassfiltrera (två glidande medelvärden på en halv bit).
//  2. Frekvensdiskriminator: vinkeln mellan två på varandra följande I/Q-värden ger frekvensen. Under 1 500 Hz = 1.
//  3. Bitarna läses i alla 20 möjliga lägen inom en bit; det läge som ger giltiga kodord vinner.
//  4. Efter sync-ordet (SYNT 3B28 från Aurora, SYNC C4D7 tas också) följer kodord om 64 bitar: 48 bitar data,
//     15 kontrollbitar (g(x) = x^15 + x^14 + x^13 + x^11 + x^4 + x^2 + 1, sista biten inverterad) och jämn paritet.
//     Kodorden läses så länge kontrollen stämmer (högst MAX_CW). Det första är adresskodordet (första biten 1).
// Polariteten avgörs av sync-ordet: hittas det inverterade sync-ordet inverteras alla bitar.
// ============================================================================
'use strict';

const BAUD = 1200;
const MAX_CW = 8;
const SYNCS = [{ name: 'SYNT', bits: 0x3B28 }, { name: 'SYNC', bits: 0xC4D7 }];

// Frekvensen (Hz kring 1 500) för varje ljudvärde
function discriminate(samples, rate) {
    const n = samples.length;
    const w = 2 * Math.PI * 1500 / rate;
    const half = Math.max(2, Math.round(rate / BAUD / 2));
    const I = new Float64Array(n), Q = new Float64Array(n);
    for (let k = 0; k < n; k++) { const x = samples[k] / 32768; I[k] = x * Math.cos(w * k); Q[k] = -x * Math.sin(w * k); }
    const ma = (a) => {   // glidande medelvärde över en halv bit
        const o = new Float64Array(n);
        let s = 0;
        for (let k = 0; k < n; k++) { s += a[k]; if (k >= half) s -= a[k - half]; o[k] = s / half; }
        return o;
    };
    const I2 = ma(ma(I)), Q2 = ma(ma(Q));
    const f = new Float64Array(n);
    for (let k = 1; k < n; k++) {
        const re = I2[k] * I2[k - 1] + Q2[k] * Q2[k - 1], im = Q2[k] * I2[k - 1] - I2[k] * Q2[k - 1];
        f[k] = Math.atan2(im, re) * rate / (2 * Math.PI);
    }
    // filtrets fördröjning: två medelvärden på en halv bit = en halv bit
    return { f, delay: half };
}

// Kontrollen för ett kodord (BigInt, 64 bitar)
function codewordOk(w) {
    const info = w >> 16n, chk = w & 0xffffn;
    let reg = info << 15n;
    const g = 0b1110100000010101n;
    for (let i = 62n; i >= 15n; i--) if ((reg >> i) & 1n) reg ^= g << (i - 15n);
    const crc = (reg & 0x7fffn) ^ 1n;
    let ones = 0;
    for (let x = w >> 1n; x; x >>= 1n) ones += Number(x & 1n);
    return (chk >> 1n) === crc && Number(w & 1n) === ones % 2;
}

function decode(samples, rate) {
    const { f, delay } = discriminate(samples, rate);
    const spb = rate / BAUD;
    const found = [];
    for (let off = 0; off < Math.round(spb); off++) {
        const nb = Math.floor((f.length - off - delay - spb) / spb);
        if (nb < 48) continue;
        const bits = new Uint8Array(nb);
        for (let k = 0; k < nb; k++) bits[k] = f[Math.round(off + delay + spb / 2 + k * spb)] < 0 ? 1 : 0;
        for (let i = 0; i + 16 + 128 <= nb; i++) {
            let v = 0;
            for (let j = 0; j < 16; j++) v = (v << 1) | bits[i + j];
            for (const s of SYNCS) {
                const inv = v === (s.bits ^ 0xffff);
                if (v !== s.bits && !inv) continue;
                const cws = [];
                for (let c = 0; c < MAX_CW; c++) {
                    const st = i + 16 + c * 64;
                    if (st + 64 > nb) break;
                    let w = 0n;
                    for (let j = 0; j < 64; j++) w = (w << 1n) | BigInt(bits[st + j] ^ (inv ? 1 : 0));
                    if (!codewordOk(w)) break;
                    cws.push(w);
                }
                if (cws.length < 2 || !((cws[0] >> 63n) & 1n)) continue;
                const hex = cws.map(w => (w >> 16n).toString(16).padStart(12, '0')).join('');
                const at = (off + i * spb) / rate;
                found.push({ at_s: Math.round(at * 1000) / 1000, sync: s.name, inverted: inv, codewords: cws.length,
                    address: hex.slice(0, 12).toUpperCase(), payload: hex.slice(12).toUpperCase() });
            }
        }
    }
    // Samma ram hittas i flera lägen inom en bit, ibland med ett kodord för lite: den längsta ramen inom 0,1 s vinner.
    // Samma innehåll längre ifrån är en ny sändning (radion sänder två eller tre gånger).
    const all = found.sort((a, b) => a.at_s - b.at_s);
    const out = [];
    for (const x of all) {
        const last = out[out.length - 1];
        if (last && x.at_s - last.at_s <= 0.1) { if (x.codewords > last.codewords) out[out.length - 1] = x; }
        else out.push(x);
    }
    return out;
}

// För testerna: modulera kodord till FFSK (fasen fortsätter mellan bitarna)
function crcBits(info48) {
    let reg = BigInt(info48) << 15n;
    const g = 0b1110100000010101n;
    for (let i = 62n; i >= 15n; i--) if ((reg >> i) & 1n) reg ^= g << (i - 15n);
    const crc = (reg & 0x7fffn) ^ 1n;
    let w = (BigInt(info48) << 16n) | (crc << 1n);
    let ones = 0;
    for (let x = w >> 1n; x; x >>= 1n) ones += Number(x & 1n);
    return w | BigInt(ones % 2);
}
function encodeBits(infos, sync) {
    const bits = [];
    for (let k = 0; k < 24; k++) bits.push(k % 2 ? 0 : 1);
    const sv = sync === undefined ? 0x3B28 : sync;
    for (let j = 15; j >= 0; j--) bits.push((sv >> j) & 1);
    for (const info of infos) { const w = crcBits(info); for (let j = 63n; j >= 0n; j--) bits.push(Number((w >> j) & 1n)); }
    return bits;
}

module.exports = { decode, codewordOk, crcBits, encodeBits, discriminate };
