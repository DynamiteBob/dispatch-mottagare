// Test av källan Serieport (J3 på en Aurora, src/serial.js, 0.4.1). Porten är en FIFO i testerna och stty är falsk.
//  - kontrollsumman, $PNIGPS skickas vidare, andra rader räknas per typ, de senaste raderna, rader delade över flera block
//  - portarna listas (by-id och ttyUSB/ttyACM, utan dubbletter), stty får hastigheten och rått läge
//  - porten saknas eller stty misslyckas: fel och nytt försök; samma inställningar öppnar inte porten igen; källan RTL-SDR: av
// Påhittade värden (ID 12345, 59° 20,1234′ N 018° 04,5678′ E).
//   node test/test_serial.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mottagare-serie-'));
const DEV = path.join(tmp, 'dev');
fs.mkdirSync(path.join(DEV, 'serial', 'by-id'), { recursive: true });
const STTY_LOG = path.join(tmp, 'stty.log');
process.env.MOTTAGARE_SERIAL_DEVDIR = DEV;
process.env.MOTTAGARE_STTY = path.join(__dirname, 'falska', 'stty');
process.env.FAKE_STTY_LOG = STTY_LOG;
const { SerialJ3, nmeaOk, listPorts } = require('../src/serial');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 600))); if (!ok) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 5000); for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } }
const nmea = (b) => { let x = 0; for (const c of b) x ^= c.charCodeAt(0); return `$${b}*${x.toString(16).toUpperCase().padStart(2, '0')}`; };
const J1 = nmea('PNIGPS,123450,33,,5920.1234,N,01804.5678,E,,,048.4,,,,,,');

(async () => {
    check('kontrollsumman', nmeaOk(J1) && !nmeaOk(J1.replace(/\*..$/, '*00')) && !nmeaOk('PNIGPS,1') && nmeaOk(nmea('GPRMC,1,2')));

    // Portarna
    const usb = path.join(DEV, 'ttyUSB0');
    execFileSync('mkfifo', [usb]);
    fs.writeFileSync(path.join(DEV, 'ttyACM1'), '');
    fs.writeFileSync(path.join(DEV, 'ttyS0'), '');
    fs.symlinkSync('../../ttyUSB0', path.join(DEV, 'serial', 'by-id', 'usb-FTDI_FT232R_USB_UART_A1B2C3-if00-port0'));
    const ports = listPorts();
    check('portarna: by-id med namn, ttyACM, inte ttyS och ingen dubblett', ports.length === 2 && ports[0].name === 'FTDI FT232R USB UART A1B2C3' && ports[0].dev === 'ttyUSB0'
          && ports[1].path === path.join(DEV, 'ttyACM1'), ports);

    // Läsning
    const got = [];
    const s = new SerialJ3({ onLine: (l) => got.push(l) });
    check('källan RTL-SDR: av', s.status().state === 'off');
    const w = fs.openSync(usb, fs.constants.O_RDWR);   // håller FIFO:n öppen
    s.apply({ source: 'serial', serial_port: ports[0].path, serial_baud: 9600 });
    check('porten öppnas', !!(await until(() => s.status().state === 'running')), s.status());
    const sttyArgs = fs.readFileSync(STTY_LOG, 'utf8').trim();
    check('stty: hastighet och rått läge', sttyArgs === `-F ${ports[0].path} 9600 raw -echo cs8 -cstopb -parenb clocal`, sttyArgs);
    fs.writeSync(w, `${J1}\r\n${nmea('GPRMC,1,2')}\r\n$PNIGPS,1*00\r\nskrap\r\n${J1.slice(0, 20)}`);
    await sleep(80);
    fs.writeSync(w, `${J1.slice(20)}\r\n`);
    await until(() => got.length === 2);
    const st = s.status();
    check('$PNIGPS skickas vidare, även delad över två block', got.length === 2 && got.every(l => l === J1), got);
    check('räknare: rader, positioner, kontrollsummefel och typer', st.lines === 5 && st.ok === 2 && st.bad_checksum === 1 && st.types.PNIGPS === 3 && st.types.GPRMC === 1 && st.types['(okänd)'] === 1, st);
    check('de senaste raderna', st.recent.length === 5 && st.recent[0].line === J1 && st.recent[3].line === 'skrap', st.recent);
    // Samma inställningar: porten öppnas inte igen
    const n0 = fs.readFileSync(STTY_LOG, 'utf8').trim().split('\n').length;
    s.apply({ source: 'serial', serial_port: ports[0].path, serial_baud: 9600, freq_hz: 1 });
    await sleep(100);
    check('samma port och hastighet: öppnas inte igen', fs.readFileSync(STTY_LOG, 'utf8').trim().split('\n').length === n0);
    // Ny hastighet: öppnas igen
    s.apply({ source: 'serial', serial_port: ports[0].path, serial_baud: 4800 });
    check('ny hastighet: stty igen', !!(await until(() => fs.readFileSync(STTY_LOG, 'utf8').includes(' 4800 raw'))));
    // Ingen port vald
    s.apply({ source: 'serial', serial_port: '' });
    check('ingen port: no_port', s.status().state === 'no_port' && /Ingen serieport/.test(s.status().error));
    // Porten saknas
    s.apply({ source: 'serial', serial_port: path.join(DEV, 'ttyUSB9') });
    check('porten saknas: fel och nytt försök', s.status().state === 'error' && /finns inte/.test(s.status().error) && !!s.timer, s.status());
    // stty misslyckas
    process.env.FAKE_STTY_FAIL = '1';
    s.apply({ source: 'serial', serial_port: ports[0].path, serial_baud: 9600 });
    check('stty misslyckas: felet visas', !!(await until(() => s.status().state === 'error' && /ställas in/.test(s.status().error))), s.status());
    delete process.env.FAKE_STTY_FAIL;
    // Tillbaka till RTL-SDR
    s.apply({ source: 'sdr' });
    check('källan RTL-SDR: porten stängs', s.status().state === 'off' && !s.stream);
    s.shutdown();
    fs.closeSync(w);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
