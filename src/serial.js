// ============================================================================
// Serieport (J3) på en Ericsson Aurora (0.4.1)
//
// En Aurora med GPS skriver på kontakten J3 en rad för varje FFSK-position den tar emot från en annan radio:
//   $PNIGPS,<ID 5 siffror + tillägg 1 siffra>,<status>,,<latitud ggmm.mmmm>,N,<longitud gggmm.mmmm>,E,,,<fart km/h>,,,,,,*<kontrollsumma>
// Mottagaren läser porten (källa Serieport i Dispatch, config.source = 'serial'), kontrollerar kontrollsumman och skickar
// $PNIGPS-raderna som rådata till Dispatch, som tolkar dem (radio90.js, parseJ3). Andra rader räknas per typ men skickas inte.
//  - Porten ställs in med stty (rått läge, hastighet serial_baud, förvalt 4 800) och öppnas icke-blockerande (O_NONBLOCK) som
//    tty.ReadStream (en pipe, net.Socket, i testerna). En vanlig filström blockerar en tråd, och då hänger programmet när det avslutas.
//    Fungerar för USB-adaptrar (/dev/ttyUSB*, /dev/ttyACM*) och namnen i /dev/serial/by-id.
//  - Går porten inte att öppna, eller tar den slut, försöker den igen efter 5 s (sedan längre, högst 60 s).
//  - Läget: no_port (ingen port vald), starting, running, error.
// MOTTAGARE_SERIAL_DEVDIR (förvalt /dev) och MOTTAGARE_STTY (förvalt stty) byts i testerna.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const tty = require('tty');
const net = require('net');
const log = require('./log')('SERIEPORT');

const DEV = process.env.MOTTAGARE_SERIAL_DEVDIR || '/dev';
const STTY = process.env.MOTTAGARE_STTY || 'stty';
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const MAX_LINE = 200;
const RECENT = 15;

// Kontrollsumman i NMEA: XOR av tecknen mellan $ och *
function nmeaOk(line) {
    const m = /^\$([^*]*)\*([0-9A-Fa-f]{2})$/.exec(line);
    if (!m) return false;
    let x = 0;
    for (const ch of m[1]) x ^= ch.charCodeAt(0);
    return x === parseInt(m[2], 16);
}

function listPorts() {
    const out = [];
    const seen = new Set();
    const byId = path.join(DEV, 'serial', 'by-id');
    let names = [];
    try { names = fs.readdirSync(byId).sort(); } catch (e) { /* inga adaptrar med namn */ }
    for (const n of names) {
        const p = path.join(byId, n);
        let real = null;
        try { real = fs.realpathSync(p); } catch (e) { /* trasig länk */ }
        if (real) seen.add(real);
        out.push({ path: p, name: n.replace(/^usb-/, '').replace(/-if\d+.*$/, '').replace(/_/g, ' '), dev: real ? path.basename(real) : null });
    }
    try {
        for (const n of fs.readdirSync(DEV).sort()) {
            if (!/^tty(USB|ACM)\d+$/.test(n)) continue;
            const p = path.join(DEV, n);
            if (!seen.has(p)) out.push({ path: p, name: n, dev: n });
        }
    } catch (e) { /* ingen /dev */ }
    return out.slice(0, 16);
}

class SerialJ3 {
    // onLine(line) för varje $PNIGPS-rad med rätt kontrollsumma
    constructor({ onLine }) {
        this.onLine = onLine || (() => {});
        this.config = {};
        this.state = 'no_port';
        this.error = null;
        this.stream = null;
        this.timer = null;
        this.retryMs = 5000;
        this.buf = '';
        this.stats = { lines: 0, ok: 0, bad_checksum: 0, types: {}, last_at: null };
        this.recent = [];
        this.gen = 0;
    }
    active() { return this.config.source === 'serial'; }
    status() {
        return { state: this.active() ? this.state : 'off', error: this.error, port: this.config.serial_port || '', baud: this.baud(),
                 lines: this.stats.lines, ok: this.stats.ok, bad_checksum: this.stats.bad_checksum, types: Object.assign({}, this.stats.types),
                 last_at: this.stats.last_at, recent: this.recent.slice(), ports: listPorts() };
    }
    baud() { const b = Number(this.config.serial_baud); return BAUDS.includes(b) ? b : 4800; }
    apply(config) {
        const old = this.config;
        this.config = Object.assign({}, config);
        const same = ['source', 'serial_port', 'serial_baud'].every(k => old[k] === this.config[k]);
        if (same && (this.stream || this.timer)) return;
        this.retryMs = 5000;
        this.restart();
    }
    restart() {
        clearTimeout(this.timer); this.timer = null;
        this.close();
        if (!this.active()) { this.state = 'no_port'; this.error = null; return; }
        if (!this.config.serial_port) { this.state = 'no_port'; this.error = 'Ingen serieport är vald. Den väljs i Dispatch.'; return; }
        this.open();
    }
    open() {
        const port = this.config.serial_port;
        const gen = ++this.gen;
        this.state = 'starting';
        this.error = null;
        if (!fs.existsSync(port)) { this.fail(`Serieporten ${port} finns inte. Är adaptern ansluten?`); return; }
        execFile(STTY, ['-F', port, String(this.baud()), 'raw', '-echo', 'cs8', '-cstopb', '-parenb', 'clocal'], { timeout: 5000 }, (e, so, se) => {
            if (gen !== this.gen) return;
            if (e) { this.fail(`Serieporten kunde inte ställas in: ${String(se || e.message).trim().split('\n')[0]}`); return; }
            let s;
            try {
                const fd = fs.openSync(port, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOCTTY || 0));
                s = tty.isatty(fd) ? new tty.ReadStream(fd) : new net.Socket({ fd, readable: true, writable: false });
            } catch (x) { this.fail(x.code === 'EACCES' ? `Mottagaren får inte läsa ${port} (gruppen dialout).` : x.message); return; }
            this.stream = s;
            this.state = 'running';
            this.retryMs = 5000;
            log(`läser ${port} i ${this.baud()} baud`);
            s.on('data', (d) => { if (this.stream === s) this.data(d); });
            s.on('error', (x) => { if (this.stream === s) { this.stream = null; this.fail(x.code === 'EACCES' ? `Mottagaren får inte läsa ${port} (gruppen dialout).` : x.message); } });
            s.on('end', () => { if (this.stream === s) { this.stream = null; this.fail('Serieporten stängdes.'); } });
        });
    }
    data(d) {
        this.buf += d.toString('latin1');
        let i;
        while ((i = this.buf.search(/[\r\n]/)) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (line) this.line(line);
        }
        if (this.buf.length > MAX_LINE * 2) this.buf = this.buf.slice(-MAX_LINE);
    }
    line(raw) {
        const line = raw.slice(0, MAX_LINE);
        this.stats.lines++;
        const at = new Date().toISOString();
        this.recent.push({ at, line });
        if (this.recent.length > RECENT) this.recent.shift();
        const m = /^\$([A-Z0-9]{2,10}),/.exec(line);
        const type = m ? m[1] : '(okänd)';
        if (!m) { this.count('(okänd)'); return; }
        this.count(type);
        if (!nmeaOk(line)) { this.stats.bad_checksum++; log(`fel kontrollsumma: ${line}`); return; }
        if (type !== 'PNIGPS') return;
        this.stats.ok++;
        this.stats.last_at = at;
        try { this.onLine(line, at); } catch (e) { log('raden kunde inte hanteras:', e.message); }
    }
    count(type) {
        const t = this.stats.types;
        if (t[type] === undefined && Object.keys(t).length >= 20) return;
        t[type] = (t[type] || 0) + 1;
    }
    fail(msg) {
        this.state = 'error';
        this.error = String(msg).slice(0, 200);
        log(`fel: ${this.error}`);
        this.close();
        clearTimeout(this.timer);
        const ms = this.retryMs;
        this.retryMs = Math.min(60000, this.retryMs * 2);
        this.timer = setTimeout(() => { this.timer = null; if (this.active()) this.open(); }, ms);
        this.timer.unref();
    }
    close() {
        const s = this.stream;
        this.stream = null;
        if (s) { try { s.destroy(); } catch (e) { /* redan stängd */ } }
    }
    shutdown() { clearTimeout(this.timer); this.gen++; this.close(); }
}

module.exports = { SerialJ3, listPorts, nmeaOk, BAUDS };
