// ============================================================================
// Kö för avkodade meddelanden som ännu inte skickats till Dispatch (meddelanden.json i tillståndsmappen).
// Högst MAX meddelanden; de äldsta tas bort när kön är full. Skrivs atomärt.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const MAX = 2000;

class MsgQueue {
    constructor(dir) {
        this.file = path.join(dir, 'meddelanden.json');
        try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!Array.isArray(this.items)) this.items = []; } catch (e) { this.items = []; }
    }
    save() {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.items));
        fs.renameSync(tmp, this.file);
    }
    add(list) { this.items.push(...list); if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX); this.save(); }
    peek(n) { return this.items.slice(0, n); }
    drop(n) { this.items.splice(0, n); this.save(); }
    get length() { return this.items.length; }
}

module.exports = { MsgQueue };
