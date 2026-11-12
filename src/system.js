// ============================================================================
// Uppgifter om datorn: serienummer (hw_id), modell, temperatur, IP-adresser, drifttid och ledigt utrymme.
// Läses ur /sys och /proc på en Raspberry Pi; på andra datorer blir det machine-id och inga temperaturer.
// MOTTAGARE_SYSROOT pekar om /sys och /proc i testerna.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.MOTTAGARE_SYSROOT || '/';
const p = (...x) => path.join(ROOT, ...x);
const read = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim(); } catch (e) { return null; } };

function hwId() {
    if (process.env.MOTTAGARE_HW_ID) return process.env.MOTTAGARE_HW_ID;
    const dt = read(p('sys/firmware/devicetree/base/serial-number'));
    if (dt) return dt.replace(/^0+(?=.{8})/, '');
    const cpu = read(p('proc/cpuinfo'));
    const m = cpu && /^Serial\s*:\s*([0-9a-fA-F]+)/m.exec(cpu);
    if (m) return m[1].replace(/^0+(?=.{8})/, '');
    return read(p('etc/machine-id')) || os.hostname();
}
function model() {
    return read(p('sys/firmware/devicetree/base/model')) || `${os.type()} ${os.arch()}`;
}
function tempC() {
    const t = read(p('sys/class/thermal/thermal_zone0/temp'));
    const n = t ? Number(t) : NaN;
    return Number.isFinite(n) ? Math.round(n / 100) / 10 : null;
}
function ips() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`${a.address} (${name})`);
    }
    return out;
}
function diskFreeMb(dir) {
    try {
        const s = fs.statfsSync(dir);
        return Math.round(s.bavail * s.bsize / 1048576);
    } catch (e) { return null; }
}

module.exports = { hwId, model, tempC, ips, diskFreeMb, hostname: () => os.hostname(), uptimeS: () => Math.round(os.uptime()) };
