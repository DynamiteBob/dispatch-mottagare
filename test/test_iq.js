// Test av mottagningen med rtl_sdr (0.4.0): FM-demodulering och signalstyrka (src/iq.js), effekt och klippning per ram
// (src/ffskstream.js), Sdr med den falska rtl_sdr (läget, förstärkningen ur stderr, brusgolv, reserven rtl_fm) och
// mätningen av förstärkningen (scanGain, suggestGain). Påhittade värden (ID 12345, 59° 20,1234′ N 018° 04,5678′ E).
//   node test/test_iq.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mottagare-iq-'));
const SDR_LOG = path.join(tmp, 'sdr.log'), FM_LOG = path.join(tmp, 'fm.log');
process.env.MOTTAGARE_RTL_SDR = path.join(__dirname, 'falska', 'rtl_sdr');
process.env.MOTTAGARE_RTL_FM = path.join(__dirname, 'falska', 'rtl_fm');
process.env.MOTTAGARE_SYSFS_USB = path.join(tmp, 'usb');
process.env.MOTTAGARE_SCAN_GAINS = '0,20,30,36.4,40.2,49.6';
process.env.MOTTAGARE_SCAN_SKIP_MS = '200';
process.env.MOTTAGARE_SCAN_MEASURE_MS = '500';
process.env.FAKE_SDR_LOG = SDR_LOG;
process.env.FAKE_RTL_LOG = FM_LOG;

const ffsk = require('../src/ffsk');
const { IqDemod, QUANT_DBFS } = require('../src/iq');
const { FfskStream } = require('../src/ffskstream');
const { Sdr, suggestGain, SCAN_GAINS, MIN_GAIN } = require('../src/sdr');
const G = require('./iqgen');
const L = require('./ljud');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 600))); if (!ok) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 10000); for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); } }
const near = (a, b, d) => typeof a === 'number' && Math.abs(a - b) <= d;

const PAY = '8312592012340180045678004512345033' + '00';
const frame = ffsk.encodeBits(['810004E02000', PAY.slice(0, 12), PAY.slice(12, 24), PAY.slice(24, 36)].map(h => BigInt('0x' + h)));
const bits = Array.from({ length: 600 }, (_, i) => i % 2 ? 0 : 1).concat(frame);
const audio = L.concat(new Int16Array(24000), L.ffsk(bits, 24000, 8000, 1), new Int16Array(36000));

function demodulate(buf) {
    const blocks = [], power = [];
    let clip = 0, samples = 0;
    const d = new IqDemod({ onBlock: (a, i) => { blocks.push(a); power.push(i.power_dbfs); clip += i.clip; samples += i.samples; } });
    for (let o = 0, k = 0; o < buf.length; k++) { const n = 16384 + (k % 3); d.push(buf.subarray(o, o + n)); o += n; }   // bitar av udda storlek också
    return { audio: L.concat(...blocks), power, clip, samples };
}

(async () => {
    // ---------- iq.js ----------
    let r = demodulate(G.iq({ audio, amp: 0.1, sigma: 0.002 }));
    let fr = ffsk.decode(r.audio, 24000);
    check('demoduleringen ger ljud som FFSK-avkodaren läser', fr.length === 1 && fr[0].payload === PAY, fr);
    const sorted = r.power.slice().sort((a, b) => a - b);
    check('effekten i kanalen: amplitud 0,1 ger −20 dBFS', near(sorted[Math.floor(sorted.length / 2)], -20, 0.5), sorted[Math.floor(sorted.length / 2)]);
    check('ingen klippning med svag signal', r.clip === 0, r.clip);
    r = demodulate(G.iq({ seconds: 1, sigma: 0.01 }));
    const p = r.power.slice().sort((a, b) => a - b)[Math.floor(r.power.length / 2)];
    check('brusgolvet: σ 0,01 ger cirka −47,8 dBFS i kanalen', near(p, -47.8, 1), p);
    r = demodulate(G.iq({ seconds: 1, sigma: 0 }));
    check('kvantiseringsgränsen ligger under −60 dBFS', QUANT_DBFS < -60 && QUANT_DBFS > -62, QUANT_DBFS);
    r = demodulate(G.iq({ audio, amp: 0.05, sigma: 0.002, offsetHz: -60000 + 40000 }));
    fr = ffsk.decode(r.audio, 24000);
    const pmax = Math.max(...r.power);
    check('en signal 40 kHz bredvid kanalen syns inte', fr.length === 0 && pmax < -40, { n: fr.length, pmax });
    r = demodulate(G.iq({ audio, amp: 0.05, sigma: 0.002, strong: 1.5 }));
    fr = ffsk.decode(r.audio, 24000);
    check('stark bärvåg utanför kanalen: klippningen räknas', r.clip > 0 && r.clip / r.samples > 0.01, { clip: r.clip, n: r.samples });

    // ---------- ffskstream.js: signal_dbfs och clipped per ram ----------
    const runStream = (buf) => {
        const out = [];
        let cur = null;
        const st = new FfskStream({ rate: 24000, onFrames: (l) => out.push(...l), info: () => ({ open: false, quiet: null, power_dbfs: cur && cur.power_dbfs, clip: cur && cur.clip }) });
        const d = new IqDemod({ onBlock: (a, i) => { cur = i; st.push(a); } });
        for (let o = 0; o < buf.length; o += 16384) d.push(buf.subarray(o, o + 16384));
        return out;
    };
    const audio2 = L.concat(audio, new Int16Array(48000));
    let frames = runStream(G.iq({ audio: audio2, amp: 0.03, sigma: 0.002 }));
    check('ramen får signal_dbfs (amplitud 0,03 = −30,5 dBFS)', frames.length === 1 && near(frames[0].signal_dbfs, -30.5, 0.7) && frames[0].clipped === false, frames);
    frames = runStream(G.iq({ audio: audio2, amp: 0.03, sigma: 0.002, strong: 0.99 }));
    check('ramen märks clipped när stickan klipper under meddelandet', frames.length === 1 && frames[0].clipped === true, frames);

    // ---------- suggestGain ----------
    const st = (gain, noise, clip) => ({ gain, noise_dbfs: noise, clip_pct: clip || 0 });
    let sg = suggestGain([st(0, -60.5), st(20, -60.4), st(30, -58), st(36.4, -54), st(40.2, -51), st(49.6, -42)]);
    check('förslaget: lägsta steget där brusgolvet stigit 8 dB', sg && sg.gain === 40.2 && sg.reason === 'ok', sg);
    sg = suggestGain([st(0, -60.5), st(20, -60.4), st(30, -58), st(36.4, -54), st(40.2, -51, 0.2), st(49.6, -42, 3)]);
    check('steg som klipper väljs inte: det högsta utan klippning', sg && sg.gain === 36.4 && sg.reason === 'low', sg);
    sg = suggestGain([st(0, -60, 1), st(20, -59, 2)]);
    check('klipper på alla steg: lägsta steget, orsak clip', sg && sg.gain === 0 && sg.reason === 'clip', sg);
    check('inga mätvärden: inget förslag', suggestGain([{ gain: 0, error: 'x' }]) === null);
    // 0.4.2: nästa steg ska också ligga HOLD_DB (6) över det lägsta. Värdena ur en verklig mätning (2026-11-14), utan steget 0.
    const real = [[7.7, -57.1], [14.4, -56.8], [19.7, -56.7], [25.4, -56.4], [28, -56.2], [32.8, -54.7], [36.4, -52.3], [38.6, -50.6],
                  [40.2, -48.2], [42.1, -50], [43.9, -46.8], [44.5, -46.7], [48, -46.4], [49.6, -46.9]].map(([g, n]) => st(g, n));
    sg = suggestGain(real);
    check('verklig mätning: 40,2 dB (42,1 dB ligger 7,1 dB över, alltså minst 6)', sg && sg.gain === 40.2 && sg.reason === 'ok', sg);
    sg = suggestGain([st(0.9, -60), st(20, -51.5), st(25.4, -59), st(30, -56), st(36.4, -53), st(40.2, -51.8), st(49.6, -45)]);
    check('en enstaka hög mätning ger inte förslaget (20 dB, nästa steg bara +1)', sg && sg.gain === 40.2 && sg.reason === 'ok', sg);
    sg = suggestGain([st(0.9, -60), st(30, -57), st(40.2, -51)]);
    check('det sista steget kan väljas (inget steg efter)', sg && sg.gain === 40.2 && sg.reason === 'ok', sg);
    check('SCAN_GAINS hoppar över 0 (automatisk i rtl_sdr)', !SCAN_GAINS.includes(0) && SCAN_GAINS.length === 5 && MIN_GAIN === 0.9, SCAN_GAINS);

    // ---------- Sdr med den falska rtl_sdr ----------
    const got = [];
    const sdr = new Sdr({ onRecording: () => {}, onFrames: (l) => got.push(...l) });
    sdr.apply({ freq_hz: 85500000, gain: 40.2, ppm: 0, decode: true, record: false });
    const running = await until(() => sdr.status().state === 'running', 5000);
    check('rtl_sdr startar med kanalen + 60 kHz, 240 000 sampel/s och -g', running && /^-f 85560000 -s 240000 -b 16384 -g 40.2 -$/.test(fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').pop()),
        fs.readFileSync(SDR_LOG, 'utf8'));
    const f1 = await until(() => got.length && got, 9000);
    check('meddelandet avkodas via rtl_sdr', f1 && f1[0].payload === PAY, got);
    // dBFS = dBm + förstärkning + 30 = −95 + 40,2 + 30 = −24,8
    check('signal_dbfs stämmer med den falska stickan (−24,8)', f1 && near(f1[0].signal_dbfs, -24.8, 1) && f1[0].clipped === false, f1 && f1[0]);
    check('förstärkningen läses ur rtl_sdr (40,2 dB)', sdr.gainDb === 40.2, sdr.gainDb);
    await until(() => sdr.status().noise_dbfs !== null, 5000);
    let s = sdr.status();
    check('livssignalen: läget iq, brusgolv, klippning 0, kvantiseringsgränsen', s.mode === 'iq' && Number.isFinite(s.noise_dbfs) && s.noise_dbfs < -40 && s.clip_pct === 0 && s.quant_dbfs === QUANT_DBFS, s);

    // Auto: ingen -g och gain_db null
    sdr.apply({ freq_hz: 85500000, gain: 'auto', ppm: 0, decode: true, record: false });
    await until(() => sdr.status().state === 'running', 5000);
    await sleep(400);
    check('Auto: ingen -g och gain_db null', !/-g/.test(fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').pop()) && sdr.gainDb === null, sdr.gainDb);
    check('Auto: gain_raised är falskt', sdr.status().gain_raised === false, sdr.status());

    // 0.4.2: 0 dB vore automatisk förstärkning; 0,9 dB används
    sdr.apply({ freq_hz: 85500000, gain: 0, ppm: 0, decode: true, record: false });
    await until(() => sdr.status().state === 'running' && sdr.gainDb !== null, 5000);
    check('0 dB: rtl_sdr får -g 0.9, gain_db 0,9 och gain_raised', / -g 0\.9 -$/.test(fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').pop())
        && sdr.gainDb === 0.9 && sdr.status().gain_raised === true, [fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').pop(), sdr.gainDb]);

    // Reserven: rtl_fm, ingen signalstyrka
    got.length = 0;
    sdr.apply({ freq_hz: 85500000, gain: 40.2, ppm: 0, decode: true, record: false, rx_mode: 'fm' });
    await until(() => sdr.status().state === 'running', 5000);
    check('Endast ljud: rtl_fm startas som förut', fs.existsSync(FM_LOG) && /^-f 85500000 -M fm -s 24000 -E dc -g 40.2 -$/.test(fs.readFileSync(FM_LOG, 'utf8').trim().split('\n').pop()), fs.existsSync(FM_LOG) && fs.readFileSync(FM_LOG, 'utf8'));
    const f2 = await until(() => got.length && got, 9000);
    check('Endast ljud: avkodas utan signalstyrka', f2 && f2[0].payload === PAY && f2[0].signal_dbfs === null && sdr.status().mode === 'fm' && sdr.status().noise_dbfs === null, f2 && f2[0]);

    // Mätningen av förstärkningen
    sdr.apply({ freq_hz: 85500000, gain: 40.2, ppm: 0, decode: true, record: false });
    await until(() => sdr.status().state === 'running', 5000);
    const before = fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').length;
    const t0 = Date.now();
    const scanP = sdr.scanGain();
    await sleep(300);
    check('under mätningen är läget scanning', sdr.status().state === 'scanning' && sdr.status().scan.total === 5, sdr.status());
    let res = await scanP;
    const lines = fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').slice(before);
    check('ett rtl_sdr per steg med stegets förstärkning, inget -g 0', ['20', '30', '36.4', '40.2', '49.6'].every((g, i) => lines[i] && lines[i].includes(`-g ${g} `))
        && !lines.some(l => l.includes('-g 0 ')), lines);
    check('mätvärden för varje steg', res.steps.length === 5 && res.steps.every(x => Number.isFinite(x.noise_dbfs) && x.clip_pct === 0), res.steps);
    check('brusgolvet stiger med förstärkningen', res.steps[4].noise_dbfs - res.steps[0].noise_dbfs > 12, res.steps.map(x => x.noise_dbfs));
    check('förslaget är 40,2 dB (första steget 8 dB över omvandlarens brus)', res.suggestion && res.suggestion.gain === 40.2 && res.suggestion.reason === 'ok', res.suggestion);
    check('mätningen tar mindre än 10 s med fem steg', Date.now() - t0 < 10000, Date.now() - t0);
    await until(() => sdr.status().state === 'running', 5000);
    check('mottagningen startar igen efter mätningen', sdr.status().state === 'running' && / -g 40\.2 -$/.test(fs.readFileSync(SDR_LOG, 'utf8').trim().split('\n').pop()));
    let e = null;
    try { const p1 = sdr.scanGain(); await sleep(50); await sdr.scanGain().catch(x => { e = x; }); await p1; } catch (x) { e = e || x; }
    check('två mätningar samtidigt går inte', e && /pågår/.test(e.message), e && e.message);

    // Stark signal bredvid: klippning på höga steg
    process.env.FAKE_SDR_STRONG_DBM = '-70';
    await until(() => sdr.status().state === 'running', 5000);
    res = await sdr.scanGain();
    check('stark signal bredvid: höga steg klipper', res.steps.find(x => x.gain === 49.6).clip_pct > 0.05 && res.steps.find(x => x.gain === 20).clip_pct === 0, res.steps);
    check('stark signal bredvid: förslaget klipper inte', res.suggestion && res.steps.find(x => x.gain === res.suggestion.gain).clip_pct <= 0.05, res.suggestion);
    delete process.env.FAKE_SDR_STRONG_DBM;

    sdr.apply({ freq_hz: 0 });
    let e2 = null;
    await sdr.scanGain().catch(x => { e2 = x; });
    check('utan frekvens går det inte att mäta', e2 && /frekvens/.test(e2.message));
    sdr.shutdown();
    console.log(fails ? `\n${fails} FEL` : '\nAlla tester OK');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
