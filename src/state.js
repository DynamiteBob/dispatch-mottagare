// ============================================================================
// Sparade uppgifter (state.json i tillståndsmappen, /var/lib/dispatch-mottagare på Pi:n)
//  - dispatch_url: Dispatch-adressen (anges på inställningssidan)
//  - receiver_id, token: från anmälan; token är mottagarens nyckel och skickas aldrig någon annanstans än till Dispatch
//  - state: pending/approved (som Dispatch senast sa), pair_code: koden som visas på inställningssidan och i Dispatch
//  - name, config, config_version: det Dispatch skickade senast (gäller även utan kontakt med Dispatch)
//  - hotspot_psk: lösenordet för mottagarens eget wifi (skapas första gången)
//  - last_cmd: id för det senaste kommandot från Dispatch, pending_update: kommandot Uppdatera som väntar på resultatet
// Filen skrivs atomärt (tmp + rename) med rättigheterna 0600.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.STATE_DIRECTORY || process.env.MOTTAGARE_STATE_DIR || path.join(__dirname, '..', 'data');
const RUN_DIR = process.env.RUNTIME_DIRECTORY || process.env.MOTTAGARE_RUN_DIR || DIR;
const FILE = path.join(DIR, 'state.json');

// Tecken som inte går att förväxla (inte 0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(n) {
    const b = crypto.randomBytes(n);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
    return s;
}
const newPairCode = () => { const s = randomCode(6); return `${s.slice(0, 3)}-${s.slice(3)}`; };

let data = null;
function load() {
    fs.mkdirSync(DIR, { recursive: true });
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { data = {}; }
    if (!data.hotspot_psk) data.hotspot_psk = randomCode(12).toLowerCase();
    save();
    return data;
}
function save() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
}
function get() { return data || load(); }
function set(patch) {
    get();
    Object.assign(data, patch);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete data[k];
    save();
    return data;
}

module.exports = { DIR, RUN_DIR, FILE, load, get, set, save, newPairCode, randomCode };
