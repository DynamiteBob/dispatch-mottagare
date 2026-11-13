// Test av avkodningen av hela ljudströmmen (src/ffskstream.js, 0.3.0) och samspelet med squelchen.
//  - ramar på alla lägen i förhållande till fönstren rapporteras exakt en gång, i ordning, med rätt tid
//  - ljudet kan komma i bitar av olika storlek
//  - en svag sändning som inte öppnar squelchen avkodas ändå (squelch_open = false), en stark med squelch_open = true
//  - samma meddelande två gånger efter varandra blir två ramar
// Påhittade värden (ID 12345 och uppåt, 59° 20,1234′ N 018° 04,5678′ E).
//   node test/test_ffskstream.js
'use strict';
const ffsk = require('../src/ffsk');
const { FfskStream } = require('../src/ffskstream');
const { Squelch, RATE } = require('../src/squelch');
const aurora = require('../src/aurora');
const L = require('./ljud');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 600))); if (!ok) fails++; };
const pay = (id) => `83125920123401800456780045${id}033` + '00';
const frameBits = (id) => ffsk.encodeBits(['810004E02000', ...[0, 12, 24].map(o => pay(id).slice(o, o + 12))].map(h => BigInt('0x' + h)));

// Strömmen: brus med ramar var 1,37 s, så att de hamnar på olika ställen i förhållande till fönstren (steg 1,4 s)
function build(n, opts) {
    const parts = [L.noise(1.0, RATE, 300)];
    const starts = [];
    let t = 1.0;
    for (let k = 0; k < n; k++) {
        const bits = frameBits(String(12345 + k));
        const sig = L.ffsk(bits, RATE, (opts && opts.amp) || 8000, (opts && opts.noise) || 300);
        starts.push(t + 24 / 1200);   // synkordet efter förspelet
        parts.push(sig);
        t += sig.length / RATE;
        const gap = 1.37 - sig.length / RATE + (k % 3) * 0.011;
        parts.push(L.noise(gap, RATE, 300));
        t += Math.round(gap * RATE) / RATE;
    }
    parts.push(L.noise(2.5, RATE, 300));
    return { samples: L.concat(...parts), starts };
}

function run(samples, chunkSizes, info) {
    let clock = 1_000_000;
    const got = [];
    const st = new FfskStream({ rate: RATE, onFrames: (l) => got.push(...l), now: () => clock, info });
    let o = 0, i = 0;
    while (o < samples.length) {
        const n = Math.min(chunkSizes[i++ % chunkSizes.length], samples.length - o);
        clock = 1_000_000 + (o + n) * 1000 / RATE;
        st.push(L.toBuf(samples.subarray(o, o + n)));
        o += n;
    }
    return { got, st };
}

const N = 15;
const { samples, starts } = build(N);
for (const [name, sizes] of [['bitar om 4 096 sampel', [4096]], ['bitar av olika storlek', [17, 3000, 777, 12000, 1, 5000]], ['en enda stor bit', [samples.length]]]) {
    const { got } = run(samples, sizes);
    const ids = got.map(g => aurora.parse(g.payload).id);
    const want = Array.from({ length: N }, (_, k) => String(12345 + k));
    check(`${name}: varje ram exakt en gång och i ordning`, JSON.stringify(ids) === JSON.stringify(want), ids);
    const errs = got.map((g, k) => Math.abs(g.at_ms - (1_000_000 + starts[k] * 1000)));
    check(`${name}: tiden stämmer inom 20 ms`, errs.length === N && errs.every(e => e < 20), errs.map(Math.round));
    check(`${name}: hela ramar (fyra kodord)`, got.every(g => g.codewords === 4), got.map(g => g.codewords));
}

// Samma meddelande två gånger direkt efter varandra (radion upprepar)
{
    const one = L.ffsk(frameBits('12345'), RATE, 8000, 300);
    const s2 = L.concat(L.noise(1, RATE, 300), one, L.noise(0.4, RATE, 300), one, L.noise(3, RATE, 300));
    const { got } = run(s2, [2400]);
    check('samma meddelande två gånger: två ramar', got.length === 2 && got[0].payload === got[1].payload && got[1].at_ms - got[0].at_ms > 500, got.map(g => g.at_ms));
}

// Med squelchen: stark sändning öppnar den, svag gör det inte men avkodas ändå
{
    const strong = L.ffsk(Array.from({ length: 600 }, (_, i) => i % 2 ? 0 : 1).concat(frameBits('11111')), RATE, 8000, 200);   // långt förspel: blir en inspelning
    const weak = L.ffsk(frameBits('22222'), RATE, 8000, 3500);
    const s3 = L.concat(L.noise(2, RATE), strong, L.noise(2, RATE), weak, L.noise(3, RATE));
    const recs = [];
    const sq = new Squelch({ rate: RATE, config: { squelch_db: 12, record: true }, onRecording: (r) => recs.push(r) });
    const info = () => ({ open: sq.open, quiet: sq.noise !== null && sq.level !== null ? sq.noise - sq.level : null });
    let clock = 0;
    const got = [];
    const st = new FfskStream({ rate: RATE, onFrames: (l) => got.push(...l), now: () => clock, info });
    for (let o = 0; o < s3.length; o += 2400) {
        const b = L.toBuf(s3.subarray(o, o + 2400));
        clock += 100;
        sq.push(b);
        st.push(b);
    }
    const byId = Object.fromEntries(got.map(g => [aurora.parse(g.payload).id, g]));
    check('stark sändning: avkodad med squelchen öppen', byId['11111'] && byId['11111'].squelch_open && byId['11111'].level_db > 12, byId['11111']);
    check('svag sändning: avkodad fast squelchen var stängd', byId['22222'] && byId['22222'].squelch_open === false, byId['22222']);
    check('bara den starka blev en inspelning', recs.length === 1, recs.map(r => r.duration_ms));
}

// Bara brus en längre stund
{
    const { got, st } = run(L.noise(20, RATE), [4800]);
    check('20 s brus: inga ramar', got.length === 0 && st.windows >= 13, { n: got.length, w: st.windows });
}

console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
process.exit(fails ? 1 : 0);
