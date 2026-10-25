// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jacob Kuznetsov

// woofr.chat client.
//
// This lives in its own file (not inline in index.html) so the CSP can forbid
// inline script entirely. Keep it that way: no inline on*="" handlers, and
// never put untrusted data (JIDs, roster names, message bodies) into innerHTML —
// build nodes and set textContent instead. See HIPAA.md.
//
// Loaded synchronously in <head> (to apply the theme before first paint);
// Strophe, libsignal and omemo.js are deferred, so only touch them from init()
// onwards.
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let conn = null;
let myJid = '';
let buddies = {}; // jid -> { name, show, preview, time, unread }
let chatWindows = {}; // jid -> { tab, win, log, input, encBtn, encrypt, sendQueue, lastStamp, noOmemoNoted }
let activeChat = null;
let nudgeTimestamps = {}; // jid -> [ms, ...]
let sessionActive = false;

// ── End-to-end encryption (OMEMO — see omemo.js) ──────────────────────────
// Every chat is encrypted unless the user explicitly turns it off for that
// chat; nothing falls back to plaintext on its own.
let omemo      = null; // Omemo.Session for the current connection
let omemoVault = null; // Promise<Vault|null>, opened at sign-in while the password is at hand
let omemoReady = null; // settles once OMEMO has started, or failed to
let omemoError = '';   // why encryption isn't available this session, if it isn't
let omemoNotices = []; // account-wide warnings, shown in Settings
let notedSkips = new Set(); // "jid|device|reason" already reported in a chat
let inbox = Promise.resolve(); // incoming messages, handled strictly in order

const NS_ATTENTION  = 'urn:xmpp:attention:0';
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info';
const NS_CAPS       = 'http://jabber.org/protocol/caps';
const CAPS_NODE     = 'https://woofr.chat';
const IDENTITY      = { category: 'client', type: 'web', name: 'woofr.chat' };
let features = [];      // set in init(), once omemo.js has loaded
let capsVer  = null;    // Promise<string|null>

// ── Session security ───────────────────────────────────────────────────────
// Lock hides everything behind a password prompt but keeps the connection up;
// logout disconnects and wipes the page. Both count from the last time the
// signed-in user touched the keyboard/mouse.
const LOCK_AFTER_MS       = 5  * 60_000;
const LOGOUT_AFTER_MS     = 15 * 60_000;
const IDLE_CHECK_MS       = 10_000;
const MAX_UNLOCK_ATTEMPTS = 5;
const PBKDF2_ITERATIONS   = 600_000;

let lastActivity   = 0;
let idleTimer      = null;
let locked         = false;
let unlockVerifier = null; // Promise<{ salt, hash } | null> — never the password itself
let unlockAttempts = 0;

// ── Theme ──────────────────────────────────────────────────────────────────
// The theme name is the only thing this app keeps in localStorage. It isn't
// PHI.
const THEMES    = ['wechat', 'retro'];
const THEME_KEY = 'woofr.theme';

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'wechat';
  } catch {
    return 'wechat';
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('.theme-select').forEach(s => { s.value = theme; });
}

function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode etc. — just don't remember it */ }
}

applyTheme(savedTheme());

// ── Helpers ────────────────────────────────────────────────────────────────
function now() {
  const d = new Date();
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function bareJid(jid) {
  return jid ? jid.split('/')[0].toLowerCase() : '';
}

function setStatus(msg, type) {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className = type || '';
}

// Text goes in via textContent, so untrusted strings can never become markup.
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function displayName(jid) {
  return buddies[jid]?.name || jid;
}

function shortName(jid) {
  return displayName(bareJid(jid)).split('@')[0];
}

const AVATAR_COLORS = ['#5b8def', '#e8735a', '#3fae74', '#b072d0', '#e59a2f', '#3aa9bf', '#d9648f', '#7a8794'];

// A coloured square with the contact's initial (we don't fetch avatars).
function avatar(jid) {
  const initial = (shortName(jid).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const a = el('div', 'avatar', initial);
  let h = 0;
  for (const ch of jid) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  a.style.backgroundColor = AVATAR_COLORS[h % AVATAR_COLORS.length]; // CSSOM, not a style="" attribute — CSP allows it
  a.setAttribute('aria-hidden', 'true');
  return a;
}

// Where the corresponding source lives (GPL-3.0 §6) — linked from About.
const SOURCE_URL = 'https://github.com/djkov/woofr-chat';

const svgNS = 'http://www.w3.org/2000/svg';
const ICON_LOCK   = 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z';
const ICON_UNLOCK = 'M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z';

function icon(path) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svgNS, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

// ── Login ──────────────────────────────────────────────────────────────────
function doLogin() {
  if (conn || !window.isSecureContext) return;

  const jid    = document.getElementById('inp-jid').value.trim();
  const passEl = document.getElementById('inp-pass');
  const pass   = passEl.value;
  const bosh   = document.getElementById('inp-bosh').value.trim();

  if (!jid || !pass || !bosh) { setStatus('Please fill in all fields.', 'error'); return; }

  // Don't leave the password sitting in the form for the next person at this
  // computer — it would still be there after sign-out.
  passEl.value = '';

  setStatus('Connecting…');
  document.getElementById('btn-login').disabled = true;

  unlockVerifier = makeUnlockVerifier(pass).catch(() => null);
  // The OMEMO key store is encrypted under the password, so derive its key
  // now — the password isn't kept once this function returns.
  omemoVault = Omemo.openVault(bareJid(jid), pass).catch(e => { console.warn('OMEMO key store unavailable', e); return null; });

  const c = new Strophe.Connection(bosh);
  conn = c;
  // Strophe's SCRAM-SHA-512 implementation is broken in this build;
  // strip everything except PLAIN so auth succeeds.
  Object.keys(c.mechanisms).forEach(k => {
    if (k !== 'PLAIN') delete c.mechanisms[k];
  });
  c.connect(jid, pass, status => onConnectStatus(c, status));
}

function doCancel() {
  endSession();
}

function doSignOut() {
  if (!confirm('Are you sure you want to sign out?')) return;
  endSession();
}

function onConnectStatus(c, status) {
  // Late callbacks from a connection endSession() already tore down.
  if (c !== conn) return;

  const S = Strophe.Status;
  const names = {
    [S.CONNECTING]:    ['Connecting…',           ''],
    [S.AUTHENTICATING]:['Authenticating…',        ''],
    [S.AUTHFAIL]:      ['Authentication failed.', 'error'],
    [S.CONNFAIL]:      ['Connection failed.',     'error'],
    [S.DISCONNECTING]: ['Disconnecting…',         ''],
    [S.DISCONNECTED]:  ['Disconnected.',          ''],
    [S.CONNECTED]:     ['Connected!',             'ok'],
    [S.ERROR]:         ['An error occurred.',     'error'],
  };
  const [msg, cls] = names[status] || ['Unknown status.', ''];

  if (status === S.CONNECTED) {
    setStatus(msg, cls);
    onConnected();
  } else if ([S.DISCONNECTED, S.AUTHFAIL, S.CONNFAIL, S.ERROR].includes(status)) {
    // Covers failed sign-ins as well as the server or network dropping a live
    // session: either way it's over, so don't leave anything on screen.
    if (sessionActive) endSession('Connection lost. Please sign in again.', 'error');
    else endSession(msg, cls);
  } else {
    setStatus(msg, cls);
  }
}

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// OS notifications show on lock screens and linger in the notification centre
// after sign-out, so they never carry PHI: no sender, no message text.
const openNotifications = new Set();

function notify(body, { persist = false, tag } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let n;
  try {
    n = new Notification('woofr.chat', { body, tag, silent: true, requireInteraction: persist });
  } catch {
    // Android Chrome only allows notifications via a service worker and throws
    // here. Swallow it: a throwing Strophe handler gets removed for good.
    return;
  }
  openNotifications.add(n);
  n.onclose = () => openNotifications.delete(n);
  if (!persist) setTimeout(() => n.close(), 6000);
}

function closeNotifications() {
  openNotifications.forEach(n => n.close());
  openNotifications.clear();
}

function onConnected() {
  const c = conn;
  c.pass = null; // only needed during SASL — don't keep it for the whole session
  sessionActive = true;
  myJid = bareJid(c.jid);
  document.getElementById('my-jid-display').textContent = myJid;
  document.getElementById('nav-avatar').replaceChildren(avatar(myJid));
  requestNotifPermission();

  // Bind handlers to this connection: once it's torn down, any stanza still in
  // flight is dropped (and the handler removed) instead of being rendered into
  // a page we've just wiped.
  const live = fn => stanza => c === conn && fn(stanza);

  c.addHandler(live(onMessageStanza), null, 'message');
  c.addHandler(live(onPresence),      null, 'presence');
  c.addHandler(live(onDiscoInfo),     NS_DISCO_INFO, 'iq', 'get');

  startOmemo(c);
  sendPresence(c);
  c.sendIQ(
    $iq({type: 'get'}).c('query', {xmlns: Strophe.NS.ROSTER}),
    live(onRoster)
  );

  startIdleTimer();
  showBuddyList();
}

// ── Service discovery / entity capabilities (XEP-0030, XEP-0115) ──────────
// Advertising devicelist+notify is what makes servers push contacts' OMEMO
// device-list changes to us.
function computeCapsVer() {
  const s = `${IDENTITY.category}/${IDENTITY.type}//${IDENTITY.name}<` + features.map(f => f + '<').join('');
  return crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
    .then(h => btoa(String.fromCharCode(...new Uint8Array(h))))
    .catch(() => null);
}

function sendPresence(c) {
  capsVer.then(ver => {
    if (c !== conn) return;
    const p = $pres();
    if (ver) p.c('c', { xmlns: NS_CAPS, hash: 'sha-1', node: CAPS_NODE, ver });
    c.send(p.tree());
  });
}

function onDiscoInfo(iq) {
  const query = iq.getElementsByTagNameNS(NS_DISCO_INFO, 'query')[0];
  const node  = query?.getAttribute('node');
  const attrs = { type: 'result', id: iq.getAttribute('id') };
  if (iq.getAttribute('from')) attrs.to = iq.getAttribute('from');
  const res = $iq(attrs).c('query', node ? { xmlns: NS_DISCO_INFO, node } : { xmlns: NS_DISCO_INFO })
    .c('identity', IDENTITY).up();
  features.forEach(f => res.c('feature', { var: f }).up());
  conn.send(res);
  return true;
}

// ── OMEMO ──────────────────────────────────────────────────────────────────
function startOmemo(c) {
  const session = new Omemo.Session(c, myJid, {
    warn: (jid, text) => {
      if (c !== conn) return;
      if (jid) noteInChat(jid, '⚠ ' + text, 'warning');
      else { omemoNotices.push(text); setStatus(text, 'error'); }
    },
    changed: jid => { if (c === conn) onOmemoChanged(jid); },
  });
  omemo = session;
  omemoReady = (async () => {
    const vault = await omemoVault;
    if (!vault) throw new Error('this browser couldn\'t open its key storage');
    await session.start(vault);
  })().catch(e => {
    if (c !== conn) return;
    omemoError = e.message || String(e);
    console.warn('OMEMO unavailable', e);
    setStatus('End-to-end encryption is unavailable: ' + omemoError, 'error');
  }).finally(() => {
    omemoVault = null;
    if (c === conn) Object.keys(chatWindows).forEach(refreshChatEncryption);
  });
}

function onOmemoChanged(jid) {
  if (chatWindows[jid]) refreshChatEncryption(jid);
  if (jid === myJid) Object.keys(chatWindows).forEach(refreshChatEncryption);
  if (modalState && (modalState.jid === jid || modalState.kind === 'settings')) renderModal();
}

// Contacts without OMEMO get a heads-up when their chat opens, rather than a
// failed send later.
function checkOmemoSupport(jid) {
  const c = conn;
  Promise.resolve(omemoReady).then(async () => {
    if (c !== conn || !omemo?.ready) return;
    const ids = await omemo.deviceList(jid);
    const chat = chatWindows[jid];
    if (c !== conn || !chat) return;
    refreshChatEncryption(jid);
    if (!ids.length && chat.encrypt && !chat.noOmemoNoted) {
      chat.noOmemoNoted = true;
      appendMsg(jid, null, '⚠ ' + displayName(jid) + ' hasn\'t set up OMEMO encryption, so messages to them can\'t be ' +
        'end-to-end encrypted yet. Ask them to use an OMEMO client (e.g. Conversations, Monal, Gajim, Dino), ' +
        'or turn encryption off for this chat.', 'warning');
    }
  }).catch(e => console.warn('OMEMO device list fetch failed', e));
}

// 'on' | 'no-omemo' | 'off' | 'unavailable'
function encryptionState(jid) {
  const chat = chatWindows[jid];
  if (chat && !chat.encrypt) return 'off';
  if (omemoError) return 'unavailable';
  const ids = omemo?.devices.get(jid);
  return ids && !ids.length ? 'no-omemo' : 'on';
}

function refreshChatEncryption(jid) {
  const chat = chatWindows[jid];
  if (!chat) return;
  const state = encryptionState(jid);
  const [cls, label, title] = {
    'on':          ['on',       'Encrypted',        'End-to-end encrypted with OMEMO. Click to turn off.'],
    'no-omemo':    ['no-omemo', 'No OMEMO',         displayName(jid) + ' has no OMEMO devices — messages can\'t be sent encrypted. Click to turn encryption off.'],
    'unavailable': ['no-omemo', 'Encryption error', 'Encryption is unavailable this session: ' + omemoError],
    'off':         ['off',      'Not encrypted',    'Encryption is off: the server can read these messages. Click to turn it on.'],
  }[state];
  chat.encBtn.className = 'enc-btn ' + cls;
  chat.encBtn.title = title;
  chat.encBtn.replaceChildren(icon(state === 'off' ? ICON_UNLOCK : ICON_LOCK), el('span', null, label));
  chat.input.placeholder = (state === 'off' ? 'Unencrypted message to ' : 'Encrypted message to ') + jid + '…';
  if (jid === activeChat) updateChatHeader();
}

function toggleEncryption(jid) {
  const chat = chatWindows[jid];
  if (!chat) return;
  if (chat.encrypt) {
    if (!confirm('Turn off end-to-end encryption for this chat?\n\n' +
      'Messages you send will be readable by the server operator, and by anyone with access to the server\'s storage or backups.')) return;
    chat.encrypt = false;
    appendMsg(jid, null, 'Encryption turned off. Messages you send in this chat are not end-to-end encrypted.', 'warning');
  } else {
    chat.encrypt = true;
    appendMsg(jid, null, 'Encryption turned on.', 'system');
    checkOmemoSupport(jid);
  }
  refreshChatEncryption(jid);
}

// Devices that didn't get a copy of a message (unverified, distrusted, key
// changed…), reported once each per session.
function noteSkipped(jid, skipped) {
  for (const s of skipped) {
    const key = s.jid + '|' + s.id + '|' + s.reason;
    if (notedSkips.has(key)) continue;
    notedSkips.add(key);
    const whose = s.jid === myJid ? 'your device' : shortName(s.jid) + '\'s device';
    appendMsg(jid, null, '⚠ Not encrypting for ' + whose + ' ' + s.id + ' (' + s.reason + '). Review it under Encryption details.', 'warning');
  }
}

// ── Roster ─────────────────────────────────────────────────────────────────
function onRoster(iq) {
  iq.querySelectorAll('item').forEach(item => {
    const jid  = item.getAttribute('jid');
    const name = item.getAttribute('name') || jid;
    const bare = bareJid(jid);
    if (!buddies[bare]) buddies[bare] = { name, show: 'offline' };
    else buddies[bare].name = name;
  });
  renderBuddyList();
}

function addBuddy() {
  const jid = document.getElementById('inp-add-buddy').value.trim();
  if (!jid || !conn) return;
  const bare = bareJid(jid);
  buddies[bare] = buddies[bare] || { name: bare, show: 'offline' };
  conn.send($pres({to: jid, type: 'subscribe'}));
  document.getElementById('inp-add-buddy').value = '';
  renderBuddyList();
}

// ── Presence ───────────────────────────────────────────────────────────────
function onPresence(pres) {
  const from = bareJid(pres.getAttribute('from'));
  const type  = pres.getAttribute('type') || 'available';
  const showEl = pres.querySelector('show');
  const show  = showEl ? showEl.textContent : (type === 'available' ? 'online' : 'offline');

  if (from === myJid) return true;

  if (!buddies[from]) buddies[from] = { name: from, show: 'offline' };
  buddies[from].show = (type === 'unavailable') ? 'offline' : show;

  renderBuddyList();
  return true;
}

function dotClass(show) {
  if (show === 'offline') return ' offline';
  if (show === 'away' || show === 'xa') return ' away';
  if (show === 'dnd') return ' busy';
  return '';
}

function presenceLabel(show) {
  return { offline: 'Offline', away: 'Away', xa: 'Away', dnd: 'Busy' }[show] || 'Online';
}

function renderBuddyList() {
  const ul     = document.getElementById('buddy-list');
  const online  = Object.entries(buddies).filter(([,b]) => b.show !== 'offline');
  const offline = Object.entries(buddies).filter(([,b]) => b.show === 'offline');

  document.getElementById('buddy-count').textContent = online.length + ' online';
  ul.replaceChildren();

  const group = (label, list) => {
    if (!list.length) return;
    const gh = el('li', 'group-header');
    gh.append(el('span', 'group-caret', '▼ '), label + ' (' + list.length + ')');
    ul.appendChild(gh);
    list.forEach(([jid, b]) => ul.appendChild(makeBuddyLi(jid, b)));
  };
  group('Online', online);
  group('Offline', offline);

  const unread = Object.values(buddies).reduce((n, b) => n + (b.unread || 0), 0);
  document.title = (unread ? '(' + unread + ') ' : '') + 'woofr.chat';
}

function makeBuddyLi(jid, b) {
  const li = el('li', 'buddy' + (jid === activeChat ? ' active' : ''));
  const wrap = el('div', 'avatar-wrap');
  wrap.append(avatar(jid), el('div', 'status-dot' + dotClass(b.show)));

  const line1 = el('div', 'buddy-line1');
  line1.append(el('span', 'buddy-name', b.name || jid), el('span', 'buddy-time', b.time || ''));
  const line2 = el('div', 'buddy-line2');
  line2.append(el('span', 'buddy-preview', b.preview ?? presenceLabel(b.show)));
  if (b.unread) line2.append(el('span', 'unread-badge', b.unread > 99 ? '99+' : String(b.unread)));
  const info = el('div', 'buddy-info');
  info.append(line1, line2);

  li.append(wrap, info);
  li.title   = jid;
  li.onclick = () => openChat(jid);
  return li;
}

// Last message shown under the contact's name, plus an unread count while
// the chat isn't on screen.
function updatePreview(jid, text, incoming) {
  const b = buddies[jid] || (buddies[jid] = { name: jid, show: 'offline' });
  b.preview = text.split('\n')[0].slice(0, 80);
  b.time = now();
  if (incoming && !chatVisible(jid)) {
    b.unread = (b.unread || 0) + 1;
    chatWindows[jid]?.tab.classList.add('has-unread');
  }
  renderBuddyList();
}

function chatVisible(jid) {
  if (jid !== activeChat || document.hidden || locked) return false;
  return !isMobileLayout() || document.getElementById('app-layout').classList.contains('mobile-chat-open');
}

function markRead(jid) {
  if (buddies[jid]?.unread) {
    buddies[jid].unread = 0;
    renderBuddyList();
  }
  chatWindows[jid]?.tab.classList.remove('has-unread');
}

// ── Messages ───────────────────────────────────────────────────────────────
function hasAttention(msg) {
  return msg.getElementsByTagNameNS(NS_ATTENTION, 'attention').length > 0;
}

// Decryption is asynchronous, so incoming messages go through one queue to
// keep them in order. Nothing is processed before OMEMO has started (offline
// messages arrive right after sign-in).
function onMessageStanza(msg) {
  const c = conn;
  inbox = inbox.then(() => handleMessage(c, msg)).catch(e => console.error('Message handling failed', e));
  return true;
}

async function handleMessage(c, msg) {
  await omemoReady;
  if (c !== conn) return;

  const type = msg.getAttribute('type') || 'normal';
  if (omemo?.handleEvent(msg)) return; // PEP device-list push
  if (type === 'groupchat' || type === 'headline') return;

  const from = bareJid(msg.getAttribute('from'));
  if (!from || from === myJid) return;
  if (type === 'error') {
    if (chatWindows[from]) appendMsg(from, null, '⚠ A message to ' + shortName(from) + ' couldn\'t be delivered.', 'nudge-error');
    return;
  }

  const enc       = msg.getElementsByTagNameNS(Omemo.NS, 'encrypted')[0];
  const attention = hasAttention(msg);
  let text = null;
  const opts = { encrypted: false, untrusted: false };

  if (enc) {
    let r;
    try {
      r = await omemo.decrypt(from, enc);
    } catch (e) {
      if (c !== conn) return;
      noteInChat(from, '⚠ ' + shortName(from) + ' sent an encrypted message that couldn\'t be read: ' + e.message +
        (e.code === 'identity-changed' ? ' Review it under Encryption details.' : ''), 'nudge-error');
      return;
    }
    if (c !== conn || r.duplicate) return;
    if (r.text === null && !attention) return; // key-transport message: nothing to show
    text = r.text;
    opts.encrypted = true;
    opts.untrusted = r.trust === 'undecided';
  } else {
    const bodyEl = msg.querySelector('body');
    text = bodyEl ? bodyEl.textContent : null;
  }

  if (attention) onAttention(from, text, opts);
  else if (text !== null) {
    if (!chatWindows[from]) createChatWindow(from);
    appendMsg(from, from, text, 'them', opts);
  }
}

function noteInChat(jid, text, type) {
  if (!chatWindows[jid]) createChatWindow(jid);
  appendMsg(jid, null, text, type);
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function showBuddyPanelMobile() {
  document.getElementById('app-layout').classList.remove('mobile-chat-open');
}

function openChat(jid) {
  if (!chatWindows[jid]) createChatWindow(jid);
  switchTab(jid);
  if (isMobileLayout()) document.getElementById('app-layout').classList.add('mobile-chat-open');
  markRead(jid);
  setTimeout(() => chatWindows[jid]?.input.focus(), isMobileLayout() ? 300 : 50);
}

function createChatWindow(jid) {
  const tabs = document.getElementById('chat-tabs');
  const wins = document.getElementById('chat-windows');

  const tab = el('button', 'chat-tab', shortName(jid));
  const closeBtn = el('span', 'close-tab', '✕');
  closeBtn.onclick = e => closeChat(jid, e);
  tab.appendChild(closeBtn);
  tab.onclick = () => { switchTab(jid); markRead(jid); };
  tabs.appendChild(tab);

  // Static markup only. Each window keeps direct references to its own
  // elements (rather than looking them up by an id derived from the JID, which
  // let e.g. a.b@x and a_b@x collide and send text to the wrong person).
  const win = el('div', 'chat-window');
  win.innerHTML = `
    <div class="chat-log" role="log"></div>
    <div class="chat-input-area">
      <div class="chat-toolbar">
        <button data-fmt="**" title="Bold"><b>B</b></button>
        <button data-fmt="_" title="Italic"><i>I</i></button>
        <button class="smiley-btn t-retro" title="Smiley">:)</button>
        <button class="nudge-btn" title="Send Nudge (XEP-0224)">&#128293;<span class="lbl"> Nudge!</span></button>
        <button class="priority-send-btn" title="Priority Message">&#9888;<span class="lbl"> Priority</span></button>
        <span class="toolbar-spacer"></span>
        <button class="enc-btn"></button>
        <button class="keys-btn" title="Encryption details">&#128273; Keys</button>
      </div>
      <div class="chat-input-row">
        <textarea class="chat-input" spellcheck="false" autocomplete="off"></textarea>
        <div class="send-col">
          <button class="btn primary send-btn">Send</button>
          <button class="btn clear-btn">Clear</button>
        </div>
      </div>
    </div>`;

  const log    = win.querySelector('.chat-log');
  const input  = win.querySelector('.chat-input');
  const encBtn = win.querySelector('.enc-btn');
  input.onkeydown = e => chatKey(e, jid);
  win.querySelectorAll('[data-fmt]').forEach(b => { b.onclick = () => fmtWrap(input, b.dataset.fmt); });
  win.querySelector('.nudge-btn').onclick         = () => sendNudge(jid);
  win.querySelector('.priority-send-btn').onclick = () => sendPriorityMsg(jid);
  win.querySelector('.send-btn').onclick          = () => sendMsg(jid);
  win.querySelector('.clear-btn').onclick         = () => { input.value = ''; };
  win.querySelector('.keys-btn').onclick          = () => openEncryptionDetails(jid);
  encBtn.onclick                                  = () => toggleEncryption(jid);
  wins.appendChild(win);

  if (!buddies[jid]) buddies[jid] = { name: jid, show: 'offline' }; // so the chat is reachable from the list
  chatWindows[jid] = { tab, win, log, input, encBtn, encrypt: true, sendQueue: Promise.resolve(), lastStamp: 0, noOmemoNoted: false };
  appendMsg(jid, null, 'Conversation with ' + jid + ' started at ' + now(), 'system');
  refreshChatEncryption(jid);
  checkOmemoSupport(jid);

  // Show tabs, hide placeholder on first chat
  tabs.hidden = false;
  document.getElementById('chat-placeholder').hidden = true;

  switchTab(jid);
  renderBuddyList();
}

function switchTab(jid) {
  if (activeChat) {
    chatWindows[activeChat]?.tab.classList.remove('active');
    chatWindows[activeChat]?.win.classList.remove('active');
  }
  activeChat = jid;
  chatWindows[jid].tab.classList.add('active');
  chatWindows[jid].win.classList.add('active');
  updateChatHeader();
  renderBuddyList();
}

function updateChatHeader() {
  const area  = document.getElementById('chat-area');
  const title = document.getElementById('chat-title');
  area.classList.toggle('has-chat', !!activeChat);
  if (!activeChat) { title.replaceChildren(); return; }
  const off = encryptionState(activeChat) !== 'on';
  const lock = el('span', 'title-lock' + (off ? ' off' : ''));
  lock.title = off ? 'Not end-to-end encrypted' : 'End-to-end encrypted';
  lock.appendChild(icon(off ? ICON_UNLOCK : ICON_LOCK));
  title.replaceChildren(displayName(activeChat), lock);
}

function closeChat(jid, e) {
  e.stopPropagation();
  chatWindows[jid].tab.remove();
  chatWindows[jid].win.remove();
  delete chatWindows[jid];
  if (activeChat === jid) {
    activeChat = null;
    const remaining = Object.keys(chatWindows);
    if (remaining.length) {
      switchTab(remaining[remaining.length - 1]);
    } else {
      document.getElementById('chat-tabs').hidden = true;
      document.getElementById('chat-placeholder').hidden = false;
      document.getElementById('app-layout').classList.remove('mobile-chat-open');
      updateChatHeader();
      renderBuddyList();
    }
  }
}

// WeChat-style centred time, at most every five minutes. (Hidden in the
// retro theme, where every line carries its own time.)
function stampTime(chat) {
  const t = Date.now();
  if (t - chat.lastStamp < 5 * 60_000) return;
  chat.lastStamp = t;
  chat.log.appendChild(el('div', 'msg-timesep', now()));
}

// type: 'me' | 'them' | 'system' | 'warning' | 'nudge' | 'nudge-error'.
// opts.encrypted / opts.untrusted mark how a chat message travelled.
function appendMsg(jid, from, text, type, opts = {}) {
  const chat = chatWindows[jid];
  if (!chat) return null;
  const log = chat.log;
  let row;
  if (type !== 'me' && type !== 'them') {
    row = el('div', 'msg-' + type, text);
  } else {
    stampTime(chat);
    const mine = type === 'me';
    row = el('div', 'msg ' + (mine ? 'msg-me' : 'msg-them'));
    const meta = el('span', 'msg-meta');
    meta.append(el('span', 'msg-time', '[' + now() + ']'), ' ');
    if (opts.encrypted) meta.append(el('span', 'msg-lock', '🔒'), ' ');
    meta.append(el('span', 'nick', (mine ? myJid : displayName(from)) + ':'), ' ');
    const main = el('div', 'msg-main');
    main.append(meta, el('div', 'bubble', text));
    if (!opts.encrypted) main.append(el('span', 'msg-flag plain', 'Not encrypted'));
    else if (opts.untrusted) main.append(el('span', 'msg-flag untrusted', 'From an unverified device'));
    row.append(avatar(mine ? myJid : jid), main);
    updatePreview(jid, text, !mine);
  }
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

// Sends go through a per-chat queue so they leave in the order they were
// typed, even though encrypting is asynchronous. The message shows at once
// (dimmed until sent); if it can't be sent it's marked and the text goes back
// into the input box.
function sendMsg(jid)         { sendText(jid, false); }
function sendPriorityMsg(jid) { sendText(jid, true); }

function sendText(jid, priority) {
  const chat = chatWindows[jid];
  const text = chat?.input.value.trim();
  if (!text || !conn) return;
  chat.input.value = '';
  chat.input.focus();

  const c = conn;
  const encrypt = chat.encrypt;
  const row = priority
    ? appendPriorityRow(jid, myJid, text, { encrypted: encrypt })
    : appendMsg(jid, myJid, text, 'me', { encrypted: encrypt });
  row.classList.add('pending');

  chat.sendQueue = chat.sendQueue.then(async () => {
    try {
      let stanza;
      if (encrypt) {
        await omemoReady;
        if (c !== conn) return;
        if (!omemo?.ready) throw new Error('Encryption is unavailable' + (omemoError ? ': ' + omemoError : '') + '.');
        const r = await omemo.encrypt(jid, text);
        stanza = r.stanza;
        noteSkipped(jid, r.skipped);
      } else {
        stanza = $msg({ to: jid, type: 'chat' }).c('body').t(text).up();
      }
      if (c !== conn) return;
      if (priority) stanza.c('attention', { xmlns: NS_ATTENTION }).up();
      c.send(stanza);
      row.classList.remove('pending');
    } catch (e) {
      if (c !== conn) return;
      row.classList.remove('pending');
      row.classList.add('failed');
      (row.querySelector('.msg-main') || row).appendChild(el('div', 'msg-failed', 'Not sent: ' + e.message));
      if (!chat.input.value) chat.input.value = text;
      if (buddies[jid]) { buddies[jid].preview = '[Not sent] ' + buddies[jid].preview; renderBuddyList(); }
      refreshChatEncryption(jid);
    }
  });
}

function chatKey(e, jid) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMsg(jid);
  }
}

// ── Priority Message ──────────────────────────────────────────────────────
let alertInterval = null;

function makePriorityRow(fromName, text, opts) {
  const row    = el('div', 'msg-priority');
  const header = el('div', 'priority-header');
  header.append(el('span', null, '⚠ Priority Message (!):'), el('span', 'msg-time', '[' + now() + '] ' + fromName));
  row.append(header, el('div', 'priority-body', text));
  if (!opts.encrypted) row.append(el('span', 'msg-flag plain', 'Not encrypted'));
  else if (opts.untrusted) row.append(el('span', 'msg-flag untrusted', 'From an unverified device'));
  return row;
}

function appendPriorityRow(jid, fromName, text, opts = {}) {
  const chat = chatWindows[jid];
  const row = makePriorityRow(fromName, text, opts);
  chat.log.appendChild(row);
  chat.log.scrollTop = chat.log.scrollHeight;
  updatePreview(jid, '[Priority] ' + text, fromName !== myJid);
  return row;
}

function appendPriorityMsg(jid, fromName, text, opts) {
  if (!chatWindows[jid]) return;
  const row = appendPriorityRow(jid, fromName, text, opts);
  const ack = el('div', 'priority-ack');
  const btn = el('button', 'priority-ack-btn', '✓ Mark as Read');
  btn.onclick = () => ackPriority(row, btn);
  ack.appendChild(btn);
  row.appendChild(ack);
  chatWindows[jid].log.scrollTop = chatWindows[jid].log.scrollHeight;
}

function ackPriority(row, btn) {
  btn.textContent = '✓ Read';
  btn.disabled    = true;
  row.classList.add('read');
  if (!document.querySelector('.priority-ack-btn:not(:disabled)')) stopAlertLoop();
}

function startAlertLoop() {
  if (alertInterval) return;
  playAlertBeep();
  alertInterval = setInterval(playAlertBeep, 1800);
}

function stopAlertLoop() {
  if (alertInterval) { clearInterval(alertInterval); alertInterval = null; }
}

function playAlertBeep() {
  const ctx     = new (window.AudioContext || window.webkitAudioContext)();
  const pattern = [900, 1400, 900, 1400, 900, 1400];
  pattern.forEach((freq, i) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.1);
    gain.gain.setValueAtTime(0.7, ctx.currentTime + i * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.1 + 0.09);
    osc.start(ctx.currentTime + i * 0.1);
    osc.stop(ctx.currentTime  + i * 0.1 + 0.09);
  });
}

// ── XEP-0224 Attention ────────────────────────────────────────────────────
// A nudge has no content, so it's never encrypted. A priority message's text
// is (see sendText).
const NUDGE_LIMIT     = 2;
const NUDGE_WINDOW_MS = 60_000;

function sendNudge(jid) {
  if (!conn) return;
  const now_ms = Date.now();
  const ts = (nudgeTimestamps[jid] || []).filter(t => now_ms - t < NUDGE_WINDOW_MS);
  if (ts.length >= NUDGE_LIMIT) {
    const wait = Math.ceil((NUDGE_WINDOW_MS - (now_ms - ts[0])) / 1000);
    appendMsg(jid, null, '⚠ Nudge limit reached! Please wait ' + wait + 's before sending another nudge.', 'nudge-error');
    return;
  }
  ts.push(now_ms);
  nudgeTimestamps[jid] = ts;
  conn.send($msg({to: jid, type: 'chat'}).c('attention', {xmlns: NS_ATTENTION}));
  appendMsg(jid, null, '*** You sent a nudge to ' + shortName(jid) + ' ***', 'nudge');
  shakeWindow();
}

function onAttention(from, text, opts) {
  if (!chatWindows[from]) createChatWindow(from);
  const name = displayName(from);
  if (text !== null) {
    appendPriorityMsg(from, name, text, opts);
    startAlertLoop();
    notify('You have a new priority message.', { persist: true, tag: 'priority' });
  } else {
    appendMsg(from, null, '*** ' + name + ' sent you a nudge! ***', 'nudge');
    updatePreview(from, '[Nudge]', true);
    playNudgeSound();
    notify('Someone sent you a nudge.', { tag: 'nudge' });
  }
  shakeWindow();
}

function playNudgeSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  [[880, 0.00], [660, 0.12], [440, 0.24]].forEach(([freq, when]) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
    gain.gain.setValueAtTime(0.4, ctx.currentTime + when);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 0.3);
    osc.start(ctx.currentTime + when);
    osc.stop(ctx.currentTime + when + 0.3);
  });
}

function shakeWindow() {
  const win = document.getElementById('main-window');
  win.classList.remove('nudging');
  void win.offsetWidth;
  win.classList.add('nudging');
  win.addEventListener('animationend', () => win.classList.remove('nudging'), {once: true});
}

function fmtWrap(ta, ch) {
  const s   = ta.selectionStart, end = ta.selectionEnd;
  const sel = ta.value.slice(s, end);
  ta.setRangeText(ch + sel + ch, s, end, 'end');
  ta.focus();
}

// ── Dialogs: settings and encryption details ──────────────────────────────
// modalState says what's showing, so it can be re-rendered when OMEMO state
// changes underneath it.
let modalState = null; // { kind: 'settings' } | { kind: 'about' } | { kind: 'contact', jid }
let modalToken = 0;

function showModal(state) {
  modalState = state;
  document.getElementById('modal').hidden = false;
  renderModal();
  document.getElementById('modal-close').focus();
}

function closeModal() {
  modalState = null;
  modalToken++;
  document.getElementById('modal').hidden = true;
  document.getElementById('modal-title').textContent = '';
  document.getElementById('modal-body').replaceChildren();
}

function section(title) {
  const s = el('div', 'modal-section');
  s.appendChild(el('h3', null, title));
  return s;
}

function renderModal() {
  if (!modalState) return;
  const token = ++modalToken;
  const body = document.getElementById('modal-body');
  body.replaceChildren();
  if (modalState.kind === 'settings') renderSettings(body, token);
  else if (modalState.kind === 'about') renderAbout(body);
  else renderContactSecurity(body, modalState.jid, token);
}

function link(text, href) {
  const a = el('a', null, text);
  a.href = href;
  if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}

// GPL-3.0 §5(d): an interactive program shows its legal notices.
function aboutSection() {
  const s = section('About woofr.chat');
  s.append(
    el('p', 'muted', 'Copyright © 2026 Jacob Kuznetsov.'),
    el('p', 'muted', 'woofr.chat is free software: you can redistribute it and/or modify it under the terms of the ' +
      'GNU General Public License, version 3 or (at your option) any later version. It comes with ABSOLUTELY NO ' +
      'WARRANTY, to the extent permitted by law.'));
  const links = el('ul', 'about-links');
  [['Source code', SOURCE_URL],
   ['GNU General Public License v3', 'LICENSE.txt'],
   ['Third-party licences: libsignal and its dependencies', 'vendor/libsignal-LICENSES.txt'],
   ['Third-party licences: Strophe.js (MIT)', 'vendor/strophe.js-LICENSE.txt']]
    .forEach(([text, href]) => { const li = el('li'); li.appendChild(link(text, href)); links.appendChild(li); });
  s.appendChild(links);
  return s;
}

function renderAbout(body) {
  document.getElementById('modal-title').textContent = 'About & licences';
  body.appendChild(aboutSection());
}

function ownFingerprintSection() {
  const s = section('This device');
  if (!omemo?.ready) {
    s.appendChild(el('p', 'enc-warn', omemoError ? 'Encryption is unavailable: ' + omemoError : 'Encryption is starting…'));
    return s;
  }
  s.append(el('p', 'muted', 'OMEMO device ' + omemo.deviceId + '. Your fingerprint:'),
           el('div', 'fingerprint', omemo.ownFingerprint()));
  return s;
}

function renderSettings(body, token) {
  document.getElementById('modal-title').textContent = 'Settings';

  const theme = section('Theme');
  const sel = el('select', 'theme-select');
  sel.append(new Option('WeChat', 'wechat'), new Option('Retro (Windows 2000)', 'retro'));
  sel.value = document.documentElement.dataset.theme;
  sel.onchange = () => setTheme(sel.value);
  theme.appendChild(sel);
  body.appendChild(theme);

  const enc = ownFingerprintSection();
  omemoNotices.forEach(n => enc.appendChild(el('p', 'enc-warn', n)));
  body.appendChild(enc);

  if (omemo?.ready) {
    const others = section('Your other devices');
    body.appendChild(others);
    renderDevices(others, myJid, token);

    const forget = section('Shared computer?');
    forget.appendChild(el('p', 'muted',
      'Your encryption keys stay in this browser (encrypted with your password) so your fingerprint stays the same. ' +
      'Remove them if other people use this computer.'));
    const btn = el('button', 'btn danger', 'Remove this device\'s keys');
    btn.onclick = forgetThisDevice;
    const row = el('div', 'device-actions');
    row.appendChild(btn);
    forget.appendChild(row);
    body.appendChild(forget);
  }

  body.appendChild(aboutSection());
}

function renderContactSecurity(body, jid, token) {
  document.getElementById('modal-title').textContent = 'Encryption — ' + displayName(jid);
  const chat = chatWindows[jid];
  const state = encryptionState(jid);
  const summary = {
    'on':          'Messages in this chat are end-to-end encrypted with OMEMO. Only the devices listed below can read them.',
    'no-omemo':    displayName(jid) + ' has no OMEMO devices, so messages can\'t be end-to-end encrypted.',
    'unavailable': 'Encryption is unavailable this session' + (omemoError ? ': ' + omemoError : '.'),
    'off':         'Encryption is turned off for this chat. The server can read messages you send.',
  }[state];
  const top = section('Status');
  top.appendChild(el('p', state === 'on' ? 'muted' : 'enc-warn', summary));
  if (chat) {
    const row = el('div', 'device-actions');
    const t = el('button', 'btn' + (chat.encrypt ? ' danger' : ' primary'), chat.encrypt ? 'Turn encryption off' : 'Turn encryption on');
    t.onclick = () => { toggleEncryption(jid); renderModal(); };
    row.appendChild(t);
    top.appendChild(row);
  }
  body.appendChild(top);

  if (!omemo?.ready) return;

  const theirs = section(displayName(jid) + '\'s devices');
  theirs.appendChild(el('p', 'muted',
    'To verify a device, compare its fingerprint with the one ' + shortName(jid) +
    ' sees in their app (in person or over a call), then mark it verified. ' +
    'Once one device is verified, new devices aren\'t trusted until you decide.'));
  body.appendChild(theirs);
  renderDevices(theirs, jid, token);

  body.appendChild(ownFingerprintSection());
}

const TRUST_LABELS = {
  verified: 'Verified', blind: 'Trusted (not verified)', undecided: 'New — not trusted yet',
  distrusted: 'Distrusted', unknown: 'Keys unavailable',
};

function renderDevices(container, jid, token) {
  const list = el('div', 'device-list');
  list.appendChild(el('p', 'muted', 'Loading…'));
  container.appendChild(list);
  const s = omemo;
  s.describe(jid).then(devices => {
    if (token !== modalToken || s !== omemo) return;
    list.replaceChildren();
    if (!devices.length) {
      list.appendChild(el('p', 'muted', jid === myJid ? 'No other devices use OMEMO on this account.' : 'No OMEMO devices.'));
      return;
    }
    devices.forEach(d => list.appendChild(deviceRow(jid, d)));
  }).catch(e => {
    if (token !== modalToken) return;
    list.replaceChildren(el('p', 'enc-warn', 'Couldn\'t load devices: ' + e.message));
  });
}

function deviceRow(jid, d) {
  const box  = el('div', 'device');
  const head = el('div', 'device-head');
  head.append(el('span', 'device-name', 'Device ' + d.id), el('span', 'trust-badge trust-' + d.trust, TRUST_LABELS[d.trust]));
  if (!d.active) head.appendChild(el('span', 'device-inactive', '(no longer in use)'));
  box.appendChild(head);
  if (d.fingerprint) box.appendChild(el('div', 'fingerprint', d.fingerprint));

  const actions = el('div', 'device-actions');
  const button = (label, cls, fn) => {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.onclick = () => fn().catch(e => alert('That didn\'t work: ' + e.message));
    actions.appendChild(b);
  };
  const trust = t => () => omemo.setTrust(jid, d.id, t);

  if (d.pending) {
    box.appendChild(el('div', 'device-warn',
      '⚠ This device\'s key changed. Messages to and from it are blocked. Only accept the new key if ' +
      shortName(jid) + ' confirms they reinstalled or reset their app — otherwise someone may be impersonating them. New fingerprint:'));
    box.appendChild(el('div', 'fingerprint', d.pending));
    button('Accept new key', 'danger', async () => {
      if (!confirm('Accept the new key for device ' + d.id + '?')) return;
      await omemo.acceptNewKey(jid, d.id);
    });
  } else if (d.fingerprint) {
    if (d.trust !== 'verified') {
      button('Verify', 'primary', async () => {
        if (!confirm('Mark device ' + d.id + ' as verified?\n\nOnly do this if this fingerprint matches exactly what ' +
          shortName(jid) + ' sees on that device:\n\n' + d.fingerprint)) return;
        await trust('verified')();
      });
    } else {
      button('Remove verification', '', trust('blind'));
    }
    if (d.trust === 'undecided') button('Trust without verifying', '', trust('blind'));
    if (d.trust !== 'distrusted') button('Distrust', 'danger', trust('distrusted'));
    else button('Trust again', '', trust('blind'));
  }
  if (actions.childNodes.length) box.appendChild(actions);
  return box;
}

function openSettings() { showModal({ kind: 'settings' }); }

function openEncryptionDetails(jid) {
  if (jid) showModal({ kind: 'contact', jid });
}

async function forgetThisDevice() {
  if (!omemo?.ready) return;
  if (!confirm('Remove this device\'s encryption keys?\n\n' +
    'Encrypted messages sent to this device can no longer be read here, and you\'ll get a new fingerprint ' +
    'the next time you sign in on this computer.')) return;
  const c = conn;
  try {
    await omemo.forget();
  } catch (e) {
    alert('Couldn\'t remove the keys: ' + e.message);
    return;
  }
  if (c !== conn) return;
  omemoError = 'this device\'s keys were removed — sign in again to create new ones';
  Object.keys(chatWindows).forEach(refreshChatEncryption);
  renderModal();
}

// ── Inactivity lock / logout ──────────────────────────────────────────────
function noteActivity() {
  // While locked only a successful unlock counts — otherwise anyone could keep
  // an unattended session alive just by nudging the mouse.
  if (!locked) lastActivity = Date.now();
}

function startIdleTimer() {
  lastActivity = Date.now();
  clearInterval(idleTimer);
  idleTimer = setInterval(checkIdle, IDLE_CHECK_MS);
}

// Compares wall-clock time instead of trusting a timer to fire on schedule:
// background tabs and sleeping laptops throttle or suspend setInterval, so
// this also runs the moment the page becomes visible again.
function checkIdle() {
  if (!sessionActive) return;
  const idle = Date.now() - lastActivity;
  if (idle >= LOGOUT_AFTER_MS) {
    endSession('Signed out after ' + (LOGOUT_AFTER_MS / 60_000) + ' minutes of inactivity.', 'error');
  } else if (idle >= LOCK_AFTER_MS && !locked) {
    lockSession();
  }
}

function lockSession() {
  locked = true;
  unlockAttempts = 0;
  closeModal(); // it sits outside the app layout, so hiding the layout wouldn't cover it
  document.getElementById('app-layout').hidden = true;
  document.getElementById('lock-panel').hidden = false;
  document.getElementById('lock-jid').textContent = myJid;
  document.getElementById('lock-msg').textContent =
    'Locked after ' + (LOCK_AFTER_MS / 60_000) + ' minutes of inactivity. Enter your password to continue — ' +
    'you will be signed out automatically ' + ((LOGOUT_AFTER_MS - LOCK_AFTER_MS) / 60_000) + ' minutes after locking.';
  document.getElementById('lock-error').textContent = '';
  document.getElementById('inp-unlock-pass').value = '';
  document.getElementById('inp-unlock-pass').focus();
  setStatus('Session locked.');
}

async function doUnlock() {
  const passEl = document.getElementById('inp-unlock-pass');
  const pass   = passEl.value;
  passEl.value = '';
  if (!pass || !locked) return;

  const ok = await checkUnlockPassword(pass);
  if (!locked) return; // signed out (e.g. timed out) while hashing

  if (ok) {
    locked = false;
    noteActivity();
    document.getElementById('lock-panel').hidden = true;
    document.getElementById('app-layout').hidden = false;
    setStatus('Connected!', 'ok');
    if (activeChat) markRead(activeChat);
  } else if (++unlockAttempts >= MAX_UNLOCK_ATTEMPTS) {
    endSession('Signed out after too many failed unlock attempts.', 'error');
  } else {
    const left = MAX_UNLOCK_ATTEMPTS - unlockAttempts;
    document.getElementById('lock-error').textContent =
      'Incorrect password. ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left before sign-out.';
    passEl.focus();
  }
}

// Unlock checks against a salted PBKDF2 hash taken at sign-in, so the
// plaintext password isn't held in memory for the life of the session.
async function pbkdf2(pass, salt) {
  const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

async function makeUnlockVerifier(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt, hash: await pbkdf2(pass, salt) };
}

async function checkUnlockPassword(pass) {
  const v = await unlockVerifier;
  if (!v) return false;
  const h = await pbkdf2(pass, v.salt);
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h[i] ^ v.hash[i];
  return diff === 0;
}

// ── Session teardown ──────────────────────────────────────────────────────
// The single exit path for every way a session ends — sign-out, inactivity,
// failed unlocks, dropped connection, cancelled or failed sign-in. Disconnects
// and wipes everything that could hold PHI from the page and from memory.
// (The OMEMO key store stays in IndexedDB, encrypted; it never holds message
// text.)
function endSession(reason = 'Not connected.', type = '') {
  const c = conn;
  conn = null; // from here on, callbacks and stanzas from `c` are ignored

  sessionActive = false;
  locked = false;
  unlockVerifier = null;
  unlockAttempts = 0;
  clearInterval(idleTimer);
  idleTimer = null;
  stopAlertLoop();
  closeNotifications();
  closeModal();

  if (omemo) omemo.stop();
  omemo = null; omemoVault = null; omemoReady = null; omemoError = ''; omemoNotices = [];
  notedSkips = new Set();
  inbox = Promise.resolve();

  myJid = ''; buddies = {}; chatWindows = {}; activeChat = null; nudgeTimestamps = {};
  document.getElementById('chat-tabs').replaceChildren();
  document.getElementById('chat-windows').replaceChildren();
  document.getElementById('buddy-list').replaceChildren();
  document.getElementById('nav-avatar').replaceChildren();
  document.getElementById('chat-title').replaceChildren();
  document.getElementById('chat-area').classList.remove('has-chat');
  document.getElementById('buddy-count').textContent    = '0 online';
  document.getElementById('my-jid-display').textContent = '';
  document.getElementById('lock-jid').textContent       = '';
  document.getElementById('lock-error').textContent     = '';
  ['inp-pass', 'inp-unlock-pass', 'inp-add-buddy'].forEach(id => { document.getElementById(id).value = ''; });
  document.title = 'woofr.chat';

  showLogin();
  setStatus(reason, type);

  // Deferred so that ending the session from inside one of Strophe's own status
  // callbacks (e.g. CONNFAIL) doesn't re-enter its teardown mid-flight.
  if (c) setTimeout(() => c.disconnect(), 0);
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showBuddyList() {
  document.getElementById('login-panel').hidden = true;
  document.getElementById('app-layout').hidden  = false;
}

function showLogin() {
  document.getElementById('login-panel').hidden = false;
  document.getElementById('app-layout').hidden  = true;
  document.getElementById('lock-panel').hidden  = true;
  document.getElementById('app-layout').classList.remove('mobile-chat-open');
  document.getElementById('chat-tabs').hidden = true;
  document.getElementById('chat-placeholder').hidden = false;
  document.getElementById('btn-login').disabled = !window.isSecureContext;
}

// ── Startup ────────────────────────────────────────────────────────────────
function init() {
  // PHI must never cross plain HTTP. HSTS covers repeat visits; this catches a
  // first visit or a misconfigured proxy. (localhost counts as secure for dev.)
  if (!window.isSecureContext) {
    document.getElementById('insecure-warning').hidden = false;
    document.getElementById('btn-login').disabled = true;
  }

  features = [NS_CAPS, NS_DISCO_INFO, NS_ATTENTION, Omemo.NOTIFY_FEATURE].sort();
  capsVer  = computeCapsVer();

  applyTheme(savedTheme());
  document.querySelectorAll('.theme-select').forEach(s => { s.onchange = () => setTheme(s.value); });

  document.getElementById('btn-login').onclick         = doLogin;
  document.getElementById('btn-cancel').onclick        = doCancel;
  document.getElementById('btn-about-login').onclick   = () => showModal({ kind: 'about' });
  document.getElementById('inp-pass').onkeydown        = e => { if (e.key === 'Enter') doLogin(); };
  document.getElementById('btn-add-buddy').onclick     = addBuddy;
  document.getElementById('inp-add-buddy').onkeydown   = e => { if (e.key === 'Enter') addBuddy(); };
  document.getElementById('btn-sign-out').onclick      = doSignOut;
  document.getElementById('nav-sign-out').onclick      = doSignOut;
  document.getElementById('btn-settings').onclick      = openSettings;
  document.getElementById('nav-settings').onclick      = openSettings;
  document.getElementById('nav-chats').onclick         = showBuddyPanelMobile;
  document.getElementById('btn-chat-security').onclick = () => openEncryptionDetails(activeChat);
  document.getElementById('mobile-back-btn').onclick   = showBuddyPanelMobile;
  document.getElementById('btn-unlock').onclick        = doUnlock;
  document.getElementById('btn-lock-sign-out').onclick = () => endSession();
  document.getElementById('inp-unlock-pass').onkeydown = e => { if (e.key === 'Enter') doUnlock(); };
  document.getElementById('modal-close').onclick       = closeModal;
  document.getElementById('modal').onclick             = e => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalState) closeModal(); });

  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(ev =>
    document.addEventListener(ev, noteActivity, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkIdle();
    if (activeChat && chatVisible(activeChat)) markRead(activeChat);
  });
}

document.addEventListener('DOMContentLoaded', init);
