// ============================================================================
// bin/uppdatera.sh med ett lokalt git-repo och en falsk systemctl:
//  - redan senaste versionen: ok, ingen omstart
//  - ny tagg 0.1.1 som startar: byter version, skriver resultatet
//  - ny tagg 0.1.2 som inte startar (skriver aldrig ok-filen): går tillbaka till 0.1.1
//  - (0.3.1) taggarna heter som versionen utan v; en tagg med v och en nyare commit på main utan tagg används inte;
//    0.1.10 är nyare än 0.1.9 (sorteras som versioner); utan taggar: fel, main används inte
//   node test/test_uppdatera.js
// ============================================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x))); if (!ok) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mottagare-upp-'));
const sh = (cmd, cwd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });

const src = path.join(tmp, 'src'), opt = path.join(tmp, 'opt'), st = path.join(tmp, 'state'), run = path.join(tmp, 'run'), units = path.join(tmp, 'units'), bin = path.join(tmp, 'bin');
for (const d of [src, st, run, units, bin]) fs.mkdirSync(d, { recursive: true });
const ROOT = path.join(__dirname, '..');
function commit(version, tag, noTag) {
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(src, 'systemd'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'bin', 'uppdatera.sh'), path.join(src, 'bin', 'uppdatera.sh'));
    fs.copyFileSync(path.join(ROOT, 'bin', 'dispatch-mottagare'), path.join(src, 'bin', 'dispatch-mottagare'));
    fs.copyFileSync(path.join(ROOT, 'systemd', 'dispatch-mottagare.service'), path.join(src, 'systemd', 'dispatch-mottagare.service'));
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'dispatch-mottagare', version }));
    sh(`git add -A && git commit -qm ${version}${noTag ? '' : ` && git tag ${tag}`}`, src);
}
sh('git init -q -b main', src);
commit('0.1.0', '0.1.0');
sh(`git clone -q ${src} ${opt} && git -C ${opt} -c advice.detachedHead=false checkout -q 0.1.0`, tmp);
// Falsk systemctl: restart "startar" programmet, som skriver ok-filen med versionen, utom när versionen står i FAKE_BROKEN
fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/bash
echo "$*" >> ${tmp}/systemctl.log
case "$1" in
  restart) V=$(node -p "require('${opt}/package.json').version"); [ "$V" = "\${FAKE_BROKEN:-}" ] || (sleep 1; echo "$V" > ${run}/ok) & ;;
  is-active) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
const env = Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}`, MOTTAGARE_DIR: opt, MOTTAGARE_STATE_DIR: st, MOTTAGARE_RUN_DIR: run,
    MOTTAGARE_UNIT_DIR: units, MOTTAGARE_UPDATE_WAIT_S: '6' });
const runUpd = (extra) => { try { execFileSync('bash', [path.join(opt, 'bin', 'uppdatera.sh')], { env: Object.assign({}, env, extra || {}), encoding: 'utf8' }); return 0; } catch (e) { return e.status; } };
const res = () => JSON.parse(fs.readFileSync(path.join(st, 'uppdatering.json'), 'utf8'));
const ver = () => JSON.parse(fs.readFileSync(path.join(opt, 'package.json'), 'utf8')).version;
const log = () => { try { return fs.readFileSync(path.join(tmp, 'systemctl.log'), 'utf8'); } catch (e) { return ''; } };

try {
    let code = runUpd();
    check('redan senaste: ok utan omstart', code === 0 && res().ok === true && /Redan senaste versionen \(0\.1\.0\)/.test(res().message) && !/restart/.test(log()), [code, res(), log()]);
    commit('0.1.1', '0.1.1');
    code = runUpd();
    check('ny version startar: uppdaterad till 0.1.1', code === 0 && ver() === '0.1.1' && res().ok === true && res().from === '0.1.0' && res().to === '0.1.1', [code, res()]);
    check('tjänstfilen kopieras och systemd läses om', fs.existsSync(path.join(units, 'dispatch-mottagare.service')) && /daemon-reload/.test(log()));
    commit('0.1.2', '0.1.2');
    code = runUpd({ FAKE_BROKEN: '0.1.2' });
    check('version som inte startar: tillbaka till 0.1.1', code === 1 && ver() === '0.1.1' && res().ok === false && /0\.1\.2 startade inte/.test(res().message), [code, ver(), res()]);
    // Tagg med v och commit på main utan tagg: används inte
    commit('0.9.0', 'v0.9.0');
    commit('0.9.1', '', true);
    code = runUpd();
    check('tagg med v och main utan tagg används inte (senaste taggen 0.1.2)', code === 0 && ver() === '0.1.2' && res().to === '0.1.2', [code, ver(), res()]);
    // Versionsordning: 0.1.10 efter 0.1.9
    commit('0.1.9', '0.1.9');
    commit('0.1.10', '0.1.10');
    code = runUpd();
    check('0.1.10 är nyare än 0.1.9', code === 0 && ver() === '0.1.10' && res().to === '0.1.10', [code, ver(), res()]);
    // Inga taggar alls: fel, main används inte
    sh(`git -C ${opt} tag -l | xargs -r git -C ${opt} tag -d >/dev/null && git -C ${src} tag -l | xargs -r git -C ${src} tag -d >/dev/null`, tmp);
    code = runUpd();
    check('utan taggar: fel och ingen ändring', code === 1 && ver() === '0.1.10' && res().ok === false && /ingen version att uppdatera till/.test(res().message), [code, ver(), res()]);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
process.exit(fails ? 1 : 0);
