# HIPAA Compliance Roadmap

> Status: **Phase 1 (client hardening) done** — 2026-10-10. **Phase 2 (OMEMO end-to-end encryption) done** — 2026-10-24. Phase 3 not started.
> Motivation: data privacy by design, ahead of any commercial use.
>
> Bottom line: the web client now covers the technical safeguards a browser
> client *can* cover. What stands between this and handling real PHI is mostly
> **not in this repo** — see Phase 3 (server) and the administrative safeguards.

---

## What HIPAA requires: three safeguard categories

### 1. Administrative safeguards (not code)
- Designated Security Officer
- Documented risk analysis and management plan
- Workforce training records
- Incident response and breach notification plan
- **Business Associate Agreement (BAA) with whoever hosts the XMPP server** (and any VPS/cloud provider under it) — mandatory if any PHI flows through it

### 2. Physical safeguards (not code)
- Data center jurisdiction and physical access controls for the server
- Workstation security policies for end users of the client (screen locks, no shared browser profiles, no untrusted browser extensions)

### 3. Technical safeguards (code + config)
Split between this client and the XMPP server. See below.

---

## Current state

| Requirement | Where | State |
|---|---|---|
| Encryption in transit (page) | Client | ✅ HSTS + client refuses to sign in outside a secure context (HTTPS, or localhost for dev) |
| Encryption in transit (XMPP) | Client + server | ✅ BOSH over TLS (`https://woofr.chat:5443`) |
| Unique user ID / authentication | Server | ⚠️ JID + password; SASL PLAIN (password reaches the server, inside TLS); no MFA |
| Automatic logoff | Client | ✅ Lock after 5 min idle, full sign-out + wipe after 15 min |
| Session lock / re-auth | Client | ✅ Password re-entry; 5 failed attempts → sign-out |
| PHI wiped on session end | Client | ✅ Every exit path (sign-out, timeout, failed unlock, dropped connection) goes through one teardown |
| PHI in browser storage | Client | ⚠️ By choice: message history is kept on the device so chats survive sign-out — AES-GCM encrypted under the password, keyed by hashes (no contact names in the clear), deleted automatically after 7/30/90 days (default 30), or not kept at all. Keys likewise encrypted. localStorage holds only UI preferences. `Cache-Control: no-store` on everything |
| No PHI in OS notifications | Client | ✅ Notifications say only "You have a new priority message" — no sender, no text; closed on sign-out |
| No PHI to third parties | Client | ✅ No CDN (Strophe is vendored); spellcheck off on inputs (Chrome/Edge "enhanced spellcheck" sends text to the cloud) |
| Integrity: XSS / script injection | Client | ✅ No untrusted data in `innerHTML`; CSP `script-src 'self'; style-src 'self'` (no inline script or CSS, no eval) |
| Integrity: messages reach the right person | Client | ✅ Fixed a bug where `a.b@x` and `a_b@x` shared a chat window (see below) |
| Audit controls | **Server** | ❌ Not started — see Phase 3 |
| Data at rest (offline messages, archives, logs) | **Server** | ❌ Not started — see Phase 3 |
| Emergency / break-glass access | **Server** | ❌ Not started |
| End-to-end encryption | Client | ✅ OMEMO, on by default and failing closed — see Phase 2. Server still sees metadata (who, when, how often) |

---

## Phase 1 — Client hardening ✅ (done)

Implemented in `app.js` / `index.html` / `nginx.conf`:

1. **HTTPS enforced.** On a non-secure origin, a warning is shown and sign-in is disabled. HSTS (already present) covers repeat visits; this catches first visits and proxy misconfiguration.
2. **Inactivity lock (5 min) and logout (15 min).**
   - Lock hides the app behind a password prompt; the connection stays up, so incoming messages still arrive and priority alerts still sound.
   - Unlock checks the password against a salted PBKDF2 (600k iterations) hash taken at sign-in — the plaintext password is not kept in memory for the session (Strophe's copy is nulled after auth too).
   - Activity while locked doesn't count, so jiggling the mouse at an unattended screen can't keep a session alive. 5 wrong passwords → sign-out.
   - Idle time is measured against the wall clock, and re-checked whenever the tab becomes visible, so throttled background tabs and sleeping laptops can't dodge it.
   - Tunables: `LOCK_AFTER_MS`, `LOGOUT_AFTER_MS`, `MAX_UNLOCK_ATTEMPTS` at the top of `app.js`.
3. **Wipe on session end.** `endSession()` is the single exit path: disconnects, clears chat logs, drafts, buddy list, JID, password fields, notifications, timers and in-memory state. Handlers are bound to their connection, so stanzas still in flight after teardown are dropped instead of rendered into the wiped page. A dropped connection also ends the session.
4. **Security fixes found during the Phase 1 review:**
   - **XSS:** roster names and JIDs were concatenated into `innerHTML` and inline `onclick="…('jid')"` handlers, with a CSP that allowed `'unsafe-inline'`. All DOM is now built with `textContent`, JS moved to `app.js`, and the CSP is `script-src 'self'`. Verified that an injected `<img onerror>` is both rendered as text and blocked by CSP.
   - **Misdirected messages:** chat elements were looked up by an id derived from the JID that only replaced `@` and `.` — so `x.y@host` and `x_y@host` collided. Reproduced against the old code: replying in `x_y`'s window sent `x.y`'s draft to `x_y`, and both conversations rendered in one window. Each window now keeps direct element references.
   - **Password left in the form:** after sign-out the password field was still filled, so the next person at a shared computer could just click Sign In. It's now cleared as soon as it's read.
   - **PHI in notifications:** priority-message text was put in a persistent OS notification (visible on lock screens, and left behind after sign-out).
   - **Third-party script:** Strophe was loaded from jsDelivr without SRI. It's now vendored (`vendor/strophe.umd.min.js`, from the npm tarball for 1.6.2, integrity-checked by npm; the unminified file is byte-identical to what jsDelivr served).

**Deliberately not built: client-side audit log panel.** The original plan included an in-session, user-visible, non-persisted log of sign-ins/messages. It wouldn't satisfy §164.312(b): a log that lives in the user's own browser, vanishes on reload, and can be edited from devtools isn't an audit trail. Audit controls belong on the server (Phase 3).

**Invariants to keep** (a regression here undoes Phase 1):
- Nothing that could contain PHI goes into `localStorage`/`sessionStorage`/cookies (they hold UI preferences only: theme, light/dark, screen saver, history retention).
- IndexedDB holds exactly two things, both AES-GCM encrypted under the password-derived key: OMEMO key material, and conversation history (one record per chat, keyed by a hash, carrying no plaintext). History must stay subject to the retention period — expired messages are purged on load and hourly — and must be fully deleted by *Don't keep* and by *Remove this device's keys and history*. Status messages, pictures and logs are never stored.
- `connect-src` is the BOSH endpoint plus `'self'`; the latter exists only so the app can notice a new deploy by re-fetching its own static files.
- Files: encrypted in the browser before upload, so the server holds ciphertext only (the key is in the OMEMO message); only the server's own files are ever fetched; decrypted files exist in memory only and are discarded at sign-out; photos are re-encoded to drop EXIF. **The encrypted files persist on the server until it deletes them, so set an upload retention period** (ejabberd `mod_http_upload_quota`: `max_days`). Videos and other files aren't stripped of metadata.
- Addresses are hidden from the UI by default (names are shown instead). That's tidiness, not anonymity: the server and contacts still see them.
- Profile pictures are fetched from the XMPP server only (never an outside URL), checked against their hash, redrawn without metadata, and kept in memory until sign-out.
- Status messages are presence, which is never end-to-end encrypted — the UI says so, and they aren't remembered between sessions.
- No `style=""` attributes or inline `<style>` (the CSP blocks them).
- Nothing is sent unencrypted unless the user turned encryption off for that chat.
- No inline `<script>` or `on*=""` attributes; no untrusted data in `innerHTML`.
- No third-party origins in the CSP.
- Notifications stay content-free.
- Any new way a session can end calls `endSession()`.

---

## Phase 2 — End-to-end encryption (OMEMO, XEP-0384) ✅ (done)

HIPAA doesn't require E2E encryption — a server that holds plaintext is acceptable if the server itself is covered (BAA, access control, audit, protected storage). E2E is still worth having: it takes the server operator, backups and logs out of the set of things that can read message content, which shrinks the Phase 3 burden.

This was originally deferred to a Converse.js migration. It's now built into this client instead (`omemo.js`, on a vendored Signal-protocol library), so the hardening from Phase 1 is kept.

1. **OMEMO (legacy `eu.siacs.conversations.axolotl` namespace)** — what Conversations, Monal, Gajim, Dino and Converse.js speak. Priority-message text is encrypted too; nudges carry no content.
2. **Fails closed.** Every chat is encrypted by default. If the contact has no OMEMO device, or none we can trust, the message is not sent; turning encryption off is per chat, behind a confirmation, and plaintext messages are flagged in the log.
3. **Trust:** blind trust before verification, with fingerprint verification in the UI. After a contact has a verified device, new devices aren't used until the user decides. A changed identity key blocks that device in both directions until explicitly accepted (the library's own check for this is broken on the PreKey path; `omemo.js` enforces it in its key store).
4. **History on the device (added later, by decision).** Because message keys are single-use, the only way to keep history with E2E encryption is on the device. It's encrypted under the same password-derived key, expires automatically (default 30 days; 7/30/90 or off), shows each message's remaining days, and is erased with the device's keys. This trades some at-rest exposure (anyone with the password *and* this browser profile can read the retained period) for usability — the *Don't keep* setting restores the earlier behaviour, and should be the policy on shared workstations.
5. **Key storage.** OMEMO keys must persist, or the fingerprint changes on every sign-in and verification means nothing. They live in IndexedDB as one record per account (keyed by a hash of the JID), AES-256-GCM encrypted under a PBKDF2 (600k) key derived from the password at sign-in; the password itself is still not kept. Ratchet state is written before any message is sent or shown, so a reload can't reuse a message key. A Web Lock stops two tabs from sharing one ratchet. *Settings → Remove this device's keys* erases the record and unpublishes the device (shared computers).
6. **CSP tightened** alongside: CSS moved to `styles.css`, so `style-src 'unsafe-inline'` is gone.

**Remaining gaps / caveats:**
- **Metadata** (who talks to whom, when, message sizes) is still visible to the server.
- **Endpoint risk:** anyone with the password and this browser profile can decrypt the key store. Workstation policy (Phase 3 notes) still matters.
- **The Signal library** (`@privacyresearch/libsignal-protocol-typescript`) is a community port without a public audit, and is **GPL-3.0** — a licensing decision for any commercial distribution of the client.
- **Not covered:** group chats (no MUC), messages sent from other devices (no carbons), history (no MAM), and the newer `urn:xmpp:omemo:2`.
- **Offline messages** stored by the server (`mod_offline`) are now ciphertext when sent from OMEMO clients — but Phase 3's retention policy still applies to anything sent unencrypted.

---

## Phase 3 — Server and operational (the real remaining gap)

PHI lives on the server today, so this is where compliance is actually decided:

- **BAA** with the XMPP host and any VPS/cloud provider underneath it.
- **Data at rest:** ejabberd stores offline messages (`mod_offline`) and, if enabled, archives (`mod_mam`) in plaintext in its database. Decide what's kept, for how long, and encrypt the disk/DB. Document a retention and deletion policy.
- **Audit logging** (§164.312(b)): server-side records of authentication events and access, retained per policy and reviewed. Keep message *content* out of logs.
- **Account provisioning:** disable open in-band registration (`mod_register`) so every account maps to a known person.
- **Brute-force protection:** `mod_fail2ban` (ejabberd) or equivalent; password policy.
- **CORS:** BOSH currently answers `Access-Control-Allow-Origin: *`. Restrict it to `https://woofr.chat`.
- **SCRAM instead of PLAIN:** the client is pinned to PLAIN because of a SCRAM-SHA-512 bug in Strophe 1.6.2 (latest is 5.x). Upgrading Strophe and re-enabling SCRAM means the server never sees the password. Needs testing against the real server.
- **MFA:** XMPP has no widely deployed standard for it. Track as a known gap. HHS's January 2025 proposed update to the Security Rule would make MFA and encryption mandatory rather than "addressable" — check where that rulemaking stands.
- **Emergency access** procedure (admin-side).
- **Patch management** for the server and the client's nginx base image.

---

## Notes

- **True HIPAA compliance is never just code** — the administrative and physical safeguards (BAA, policies, training) are equally required.
- Some risks a web client can't control: browser extensions with page access, OS screenshots / app-switcher snapshots, shared browser profiles. These are workstation-policy items.
