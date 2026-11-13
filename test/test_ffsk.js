// Test av FFSK-avkodaren (src/ffsk.js) och tolkningen av Aurora-meddelandet (src/aurora.js).
// Ramarna byggs med påhittade värden (ID 12345, 59° 20,1234′ N 018° 04,5678′ E), moduleras som FFSK 1200 bit/s
// i 24 kHz med brus och avkodas igen.
//   node test/test_ffsk.js
'use strict';
const ffsk = require('../src/ffsk');
const aurora = require('../src/aurora');
const L = require('./ljud');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 500))); if (!ok) fails++; };
const RATE = 24000;
const ADDR = '810004E02000';
const pay = (fix, lat, lon, speed, id, status) => `${fix ? '83' : '03'}12${lat}${lon}${speed}${id}0${status}00`;
const P1 = pay(true, '59201234', '0180045678', '0045', '12345', '33');
const NOFIX = pay(false, '00000000', '0000000000', 'EEEE', '12345', '34');
const infos = (payload) => [ADDR, payload.slice(0, 12), payload.slice(12, 24), payload.slice(24, 36)].map(h => BigInt('0x' + h));
const signal = (bits, opts) => L.concat(L.noise(0.3, RATE, 300), L.ffsk(bits, RATE, (opts && opts.amp) || 8000, (opts && opts.noise) || 400), L.noise(0.3, RATE, 300));

// Kodorden
for (const h of infos(P1)) {
    const w = ffsk.crcBits(h);
    check(`kodordet ${h.toString(16)} går igenom kontrollen`, ffsk.codewordOk(w));
    check(`en ändrad bit i ${h.toString(16)} upptäcks`, !ffsk.codewordOk(w ^ (1n << 40n)) && !ffsk.codewordOk(w ^ 1n));
}

// En ram med fix
let fr = ffsk.decode(signal(ffsk.encodeBits(infos(P1))), RATE);
check('en ram hittas', fr.length === 1, fr);
check('adressen och data som skickades', fr[0] && fr[0].address === ADDR && fr[0].payload === P1 && fr[0].codewords === 4 && fr[0].sync === 'SYNT' && !fr[0].inverted, fr[0]);
check('tiden i inspelningen (efter 0,3 s brus och förspelet)', fr[0] && Math.abs(fr[0].at_s - (0.3 + 24 / 1200)) < 0.01, fr[0] && fr[0].at_s);
let p = aurora.parse(P1);
check('tolkningen: ID, fix, position, fart och status', p.known && p.id === '12345' && p.id_ext === '0' && p.fix && Math.abs(p.lat - (59 + 20.1234 / 60)) < 1e-6
    && Math.abs(p.lon - (18 + 4.5678 / 60)) < 1e-6 && p.speed_kmh === 4.5 && p.status === '33', p);

// Utan fix
fr = ffsk.decode(signal(ffsk.encodeBits(infos(NOFIX))), RATE);
p = aurora.parse(fr[0] ? fr[0].payload : '');
check('utan fix: ID och status, ingen position och ingen fart', p.id === '12345' && p.fix === false && p.lat === null && p.speed_kmh === null && p.status === '34', p);

// Omvänd polaritet (mottagarens diskriminator åt andra hållet)
const inv = ffsk.encodeBits(infos(P1)).map(b => 1 - b);
fr = ffsk.decode(signal(inv), RATE);
check('omvänd polaritet: samma data, inverted', fr.length === 1 && fr[0].payload === P1 && fr[0].inverted, fr);

// Två sändningar i samma inspelning (radion sänder två eller tre gånger)
const one = ffsk.encodeBits(infos(P1));
fr = ffsk.decode(L.concat(signal(one), signal(one)), RATE);
check('två sändningar: två ramar', fr.length === 2 && fr.every(x => x.payload === P1), fr.map(x => x.at_s));

// Fel i det sista kodordet: ramen kortas av, fel i det andra: bara adressen och ett kodord räcker inte
const bad = one.slice();
bad[24 + 16 + 3 * 64 + 10] ^= 1;
fr = ffsk.decode(signal(bad), RATE);
check('fel i sista kodordet: tre kodord', fr.length === 1 && fr[0].codewords === 3, fr);
const bad2 = one.slice();
bad2[24 + 16 + 64 + 5] ^= 1;
fr = ffsk.decode(signal(bad2), RATE);
check('fel i första datakodordet: ingen ram', fr.length === 0, fr);

// Svag signal med mer brus, och bara brus
fr = ffsk.decode(signal(one, { amp: 3000, noise: 900 }), RATE);
check('svag signal med brus avkodas', fr.length === 1 && fr[0].payload === P1, fr);
fr = ffsk.decode(L.noise(2, RATE), RATE);
check('bara brus: inga ramar', fr.length === 0, fr);
fr = ffsk.decode(L.tone(1, 1500, RATE), RATE);
check('en ton: inga ramar', fr.length === 0, fr);

// Okänt fältval: bara rådata
p = aurora.parse('8313' + P1.slice(4));
check('annan byte 1: inte tolkat', p.known === false && p.fix === true && p.id === null, p);
check('för kort: inte tolkat', aurora.parse('8312').known === false);

console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
process.exit(fails ? 1 : 0);
