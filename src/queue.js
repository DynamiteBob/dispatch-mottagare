// ============================================================================
// Kö för inspelningar som ännu inte skickats till Dispatch (mappen kö/ i tillståndsmappen).
// Varje inspelning är <id>.wav + <id>.json (tid, längd, frekvens, nivå). Högst MAX_FILES filer och MAX_BYTES;
// de äldsta tas bort när kön är full, så att en mottagare utan nät inte fyller minneskortet.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILES = 300;
const MAX_BYTES = 80 * 1024 * 1024;

class Queue {
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
        this.seq = 0;
    }
    ids() {
        let names = [];
        try { names = fs.readdirSync(this.dir); } catch (e) { return []; }
        return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort();
    }
    add(meta, wavBuf) {
        const id = `${Date.now()}-${String(this.seq++ % 1000).padStart(3, '0')}`;
        fs.writeFileSync(path.join(this.dir, id + '.wav'), wavBuf);
        fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(meta));
        this.trim();
        return id;
    }
    oldest() {
        for (const id of this.ids()) {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8'));
                const wav = fs.readFileSync(path.join(this.dir, id + '.wav'));
                return { id, meta, wav };
            } catch (e) { this.remove(id); }
        }
        return null;
    }
    remove(id) {
        for (const ext of ['.wav', '.json']) { try { fs.unlinkSync(path.join(this.dir, id + ext)); } catch (e) { /* redan borta */ } }
    }
    stats() {
        let bytes = 0;
        const ids = this.ids();
        for (const id of ids) { try { bytes += fs.statSync(path.join(this.dir, id + '.wav')).size; } catch (e) { /* ignoreras */ } }
        return { files: ids.length, bytes };
    }
    trim() {
        let ids = this.ids();
        let { bytes } = this.stats();
        while (ids.length > MAX_FILES || (bytes > MAX_BYTES && ids.length)) {
            const id = ids.shift();
            try { bytes -= fs.statSync(path.join(this.dir, id + '.wav')).size; } catch (e) { /* ignoreras */ }
            this.remove(id);
        }
    }
}

module.exports = { Queue };
