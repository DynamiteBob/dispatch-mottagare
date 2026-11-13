// ============================================================================
// Kontakten med Dispatch
//  - Anmälan: POST /api/mottagare/anmal { hw_id, name, model, version, pair_code } → { id, token }. Mottagaren väntar sedan på
//    att en administratör godkänner den i Adminportalen → Mottagare (samma kod visas där och på inställningssidan).
//  - Long polling: GET /api/mottagare/poll?s=<läge>&v=<inställningarnas version>&c=<senaste kommando>. Dispatch svarar direkt
//    när något ändrats, annars efter 25 s, och mottagaren frågar igen direkt. Svaret har läget, namnet, inställningarna och kommandon.
//    401 UNKNOWN = mottagaren har tagits bort i Dispatch: nyckeln glöms och mottagaren anmäler sig igen med en ny kod.
//  - Livssignal: POST /api/mottagare/status var 30:e sekund (HB_MS) och direkt efter nya inställningar.
//  - Inspelningar: POST /api/mottagare/recordings (audio/wav) från kön, den äldsta först.
//  - Avkodade meddelanden (0.2.0): POST /api/mottagare/messages { messages: [...] }, högst 50 åt gången, direkt när de
//    avkodats och annars var 2:a sekund tills kön är tom.
// Efter ett fel väntar den 3 s, sedan längre (högst 60 s).
// ============================================================================
'use strict';

const state = require('./state');
const log = require('./log')('DISPATCH');

const HB_MS = parseInt(process.env.MOTTAGARE_HB_MS, 10) || 30000;
const POLL_TIMEOUT_MS = 45000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeUrl(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

class DispatchClient {
    constructor({ version, hwId, model, hostname, statusFn, onConfig, onCommand, queue, msgs }) {
        Object.assign(this, { version, hwId, model, hostname, statusFn, onConfig, onCommand, queue, msgs });
        this.sendingMsgs = false;
        this.stopped = false;
        this.ctrl = null;
        this.lastOkAt = null;
        this.lastError = null;
        this.backoff = 3000;
        this.uploading = false;
    }
    info() {
        const s = state.get();
        return { url: s.dispatch_url || '', state: s.token ? (s.state || 'pending') : null, pair_code: s.pair_code || null, receiver_id: s.receiver_id || null,
                 name: s.name || null, last_ok_at: this.lastOkAt, last_error: this.lastError };
    }
    start() {
        this.pollLoop();
        this.hb = setInterval(() => this.heartbeat(), HB_MS);
        this.up = setInterval(() => { this.uploadNext(); this.uploadMessages(); }, 2000);
    }
    stop() { this.stopped = true; clearInterval(this.hb); clearInterval(this.up); if (this.ctrl) this.ctrl.abort(); }
    // Ny Dispatch-adress från inställningssidan: nyckeln glöms och mottagaren anmäler sig på nytt
    setUrl(url) {
        state.set({ dispatch_url: url, token: undefined, receiver_id: undefined, state: undefined, pair_code: undefined, last_cmd: undefined });
        this.lastError = null; this.lastOkAt = null; this.backoff = 3000;
        if (this.ctrl) this.ctrl.abort();
    }
    async req(method, path, opts) {
        const s = state.get();
        const o = opts || {};
        const headers = Object.assign({}, o.headers || {});
        if (s.token) headers.authorization = 'Bearer ' + s.token;
        let body = o.body;
        if (body !== undefined && !Buffer.isBuffer(body)) { body = JSON.stringify(body); headers['content-type'] = 'application/json'; }
        const ctrl = new AbortController();
        if (o.poll) this.ctrl = ctrl;
        const t = setTimeout(() => ctrl.abort(), o.timeout || 20000);
        try {
            const res = await fetch(s.dispatch_url + path, { method, headers, body, signal: ctrl.signal });
            let json = {};
            try { json = await res.json(); } catch (e) { /* inget JSON */ }
            return { status: res.status, json };
        } finally { clearTimeout(t); if (this.ctrl === ctrl) this.ctrl = null; }
    }
    errText(e) {
        const c = e && e.cause && e.cause.code;
        if (e && e.name === 'AbortError') return 'Ingen kontakt med Dispatch (tidsgräns).';
        if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'Dispatch-adressen hittades inte (DNS).';
        if (c === 'ECONNREFUSED') return 'Dispatch svarar inte på adressen.';
        if (c && /CERT|SSL|TLS/.test(c)) return 'Certifikatet för Dispatch godtogs inte.';
        return `Ingen kontakt med Dispatch${c ? ` (${c})` : ''}.`;
    }
    async enroll() {
        const code = state.get().pair_code || state.newPairCode();
        state.set({ pair_code: code });
        const r = await this.req('POST', '/api/mottagare/anmal', { body: { hw_id: this.hwId, name: this.hostname, model: this.model, version: this.version, pair_code: code } });
        if (r.status !== 200 || !r.json.token) throw Object.assign(new Error(r.json.error || `Anmälan misslyckades (HTTP ${r.status}).`), { http: true });
        state.set({ token: r.json.token, receiver_id: r.json.id, state: 'pending' });
        log(`anmäld som mottagare ${r.json.id}, koden ${code}`);
    }
    async pollLoop() {
        while (!this.stopped) {
            const s = state.get();
            if (!s.dispatch_url) { await sleep(2000); continue; }
            try {
                if (!s.token) await this.enroll();
                const st = state.get();
                const q = `s=${encodeURIComponent(st.state || '')}&v=${st.config_version || 0}&c=${st.last_cmd || 0}`;
                const r = await this.req('GET', `/api/mottagare/poll?${q}`, { timeout: POLL_TIMEOUT_MS, poll: true });
                if (r.status === 401) {
                    log('Dispatch känner inte igen mottagaren, anmäler den igen');
                    state.set({ token: undefined, receiver_id: undefined, state: undefined, pair_code: undefined, last_cmd: undefined });
                    this.lastError = 'Mottagaren togs bort i Dispatch och anmäler sig igen.';
                    await sleep(1000);
                    continue;
                }
                if (r.status !== 200) throw Object.assign(new Error(r.json.error || `Dispatch svarade ${r.status}.`), { http: true });
                this.lastOkAt = new Date().toISOString(); this.lastError = null; this.backoff = 3000;
                await this.handle(r.json);
            } catch (e) {
                if (this.stopped) return;
                if (!state.get().dispatch_url) continue;
                this.lastError = e.http ? e.message : this.errText(e);
                log(this.lastError);
                await sleep(this.backoff);
                this.backoff = Math.min(60000, this.backoff * 2);
            }
        }
    }
    async handle(j) {
        const before = state.get();
        const patch = { state: j.state, name: j.name || before.name };
        if (j.state === 'pending' && j.pair_code) patch.pair_code = j.pair_code;
        const wasApproved = before.state === 'approved';
        let newConfig = null;
        if (j.state === 'approved' && j.config && j.config_version !== before.config_version) {
            patch.config = j.config; patch.config_version = j.config_version;
            newConfig = j.config;
        }
        state.set(patch);
        if (j.state === 'approved' && !wasApproved) log('godkänd i Dispatch');
        if (newConfig) { log(`nya inställningar (version ${j.config_version})`); try { await this.onConfig(newConfig); } catch (e) { log('inställningarna kunde inte användas:', e.message); } this.heartbeat(); }
        for (const c of j.commands || []) {
            if (c.id <= (state.get().last_cmd || 0)) continue;
            state.set({ last_cmd: c.id });
            this.onCommand(c);
        }
    }
    async heartbeat() {
        const s = state.get();
        if (!s.dispatch_url || !s.token) return;
        try {
            const r = await this.req('POST', '/api/mottagare/status', { body: Object.assign(this.statusFn(), { config_version: s.config_version || 0 }) });
            if (r.status === 200) { this.lastOkAt = new Date().toISOString(); }
        } catch (e) { /* pollningen visar felet */ }
    }
    async commandDone(id, ok, message) {
        try { await this.req('POST', `/api/mottagare/commands/${id}/done`, { body: { ok, message } }); return true; } catch (e) { return false; }
    }
    async uploadMessages() {
        const s = state.get();
        if (!this.msgs || this.sendingMsgs || !s.dispatch_url || !s.token || s.state !== 'approved' || !this.msgs.length) return;
        this.sendingMsgs = true;
        try {
            const batch = this.msgs.peek(50);
            const r = await this.req('POST', '/api/mottagare/messages', { body: { messages: batch } });
            if (r.status === 200) { this.msgs.drop(batch.length); if (this.msgs.length) setImmediate(() => this.uploadMessages()); }
            else if (r.status === 400) { this.msgs.drop(batch.length); log(`meddelandena avvisades: ${r.json.error || r.status}`); }
        } catch (e) { /* försöker igen */ }
        finally { this.sendingMsgs = false; }
    }
    async uploadNext() {
        const s = state.get();
        if (this.uploading || !s.dispatch_url || !s.token || s.state !== 'approved') return;
        const item = this.queue.oldest();
        if (!item) return;
        this.uploading = true;
        try {
            const m = item.meta;
            const q = `at=${encodeURIComponent(m.at)}&dur=${m.duration_ms}&freq=${m.freq_hz || 0}&level=${m.level_db === null ? '' : m.level_db}`;
            const r = await this.req('POST', `/api/mottagare/recordings?${q}`, { body: item.wav, headers: { 'content-type': 'audio/wav' }, timeout: 60000 });
            if (r.status === 200) { this.queue.remove(item.id); log(`inspelning skickad (${m.duration_ms} ms)`); setImmediate(() => this.uploadNext()); }
            else if (r.status === 400 || r.status === 413) { this.queue.remove(item.id); log(`inspelningen avvisades: ${r.json.error || r.status}`); }
        } catch (e) { /* försöker igen */ }
        finally { this.uploading = false; }
    }
}

module.exports = { DispatchClient, normalizeUrl };
