# HIPAA Compliance Roadmap

> Status: **Phase 1 (client hardening) done** — 2026-10-10. Phases 2–3 not started.
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
| No PHI in browser storage | Client | ✅ No localStorage/IndexedDB/cookies; `Cache-Control: no-store` on everything |
| No PHI in OS notifications | Client | ✅ Notifications say only "You have a new priority message" — no sender, no text; closed on sign-out |
| No PHI to third parties | Client | ✅ No CDN (Strophe is vendored); spellcheck off on inputs (Chrome/Edge "enhanced spellcheck" sends text to the cloud) |
| Integrity: XSS / script injection | Client | ✅ No untrusted data in `innerHTML`; CSP `script-src 'self'` (no inline script) |
| Integrity: messages reach the right person | Client | ✅ Fixed a bug where `a.b@x` and `a_b@x` shared a chat window (see below) |
| Audit controls | **Server** | ❌ Not started — see Phase 3 |
| Data at rest (offline messages, archives, logs) | **Server** | ❌ Not started — see Phase 3 |
| Emergency / break-glass access | **Server** | ❌ Not started |
| End-to-end encryption | Client + server | ❌ None — server can read message content. Not required by HIPAA, but see Phase 2 |

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
- No `localStorage`/`sessionStorage`/IndexedDB/cookies for anything that could contain PHI.
- No inline `<script>` or `on*=""` attributes; no untrusted data in `innerHTML`.
- No third-party origins in the CSP.
- Notifications stay content-free.
- Any new way a session can end calls `endSession()`.

---

## Phase 2 — End-to-end encryption (OMEMO, XEP-0384)

HIPAA doesn't require E2E encryption — a server that holds plaintext is acceptable if the server itself is covered (BAA, access control, audit, protected storage). E2E is still worth having: it takes the server operator, backups and logs out of the set of things that can read message content, which shrinks the Phase 3 burden.

Building OMEMO into this hand-rolled client is a large project (Signal protocol, device lists, key exchange, multi-device). **Converse.js ships OMEMO already** — given the plan to move the web client to Converse.js, get E2E there rather than here.

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
