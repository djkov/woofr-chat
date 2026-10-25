// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jacob Kuznetsov

// Conversation history, kept on this device so chats are still there after
// signing back in. (OMEMO message keys are single-use, so history can't be
// fetched from the server and decrypted again later.)
//
// One IndexedDB record per conversation, AES-GCM encrypted under the same
// password-derived key as the OMEMO store (Vault.seal / Vault.open in
// omemo.js), and keyed by a hash so the database doesn't name who you talk
// to. Messages older than the retention period are deleted; with history
// turned off nothing is written at all. See HIPAA.md.
'use strict';

const History = (() => {
  const DB_NAME   = 'woofr-history';
  const DB_STORE  = 'conversations';
  const MAX_PER_CHAT = 1000;
  const DAY = 86_400_000;

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE).createIndex('acct', 'acct');
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
  }

  async function run(mode, fn) {
    const db = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const tx  = db.transaction(DB_STORE, mode);
        const out = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function sha256Hex(s) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Message: { dir: 'in' | 'out', kind: 'msg' | 'priority', text, ts, enc, untrusted }
  class Store {
    constructor(vault, days) {
      this.vault  = vault;
      this.days   = days;
      this.writes = Promise.resolve();
    }

    expiresAt(ts) { return ts + this.days * DAY; }
    expired(m, now = Date.now()) { return this.expiresAt(m.ts) <= now; }

    async recordKey(jid) {
      const conv = await sha256Hex(this.vault.id + ':' + jid);
      return { key: this.vault.id + ':' + conv, conv };
    }

    // Every conversation for this account: Map<jid, messages oldest first>,
    // with expired messages already removed (and removed from disk). Records
    // that can't be decrypted (the password changed) are deleted.
    async load() {
      const acct = this.vault.id;
      const rows = await run('readonly', s => {
        const found = [];
        const req = s.index('acct').openCursor(IDBKeyRange.only(acct));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          found.push({ key: cur.primaryKey, rec: cur.value });
          cur.continue();
        };
        return found;
      });
      const out = new Map(), drop = [], rewrite = [];
      for (const { key, rec } of rows) {
        let data;
        try {
          data = await this.vault.open(rec.iv, rec.ct, 'history:' + rec.conv);
        } catch {
          drop.push(key);
          continue;
        }
        const live = data.messages.filter(m => !this.expired(m));
        if (!live.length) drop.push(key);
        else {
          if (live.length !== data.messages.length) rewrite.push([data.jid, live]);
          out.set(data.jid, live);
        }
      }
      if (drop.length) await run('readwrite', s => drop.forEach(k => s.delete(k)));
      rewrite.forEach(([jid, msgs]) => this.save(jid, msgs));
      return out;
    }

    // Writes run one at a time, each snapshotting the conversation as it is.
    save(jid, messages) {
      const keep = messages.filter(m => !this.expired(m)).slice(-MAX_PER_CHAT);
      this.writes = this.writes.then(async () => {
        const { key, conv } = await this.recordKey(jid);
        if (!keep.length) {
          await run('readwrite', s => s.delete(key));
          return;
        }
        const { iv, ct } = await this.vault.seal({ jid, messages: keep }, 'history:' + conv);
        await run('readwrite', s => s.put({ acct: this.vault.id, conv, iv, ct }, key));
      }).catch(e => console.warn('Couldn\'t save history', e));
      return this.writes;
    }

    // Deletes this account's history from this device.
    clear() {
      const acct = this.vault.id;
      this.writes = this.writes.then(() => run('readwrite', s => {
        const req = s.index('acct').openKeyCursor(IDBKeyRange.only(acct));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          s.delete(cur.primaryKey);
          cur.continue();
        };
      })).catch(e => console.warn('Couldn\'t clear history', e));
      return this.writes;
    }
  }

  return { Store, DAY };
})();
