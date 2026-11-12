// Kör alla tester: node test/kor_alla.js  (test_e2e.js kräver Dispatch-repot bredvid eller DISPATCH_DIR)
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tests = fs.readdirSync(__dirname).filter(f => /^test_.*\.js$/.test(f)).sort();
let bad = [];
for (const t of tests) {
    const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit', timeout: 300000 });
    console.log(`${r.status === 0 ? 'OK ' : 'FEL'} ${t}\n`);
    if (r.status !== 0) bad.push(t);
}
console.log(bad.length ? `FEL i ${bad.join(', ')}` : `Alla ${tests.length} testfiler OK`);
process.exit(bad.length ? 1 : 0);
