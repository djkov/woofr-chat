# woofr.chat

An XMPP web client with OMEMO end-to-end encryption and two looks: a WeChat-style theme (the default) and the original retro theme built with nostalgia for the 2000s (AIM, MSN Messenger, ICQ). No build step, no framework, two vendored dependencies.

---

## Overview

| Property | Value |
|---|---|
| Files | `index.html` (markup), `styles.css` (both themes), `app.js` (UI + XMPP), `omemo.js` (encryption), `vendor/` |
| Licence | GPL-3.0-or-later (see `LICENSE`) |
| Dependencies | [Strophe.js 1.6.2](https://www.npmjs.com/package/strophe.js/v/1.6.2), [libsignal-protocol-typescript 0.0.16](https://www.npmjs.com/package/@privacyresearch/libsignal-protocol-typescript) — both vendored, no CDN |
| Protocol | XMPP over BOSH (XEP-0124); OMEMO (XEP-0384) for end-to-end encryption |
| BOSH endpoint | `https://woofr.chat:5443/bosh` (hardcoded, not shown to users) |
| Auth | SASL PLAIN (SCRAM-SHA-512 disabled due to Strophe 1.6.2 bug) |
| Browser APIs | Web Audio, Notifications, Web Crypto, IndexedDB (encrypted keys only), Web Locks |

---

## Licence

woofr.chat is free software, licensed under the **GNU General Public License v3.0 or later** — see [`LICENSE`](LICENSE). Copyright © 2026 Jacob Kuznetsov.

The web client's JavaScript is downloaded by every visitor, which counts as distribution, so the GPL's conditions apply to the deployed site even though it's free:

- **Source:** this repository is the corresponding source. Keep it in step with what's deployed — the About dialog links here.
- **Notices:** the app serves `LICENSE.txt` and the third-party licence files, and shows the required notice under *About & licences* (sign-in screen and Settings).
- **Third-party code:** Strophe.js (MIT) and the libsignal bundle (GPL-3.0-only, with MIT / BSD-3-Clause / Apache-2.0 dependencies) — see `vendor/*LICENSE*.txt`. All are compatible with GPL-3.0.

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
- `Content-Security-Policy` with `script-src 'self'` and `style-src 'self'` (no inline script or CSS, no eval, no CDNs) and `connect-src` locked to `https://woofr.chat:5443` only
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` / `-Resource-Policy: same-origin`
- Only `/messenger/alpha/`, the files it loads (`app.js`, `omemo.js`, `styles.css`, two vendored scripts) and the licence texts are served (`/messenger/alpha` redirects to add the trailing slash); everything else returns 404 — no directory listing, no docs exposed

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

### Themes

- **WeChat** (default) — dark navigation rail, chat list with avatars, last-message previews, timestamps and red unread badges; green/white chat bubbles with centred time stamps. On phones: title bars on top, a Chats / Settings / Sign out tab bar at the bottom.
- **Retro** — the original Windows 2000 / AIM look: title bar, buddy list, tabbed chat windows, `[12:34] nick: text` lines.
- **Screen saver** (retro): when the session locks, a DVD-player-style *woofr.chat* logo bounces around a black screen, changing colour off each wall (watch for the corner). Any key or click brings back the unlock prompt; it returns after a minute untouched. *Settings → Theme* has *Preview* and *(None)*, and it holds still for people who've asked for reduced motion.
- **Light and dark** for both themes. *Automatic* (the default) follows the system setting; *Light* or *Dark* overrides it.
- Switch on the sign-in screen or in **Settings**. Only the theme and light/dark choice are remembered (`localStorage`, keys `woofr.theme`, `woofr.mode` and `woofr.screensaver`); they're applied before first paint.

### Profile pictures

- Contacts' pictures appear in the chat list, chat header area and next to messages (WeChat theme), read from **XEP-0084** (PEP avatars — Conversations, Monal, Dino, Gajim) with **XEP-0153** vCard avatars as the fallback (Converse and older clients).
- **Settings → Profile picture** sets or removes yours. It's square-cropped to 192×192 PNG and published both ways, so every kind of client sees it. The rest of your vCard is kept.
- Pictures only ever come from the XMPP server — avatars that point at an outside URL are ignored. Each is checked against its SHA-1, must be PNG/JPEG/GIF/WebP and at most 512 KB, and is redrawn on a canvas (dropping EXIF and other metadata) before it's shown. They're held in memory only and wiped on sign-out.

### Status

- **Settings → Your status** (or click your picture in the WeChat rail, or *[online]* in retro): *Available*, *Away* or *Busy*, plus an optional status message, sent to your contacts as standard XMPP presence.
- Contacts' status shows as a coloured dot, under their name in the chat list until you've exchanged messages, in the chat header, and in tooltips; retro shows the message next to the name.
- While the session is locked you show as *Away* (unless you chose *Busy*), and go back to what you set when you unlock.
- Status messages are **not** end-to-end encrypted (presence never is) and aren't remembered between sessions; Settings warns not to put sensitive details in them.

### End-to-end encryption (OMEMO)

Messages are encrypted with **OMEMO** ([XEP-0384](https://xmpp.org/extensions/xep-0384.html), the `eu.siacs.conversations.axolotl` namespace), so they interoperate with Conversations, Monal, Gajim, Dino and Converse.js. The server only relays ciphertext.

- **On by default, fails closed.** Every chat starts encrypted. If a contact has no OMEMO device, sending fails with an explanation (and the text goes back into the input box); nothing falls back to plaintext on its own. Turning encryption off is per chat, behind a confirmation, and the chat shows it (red *Not encrypted* toggle, open padlock, and each plaintext message is flagged).
- **Priority messages** are encrypted too (the `<attention/>` element stays outside so the alarm still works). **Nudges** carry no content and are sent as before.
- **Multi-device.** Messages are also encrypted for your own other OMEMO devices (e.g. Conversations on your phone).
- **Trust: blind trust before verification** (like Conversations). New contacts' devices are trusted on first use; once you've *verified* one of a contact's devices, any new device of theirs stays *undecided* (not encrypted to) until you decide. A device whose identity key changes is **blocked** in both directions until you explicitly accept the new key.
- **Encryption details** (`···` in the chat header, or *Keys* in retro): each device's fingerprint (same format Conversations shows), trust status, and Verify / Distrust / Accept-new-key actions. **Settings** shows this device's fingerprint and your other devices.
- **Key storage.** Identity keys, prekeys and Signal sessions are kept in IndexedDB, **AES-256-GCM encrypted under a key derived from your password** (PBKDF2-SHA-256, 600k iterations), so your fingerprint survives reloads. Message text is never stored. If your password changes, the old keys can't be unlocked: the client makes new ones, retires the old device from your device list, and tells you.
- **Shared computers:** *Settings → Remove this device's keys* deletes the keys from the browser and unpublishes the device.
- One tab per account: a second tab with the same account gets no encryption (two tabs writing one ratchet state would corrupt it), and says so.

### Connection & Auth

- Connects via **BOSH** (HTTP long-polling, no WebSocket)
- **SASL PLAIN** only — SCRAM-SHA-512 stripped at runtime due to a broken implementation in Strophe.js 1.6.2
- Requests the **roster** (contact list) on connect and subscribes to presence

### Session security

- **HTTPS only** — sign-in is disabled (with a warning) unless the page is a secure context (HTTPS, or `localhost` for development)
- **Lock after 5 minutes** idle — the app is hidden behind a password prompt; the connection stays up. 5 wrong passwords signs you out
- **Sign-out after 15 minutes** idle, even if locked
- **Everything is wiped** on any session end — sign-out, timeout, failed unlock, or a dropped connection. (The only thing left behind is the password-encrypted OMEMO key store, which never holds message text.)
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
- Messages show who sent them and when (bubbles in the WeChat theme; timestamp and coloured nick in retro), with a flag on anything that wasn't end-to-end encrypted
- Messages that fail to send stay in the log marked *Not sent*, with the reason

---

## Implemented XEPs

### XEP-0124 — BOSH
XMPP over HTTP long-polling. Handled entirely by Strophe.js.

### XEP-0384 — OMEMO Encryption (with XEP-0163 PEP, XEP-0380 EME, XEP-0334 hints)
`omemo.js`. Publishes this browser's device and bundle (100 one-time prekeys, refilled as they're used; signed prekey rotated weekly) with an `open` access model, fetches contacts' device lists and bundles, and encrypts each message with AES-128-GCM, the key + tag going to every recipient device through its Signal session. Outgoing messages carry an EME hint, a `store` hint, and a content-free fallback body.

### XEP-0030 / XEP-0115 — Service Discovery / Entity Capabilities
The client answers `disco#info` and advertises a caps hash in its presence. That's what tells the server to push contacts' OMEMO device-list and avatar changes (`devicelist+notify`, `urn:xmpp:avatar:metadata+notify`).

### XEP-0084 / XEP-0153 (+ XEP-0054) — Avatars
Reads PEP avatars (metadata pushes, data fetched by hash) and vCard-based avatars (photo hash in presence, vCard fetched on change). Publishes your own picture to both, and advertises your vCard photo hash in presence.

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
- **No message carbons** — XEP-0280 not implemented, so messages you send from another device don't show up here (they *are* encrypted for your other devices, so those can read what you send from here).
- **No multi-user chat** — XEP-0045 (MUC) not implemented, so no group OMEMO either.
- **OMEMO library** — `libsignal-protocol-typescript` is a community TypeScript port of Signal's protocol, not Signal's own code, and hasn't had a public audit. Its PreKey receive path skips the identity check (a missing `await`); `omemo.js`'s key store refuses changed keys itself to close that gap. It is **GPL-3.0**: serving it to browsers is distribution, so the client as a whole needs to be GPL-compatible.
- **No "now playing"** yet — the plan for sharing what you're listening to (e.g. Spotify) is XEP-0118 *User Tune* over PEP, the same way avatars travel. Reading Spotify would mean an OAuth connection to Spotify's API from the browser, so it needs a CSP exception and a privacy decision first.
- **Legacy OMEMO only** — the newer `urn:xmpp:omemo:2` namespace (OMEMO 0.8+) isn't supported; few clients ship it yet.
- **No file transfer** — XEP-0096 / XEP-0234 not implemented.
- **No message delivery receipts** — XEP-0184 not implemented.
- **No typing indicators** — XEP-0085 (Chat State Notifications) not implemented.
- **No vCard / avatars** — XEP-0054 / XEP-0084 not implemented.
- **No persistence** — roster additions, nudge rate-limit timestamps, and chat logs are all in-memory and lost on reload.

---

## Architecture

```
index.html           Markup only — login, lock and app panels, nav rail, buddy list, chat area, dialog
styles.css           Shared layout, then [data-theme="retro"] and [data-theme="wechat"] rules (colours from
                     palette variables), then the dark palettes for data-mode="auto" / "dark"

app.js
├── Theme            savedTheme / applyTheme / setTheme, savedMode / applyMode / setMode (before first paint)
├── Avatars          avatar / paintAvatar, onAvatarMetadata (XEP-0084), onVcardUpdate (XEP-0153), setOwnAvatar
├── Status           setMyStatus / renderOwnStatus / statusSection; auto-away while locked
├── Screen saver     startScreensaver / stopScreensaver / onSaverInput (retro lock screen)
├── State            conn, myJid, buddies{}, chatWindows{}, activeChat, nudgeTimestamps{}
├── Auth             doLogin (also opens the OMEMO vault) / onConnectStatus / onConnected
├── Disco / caps     computeCapsVer / sendPresence / onDiscoInfo
├── OMEMO glue       startOmemo / checkOmemoSupport / encryptionState / toggleEncryption
├── Roster           onRoster / addBuddy / renderBuddyList (previews, unread badges)
├── Presence         onPresence
├── Messaging        onMessageStanza → handleMessage (ordered inbox, decrypts) / sendText (per-chat queue, encrypts) / appendMsg
├── XEP-0224         sendNudge (rate-limited) / onAttention / priority messages
├── Alerts           startAlertLoop / stopAlertLoop / playAlertBeep / playNudgeSound / shakeWindow
├── Notifications    requestNotifPermission / notify / closeNotifications
├── Dialogs          settings, encryption details, device trust actions
├── Inactivity       noteActivity / checkIdle / lockSession / doUnlock
└── Teardown         endSession — the single exit path; wipes all PHI

omemo.js
├── Vault            password-encrypted IndexedDB record per account (openVault)
└── Session          key generation, PEP device lists + bundles, encrypt / decrypt, trust, forget

vendor/strophe.umd.min.js   Strophe.js 1.6.2 (+ its MIT licence alongside)
vendor/libsignal.min.js     libsignal-protocol-typescript 0.0.16, bundled (+ libsignal-LICENSES.txt)
vendor/libsignal-build/     The recipe that produced it (entry point, pinned lockfile)
```

---

## Development Notes

- **Strophe.js 1.6.2 UMD build** is vendored as `vendor/strophe.umd.min.js` — the ESM `src/strophe.js` fails in non-module `<script>` tags. To update it: `npm pack strophe.js@<version>` (npm verifies the tarball's integrity), copy `package/dist/strophe.umd.min.js` and `package/LICENSE.txt` into `vendor/`.
- **libsignal** is vendored as one IIFE bundle (global `libsignal`). To rebuild or update it: in `vendor/libsignal-build/`, run `npm ci --ignore-scripts` then `npm run build`, which writes `vendor/libsignal.min.js` (with a banner pointing to its source, and the upstream licence comments kept at the end). It must stay free of `eval`/`new Function` (the CSP blocks them); the curve code is a pure-JS wasm2js build, so it is. Regenerate `vendor/libsignal-LICENSES.txt` if the dependency tree changes.
- **No inline JS or CSS, ever.** The CSP is `script-src 'self'; style-src 'self'`, so inline `<script>`/`<style>` blocks and `onclick=""`/`style=""` attributes are blocked. Attach handlers from `app.js`, toggle visibility with the `hidden` attribute, and build DOM with `textContent` — never put JIDs, roster names or message text into `innerHTML`. (Setting `element.style.x` from JS is fine; the CSP doesn't restrict the CSSOM.)
- **Themes:** shared layout goes at the top of `styles.css`; anything visual is scoped under `[data-theme="retro"]` or `[data-theme="wechat"]`. Put `t-retro` / `t-wechat` on markup that should only appear in one theme. **Colours always come from the theme's palette variables** (`--r-*` for retro, unprefixed for WeChat) — add new ones to the light palette *and* both dark blocks at the end of the file, never as hex in a rule, or dark mode breaks.
- **OMEMO state** is only touched through `Omemo.Session`, whose jobs run one at a time and persist the ratchet before a message is sent or shown — never send a stanza built by `encrypt()` before that promise resolves.
- SCRAM-SHA-512 is deleted from `conn.mechanisms` before `connect()` — the Strophe implementation sends a literal base64(`"false"`) as the client-final message, which fails auth on every server.
- Incoming attention stanzas are detected with `getElementsByTagNameNS('urn:xmpp:attention:0', 'attention')` rather than `querySelector` — namespace-aware queries are required for XML stanzas and `querySelector` attribute matching is unreliable across browsers on XML documents.
