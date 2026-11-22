// ============================================================================
// 0.4.3: bin/nmcli-dispatch (nmcli som root via sudo) och bin/systemfiler.sh
//  - kommandona som src/net.js använder släpps igenom oförändrade till nmcli
//  - andra kommandon och inställningar nekas med slutkod 2, utan att nmcli körs
//  - systemfiler.sh installerar sudo-regeln (0440, bara nmcli-skriptet) och länken, och låter en fel regel vara
//   node test/test_nmcli.js
// ============================================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let fails = 0;
const check = (n, ok, x) => { console.log((ok ? 'OK   ' : 'FEL  ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x))); if (!ok) fails++; };
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mottagare-nmcli-'));
try {
    // En "nmcli" som bara skriver ut sina argument, och en kopia av skriptet som pekar på den
    const fake = path.join(tmp, 'nmcli');
    fs.writeFileSync(fake, '#!/bin/bash\nprintf "%s|" "$@"\n', { mode: 0o755 });
    const wrap = path.join(tmp, 'nmcli-dispatch');
    fs.writeFileSync(wrap, fs.readFileSync(path.join(ROOT, 'bin', 'nmcli-dispatch'), 'utf8').replace(/^NMCLI=\/usr\/bin\/nmcli$/m, `NMCLI=${fake}`), { mode: 0o755 });
    check('kopian pekar på den falska nmcli', fs.readFileSync(wrap, 'utf8').includes(`NMCLI=${fake}`));
    const run = (args) => spawnSync('bash', [wrap].concat(args), { encoding: 'utf8' });
    const ALLOWED = [
        ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'],
        ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'no'],
        ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'],
        ['-t', '-f', 'NAME,TYPE', 'connection', 'show'],
        ['-t', '-g', '802-11-wireless.ssid,802-11-wireless.mode', 'connection', 'show', 'dispatch-wifi-Hemma'],
        ['connection', 'delete', 'dispatch-mottagare-hotspot'],
        ['connection', 'add', 'type', 'wifi', 'ifname', 'wlan0', 'con-name', 'dispatch-mottagare-hotspot', 'autoconnect', 'no',
            'ssid', 'Dispatch-mottagare-AB12', '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg',
            'ipv4.method', 'shared', 'ipv4.addresses', '10.42.0.1/24', 'ipv6.method', 'disabled',
            'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', 'hemligt-losen'],
        ['--wait', '30', 'connection', 'up', 'dispatch-mottagare-hotspot'],
        ['connection', 'down', 'dispatch-mottagare-hotspot'],
        ['connection', 'add', 'type', 'wifi', 'con-name', 'dispatch-wifi-Hemma', 'ssid', 'Hemma nät', 'connection.autoconnect', 'yes',
            'connection.autoconnect-priority', '10', 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', 'ratt-losenord'],
        ['connection', 'add', 'type', 'wifi', 'con-name', 'dispatch-wifi-Kafe', 'ssid', 'Kafe', 'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '10'],
        ['--wait', '40', 'connection', 'up', 'dispatch-wifi-Hemma']
    ];
    for (const a of ALLOWED) {
        const r = run(a);
        check(`tillåtet: nmcli ${a.slice(0, 6).join(' ')}`, r.status === 0 && r.stdout === a.join('|') + '|', [r.status, r.stdout, r.stderr]);
    }
    const DENIED = [
        [],
        ['general', 'hostname', 'x'],
        ['connection', 'modify', 'Kabel', 'ipv4.dns', '1.2.3.4'],
        ['connection', 'add', 'type', 'vpn', 'con-name', 'x', 'vpn-type', 'openvpn'],
        ['connection', 'add', 'type', 'wifi', 'con-name', 'x', 'ssid', 'x', '802-1x.ca-cert', '/etc/shadow'],
        ['connection', 'add', 'type', 'wifi', 'con-name', 'x', 'ssid', 'x', 'connection.permissions', ''],
        ['connection', 'add', 'type', 'wifi', 'con-name', 'x', 'ssid'],
        ['connection', 'add', 'type', 'wifi', 'ipv4.addresses', '192.168.1.1/24'],
        ['connection', 'up', '--ask', 'x'],
        ['connection', 'delete', '-h'],
        ['connection', 'show', 'a', 'b'],
        ['--ask', 'connection', 'show'],
        ['-f', 'X;Y', 'device'],
        ['device', 'set', 'wlan0', 'managed', 'no'],
        ['networking', 'off'],
        ['radio', 'wifi', 'off'],
        ['-t', '-f', 'DEVICE', 'device', 'wifi', 'connect', 'Hemma']
    ];
    for (const a of DENIED) {
        const r = run(a);
        check(`nekas: nmcli ${a.join(' ') || '(inget)'}`, r.status === 2 && r.stdout === '' && /inte tillåtet/.test(r.stderr), [r.status, r.stdout, r.stderr]);
    }

    // systemfiler.sh
    const dir = path.join(tmp, 'opt');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'systemd'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'bin', 'nmcli-dispatch'), path.join(dir, 'bin', 'nmcli-dispatch'));
    fs.copyFileSync(path.join(ROOT, 'systemd', 'sudoers'), path.join(dir, 'systemd', 'sudoers'));
    const sudoers = path.join(tmp, 'sudoers.d', 'dispatch-mottagare'), sbin = path.join(tmp, 'sbin');
    fs.mkdirSync(path.dirname(sudoers)); fs.mkdirSync(sbin);
    fs.writeFileSync(sudoers, 'mottagare ALL=(root) NOPASSWD: /usr/bin/nmcli\n');
    const sys = () => spawnSync('bash', [path.join(ROOT, 'bin', 'systemfiler.sh')], { encoding: 'utf8',
        env: Object.assign({}, process.env, { MOTTAGARE_DIR: dir, MOTTAGARE_USER: 'pi', MOTTAGARE_SUDOERS: sudoers, MOTTAGARE_SBIN: sbin }) });
    let r = sys();
    const txt = fs.readFileSync(sudoers, 'utf8');
    check('systemfiler.sh: sudo-regeln installeras med användaren', r.status === 0 && /^pi ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/dispatch-mottagare-nmcli$/m.test(txt) && !/\/usr\/bin\/nmcli/.test(txt) && !/^mottagare /m.test(txt), [r.status, r.stderr, txt]);
    check('systemfiler.sh: rättigheterna är 0440', (fs.statSync(sudoers).mode & 0o777) === 0o440);
    check('systemfiler.sh: länken till nmcli-skriptet', fs.readlinkSync(path.join(sbin, 'dispatch-mottagare-nmcli')) === path.join(dir, 'bin', 'nmcli-dispatch'));
    r = sys();
    check('systemfiler.sh: oförändrad regel skrivs inte om', r.status === 0 && !/uppdaterad/.test(r.stdout), r.stdout);
    if (spawnSync('sh', ['-c', 'command -v visudo']).status === 0) {
        fs.writeFileSync(path.join(dir, 'systemd', 'sudoers'), 'mottagare ALL=(root NOPASSWD: trasig\n');
        fs.chmodSync(sudoers, 0o640); fs.writeFileSync(sudoers, 'GAMMAL\n');
        r = sys();
        check('systemfiler.sh: en fel regel installeras inte', r.status === 1 && fs.readFileSync(sudoers, 'utf8') === 'GAMMAL\n', [r.status, r.stderr]);
    }
    const svc = fs.readFileSync(path.join(ROOT, 'systemd', 'dispatch-mottagare.service'), 'utf8');
    check('tjänsten kör systemfiler.sh som root före start', /^ExecStartPre=-\+\/opt\/dispatch-mottagare\/bin\/systemfiler\.sh$/m.test(svc));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(fails ? `\n${fails} FEL` : '\nALLT OK');
process.exit(fails ? 1 : 0);
