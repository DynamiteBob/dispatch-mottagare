// ============================================================================
// Tolkning av positionsmeddelandet från Ericsson Aurora (C50), fälten valda som i GPS Parametrar rev 4:
// position, fart, ID och status. Datakodorden ger 18 byte (se docs/aurora-ffsk.md):
//   0      flaggor: 0x80 = GPS-fix (0x83 med fix, 0x03 utan)
//   1      0x12 (samma i alla meddelanden hittills; troligen vilka fält som är med)
//   2–5    latitud BCD gg mm mm mm      59 20 12 34    = 59° 20,1234′
//   6–10   longitud BCD ggg h mm mmmm   01 80 04 56 78 = 018° 04,5678′ (h = ett halvbyte, troligen väderstreck, 0 i Sverige)
//   11–12  fart BCD i tiondels km/h (03 75 = 37,5 km/h; EE EE utan fix)
//   13–15  ID BCD: fem siffror och en extra siffra (#0)  12 34 50 = 12345, 0
//   16     status BCD W0 W1 (00 = ingen)
//   17     utfyllnad
// Andra fältval ger en annan byte 1; då skickas bara rådata.
// Samma tolkning finns i Dispatch (radio90.js), som tolkar om rådata själv.
// ============================================================================
'use strict';

const bcd = (bytes) => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const digits = (s) => /^\d+$/.test(s) ? s : null;

function parse(payloadHex) {
    const b = [];
    for (let i = 0; i + 1 < payloadHex.length; i += 2) b.push(parseInt(payloadHex.slice(i, i + 2), 16));
    const out = { known: false, fix: null, lat: null, lon: null, speed_kmh: null, id: null, id_ext: null, status: null };
    if (b.length < 17) return out;
    out.fix = !!(b[0] & 0x80);
    if (b[1] !== 0x12) return out;
    out.known = true;
    const id = digits(bcd(b.slice(13, 16)));
    if (id) { out.id = id.slice(0, 5); out.id_ext = id.slice(5); }
    const st = digits(bcd([b[16]]));
    out.status = st;
    const sp = digits(bcd(b.slice(11, 13)));
    out.speed_kmh = sp === null ? null : parseInt(sp, 10) / 10;   // 0.3.2: tiondels km/h
    const la = digits(bcd(b.slice(2, 6)));
    const lo = bcd(b.slice(6, 11));
    if (out.fix && la && /^\d{3}[0-9a-f]\d{6}$/.test(lo)) {
        const lat = parseInt(la.slice(0, 2), 10) + parseInt(la.slice(2), 10) / 10000 / 60;
        const lon = parseInt(lo.slice(0, 3), 10) + parseInt(lo.slice(4), 10) / 10000 / 60;
        if (lat <= 90 && lon <= 180 && parseInt(la.slice(2, 4), 10) < 60 && parseInt(lo.slice(4, 6), 10) < 60) {
            out.lat = Math.round(lat * 1e7) / 1e7;
            out.lon = Math.round(lon * 1e7) / 1e7;
            out.hemi = lo[3];
        }
    }
    return out;
}

module.exports = { parse };
