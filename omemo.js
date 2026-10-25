// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jacob Kuznetsov

// OMEMO end-to-end encryption (XEP-0384), in the legacy
// eu.siacs.conversations.axolotl namespace — the version Conversations, Monal,
// Gajim, Dino and Converse.js actually speak.
//
// Depends on Strophe ($iq, $build) and vendor/libsignal.min.js (global
// `libsignal`). Key material — never message text — is kept in IndexedDB,
// AES-GCM encrypted under a key derived from the account password. See
// HIPAA.md (Phase 2).
'use strict';

const Omemo = (() => {
  const NS             = 'eu.siacs.conversations.axolotl';
  const NODE_DEVICES   = NS + '.devicelist';
  const NODE_BUNDLE    = NS + '.bundles:';
  const NOTIFY_FEATURE = NODE_DEVICES + '+notify';
  const NS_PUBSUB      = 'http://jabber.org/protocol/pubsub';
  const NS_EVENT       = NS_PUBSUB + '#event';
  const NS_OWNER       = NS_PUBSUB + '#owner';
  const NS_STANZAS     = 'urn:ietf:params:xml:ns:xmpp-stanzas';

  const PREKEYS           = 100;
  const MAX_PREKEY_ID     = 0xFFFFFE;
  const SPK_ROTATE_MS     = 7  * 86_400_000;
  const SPK_KEEP_MS       = 30 * 86_400_000; // old signed prekeys, for PreKey messages still in flight
  const IQ_TIMEOUT_MS     = 15_000;
  const PBKDF2_ITERATIONS = 600_000;
  const DB_NAME = 'woofr-omemo', DB_STORE = 'accounts';

  // What non-OMEMO clients show instead. Deliberately says nothing about the
  // content.
  const FALLBACK_BODY = 'This message is OMEMO encrypted, and your client does not support OMEMO.';

  const utf8 = new TextEncoder(), unutf8 = new TextDecoder();

  // ── Bytes ──────────────────────────────────────────────────────────────────
  function toB64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }

  function fromB64(b64) {
    const s = atob(b64.replace(/\s+/g, ''));
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }

  function bufEq(a, b) {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(new Uint8Array(a), 0);
    out.set(new Uint8Array(b), a.byteLength);
    return out;
  }

  const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  // Same format Conversations shows: the 32-byte Curve25519 key (without
  // libsignal's 0x05 type prefix) as hex, in groups of 8.
  function fingerprint(pubKey) {
    let u = new Uint8Array(pubKey);
    if (u.length === 33) u = u.slice(1);
    return toHex(u).match(/.{8}/g).join(' ');
  }

  // State is JSON with binary values as { $b: base64 }.
  const replacer = (k, v) =>
    v instanceof ArrayBuffer ? { $b: toB64(v) } :
    ArrayBuffer.isView(v)    ? { $b: toB64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) } : v;
  const reviver = (k, v) =>
    v && typeof v === 'object' && typeof v.$b === 'string' && Object.keys(v).length === 1 ? fromB64(v.$b) : v;

  // ── XML ────────────────────────────────────────────────────────────────────
  const kids = (el, name) => el ? [...el.childNodes].filter(n => n.nodeType === 1 && (n.localName || n.nodeName) === name) : [];
  const kid  = (el, name) => kids(el, name)[0] || null;
  const bare = jid => jid ? jid.split('/')[0].toLowerCase() : '';

  class OmemoError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  class IqError extends Error {
    constructor(stanza) {
      const err = stanza && stanza.getElementsByTagName('error')[0];
      const cond = err && [...err.childNodes].find(n => n.nodeType === 1 && n.namespaceURI === NS_STANZAS);
      super(stanza ? 'IQ error: ' + (cond ? cond.localName : 'unknown') : 'IQ timed out');
      this.condition = stanza ? (cond ? cond.localName : 'unknown') : 'timeout';
    }
  }

  // ── Encrypted IndexedDB vault ─────────────────────────────────────────────
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
  }

  async function idbOp(mode, fn) {
    const db = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const tx  = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  // One record per account, keyed by a hash of the JID (so the database
  // doesn't name who uses this browser): { salt, iv, ct, deviceId }. deviceId
  // is public anyway — it's in the PEP device list — and is kept in the clear
  // so that a device whose keys can no longer be decrypted (password changed)
  // can still be retired from the list.
  class Vault {
    constructor(id, salt, key, rec) {
      this.id = id;
      this.salt = salt;
      this.key = key;
      this.rec = rec;
      this.previousDeviceId = rec ? rec.deviceId : null;
    }

    // The saved state; null if there is none. Throws if it can't be decrypted.
    async load() {
      if (!this.rec) return null;
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.rec.iv, additionalData: utf8.encode(this.id) }, this.key, this.rec.ct);
      return JSON.parse(unutf8.decode(pt), reviver);
    }

    async save(state) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8.encode(this.id) }, this.key,
        utf8.encode(JSON.stringify(state, replacer)));
      this.rec = { v: 1, salt: this.salt, iv, ct, deviceId: state.deviceId };
      await idbOp('readwrite', s => s.put(this.rec, this.id));
    }

    async destroy() {
      this.rec = null;
      await idbOp('readwrite', s => s.delete(this.id));
    }

    // For other on-device data under the same key (history.js). `aad` names
    // the record, so a ciphertext can't be swapped into another place.
    async seal(value, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8.encode(this.id + '|' + aad) }, this.key,
        utf8.encode(JSON.stringify(value)));
      return { iv, ct };
    }

    async open(iv, ct, aad) {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: utf8.encode(this.id + '|' + aad) }, this.key, ct);
      return JSON.parse(unutf8.decode(pt));
    }
  }

  // Called at sign-in, while the password is still at hand. The derived key is
  // non-extractable; the password itself isn't kept.
  async function openVault(jid, password) {
    const id   = toHex(await crypto.subtle.digest('SHA-256', utf8.encode('woofr-omemo:' + bare(jid))));
    const rec  = await idbOp('readonly', s => s.get(id));
    const salt = rec ? rec.salt : crypto.getRandomValues(new Uint8Array(16));
    const base = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key  = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return new Vault(id, salt, key, rec || null);
  }

  // ── Session (one per signed-in connection) ────────────────────────────────
  //
  // Trust, per remote device:
  //   blind      first key seen for a contact with no verified devices — used
  //              (blind trust before verification, like Conversations)
  //   verified   fingerprint confirmed by the user — used
  //   undecided  new device for a contact who already has a verified one —
  //              not encrypted to until the user decides
  //   distrusted rejected by the user — never encrypted to, messages refused
  // A device whose identity key changes is blocked (pendingKey) until the user
  // accepts the new key.
  //
  // libsignal addresses are named "jid|deviceId": the library checks trust by
  // address *name*, and OMEMO trust is per device, not per contact.
  const addressName = (jid, id) => jid + '|' + id;
  function splitIdentity(s) {
    const m = /^(.*)\|(\d+)(?:\.\d+)?$/.exec(s);
    return m ? { jid: m[1], id: +m[2], key: m[1] + '|' + m[2] } : { jid: s, id: 0, key: s };
  }

  class Session {
    constructor(conn, jid, hooks = {}) {
      this.conn    = conn;
      this.jid     = bare(jid);
      this.hooks   = hooks;  // { warn(jid|null, text), changed(jid) }
      this.state   = null;
      this.vault   = null;
      this.ready   = false;
      this.stopped = false;
      this.devices = new Map(); // jid -> [deviceId]  (published lists, this session)
      this.fetched = new Map(); // jid -> Promise of the in-flight/finished fetch
      this.queue   = Promise.resolve();
      this.saving  = Promise.resolve();
      this.refillTimer  = null;
      this.preKeysUsed  = false;
      this.releaseLock  = () => {};
      this.store   = this.makeStore();
    }

    get deviceId() { return this.state ? this.state.deviceId : null; }

    alive() { if (this.stopped) throw new OmemoError('OMEMO session ended', 'stopped'); }

    // Ratchet state must never be used concurrently; run every crypto job in turn.
    serial(fn) {
      const p = this.queue.then(fn);
      this.queue = p.catch(() => {});
      return p;
    }

    // Persists the state. Awaited before anything is sent or shown, so a
    // reload can never reuse a message key or lose a ratchet step.
    save() {
      const vault = this.vault, state = this.state;
      const p = this.saving.then(() => vault.save(state));
      this.saving = p.catch(() => {});
      return p;
    }

    async start(vault) {
      this.vault = vault;
      if (!await this.acquireLock()) {
        throw new OmemoError('Encryption is already active for this account in another tab.', 'locked');
      }
      this.alive();

      let state = null, retire = null;
      try {
        state = await vault.load();
      } catch {
        retire = vault.previousDeviceId;
        this.warn(null, 'Your saved encryption keys couldn\'t be unlocked (was your password changed?). ' +
          'This browser now has new keys, so contacts will see a new fingerprint for you.');
      }
      this.alive();

      const own = await this.fetchDeviceList(this.jid);
      this.alive();
      this.state = state || await this.createState(own);
      await this.rotateSignedPreKey();
      await this.topUpPreKeys();
      this.alive();
      await this.save();
      this.alive();
      await this.publishBundle();
      this.alive();

      const ids = own.filter(id => id !== retire);
      if (!ids.includes(this.deviceId)) ids.push(this.deviceId);
      if (ids.length !== own.length || ids.some((id, i) => id !== own[i])) await this.publishDeviceList(ids);
      this.alive();
      this.fetched.set(this.jid, Promise.resolve(ids));
      this.ready = true;
      this.changed(this.jid);
    }

    stop() {
      this.stopped = true;
      this.ready = false;
      clearTimeout(this.refillTimer);
      // Let a save that's already running finish, then let another tab have the keys.
      const release = this.releaseLock;
      this.saving.finally(release);
      this.state = null;
      this.devices.clear();
      this.fetched.clear();
      this.conn = null;
    }

    // Two tabs writing the same ratchet state would corrupt it.
    acquireLock() {
      if (!navigator.locks) return Promise.resolve(true);
      return new Promise(resolve => {
        navigator.locks.request('woofr-omemo:' + this.vault.id, { ifAvailable: true }, lock => {
          if (!lock) { resolve(false); return undefined; }
          resolve(true);
          return new Promise(release => { this.releaseLock = release; });
        }).catch(() => resolve(false));
      });
    }

    warn(jid, text) { if (!this.stopped && this.hooks.warn) this.hooks.warn(jid, text); }
    changed(jid)    { if (!this.stopped && this.hooks.changed) this.hooks.changed(jid); }

    // ── Keys ────────────────────────────────────────────────────────────────
    async createState(ownDevices) {
      const { KeyHelper } = libsignal;
      let deviceId;
      do {
        deviceId = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7FFFFFFF);
      } while (ownDevices.includes(deviceId));
      return {
        v: 1,
        deviceId,
        registrationId:  KeyHelper.generateRegistrationId(),
        identityKeyPair: await KeyHelper.generateIdentityKeyPair(),
        preKeys:         {},
        nextPreKeyId:    1,
        signedPreKeys:   {},
        signedPreKeyId:  0,
        sessions:        {},
        identities:      {}, // "jid|id" -> { key, trust, added, pendingKey? }
      };
    }

    async rotateSignedPreKey() {
      const s = this.state, now = Date.now();
      const cur = s.signedPreKeys[s.signedPreKeyId];
      if (cur && now - cur.created < SPK_ROTATE_MS) return;
      const id  = s.signedPreKeyId + 1;
      const spk = await libsignal.KeyHelper.generateSignedPreKey(s.identityKeyPair, id);
      s.signedPreKeys[id] = { keyPair: spk.keyPair, signature: spk.signature, created: now };
      s.signedPreKeyId = id;
      for (const [k, v] of Object.entries(s.signedPreKeys)) {
        if (+k !== id && now - v.created > SPK_KEEP_MS) delete s.signedPreKeys[k];
      }
    }

    async topUpPreKeys() {
      const s = this.state;
      for (let n = Object.keys(s.preKeys).length; n < PREKEYS; n++) {
        const id = s.nextPreKeyId;
        s.nextPreKeyId = id >= MAX_PREKEY_ID ? 1 : id + 1;
        s.preKeys[id] = (await libsignal.KeyHelper.generatePreKey(id)).keyPair;
      }
    }

    // Each one-time prekey is used once; replace them in batches.
    schedulePreKeyRefill() {
      this.preKeysUsed = false;
      clearTimeout(this.refillTimer);
      this.refillTimer = setTimeout(() => {
        this.serial(async () => {
          this.alive();
          await this.topUpPreKeys();
          await this.save();
          await this.publishBundle();
        }).catch(e => { if (e.code !== 'stopped') console.warn('OMEMO prekey refill failed', e); });
      }, 2000);
    }

    // The storage interface libsignal expects.
    makeStore() {
      return {
        getIdentityKeyPair:     async () => this.state.identityKeyPair,
        getLocalRegistrationId: async () => this.state.registrationId,
        isTrustedIdentity: async (name, key) => {
          const r = this.state.identities[splitIdentity(name).key];
          return !r || (bufEq(r.key, key) && r.trust !== 'distrusted');
        },
        // Unlike a stock libsignal store, this refuses (throws) rather than
        // overwrites a changed key. That also covers the library's PreKey
        // receive path, whose own trust check is missing an `await` and so
        // never fails.
        saveIdentity: async (addr, key) => {
          const { jid, key: id } = splitIdentity(addr);
          const r = this.state.identities[id];
          if (!r) {
            this.state.identities[id] = { key, trust: this.initialTrust(jid), added: Date.now() };
            return false;
          }
          if (!bufEq(r.key, key)) {
            r.pendingKey = key;
            throw new OmemoError('Identity key changed', 'identity-changed');
          }
          if (r.trust === 'distrusted') throw new OmemoError('Device is distrusted', 'distrusted');
          return false;
        },
        loadPreKey:   async id => this.state.preKeys[id],
        storePreKey:  async (id, kp) => { this.state.preKeys[id] = kp; },
        removePreKey: async id => { delete this.state.preKeys[id]; this.preKeysUsed = true; },
        loadSignedPreKey:   async id => this.state.signedPreKeys[id] && this.state.signedPreKeys[id].keyPair,
        storeSignedPreKey:  async (id, kp) => { this.state.signedPreKeys[id] = { keyPair: kp, created: Date.now() }; },
        removeSignedPreKey: async id => { delete this.state.signedPreKeys[id]; },
        loadSession:  async a => this.state.sessions[a],
        storeSession: async (a, rec) => { this.state.sessions[a] = rec; },
      };
    }

    address(jid, id) { return new libsignal.SignalProtocolAddress(addressName(jid, id), id); }

    identity(jid, id) { return this.state ? this.state.identities[addressName(jid, id)] : undefined; }

    // `except` leaves one device out of the "has verified devices" check.
    initialTrust(jid, except) {
      const verified = Object.entries(this.state.identities)
        .some(([k, r]) => k !== except && splitIdentity(k).jid === jid && r.trust === 'verified');
      return verified ? 'undecided' : 'blind';
    }

    // ── PEP ─────────────────────────────────────────────────────────────────
    iq(stanza) {
      const c = this.conn;
      if (!c) return Promise.reject(new OmemoError('OMEMO session ended', 'stopped'));
      return new Promise((resolve, reject) =>
        c.sendIQ(stanza, resolve, err => reject(new IqError(err)), IQ_TIMEOUT_MS));
    }

    pubsubGet(jid, node) {
      const attrs = { type: 'get' };
      if (jid !== this.jid) attrs.to = jid;
      return this.iq($iq(attrs).c('pubsub', { xmlns: NS_PUBSUB }).c('items', { node, max_items: 1 }));
    }

    // Asks for an open access model (so contacts who haven't subscribed to our
    // presence can still fetch our keys). A server whose existing node is
    // configured differently refuses the precondition — then publish anyway.
    async publishItem(node, makePayload) {
      const build = withOptions => {
        const b = $iq({ type: 'set' }).c('pubsub', { xmlns: NS_PUBSUB })
          .c('publish', { node }).c('item', { id: 'current' }).cnode(makePayload()).up().up().up();
        if (withOptions) {
          b.c('publish-options').c('x', { xmlns: 'jabber:x:data', type: 'submit' })
            .c('field', { var: 'FORM_TYPE', type: 'hidden' }).c('value').t(NS_PUBSUB + '#publish-options').up().up()
            .c('field', { var: 'pubsub#access_model' }).c('value').t('open');
        }
        return b;
      };
      try {
        await this.iq(build(true));
      } catch (e) {
        if (!(e instanceof IqError) || e.condition === 'timeout') throw e;
        await this.iq(build(false));
      }
    }

    static parseDeviceList(itemsEl) {
      const item = kid(itemsEl, 'item');
      const list = item && kids(item, 'list').find(l => l.namespaceURI === NS);
      const ids  = kids(list, 'device').map(d => parseInt(d.getAttribute('id'), 10))
        .filter(id => Number.isInteger(id) && id > 0 && id <= 0x7FFFFFFF);
      return [...new Set(ids)];
    }

    async fetchDeviceList(jid) {
      let ids;
      try {
        const res = await this.pubsubGet(jid, NODE_DEVICES);
        const items = [...res.getElementsByTagNameNS(NS_PUBSUB, 'items')][0];
        ids = items ? Session.parseDeviceList(items) : [];
      } catch (e) {
        // No node, no PEP, or not allowed to see it: no OMEMO for us there.
        if (!(e instanceof IqError) || e.condition === 'timeout') throw e;
        ids = [];
      }
      if (this.stopped) throw new OmemoError('OMEMO session ended', 'stopped');
      this.devices.set(jid, ids);
      return ids;
    }

    // Fetched once per session; after that PEP pushes updates (we advertise
    // devicelist+notify in our caps).
    deviceList(jid, refresh = false) {
      if (refresh || !this.fetched.has(jid)) {
        const p = this.fetchDeviceList(jid);
        this.fetched.set(jid, p);
        p.catch(() => this.fetched.delete(jid));
      }
      return this.fetched.get(jid);
    }

    publishDeviceList(ids) {
      this.devices.set(this.jid, ids);
      return this.publishItem(NODE_DEVICES, () => {
        const b = $build('list', { xmlns: NS });
        ids.forEach(id => b.c('device', { id }).up());
        return b.tree();
      });
    }

    publishBundle() {
      const s = this.state;
      const spk = s.signedPreKeys[s.signedPreKeyId];
      return this.publishItem(NODE_BUNDLE + s.deviceId, () => {
        const b = $build('bundle', { xmlns: NS })
          .c('signedPreKeyPublic', { signedPreKeyId: s.signedPreKeyId }).t(toB64(spk.keyPair.pubKey)).up()
          .c('signedPreKeySignature').t(toB64(spk.signature)).up()
          .c('identityKey').t(toB64(s.identityKeyPair.pubKey)).up()
          .c('prekeys');
        for (const [id, kp] of Object.entries(s.preKeys)) b.c('preKeyPublic', { preKeyId: id }).t(toB64(kp.pubKey)).up();
        return b.tree();
      });
    }

    async fetchBundle(jid, id) {
      const res    = await this.pubsubGet(jid, NODE_BUNDLE + id);
      const bundle = [...res.getElementsByTagNameNS(NS, 'bundle')][0];
      const spk = kid(bundle, 'signedPreKeyPublic');
      const sig = kid(bundle, 'signedPreKeySignature');
      const ik  = kid(bundle, 'identityKey');
      const pks = kids(kid(bundle, 'prekeys'), 'preKeyPublic');
      if (!spk || !sig || !ik || !pks.length) throw new OmemoError('Invalid OMEMO bundle', 'bad-bundle');
      const pk = pks[crypto.getRandomValues(new Uint32Array(1))[0] % pks.length];
      return {
        registrationId: 0,
        identityKey: fromB64(ik.textContent),
        signedPreKey: {
          keyId:     parseInt(spk.getAttribute('signedPreKeyId'), 10),
          publicKey: fromB64(spk.textContent),
          signature: fromB64(sig.textContent),
        },
        preKey: { keyId: parseInt(pk.getAttribute('preKeyId'), 10), publicKey: fromB64(pk.textContent) },
      };
    }

    // A PEP push. Returns true if it was an OMEMO device list.
    handleEvent(msg) {
      const items = [...msg.getElementsByTagNameNS(NS_EVENT, 'items')].find(i => i.getAttribute('node') === NODE_DEVICES);
      if (!items || !this.state) return false;
      const from = bare(msg.getAttribute('from')) || this.jid;
      const ids  = Session.parseDeviceList(items);
      this.devices.set(from, ids);
      this.fetched.set(from, Promise.resolve(ids));
      // Another client of ours overwrote the list without us: put us back.
      if (from === this.jid && this.ready && !ids.includes(this.deviceId)) {
        this.publishDeviceList([...ids, this.deviceId]).catch(e => console.warn('OMEMO device list republish failed', e));
      }
      this.changed(from);
      return true;
    }

    // ── Encrypt / decrypt ───────────────────────────────────────────────────
    // Resolves to { stanza (a $msg builder positioned at <message>), skipped },
    // or rejects with an OmemoError if no device of `to` can be encrypted for.
    encrypt(to, text) { return this.serial(() => this.encryptJob(bare(to), text)); }

    async encryptJob(to, text) {
      this.alive();
      if (!this.ready) throw new OmemoError('Encryption isn\'t ready yet', 'not-ready');
      const [theirs, mine] = await Promise.all([this.deviceList(to), this.deviceList(this.jid)]);
      this.alive();
      if (!theirs.length) throw new OmemoError(to + ' doesn\'t have OMEMO set up', 'no-devices');

      // Payload: AES-128-GCM. Each device gets key || tag via its Signal session.
      const key = crypto.getRandomValues(new Uint8Array(16));
      const iv  = crypto.getRandomValues(new Uint8Array(12));
      const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
      const ct  = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, utf8.encode(text)));
      const payload = ct.slice(0, ct.length - 16);
      const keyMaterial = concat(key, ct.slice(ct.length - 16)).buffer;

      const targets = [
        ...theirs.map(id => [to, id]),
        ...(to === this.jid ? [] : mine.filter(id => id !== this.deviceId).map(id => [this.jid, id])),
      ].filter(([jid, id]) => !(jid === this.jid && id === this.deviceId));

      const keys = [], skipped = [];
      // Why a known device can't be used, or null if it can (or is new).
      const unusable = (jid, id) => {
        const r = this.identity(jid, id);
        if (!r) return null;
        if (r.pendingKey) return 'key changed';
        return r.trust === 'blind' || r.trust === 'verified' ? null : r.trust;
      };
      for (const [jid, id] of targets) {
        const why = unusable(jid, id);
        if (why) { skipped.push({ jid, id, reason: why }); continue; }
        try {
          const addr   = this.address(jid, id);
          const cipher = new libsignal.SessionCipher(this.store, addr);
          if (!await cipher.hasOpenSession()) {
            const bundle = await this.fetchBundle(jid, id);
            this.alive();
            const r = this.identity(jid, id);
            if (r && !bufEq(r.key, bundle.identityKey)) {
              r.pendingKey = bundle.identityKey;
              skipped.push({ jid, id, reason: 'key changed' });
              continue;
            }
            await new libsignal.SessionBuilder(this.store, addr).processPreKey(bundle);
            // A new device for a contact with verified devices starts undecided.
            const now = unusable(jid, id);
            if (now) { skipped.push({ jid, id, reason: now }); continue; }
          }
          keys.push({ jid, id, msg: await cipher.encrypt(keyMaterial) });
        } catch (e) {
          if (e.code === 'stopped') throw e;
          skipped.push({ jid, id, reason: e.message });
        }
      }
      this.alive();

      if (!keys.some(k => k.jid === to)) {
        await this.save().catch(() => {});
        const why = skipped.filter(s => s.jid === to).map(s => s.reason);
        throw new OmemoError('None of ' + to + '\'s devices can be encrypted for (' +
          [...new Set(why)].join(', ') + '). Check Encryption details.', 'no-trusted-devices');
      }

      await this.save();
      this.alive();

      const m = $msg({ to, type: 'chat', id: this.conn.getUniqueId('omemo') })
        .c('encrypted', { xmlns: NS }).c('header', { sid: this.deviceId });
      for (const k of keys) {
        const attrs = { rid: k.id };
        if (k.msg.type === 3) attrs.prekey = 'true';
        m.c('key', attrs).t(btoa(k.msg.body)).up();
      }
      m.c('iv').t(toB64(iv)).up().up()
        .c('payload').t(toB64(payload)).up().up()
        .c('store', { xmlns: 'urn:xmpp:hints' }).up()
        .c('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: NS, name: 'OMEMO' }).up()
        .c('body').t(FALLBACK_BODY).up();
      return { stanza: m, skipped };
    }

    // Resolves to { text, sid, trust } — text is null for a key-transport
    // message (no payload) and duplicate is set for a replayed message.
    decrypt(from, encryptedEl) { return this.serial(() => this.decryptJob(bare(from), encryptedEl)); }

    async decryptJob(from, enc) {
      this.alive();
      if (!this.ready) throw new OmemoError('Encryption isn\'t set up on this device', 'not-ready');
      const header = kid(enc, 'header');
      const sid = parseInt(header && header.getAttribute('sid'), 10);
      const ivEl = kid(header, 'iv');
      if (!sid || !ivEl) throw new OmemoError('Malformed OMEMO message', 'malformed');
      const keyEl = kids(header, 'key').find(k => parseInt(k.getAttribute('rid'), 10) === this.deviceId);
      if (!keyEl) throw new OmemoError('It wasn\'t encrypted for this device', 'not-for-us');

      const r = this.identity(from, sid);
      if (r && r.trust === 'distrusted') throw new OmemoError('It came from a device you distrusted', 'distrusted');
      if (r && r.pendingKey) throw new OmemoError('That device\'s key changed', 'identity-changed');

      const prekey = ['true', '1'].includes(keyEl.getAttribute('prekey'));
      const cipher = new libsignal.SessionCipher(this.store, this.address(from, sid));
      const bin = atob(keyEl.textContent.replace(/\s+/g, ''));
      let km;
      try {
        km = new Uint8Array(prekey
          ? await cipher.decryptPreKeyWhisperMessage(bin, 'binary')
          : await cipher.decryptWhisperMessage(bin, 'binary'));
      } catch (e) {
        this.alive();
        if (e.code === 'identity-changed' || /identity key changed/i.test(e.message)) {
          await this.save().catch(() => {});
          throw new OmemoError('That device\'s key changed', 'identity-changed');
        }
        if (e.name === 'MessageCounterError' || /counter was repeated/i.test(e.message)) {
          return { text: null, sid, duplicate: true };
        }
        throw new OmemoError('It couldn\'t be decrypted (' + e.message + ')', 'decrypt-failed');
      }
      this.alive();
      await this.save();
      if (this.preKeysUsed) this.schedulePreKeyRefill();

      const trust = this.identity(from, sid) ? this.identity(from, sid).trust : 'blind';
      const payloadEl = kid(enc, 'payload');
      if (!payloadEl) return { text: null, sid, trust };

      // key || tag; very old senders put the tag on the payload instead.
      const tag = km.slice(16);
      let data = new Uint8Array(fromB64(payloadEl.textContent));
      if (tag.length) data = concat(data, tag);
      const aes = await crypto.subtle.importKey('raw', km.slice(0, 16), 'AES-GCM', false, ['decrypt']);
      let pt;
      try {
        pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromB64(ivEl.textContent)) }, aes, data);
      } catch {
        throw new OmemoError('Its contents failed the integrity check', 'decrypt-failed');
      }
      return { text: unutf8.decode(pt), sid, trust };
    }

    // ── Trust management (for the UI) ─────────────────────────────────────
    ownFingerprint() { return this.state ? fingerprint(this.state.identityKeyPair.pubKey) : ''; }

    // Every device of `jid` we know of: published now, or seen before.
    // Fetches bundles for published devices we haven't seen, so their
    // fingerprints can be shown.
    async describe(jid) {
      jid = bare(jid);
      const published = await this.deviceList(jid, true);
      this.alive();
      for (const id of published) {
        if (jid === this.jid && id === this.deviceId) continue;
        if (this.identity(jid, id)) continue;
        try {
          const b = await this.fetchBundle(jid, id);
          this.alive();
          if (!this.identity(jid, id)) {
            this.state.identities[addressName(jid, id)] = { key: b.identityKey, trust: this.initialTrust(jid), added: Date.now() };
          }
        } catch (e) {
          if (e.code === 'stopped') throw e;
        }
      }
      await this.save();
      const ids = new Set(published);
      for (const k of Object.keys(this.state.identities)) {
        const s = splitIdentity(k);
        if (s.jid === jid) ids.add(s.id);
      }
      ids.delete(jid === this.jid ? this.deviceId : -1);
      return [...ids].sort((a, b) => a - b).map(id => {
        const r = this.identity(jid, id);
        return {
          id,
          active:      published.includes(id),
          trust:       r ? r.trust : 'unknown',
          fingerprint: r ? fingerprint(r.key) : null,
          pending:     r && r.pendingKey ? fingerprint(r.pendingKey) : null,
        };
      });
    }

    setTrust(jid, id, trust) {
      return this.serial(async () => {
        this.alive();
        const r = this.identity(bare(jid), id);
        if (!r) return;
        r.trust = trust;
        await this.save();
        this.changed(bare(jid));
      });
    }

    // Replace a changed identity key. The device starts over as undecided
    // (or blind, if nothing of this contact is verified) and its old
    // session is dropped.
    acceptNewKey(jid, id) {
      return this.serial(async () => {
        this.alive();
        jid = bare(jid);
        const r = this.identity(jid, id);
        if (!r || !r.pendingKey) return;
        r.key = r.pendingKey;
        delete r.pendingKey;
        r.trust = this.initialTrust(jid, addressName(jid, id));
        r.added = Date.now();
        delete this.state.sessions[this.address(jid, id).toString()];
        await this.save();
        this.changed(jid);
      });
    }

    // Removes this browser as an OMEMO device: off the published device
    // list, bundle deleted, keys erased from IndexedDB.
    forget() {
      return this.serial(async () => {
        this.alive();
        const id = this.deviceId;
        try {
          const ids = await this.fetchDeviceList(this.jid);
          await this.publishDeviceList(ids.filter(i => i !== id));
          await this.iq($iq({ type: 'set' }).c('pubsub', { xmlns: NS_OWNER }).c('delete', { node: NODE_BUNDLE + id }));
        } catch (e) {
          console.warn('OMEMO: could not unpublish this device', e);
        }
        const vault = this.vault;
        this.stop();
        await this.saving;
        await vault.destroy();
      });
    }
  }

  return { NS, NOTIFY_FEATURE, OmemoError, openVault, Session, fingerprint };
})();
