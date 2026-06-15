# HIPAA Compliance Roadmap

> Status: **Planning** — not yet started.
> Motivation: data privacy by design, ahead of any commercial use.

---

## What HIPAA requires: three safeguard categories

### 1. Administrative safeguards (not code)
- Designated Security Officer
- Documented risk analysis and management plan
- Workforce training records
- Incident response and breach notification plan
- **Business Associate Agreement (BAA) with the XMPP server host** — mandatory if any PHI flows through it

### 2. Physical safeguards (not code)
- Data center jurisdiction and physical access controls for the server
- Workstation security policies for end users of the client

### 3. Technical safeguards (code + config)
This is where the client contributes. See gap analysis below.

---

## Current state vs requirements

| Requirement | Current state | Gap |
|---|---|---|
| Encryption in transit | ✅ TLS on port 5443 | Must **enforce** HTTPS and warn/block if loaded over HTTP |
| End-to-end encryption | ❌ None | **OMEMO (XEP-0384)** — server sees plaintext today |
| Unique user ID / authentication | ✅ JID + password | Weak — SASL PLAIN, no MFA |
| Automatic session timeout | ❌ None | Auto-logout after configurable inactivity period |
| Session lock before timeout | ❌ None | Re-auth prompt after shorter inactivity window |
| Audit controls | ❌ None | Timestamped log of sign-in/out and message events |
| Emergency / break-glass access | ❌ None | Admin override path (server-side concern primarily) |
| Message integrity | ❌ None | Covered by OMEMO |
| No PHI in browser storage | ✅ (by accident — no localStorage used) | Must stay this way; no caching of messages locally |
| DOM cleared on logout/timeout | ❌ None | Wipe all chat logs from DOM on session end |

---

## Roadmap

### Phase 1 — Client hardening (self-contained, no server changes)

1. **Enforce HTTPS** — detect `location.protocol`, show a blocking warning if loaded over HTTP, refuse to connect.
2. **Inactivity timer** — two thresholds:
   - **Lock** (e.g. 5 min): blur/hide chat area, show re-auth prompt without full disconnect.
   - **Logout** (e.g. 15 min): full disconnect, DOM wipe, return to login screen.
3. **DOM wipe on session end** — clear all chat logs, buddy list, and any displayed PHI from the DOM on logout or timeout.
4. **Audit log panel** — in-session, timestamped record of: sign-in, sign-out, contacts added, messages sent/received (metadata only — no message content in the audit log). Visible to the user, not persisted.

### Phase 2 — End-to-end encryption (significant effort)

- **OMEMO (XEP-0384)** — Signal protocol-based E2E encryption.
  - Without this the XMPP server operator can read every message. For any PHI use case this is the critical gap.
  - Requires a JavaScript Signal protocol implementation (e.g. `@privacyresearch/libsignal-protocol-typescript` or similar).
  - Requires device key management, key exchange on first contact, and handling of multi-device sessions.
  - Significant architecture addition — treat as a separate project milestone.

### Phase 3 — Server and operational

- BAA signed with XMPP server host (ejabberd/Prosody hosting provider).
- Server-side audit logging enabled and retained per policy (ejabberd has `mod_log_chat`, Prosody has `mod_mam`).
- Defined message retention and deletion policy documented.
- TLS certificate pinning or verification strategy.
- Consider self-hosting the XMPP server to fully control the data path.

---

## Notes

- **Phase 1 is entirely client-side** and can be done without touching the server. It meaningfully closes several gaps.
- **Phase 2 (OMEMO) is the most important gap** from a PHI confidentiality standpoint but also the most complex. Plan it as a dedicated effort.
- **True HIPAA compliance is never just code** — the administrative and physical safeguards (BAA, policies, training) are equally required and must be addressed in parallel.
- The current "no localStorage" behaviour is accidental but must be explicitly protected — never add client-side message persistence without encryption at rest.
