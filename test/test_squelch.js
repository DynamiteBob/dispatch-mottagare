// Squelchen och inspelningarna: öppnar på signal, stänger på brus, förinspelning, max längd, kort brusspik kastas
'use strict';
const { Squelch, RATE } = require('../src/squelch');
const { wav, readWav } = require('../src/wav');
const L = require('./ljud');
let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x))); if (!ok) fails++; };

const bits = Array.from({ length: 1200 }, (_, i) => (i * 7919 % 13) > 6 ? 1 : 0);
let recs = [];
let q = new Squelch({ config: { squelch_db: 10, record_max_s: 30, freq_hz: 69718750 }, onRecording: (r) => recs.push(r) });
q.push(L.toBuf(L.concat(L.noise(3, RATE), L.ffsk(bits, RATE), L.noise(2, RATE))));
check('en inspelning av en sekund FFSK', recs.length === 1 && !recs[0].short, recs.map(r => r.duration_ms));
const r = recs[0] || {};
check('längden är signalen + förinspelning + eftersläp (1,0–1,8 s)', r.duration_ms >= 1000 && r.duration_ms <= 1800, r.duration_ms);
check('frekvensen följer med', r.freq_hz === 69718750);
check('signalen ligger långt under bruset (level_db > 15)', r.level_db > 15, r.level_db);
check('squelchen är stängd efteråt', !q.open && q.status().noise_db !== null, q.status());

recs = [];
q = new Squelch({ config: { squelch_db: 10 }, onRecording: (x) => recs.push(x) });
q.push(L.toBuf(L.concat(L.noise(2, RATE), L.tone(0.06, 1500, RATE), L.noise(2, RATE))));
check('en kort spik (60 ms) blir ett kort avsnitt (bara för avkodaren)', recs.length <= 1 && recs.every(x => x.short), recs.map(x => [x.duration_ms, x.short]));

recs = [];
q = new Squelch({ config: { squelch_db: 10, record_max_s: 5 }, onRecording: (x) => recs.push(x) });
q.push(L.toBuf(L.concat(L.noise(2, RATE), L.tone(12, 1200, RATE), L.noise(2, RATE), L.tone(1, 1800, RATE), L.noise(1, RATE))));
check('bärvåg i 12 s med max 5 s: en inspelning på 5 s, sedan inget förrän squelchen stängt, sedan nästa',
      recs.length === 2 && Math.abs(recs[0].duration_ms - 5000) <= 20 && recs[0].cut && !recs[1].cut, recs.map(x => [x.duration_ms, x.cut]));

recs = [];
q = new Squelch({ config: { squelch_db: 10, record: false }, onRecording: (x) => recs.push(x) });
q.push(L.toBuf(L.concat(L.noise(2, RATE), L.tone(2, 1200, RATE), L.noise(1, RATE))));
check('inspelning av: avsnittet går till avkodaren men räknas inte som inspelning', recs.length === 1 && q.status().recordings === 0);

recs = [];
q = new Squelch({ config: { squelch_db: 40 }, onRecording: (x) => recs.push(x) });
q.push(L.toBuf(L.concat(L.noise(2, RATE), L.tone(2, 1200, RATE, 8000, 1500), L.noise(1, RATE))));
check('squelch 40 dB: en svag signal öppnar inte', recs.length === 0, q.status());

// WAV
const w = wav(new Int16Array([0, 1000, -1000, 32767]), RATE);
const back = readWav(w);
check('WAV går att läsa tillbaka', back.rate === RATE && back.samples.length === 4 && back.samples[3] === 32767);

console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
process.exit(fails ? 1 : 0);
