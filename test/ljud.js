// Syntetiskt ljud för testerna: brus (som FM-demodulerat utan bärvåg) och FFSK/ton med lite brus (med bärvåg)
'use strict';
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 1.0; };
function noise(sec, rate, amp) { const n = Math.round(sec * rate), a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.max(-32767, Math.min(32767, Math.round(gauss() * (amp || 9000)))); return a; }
// FFSK 1200 bit/s: 1200 Hz = 1, 1800 Hz = 0, fasen fortsätter mellan bitarna
function ffsk(bits, rate, amp, noiseAmp) {
    const spb = rate / 1200, n = Math.round(bits.length * spb), a = new Int16Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const b = bits[Math.min(bits.length - 1, Math.floor(i / spb))];
        ph += 2 * Math.PI * (b ? 1200 : 1800) / rate;
        a[i] = Math.round(Math.sin(ph) * (amp || 8000) + gauss() * (noiseAmp || 200));
    }
    return a;
}
function tone(sec, hz, rate, amp, noiseAmp) { const n = Math.round(sec * rate), a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(2 * Math.PI * hz * i / rate) * (amp || 8000) + gauss() * (noiseAmp || 200)); return a; }
function concat(...parts) { const n = parts.reduce((t, p) => t + p.length, 0), a = new Int16Array(n); let o = 0; for (const p of parts) { a.set(p, o); o += p.length; } return a; }
function toBuf(a) { const b = Buffer.alloc(a.length * 2); for (let i = 0; i < a.length; i++) b.writeInt16LE(a[i], i * 2); return b; }
module.exports = { noise, ffsk, tone, concat, toBuf };
