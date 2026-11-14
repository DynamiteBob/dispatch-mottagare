// Syntetisk radiosignal för testerna (0.4.0): I och Q som osignerade byte som från rtl_sdr i 240 000 sampel per sekund.
//  - audio: ljud i 24 kHz (Int16Array) som FM-moduleras på en bärvåg med amplituden amp (1 = fullt utslag), avvikelse DEV_HZ
//    vid ljudnivån 8 000. Bärvågen ligger offsetHz från stickans mittfrekvens (förvalt −60 kHz, där mottagaren lägger kanalen).
//    amp = 0 eller audio = null ger ingen bärvåg.
//  - sigma: brus (standardavvikelse i I och Q, i fullt utslag)
//  - strong: amplitud för en omodulerad bärvåg 90 kHz över mittfrekvensen (utanför kanalen), som kan överstyra stickan
// Värdena avrundas till heltal 0–255 som i stickan, så kvantiseringen och klippningen blir som i verkligheten.
'use strict';
const IQ_RATE = 240000;
const DEV_HZ = 2500;
let seed = 4711;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed + 0.5) / 0x80000000; };
function iq({ audio, seconds, amp, sigma, strong, offsetHz }) {
    const up = IQ_RATE / 24000;
    const n = audio ? audio.length * up : Math.round((seconds || 1) * IQ_RATE);
    const off = offsetHz === undefined ? -IQ_RATE / 4 : offsetHz;
    const buf = Buffer.alloc(n * 2);
    let ph = 0, phs = 0;
    const a = amp || 0, sg = sigma || 0, st = strong || 0;
    for (let i = 0; i < n; i++) {
        const au = audio ? audio[Math.floor(i / up)] / 8000 : 0;
        ph += 2 * Math.PI * (off + DEV_HZ * au) / IQ_RATE;
        if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
        let x = a * Math.cos(ph), y = a * Math.sin(ph);
        if (st) { phs += 2 * Math.PI * 90000 / IQ_RATE; x += st * Math.cos(phs); y += st * Math.sin(phs); }
        if (sg) {
            const u1 = rnd(), u2 = rnd(), r = Math.sqrt(-2 * Math.log(u1)) * sg;
            x += r * Math.cos(2 * Math.PI * u2); y += r * Math.sin(2 * Math.PI * u2);
        }
        buf[i * 2] = Math.max(0, Math.min(255, Math.round(127.5 + x * 127.5)));
        buf[i * 2 + 1] = Math.max(0, Math.min(255, Math.round(127.5 + y * 127.5)));
    }
    return buf;
}
module.exports = { iq, IQ_RATE, DEV_HZ };
