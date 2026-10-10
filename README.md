# woofr.chat

A retro-styled XMPP web client built with nostalgia for the 2000s (AIM, MSN Messenger, ICQ). No build step, no framework, one vendored dependency.

---

## Overview

| Property | Value |
|---|---|
| Files | `index.html` (markup + CSS), `app.js` (all JS), `vendor/strophe.umd.min.js` |
| Dependencies | [Strophe.js 1.6.2](https://www.npmjs.com/package/strophe.js/v/1.6.2) (vendored — no CDN) |
| Protocol | XMPP over BOSH (XEP-0124) |
| BOSH endpoint | `https://woofr.chat:5443/bosh` (hardcoded, not shown to users) |
| Auth | SASL PLAIN (SCRAM-SHA-512 disabled due to Strophe 1.6.2 bug) |
| Browser APIs | Web Audio API, Notifications API |

---

## Running with Docker

### Build

```bash
docker build -t woofr-client .
```

### Run (behind a TLS-terminating reverse proxy)

```bash
docker run -d \
  --name woofr-client \
  --read-only \
  --cap-drop ALL \
  --tmpfs /tmp \
  -p 127.0.0.1:8090:8080 \
  woofr-client
```

- Bound to `127.0.0.1` only — not exposed directly to the internet.
- `--read-only` — container filesystem is immutable at runtime.
- `--cap-drop ALL` — drops all Linux capabilities.
- `--tmpfs /tmp` — nginx writes its temp files to an in-memory mount; nothing persists to disk.

**TLS is required.** Point your reverse proxy (Traefik, nginx, Caddy, cloud LB) at host port 8090 (container listens on 8080 internally) and terminate HTTPS there. The container will not serve traffic directly on a public port.

On the woofr.chat VPS, `docker compose up` (see `docker-compose.yml`) joins the container to **Traefik**'s shared `proxy` network. Its labels route `woofr.chat` to port 8080, and Traefik terminates TLS (configured in the `djkov/infra` repo). The app lives under `/messenger/<name>`, e.g. `/messenger/alpha`, and `/` returns 404 by design. Until the Traefik cutover, Nginx Proxy Manager also reaches the container over `npm_network`. The staging override sets `traefik.enable=false`, so a smoke-test stack never gets production traffic.

Example Caddy config:

```
woofr.chat {
    reverse_proxy 127.0.0.1:8090
}
```

### HIPAA note

The nginx config (`nginx.conf`) enforces:

- `Cache-Control: no-store` — prevents PHI caching in browsers and proxies
- `Strict-Transport-Security` — locks browsers to HTTPS for 2 years
- `Content-Security-Policy` with `script-src 'self'` (no inline script, no CDNs) and `connect-src` locked to `https://woofr.chat:5443` only
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` / `-Resource-Policy: same-origin`
- Only `/messenger/alpha/` and the two scripts it loads are served (`/messenger/alpha` redirects to add the trailing slash); everything else returns 404 — no directory listing, no docs exposed

See `HIPAA.md` for the full compliance gap analysis and roadmap.

---

## Requirements

### Server-side

- An XMPP server with **BOSH** enabled (ejabberd, Prosody, Openfire, MongooseIM)
- BOSH endpoint must serve **CORS headers** on all responses (not just OPTIONS):

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

**ejabberd example** (`ejabberd.yml`):
```yaml
listen:
  - port: 5443
    tls: true
    module: ejabberd_http
    request_handlers:
      /bosh: mod_bosh
    custom_headers:
      "Access-Control-Allow-Origin": "*"
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      "Access-Control-Allow-Headers": "Content-Type"
```

### Client-side

- Serve `index.html` from any HTTP server — **do not open as `file://`**, browsers block CORS from file origins.

```bash
cd xmpp-mvp-client
python3 -m http.server 8080
# then open http://localhost:8080
```

---

## Features

### Connection & Auth

- Connects via **BOSH** (HTTP long-polling, no WebSocket)
- **SASL PLAIN** only — SCRAM-SHA-512 stripped at runtime due to a broken implementation in Strophe.js 1.6.2
- Requests the **roster** (contact list) on connect and subscribes to presence

### Session security

- **HTTPS only** — sign-in is disabled (with a warning) unless the page is a secure context (HTTPS, or `localhost` for development)
- **Lock after 5 minutes** idle — the app is hidden behind a password prompt; the connection stays up. 5 wrong passwords signs you out
- **Sign-out after 15 minutes** idle, even if locked
- **Everything is wiped** on any session end — sign-out, timeout, failed unlock, or a dropped connection
- The password field is cleared as soon as sign-in starts, and the password isn't kept in memory (unlock checks a PBKDF2 hash)

See `HIPAA.md` for the reasoning.

### Buddy List

- Populated from server roster via IQ query
- Live presence updates — contacts show as **Online** (green), **Away** (yellow), or **Offline** (grey)
- Inline "Add buddy" field — sends a presence subscription request
- Click any buddy to open a chat window

### Chat

- **Tabbed chat windows** — one tab per conversation, closeable
- **Enter** to send, **Shift+Enter** for newline
- Basic text formatting toolbar (Bold, Italic) wraps selected text with `**` / `_` markers
- Messages are displayed with timestamp and coloured nick (red for them, blue for you)

---

## Implemented XEPs

### XEP-0124 — BOSH
XMPP over HTTP long-polling. Handled entirely by Strophe.js.

### XEP-0224 — Attention

**Nudge** — sends a `<message>` stanza with an `<attention xmlns='urn:xmpp:attention:0'/>` child and no `<body>`:

```xml
<message to="buddy@server" type="chat">
  <attention xmlns="urn:xmpp:attention:0"/>
</message>
```

- Displayed as an italic system line in the chat log
- Triggers a window shake animation
- Plays a short descending three-tone sound (880→660→440 Hz sine waves)

**Rate limiting:** maximum **2 nudges per 60 seconds** per contact. On the 3rd attempt within the window, a red error banner shows the remaining wait time. This limit does not apply to Priority Messages.

### Priority Message (XEP-0224 extended)

Sends a `<message>` with both a `<body>` and `<attention>` — a message that demands immediate attention:

```xml
<message to="buddy@server" type="chat">
  <body>Call me NOW</body>
  <attention xmlns="urn:xmpp:attention:0"/>
</message>
```

**Sender side:**
- Triggered by the **⚠ Priority** button in the chat toolbar
- Displayed in the sender's log with a yellow background and red border

**Recipient side:**
- Rendered as a **Priority Message (!)** block — yellow background, red border, bold text
- Shows a **✓ Mark as Read** button
- Triggers a window shake
- Plays a repeating siren alert (alternating 900/1400 Hz square waves) **every 1.8 seconds until acknowledged**
- The alert loop stops only when all unread Priority Messages have been marked as read

---

## Browser Notifications

On sign-in the client requests `Notification` permission.

| Event | Behaviour |
|---|---|
| Nudge received | "Someone sent you a nudge." — auto-dismisses after 6 seconds |
| Priority Message received | "You have a new priority message." — stays until dismissed (`requireInteraction: true`) |

Notifications deliberately never include the sender or message text (they show on lock screens and outlive the session), and are all closed on sign-out. Both are `silent: true` — the in-app Web Audio handles sound.

---

## Audio

All sounds are synthesised via the **Web Audio API** — no audio files needed.

| Sound | Trigger | Waveform | Notes |
|---|---|---|---|
| Nudge tone | Nudge received | Sine, 3 tones descending | Plays once |
| Priority alert | PM received | Square, 900/1400 Hz alternating × 6 | Loops every 1.8s until read |

---

## Known Issues & Future Work

- **SASL PLAIN only** — credentials sent base64-encoded; HTTPS is mandatory in production. SCRAM-SHA-1/SHA-256 support needs a Strophe plugin or library upgrade.
- **No message history** — XEP-0313 (MAM) not implemented; chat log is session-only.
- **No multi-user chat** — XEP-0045 (MUC) not implemented.
- **No file transfer** — XEP-0096 / XEP-0234 not implemented.
- **No message delivery receipts** — XEP-0184 not implemented.
- **No typing indicators** — XEP-0085 (Chat State Notifications) not implemented.
- **No vCard / avatars** — XEP-0054 / XEP-0084 not implemented.
- **CSS is still inline** in `index.html` — it's why the CSP keeps `style-src 'unsafe-inline'`.
- **No persistence** — roster additions, nudge rate-limit timestamps, and chat logs are all in-memory and lost on reload.

---

## Architecture

```
index.html
├── <style>          Inline CSS — Win2000 aesthetic, animations, component styles
└── <body>           HTML — login, lock and app panels, buddy list, chat area (all in one window div)

app.js
├── State            conn, myJid, buddies{}, chatWindows{}, activeChat, nudgeTimestamps{}
├── Auth             doLogin / onConnectStatus / onConnected
├── Roster           onRoster / addBuddy / renderBuddyList
├── Presence         onPresence
├── Messaging        onMessage / sendMsg / appendMsg
├── XEP-0224         sendNudge (rate-limited) / onAttention / sendPriorityMsg / appendPriorityMsg
├── Alerts           startAlertLoop / stopAlertLoop / playAlertBeep / playNudgeSound / shakeWindow
├── Notifications    requestNotifPermission / notify / closeNotifications
├── Inactivity       noteActivity / checkIdle / lockSession / doUnlock
└── Teardown         endSession — the single exit path; wipes all PHI

vendor/strophe.umd.min.js   Strophe.js 1.6.2 (+ its MIT licence alongside)
```

---

## Development Notes

- **Strophe.js 1.6.2 UMD build** is vendored as `vendor/strophe.umd.min.js` — the ESM `src/strophe.js` fails in non-module `<script>` tags. To update it: `npm pack strophe.js@<version>` (npm verifies the tarball's integrity), copy `package/dist/strophe.umd.min.js` and `package/LICENSE.txt` into `vendor/`.
- **No inline JS, ever.** The CSP is `script-src 'self'`, so inline `<script>` blocks and `onclick=""` attributes are blocked. Attach handlers from `app.js`, and build DOM with `textContent` — never put JIDs, roster names or message text into `innerHTML`.
- SCRAM-SHA-512 is deleted from `conn.mechanisms` before `connect()` — the Strophe implementation sends a literal base64(`"false"`) as the client-final message, which fails auth on every server.
- Incoming attention stanzas are detected with `getElementsByTagNameNS('urn:xmpp:attention:0', 'attention')` rather than `querySelector` — namespace-aware queries are required for XML stanzas and `querySelector` attribute matching is unreliable across browsers on XML documents.
