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
let buddies = {}; // jid -> { local, theirs, groups, show, status, preview, time, unread, inRoster, sub, ask }
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
// The theme name and light/dark choice are the only things this app keeps in
// localStorage. They aren't PHI.
const THEMES    = ['wechat', 'retro'];
const THEME_KEY = 'woofr.theme';
const MODES     = ['auto', 'light', 'dark']; // auto follows the system setting
const MODE_KEY  = 'woofr.mode';

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
  if (theme !== 'retro') stopScreensaver();
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode etc. — just don't remember it */ }
}

function savedMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.includes(m) ? m : 'auto';
  } catch {
    return 'auto';
  }
}

function applyMode(mode) {
  document.documentElement.dataset.mode = mode;
  document.querySelectorAll('.mode-select').forEach(s => { s.value = mode; });
}

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  applyMode(mode);
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* just don't remember it */ }
}

applyTheme(savedTheme());
applyMode(savedMode());

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

// What to call someone: the name you gave them (roster, only your own
// devices see it), else the name they publish, else just the part before the
// @ — never the full address, which only shows in the contact's details.
function displayName(jid) {
  const b = buddies[jid];
  return b?.local || b?.theirs || jid.split('@')[0];
}

function ownName() {
  return myName || myJid.split('@')[0];
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function shortName(jid) {
  return displayName(bareJid(jid));
}

const AVATAR_COLORS = ['#5b8def', '#e8735a', '#3fae74', '#b072d0', '#e59a2f', '#3aa9bf', '#d9648f', '#7a8794'];

// The contact's profile picture, or a coloured square with their initial.
// Tagged with the JID so it can be repainted when a picture arrives.
function avatar(jid) {
  const a = el('div', 'avatar');
  a.dataset.jid = jid;
  a.setAttribute('aria-hidden', 'true');
  paintAvatar(a);
  return a;
}

function paintAvatar(a) {
  const jid = a.dataset.jid;
  const pic = avatars[jid]?.url;
  if (pic) {
    const img = el('img');
    img.alt = '';
    img.src = pic; // always a data: URL we drew ourselves (see renderAvatarImage)
    a.replaceChildren(img);
    a.classList.add('has-pic');
    a.style.backgroundColor = '';
  } else {
    a.replaceChildren((shortName(jid).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase());
    a.classList.remove('has-pic');
    let h = 0;
    for (const ch of jid) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    a.style.backgroundColor = AVATAR_COLORS[h % AVATAR_COLORS.length]; // CSSOM, not a style="" attribute — CSP allows it
  }
}

function renderOwnStatus() {
  if (!myJid) return;
  document.getElementById('my-jid-display').textContent = ownName();
  const show = myShow || (idleAway ? 'away' : '');
  const wrap = el('div', 'avatar-wrap');
  wrap.append(avatar(myJid), el('div', 'status-dot' + dotClass(show)));
  const nav = document.getElementById('nav-avatar');
  nav.replaceChildren(wrap);
  nav.title = 'Your status: ' + presenceLabel(show) + (myStatusText ? ' — ' + myStatusText : '');
  document.getElementById('my-dot').className = 'status-dot' + dotClass(show);
  const label = document.getElementById('btn-my-status');
  label.textContent = '[' + presenceLabel(show).toLowerCase() + ']';
  label.title = myStatusText || 'Set your status';
}

function setMyStatus(show, text) {
  myShow = ['away', 'dnd'].includes(show) ? show : '';
  myStatusText = text.trim().slice(0, STATUS_MAX);
  if (conn) sendPresence(conn);
  renderOwnStatus();
}

function statusSection() {
  const s = section('Your status');
  const row = el('div', 'device-actions');
  const show = el('select', 'status-select');
  show.append(new Option('Available', ''), new Option('Away', 'away'), new Option('Busy', 'dnd'));
  show.value = myShow;
  show.setAttribute('aria-label', 'Availability');
  const text = el('input', 'status-input');
  text.type = 'text';
  text.maxLength = STATUS_MAX;
  text.placeholder = 'Status message (optional)';
  text.value = myStatusText;
  text.spellcheck = false;
  text.setAttribute('aria-label', 'Status message');
  const save = el('button', 'btn primary', 'Update');
  const saved = el('span', 'muted');
  const apply = () => { setMyStatus(show.value, text.value); saved.textContent = 'Updated.'; };
  save.onclick = apply;
  text.onkeydown = e => { if (e.key === 'Enter') apply(); };
  show.onchange = apply;
  row.append(show, text, save, saved);
  s.append(row, el('p', 'muted',
    'Your contacts see this. Status messages aren\'t end-to-end encrypted, so don\'t put patient or other sensitive details in them.'));
  return s;
}

function refreshAvatars(jid) {
  document.querySelectorAll('.avatar').forEach(a => { if (a.dataset.jid === jid) paintAvatar(a); });
}

// ── Profile pictures (XEP-0084 User Avatar, XEP-0153 vCard avatars) ───────
// Only ever fetched from the XMPP server: avatars that point at an outside
// URL are ignored. Each one is checked against its SHA-1, decoded, and
// redrawn small on a canvas (which also drops metadata such as EXIF
// location), then kept in memory as a data: URL. Wiped in endSession().
const NS_PUBSUB       = 'http://jabber.org/protocol/pubsub';
const NS_PUBSUB_EVENT = NS_PUBSUB + '#event';
const NS_AVATAR_DATA  = 'urn:xmpp:avatar:data';
const NS_AVATAR_META  = 'urn:xmpp:avatar:metadata';
const NS_VCARD        = 'vcard-temp';
const NS_VCARD_UPDATE = 'vcard-temp:x:update';
const AVATAR_TYPES    = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_PX         = 128; // kept in memory; shown at up to 46px, so sharp on 2x screens
const AVATAR_PUBLISH_PX = 192;

const NAME_MAX      = 60;
const NS_NICK       = 'http://jabber.org/protocol/nick';
let myName          = '';        // the name we publish for ourselves
let namesAsked      = new Set(); // JIDs whose published name we've asked for this session
let avatars      = {};   // jid -> { src: 'pep' | 'vcard', hash, url }
let avatarImages = {};   // sha1 -> Promise<data: URL | null>
let avatarAsked  = new Set(); // JIDs whose PEP avatar we've asked for this session
let ownVcardHash = null; // our vCard photo hash, for XEP-0153 presence ('' = none, null = unknown)

// ── History (history.js) ──────────────────────────────────────────────────
// Kept on this device, encrypted with the password-derived key, and deleted
// after the retention period. Each message shows how long it has left.
const HISTORY_KEY  = 'woofr.history'; // retention in days, '0' = don't keep — not PHI
const HISTORY_DAYS = [7, 30, 90];
let sessionVault = null;     // the unlocked Vault, for history (and nothing else) this session
let historyStore = null;     // History.Store while history is on
let history      = new Map(); // jid -> messages, oldest first
let expiryTimer  = null;

function historyDays() {
  try {
    const v = localStorage.getItem(HISTORY_KEY);
    if (v === '0') return 0;
    return HISTORY_DAYS.includes(+v) ? +v : 30;
  } catch {
    return 30;
  }
}

function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

// "11:33 PM" today, "Oct 24, 11:33 PM" before.
function fmtTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay(ts, Date.now()) ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

// For the chat list: the time today, the date before that.
function fmtListTime(ts) {
  return sameDay(ts, Date.now())
    ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function daysLeft(ts) {
  return Math.max(0, Math.ceil((historyStore.expiresAt(ts) - Date.now()) / History.DAY));
}

function expiryLabel(ts, short) {
  const n = daysLeft(ts);
  if (short) return n + 'd left';
  return n === 0 ? 'deleted today' : n + (n === 1 ? ' day left' : ' days left');
}

function expiryTitle(ts) {
  return 'Deleted from this device on ' + new Date(historyStore.expiresAt(ts)).toLocaleDateString([], { dateStyle: 'medium' });
}

// Saves a message we've just sent or received.
function recordMessage(jid, entry) {
  if (!historyStore) return;
  const list = history.get(jid) || [];
  list.push(entry);
  history.set(jid, list);
  historyStore.save(jid, list);
}

async function loadHistory(c, vault) {
  sessionVault = vault;
  const days = historyDays();
  if (!days) return;
  const store = new History.Store(vault, days);
  let loaded;
  try {
    loaded = await store.load();
  } catch (e) {
    console.warn('Couldn\'t load history', e);
    return;
  }
  if (c !== conn) return;
  historyStore = store;
  history = loaded;
  for (const [jid, msgs] of loaded) {
    const last = msgs[msgs.length - 1];
    const b = buddies[jid] || (buddies[jid] = { show: 'offline' });
    b.preview = last.kind === 'media' ? mediaPreview(last.text)
      : (last.kind === 'priority' ? '[Priority] ' : '') + Rich.plain(last.text).slice(0, 80);
    b.time = fmtListTime(last.ts);
  }
  renderBuddyList();
  clearInterval(expiryTimer);
  expiryTimer = setInterval(sweepExpired, 60 * 60_000);
}

// Drops what has expired — from memory, disk and the screen — and refreshes
// the days-left labels. Hourly, and when the retention setting changes.
function sweepExpired() {
  if (!historyStore) return;
  for (const [jid, msgs] of history) {
    const live = msgs.filter(m => !historyStore.expired(m));
    if (live.length !== msgs.length) {
      if (live.length) history.set(jid, live); else history.delete(jid);
      historyStore.save(jid, live);
    }
  }
  refreshExpiryLabels();
}

function refreshExpiryLabels() {
  document.querySelectorAll('.chat-log [data-ts]').forEach(node => {
    const ts = +node.dataset.ts;
    if (historyStore && historyStore.expired({ ts })) { node.remove(); return; }
    paintExpiry(node, ts);
  });
}

function paintExpiry(node, ts) {
  if (node.classList.contains('msg-timesep')) {
    node.textContent = fmtTime(ts) + (historyStore ? '  ·  ' + expiryLabel(ts) : '');
    node.title = historyStore ? expiryTitle(ts) : '';
    return;
  }
  const tag = node.querySelector('.msg-expiry');
  if (tag) tag.textContent = historyStore ? expiryLabel(ts, true) : '';
  const target = node.querySelector('.bubble') || node.querySelector('.priority-body');
  if (target) target.title = historyStore ? expiryTitle(ts) : '';
}

async function setHistoryDays(days) {
  try { localStorage.setItem(HISTORY_KEY, String(days)); } catch { /* just don't remember it */ }
  if (!days) {
    if (historyStore) await historyStore.clear();
    historyStore = null;
    history = new Map();
    clearInterval(expiryTimer);
  } else if (historyStore) {
    historyStore.days = days;
    sweepExpired();
  } else if (sessionVault && conn) {
    // Turned on mid-session: start keeping what's on screen from now on.
    historyStore = new History.Store(sessionVault, days);
    clearInterval(expiryTimer);
    expiryTimer = setInterval(sweepExpired, 60 * 60_000);
  }
  refreshExpiryLabels();
}

function historySection() {
  const s = section('Message history');
  const row = el('div', 'device-actions');
  const pick = el('select', 'history-select');
  pick.setAttribute('aria-label', 'Keep messages for');
  pick.append(...HISTORY_DAYS.map(d => new Option('Keep for ' + d + ' days', String(d))), new Option('Don\'t keep', '0'));
  pick.value = String(historyDays());
  pick.onchange = async () => {
    const days = +pick.value;
    if (!days && !confirm('Stop keeping messages on this device?\n\nThe history saved here is deleted now. ' +
      'Chats will start empty each time you sign in.')) { pick.value = String(historyDays()); return; }
    await setHistoryDays(days);
    renderModal();
  };
  row.appendChild(pick);
  const days = historyDays();
  s.append(row, el('p', 'muted', days
    ? 'Messages are saved on this device, encrypted with your password, and deleted ' + days + ' days after they were sent. Each message shows how many days it has left. Your contacts\' devices keep their own copies.'
    : 'Nothing is saved: chats start empty each time you sign in.'));
  return s;
}

// ── Your status (presence <show/> and <status/>) ──────────────────────────
// Shared with everyone subscribed to your presence. Presence isn't end-to-end
// encrypted, so the server sees the status text too — Settings says so. Not
// remembered between sessions: the text could hold anything.
const STATUS_MAX = 200;
let myShow       = '';    // '' (available) | 'away' | 'dnd'
let myStatusText = '';
let idleAway     = false; // shown as away while the session is locked

function iqP(c, stanza) {
  return new Promise((resolve, reject) => c.sendIQ(stanza, resolve, err => reject(err || new Error('timeout')), 15_000));
}

async function sha1Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s+/g, ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

function bytesToB64(bytes) {
  const u = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

// Square-crops and scales an image onto a canvas. createImageBitmap rejects
// anything that isn't a decodable bitmap image (SVG included).
async function drawSquare(blob, px) {
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const side = Math.min(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, px, px);
    return canvas;
  } finally {
    bmp.close();
  }
}

async function renderAvatarImage(bytes) {
  if (bytes.byteLength > AVATAR_MAX_BYTES) throw new Error('avatar too large');
  return (await drawSquare(new Blob([bytes]), AVATAR_PX)).toDataURL('image/png');
}

// Fetches (once per hash), verifies and decodes, then shows it for `jid`.
// A PEP avatar always wins over a vCard one.
async function loadAvatar(c, jid, src, hash, fetchBytes) {
  hash = hash.toLowerCase();
  if (!avatarImages[hash]) {
    avatarImages[hash] = (async () => {
      const bytes = await fetchBytes();
      if (await sha1Hex(bytes) !== hash) throw new Error('avatar hash mismatch');
      return renderAvatarImage(bytes);
    })().catch(e => { console.warn('Couldn\'t load avatar for', jid, e); return null; });
  }
  const url = await avatarImages[hash];
  if (c !== conn || !url) return;
  if (src === 'vcard' && avatars[jid]?.src === 'pep') return;
  avatars[jid] = { src, hash, url };
  refreshAvatars(jid);
}

function clearAvatar(jid, src) {
  if (avatars[jid]?.src !== src) return;
  delete avatars[jid];
  refreshAvatars(jid);
}

// XEP-0084 metadata, from a PEP push or a fetch. Empty = avatar removed.
function onAvatarMetadata(c, jid, metadata) {
  const infos = metadata ? [...metadata.getElementsByTagNameNS(NS_AVATAR_META, 'info')] : [];
  if (!infos.length) { clearAvatar(jid, 'pep'); return; }
  const usable = infos.filter(i => !i.getAttribute('url') && AVATAR_TYPES.includes(i.getAttribute('type')) &&
    /^[0-9a-f]{40}$/i.test(i.getAttribute('id') || '') && +(i.getAttribute('bytes') || 0) <= AVATAR_MAX_BYTES);
  const info = usable.find(i => i.getAttribute('type') === 'image/png') || usable[0];
  if (!info) return;
  const hash = info.getAttribute('id').toLowerCase();
  if (avatars[jid]?.src === 'pep' && avatars[jid].hash === hash) return;
  loadAvatar(c, jid, 'pep', hash, async () => {
    const attrs = { type: 'get' };
    if (jid !== myJid) attrs.to = jid;
    const res = await iqP(c, $iq(attrs).c('pubsub', { xmlns: NS_PUBSUB })
      .c('items', { node: NS_AVATAR_DATA }).c('item', { id: hash }));
    const data = res.getElementsByTagNameNS(NS_AVATAR_DATA, 'data')[0];
    if (!data) throw new Error('no avatar data');
    return b64ToBytes(data.textContent);
  });
}

// For contacts the server doesn't push to us (e.g. not on the roster).
function requestAvatar(c, jid) {
  if (avatarAsked.has(jid) || avatars[jid]?.src === 'pep') return;
  avatarAsked.add(jid);
  const attrs = { type: 'get' };
  if (jid !== myJid) attrs.to = jid;
  iqP(c, $iq(attrs).c('pubsub', { xmlns: NS_PUBSUB }).c('items', { node: NS_AVATAR_META, max_items: 1 }))
    .then(res => { if (c === conn) onAvatarMetadata(c, jid, res.getElementsByTagNameNS(NS_AVATAR_META, 'metadata')[0]); })
    .catch(() => { /* no avatar, or not allowed to see it */ });
}

async function fetchVcard(c, jid) {
  const attrs = { type: 'get' };
  if (jid !== myJid) attrs.to = jid;
  const res = await iqP(c, $iq(attrs).c('vCard', { xmlns: NS_VCARD }));
  return res.getElementsByTagNameNS(NS_VCARD, 'vCard')[0] || null;
}

function vcardPhoto(vcard) {
  const photo = vcard && [...vcard.childNodes].find(n => n.localName === 'PHOTO');
  const binval = photo && [...photo.childNodes].find(n => n.localName === 'BINVAL');
  const type = photo && [...photo.childNodes].find(n => n.localName === 'TYPE');
  if (!binval || !binval.textContent.trim()) return null;
  if (type && type.textContent.trim() && !AVATAR_TYPES.includes(type.textContent.trim().toLowerCase())) return null;
  return b64ToBytes(binval.textContent);
}

// XEP-0153: a photo hash in someone's presence.
function onVcardUpdate(c, jid, pres) {
  const x = pres.getElementsByTagNameNS(NS_VCARD_UPDATE, 'x')[0];
  const photo = x && [...x.childNodes].find(n => n.localName === 'photo');
  if (!photo) return; // no element: the client doesn't know yet
  const hash = photo.textContent.trim().toLowerCase();
  if (!hash) { clearAvatar(jid, 'vcard'); return; }
  if (!/^[0-9a-f]{40}$/.test(hash) || avatars[jid]?.src === 'pep' || avatars[jid]?.hash === hash) return;
  loadAvatar(c, jid, 'vcard', hash, async () => {
    const bytes = vcardPhoto(await fetchVcard(c, jid));
    if (!bytes) throw new Error('no vCard photo');
    return bytes;
  });
}

// Our own picture: PEP first, vCard as the fallback. Also learns our vCard
// photo hash so presence can advertise it to vCard-only clients.
async function loadOwnAvatar(c) {
  requestAvatar(c, myJid);
  try {
    const bytes = vcardPhoto(await fetchVcard(c, myJid));
    if (c !== conn) return;
    ownVcardHash = bytes ? await sha1Hex(bytes) : '';
    if (bytes) loadAvatar(c, myJid, 'vcard', ownVcardHash, async () => bytes);
  } catch {
    if (c !== conn) return;
    ownVcardHash = ''; // no vCard yet
  }
  sendPresence(c);
}

// Publishes a new picture (or removes it, with file = null): XEP-0084 for
// current clients, and the vCard for clients that only read those.
// The vCard is replaced as a whole, so keep everything except what we
// own here (`drop`, by element name) and add the new parts with `add`.
async function rewriteOwnVcard(c, drop, add) {
  let vcard = null;
  try { vcard = await fetchVcard(c, myJid); } catch { /* none yet */ }
  const doc = new DOMParser().parseFromString('<vCard xmlns="vcard-temp"/>', 'text/xml');
  const out = doc.documentElement;
  if (vcard) [...vcard.childNodes].forEach(n => { if (!drop.includes(n.localName)) out.appendChild(doc.importNode(n, true)); });
  add(doc, out);
  await iqP(c, $iq({ type: 'set' }).cnode(out));
}

// ── Display names (XEP-0172 User Nickname, vCard FN/NICKNAME) ─────────────
// Your name is published to your contacts. A contact's name is read the same
// way. A nickname you give a contact is kept in your own roster instead, so
// it follows you across your devices and they never see it.
async function setOwnName(name) {
  const c = conn;
  name = cleanName(name);
  const pub = $iq({ type: 'set' }).c('pubsub', { xmlns: NS_PUBSUB }).c('publish', { node: NS_NICK }).c('item', { id: 'current' });
  if (name) pub.c('nick', { xmlns: NS_NICK }).t(name);
  else pub.c('nick', { xmlns: NS_NICK });
  await iqP(c, pub);
  try {
    await rewriteOwnVcard(c, ['FN', 'NICKNAME'], (doc, out) => {
      if (!name) return;
      const fn = doc.createElementNS(NS_VCARD, 'FN');
      fn.textContent = name;
      const nick = doc.createElementNS(NS_VCARD, 'NICKNAME');
      nick.textContent = name;
      out.append(fn, nick);
    });
  } catch (e) {
    console.warn('Couldn\'t update the vCard name', e);
  }
  if (c !== conn) return;
  myName = name;
  renderOwnStatus();
}

function setTheirName(jid, name) {
  const b = buddies[jid];
  if (!b) return;
  name = cleanName(name);
  if (name === (b.theirs || '')) return;
  b.theirs = name;
  renderBuddyList();
  if (jid === activeChat) updateChatHeader();
  if (chatWindows[jid]) {
    chatWindows[jid].tab.firstChild.textContent = shortName(jid);
    refreshChatEncryption(jid);
  }
  refreshAvatars(jid);
}

function nickFromItems(items) {
  const n = items && items.getElementsByTagNameNS(NS_NICK, 'nick')[0];
  return n ? cleanName(n.textContent) : '';
}

function vcardName(vcard) {
  const pick = tag => cleanName([...(vcard?.childNodes || [])].find(n => n.localName === tag)?.textContent);
  return pick('NICKNAME') || pick('FN');
}

let nameQueue = Promise.resolve();

// Someone's published name: their PEP nickname, else their vCard. Looked up
// once per session, a few at a time.
function requestName(c, jid) {
  if (!jid || jid === myJid || namesAsked.has(jid)) return;
  namesAsked.add(jid);
  nameQueue = nameQueue.then(async () => {
    if (c !== conn) return;
    let name = '';
    try {
      const res = await iqP(c, $iq({ type: 'get', to: jid }).c('pubsub', { xmlns: NS_PUBSUB }).c('items', { node: NS_NICK, max_items: 1 }));
      name = nickFromItems(res);
    } catch { /* no PEP nickname */ }
    if (!name) {
      try { name = vcardName(await fetchVcard(c, jid)); } catch { /* no vCard */ }
    }
    if (c === conn && name) setTheirName(jid, name);
  }).catch(() => {});
}

async function loadOwnName(c) {
  let name = '';
  try {
    const res = await iqP(c, $iq({ type: 'get' }).c('pubsub', { xmlns: NS_PUBSUB }).c('items', { node: NS_NICK, max_items: 1 }));
    name = nickFromItems(res);
  } catch { /* none */ }
  if (!name) {
    try { name = vcardName(await fetchVcard(c, myJid)); } catch { /* none */ }
  }
  if (c === conn && name) { myName = name; renderOwnStatus(); }
}

function nameSection() {
  const s = section('Your name');
  const row = el('div', 'device-actions');
  const text = el('input', 'status-input');
  text.type = 'text';
  text.maxLength = NAME_MAX;
  text.placeholder = myJid.split('@')[0];
  text.value = myName;
  text.spellcheck = false;
  text.setAttribute('aria-label', 'Your name');
  const save = el('button', 'btn primary', 'Save');
  const note = el('span', 'muted');
  const apply = async () => {
    note.textContent = 'Saving…';
    try { await setOwnName(text.value); note.textContent = 'Saved.'; }
    catch (e) { note.textContent = 'That didn\'t work: ' + (e?.message || 'the server refused it') + '.'; }
  };
  save.onclick = apply;
  text.onkeydown = e => { if (e.key === 'Enter') apply(); };
  row.append(text, save, note);
  s.append(row, el('p', 'muted', 'Your contacts see this name instead of your address.'));
  return s;
}

async function setOwnAvatar(file) {
  const c = conn;
  let bytes = null, hash = '', url = null;
  if (file) {
    const canvas = await drawSquare(file, AVATAR_PUBLISH_PX); // rejects files that aren't images
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    bytes = new Uint8Array(await blob.arrayBuffer());
    hash = await sha1Hex(bytes);
    url = await renderAvatarImage(bytes);
  }
  if (c !== conn) return;

  const pub = (node, id) => $iq({ type: 'set' }).c('pubsub', { xmlns: NS_PUBSUB }).c('publish', { node }).c('item', { id });
  if (bytes) {
    await iqP(c, pub(NS_AVATAR_DATA, hash).c('data', { xmlns: NS_AVATAR_DATA }).t(bytesToB64(bytes)));
    await iqP(c, pub(NS_AVATAR_META, hash).c('metadata', { xmlns: NS_AVATAR_META })
      .c('info', { bytes: bytes.byteLength, id: hash, height: AVATAR_PUBLISH_PX, width: AVATAR_PUBLISH_PX, type: 'image/png' }));
  } else {
    await iqP(c, pub(NS_AVATAR_META, 'current').c('metadata', { xmlns: NS_AVATAR_META }));
  }

  try {
    await rewriteOwnVcard(c, ['PHOTO'], (doc, out) => {
      if (!bytes) return;
      const photo = doc.createElementNS(NS_VCARD, 'PHOTO');
      const type = doc.createElementNS(NS_VCARD, 'TYPE');
      type.textContent = 'image/png';
      const binval = doc.createElementNS(NS_VCARD, 'BINVAL');
      binval.textContent = bytesToB64(bytes);
      photo.append(type, binval);
      out.appendChild(photo);
    });
  } catch (e) {
    console.warn('Couldn\'t update the vCard photo', e);
  }
  if (c !== conn) return;

  ownVcardHash = hash;
  sendPresence(c);
  if (bytes) {
    avatarImages[hash] = Promise.resolve(url);
    avatars[myJid] = { src: 'pep', hash, url };
  } else {
    delete avatars[myJid];
  }
  refreshAvatars(myJid);
}

// Where the corresponding source lives (GPL-3.0 §6) — linked from About.
const SOURCE_URL = 'https://github.com/djkov/woofr-chat';

const svgNS = 'http://www.w3.org/2000/svg';
const ICON_LOCK   = 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z';
const ICON_UNLOCK = 'M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z';

const ICON_CLIP     = 'M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z';
const ICON_BOLT     = 'M7 2v11h3v9l7-12h-4l4-8z';
const ICON_ALERT    = 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z';
const ICON_KEY      = 'M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z';
const ICON_REPLY    = 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z';
const ICON_DOWNLOAD = 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z';
const ICON_CLOSE    = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
const ICON_CHAT     = 'M12 3C6.5 3 2 6.6 2 11c0 2.4 1.3 4.6 3.4 6.1L4.6 21l4.2-2.3c1 .2 2.1.3 3.2.3 5.5 0 10-3.6 10-8s-4.5-8-10-8z';

// Static markup only (the paths above are constants), for the toolbar template.
const svgHtml = path => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';

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
  document.getElementById('my-jid-display').textContent = ownName();
  document.getElementById('my-jid-display').title = myJid;
  renderOwnStatus();
  requestNotifPermission();

  // Bind handlers to this connection: once it's torn down, any stanza still in
  // flight is dropped (and the handler removed) instead of being rendered into
  // a page we've just wiped.
  const live = fn => stanza => c === conn && fn(stanza);

  c.addHandler(live(onMessageStanza), null, 'message');
  c.addHandler(live(onPresence),      null, 'presence');
  c.addHandler(live(onDiscoInfo),     NS_DISCO_INFO, 'iq', 'get');
  c.addHandler(live(onRosterPush),    Strophe.NS.ROSTER, 'iq', 'set');

  startOmemo(c);
  // Roster first, then presence (RFC 6121 order): subscription requests that
  // waited while we were offline arrive after our presence, and need the
  // roster to tell contacts we added from strangers.
  c.sendIQ(
    $iq({type: 'get'}).c('query', {xmlns: Strophe.NS.ROSTER}),
    live(iq => { onRoster(iq); sendPresence(c); loadOwnAvatar(c); loadOwnName(c); discoverUploads(c); }),
    live(() => { sendPresence(c); loadOwnAvatar(c); loadOwnName(c); discoverUploads(c); })
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
    const show = myShow || (idleAway ? 'away' : '');
    if (show) p.c('show').t(show).up();
    if (myStatusText) p.c('status').t(myStatusText).up();
    if (ver) p.c('c', { xmlns: NS_CAPS, hash: 'sha-1', node: CAPS_NODE, ver }).up();
    if (ownVcardHash !== null) {
      p.c('x', { xmlns: NS_VCARD_UPDATE });
      if (ownVcardHash) p.c('photo').t(ownVcardHash); else p.c('photo');
    }
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
      if (jid) noteInChat(jid, text, 'warning');
      else { omemoNotices.push(text); setStatus(text, 'error'); }
    },
    changed: jid => { if (c === conn) onOmemoChanged(jid); },
  });
  omemo = session;
  omemoReady = (async () => {
    const vault = await omemoVault;
    if (!vault) throw new Error('this browser couldn\'t open its key storage');
    await loadHistory(c, vault);
    await session.start(vault);
  })().catch(e => {
    if (c !== conn) return;
    // Another tab owns this account's keys, and its history too: show what's
    // saved here, but leave the writing to that tab.
    if (e.code === 'locked') { historyStore = null; clearInterval(expiryTimer); }
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
      appendMsg(jid, null, displayName(jid) + ' hasn\'t set up OMEMO encryption, so messages to them can\'t be ' +
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
  chat.input.placeholder = (state === 'off' ? 'Unencrypted message to ' : 'Encrypted message to ') + displayName(jid) + '…';
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
    appendMsg(jid, null, 'Not encrypting for ' + whose + ' ' + s.id + ' (' + s.reason + '). Review it under Encryption details.', 'warning');
  }
}

// ── Roster ─────────────────────────────────────────────────────────────────
// Presence only flows once a subscription is approved (RFC 6121). Each
// buddy carries its roster state: inRoster, sub ('none' | 'to' | 'from' |
// 'both') and ask (we've asked and are waiting). `requests` holds people who
// asked to see our presence and haven't been answered.
let requests = new Set();

function applyRosterItem(item) {
  const bare = bareJid(item.getAttribute('jid'));
  if (!bare || bare === myJid) return;
  if (item.getAttribute('subscription') === 'remove') {
    if (buddies[bare]) {
      if (chatWindows[bare]) Object.assign(buddies[bare], { inRoster: false, sub: 'none', ask: false });
      else delete buddies[bare];
    }
    return;
  }
  const b = buddies[bare] || (buddies[bare] = { show: 'offline' });
  const nick = cleanName(item.getAttribute('name'));
  b.local    = nick && nick !== bare ? nick : '';
  b.groups   = [...item.getElementsByTagName('group')].map(g => g.textContent);
  b.inRoster = true;
  b.sub      = item.getAttribute('subscription') || 'none';
  b.ask      = item.getAttribute('ask') === 'subscribe';
  // Already sharing presence with them, so any request is settled.
  if (b.sub === 'from' || b.sub === 'both') requests.delete(bare);
}

function onRoster(iq) {
  iq.querySelectorAll('item').forEach(applyRosterItem);
  Object.keys(buddies).forEach(jid => requestName(conn, jid));
  renderBuddyList();
}

// The server tells us about roster changes (ours, or from our other
// devices). Only our own server may: pushes from anyone else are ignored.
function onRosterPush(iq) {
  const from = iq.getAttribute('from');
  if (from && bareJid(from) !== myJid) return true;
  iq.querySelectorAll('item').forEach(applyRosterItem);
  conn.send($iq({ type: 'result', id: iq.getAttribute('id') }));
  renderBuddyList();
  Object.keys(chatWindows).forEach(jid => {
    chatWindows[jid].tab.firstChild.textContent = shortName(jid);
    refreshChatEncryption(jid);
    refreshAvatars(jid);
  });
  if (activeChat) updateChatHeader();
  if (modalState?.kind === 'contact') renderModal();
  return true;
}

function addBuddy() {
  const jid = document.getElementById('inp-add-buddy').value.trim();
  if (!jid || !conn) return;
  const bare = bareJid(jid);
  const b = buddies[bare] || (buddies[bare] = { show: 'offline' });
  b.inRoster = true;
  b.ask = true;
  conn.send($pres({to: bare, type: 'subscribe'}));
  // If they'd already asked us, adding them back is the answer.
  if (requests.has(bare)) approveRequest(bare);
  document.getElementById('inp-add-buddy').value = '';
  renderBuddyList();
}

// Someone wants to see our presence. People we added ourselves are
// approved straight away — adding someone means you want to see each other.
// Anyone else waits for Accept / Decline.
function onSubscribeRequest(from) {
  const b = buddies[from];
  if (b?.inRoster) {
    approveRequest(from);
    return;
  }
  if (requests.has(from)) return;
  requests.add(from);
  renderBuddyList();
  notify('You have a new contact request.', { tag: 'subscribe' }); // no name: notifications never carry who
}

function approveRequest(jid) {
  if (!conn) return;
  requests.delete(jid);
  conn.send($pres({ to: jid, type: 'subscribed' }));
  const b = buddies[jid] || (buddies[jid] = { show: 'offline' });
  // Make it mutual: ask to see theirs too, unless we already do (or asked).
  if (!(b.sub === 'to' || b.sub === 'both' || b.ask)) {
    b.ask = true;
    conn.send($pres({ to: jid, type: 'subscribe' }));
  }
  b.inRoster = true;
  renderBuddyList();
}

function declineRequest(jid) {
  if (!conn) return;
  requests.delete(jid);
  conn.send($pres({ to: jid, type: 'unsubscribed' }));
  renderBuddyList();
}

// ── Presence ───────────────────────────────────────────────────────────────
function onPresence(pres) {
  const from = bareJid(pres.getAttribute('from'));
  const type  = pres.getAttribute('type') || 'available';
  const showEl = pres.querySelector('show');
  const show  = showEl ? showEl.textContent : (type === 'available' ? 'online' : 'offline');

  if (from === myJid || !from) return true;
  // Subscription traffic isn't availability: don't mark anyone offline for it.
  if (type === 'subscribe') { onSubscribeRequest(from); return true; }
  if (!['available', 'unavailable'].includes(type)) return true; // subscribed, unsubscribe(d), probe, error
  if (type !== 'unavailable') onVcardUpdate(conn, from, pres);

  if (!buddies[from]) buddies[from] = { show: 'offline' };
  buddies[from].show = (type === 'unavailable') ? 'offline' : show;
  const statusEl = [...pres.childNodes].find(n => n.localName === 'status');
  buddies[from].status = type === 'unavailable' ? '' : (statusEl?.textContent.trim().slice(0, STATUS_MAX) || '');

  renderBuddyList();
  if (from === activeChat) updateChatHeader();
  if (chatWindows[from]) chatWindows[from].tab.title = buddies[from].status;
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

  if (requests.size) {
    const gh = el('li', 'group-header');
    gh.append(el('span', 'group-caret', '▼ '), 'Contact requests (' + requests.size + ')');
    ul.appendChild(gh);
    requests.forEach(jid => ul.appendChild(makeRequestLi(jid)));
  }

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

function makeRequestLi(jid) {
  const li = el('li', 'buddy request');
  const wrap = el('div', 'avatar-wrap');
  wrap.appendChild(avatar(jid));
  const info = el('div', 'buddy-info');
  const line1 = el('div', 'buddy-line1');
  line1.appendChild(el('span', 'buddy-name', buddies[jid]?.theirs ? buddies[jid].theirs + ' (' + jid + ')' : jid));
  const line2 = el('div', 'buddy-line2');
  line2.appendChild(el('span', 'buddy-preview', 'Wants to add you'));
  info.append(line1, line2);
  const actions = el('div', 'request-actions');
  const yes = el('button', 'btn primary', 'Accept');
  const no  = el('button', 'btn', 'Decline');
  yes.onclick = e => { e.stopPropagation(); approveRequest(jid); };
  no.onclick  = e => { e.stopPropagation(); declineRequest(jid); };
  actions.append(yes, no);
  li.append(wrap, info, actions);
  li.title = jid + ' wants to see when you\'re online';
  return li;
}

// Shown instead of a presence label while they haven't approved us yet.
function pendingLabel(b) {
  return b.inRoster && b.ask && !(b.sub === 'to' || b.sub === 'both') ? 'Waiting for approval' : '';
}

function makeBuddyLi(jid, b) {
  const li = el('li', 'buddy' + (jid === activeChat ? ' active' : ''));
  const wrap = el('div', 'avatar-wrap');
  wrap.append(avatar(jid), el('div', 'status-dot' + dotClass(b.show)));

  const line1 = el('div', 'buddy-line1');
  line1.append(el('span', 'buddy-name', displayName(jid)));
  if (b.status) line1.append(el('span', 'buddy-status', b.status));
  line1.append(el('span', 'buddy-time', b.time || ''));
  const line2 = el('div', 'buddy-line2');
  line2.append(el('span', 'buddy-preview', b.preview ?? (b.status || pendingLabel(b) || presenceLabel(b.show))));
  if (pendingLabel(b)) line1.insertBefore(el('span', 'buddy-status', '(waiting for approval)'), line1.lastChild);
  if (b.unread) line2.append(el('span', 'unread-badge', b.unread > 99 ? '99+' : String(b.unread)));
  const info = el('div', 'buddy-info');
  info.append(line1, line2);

  li.append(wrap, info);
  li.title   = jid + (b.status ? ' — ' + b.status : '');
  li.onclick = () => openChat(jid);
  return li;
}

// Last message shown under the contact's name, plus an unread count while
// the chat isn't on screen.
function updatePreview(jid, text, incoming) {
  const b = buddies[jid] || (buddies[jid] = { show: 'offline' });
  b.preview = Rich.plain(text).slice(0, 80);
  b.time = fmtListTime(Date.now());
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
  const avatarPush = [...msg.getElementsByTagNameNS(NS_PUBSUB_EVENT, 'items')].find(i => i.getAttribute('node') === NS_AVATAR_META);
  const nickPush = [...msg.getElementsByTagNameNS(NS_PUBSUB_EVENT, 'items')].find(i => i.getAttribute('node') === NS_NICK);
  if (nickPush) {
    const who = bareJid(msg.getAttribute('from')) || myJid;
    if (who === myJid) { myName = nickFromItems(nickPush); renderOwnStatus(); } else setTheirName(who, nickFromItems(nickPush));
    return;
  }
  if (avatarPush) { onAvatarMetadata(c, bareJid(msg.getAttribute('from')) || myJid, avatarPush.getElementsByTagNameNS(NS_AVATAR_META, 'metadata')[0]); return; }
  if (omemo?.handleEvent(msg)) return; // PEP device-list push
  if (type === 'groupchat' || type === 'headline') return;

  const from = bareJid(msg.getAttribute('from'));
  if (!from || from === myJid) return;
  if (type === 'error') {
    if (chatWindows[from]) appendMsg(from, null, 'A message to ' + shortName(from) + ' couldn\'t be delivered.', 'nudge-error');
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
      noteInChat(from, shortName(from) + ' sent an encrypted message that couldn\'t be read: ' + e.message +
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
    const link = mediaLink(text, opts.encrypted);
    const row = appendMsg(from, from, text, 'them', link ? { ...opts, media: link } : opts);
    recordMessage(from, { dir: 'in', kind: link ? 'media' : 'msg', text, ts: +row.dataset.ts, enc: opts.encrypted, untrusted: opts.untrusted });
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
  requestAvatar(conn, jid);
  requestName(conn, jid);
  switchTab(jid);
  if (isMobileLayout()) document.getElementById('app-layout').classList.add('mobile-chat-open');
  markRead(jid);
  setTimeout(() => chatWindows[jid]?.input.focus(), isMobileLayout() ? 300 : 50);
}

function createChatWindow(jid) {
  const tabs = document.getElementById('chat-tabs');
  const wins = document.getElementById('chat-windows');

  const tab = el('button', 'chat-tab', shortName(jid));
  const closeBtn = el('span', 'close-tab');
  closeBtn.appendChild(icon(ICON_CLOSE));
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
      <div class="attach-tray" hidden></div>
      <div class="kaomoji-menu" role="menu" hidden></div>
      <div class="chat-toolbar">
        <button data-fmt="**" title="Bold"><b>B</b></button>
        <button data-fmt="_" title="Italic"><i>I</i></button>
        <button class="kaomoji-btn" title="Kaomoji" aria-haspopup="true" aria-expanded="false">(^_^)</button>
        <button class="attach-btn" title="Send a file or photo">${svgHtml(ICON_CLIP)}<span class="lbl"> Attach</span></button>
        <input type="file" class="attach-input" multiple hidden>
        <button class="nudge-btn" title="Send Nudge (XEP-0224)">${svgHtml(ICON_BOLT)}<span class="lbl"> Nudge!</span></button>
        <button class="priority-send-btn" title="Priority Message">${svgHtml(ICON_ALERT)}<span class="lbl"> Priority</span></button>
        <span class="toolbar-spacer"></span>
        <button class="enc-btn"></button>
        <button class="keys-btn" title="Encryption details">${svgHtml(ICON_KEY)} Keys</button>
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
  const picker = win.querySelector('.attach-input');
  win.querySelector('.attach-btn').onclick = () => picker.click();
  // Picked, dropped and pasted files wait in a tray until Send, so a message
  // can go with them and nothing is sent by accident.
  picker.onchange = () => { stageFiles(jid, [...picker.files]); picker.value = ''; };
  win.ondragover = e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
  win.ondrop = e => { if (e.dataTransfer?.files.length) { e.preventDefault(); stageFiles(jid, [...e.dataTransfer.files]); } };
  input.onpaste = e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); stageFiles(jid, files); } };
  const kaomojiBtn = win.querySelector('.kaomoji-btn');
  kaomojiBtn.onclick = e => { e.stopPropagation(); toggleKaomoji(jid); };
  encBtn.onclick                                  = () => toggleEncryption(jid);
  wins.appendChild(win);

  if (!buddies[jid]) buddies[jid] = { show: 'offline' }; // so the chat is reachable from the list
  chatWindows[jid] = { tab, win, log, input, encBtn, staged: [], tray: win.querySelector('.attach-tray'), kaomoji: win.querySelector('.kaomoji-menu'), encrypt: true, sendQueue: Promise.resolve(), lastStamp: 0, noOmemoNoted: false };
  const past = history.get(jid);
  if (past?.length) {
    for (const m of past) {
      const opts = { ts: m.ts, encrypted: m.enc, untrusted: m.untrusted, restored: true };
      const link = m.kind === 'media' ? mediaLink(m.text, m.enc) : null;
      if (m.kind === 'priority') appendPriorityRow(jid, m.dir === 'out' ? ownName() : displayName(jid), m.text, opts);
      else if (link) appendMsg(jid, m.dir === 'out' ? myJid : jid, m.text, m.dir === 'out' ? 'me' : 'them', { ...opts, media: link, manual: true });
      else appendMsg(jid, m.dir === 'out' ? myJid : jid, m.text, m.dir === 'out' ? 'me' : 'them', opts);
    }
  } else {
    appendMsg(jid, null, 'Conversation with ' + displayName(jid) + ' started at ' + now(), 'system');
  }
  refreshChatEncryption(jid);
  refreshAttachButtons();
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
  const sub   = document.getElementById('chat-subtitle');
  area.classList.toggle('has-chat', !!activeChat);
  if (!activeChat) { title.replaceChildren(); sub.textContent = ''; return; }
  const b = buddies[activeChat];
  sub.textContent = (b && pendingLabel(b)) || (presenceLabel(b?.show) + (b?.status ? ' · ' + b.status : ''));
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
function stampTime(chat, ts) {
  if (ts - chat.lastStamp < 5 * 60_000) return;
  chat.lastStamp = ts;
  const sep = el('div', 'msg-timesep');
  sep.dataset.ts = ts;
  paintExpiry(sep, ts);
  chat.log.appendChild(sep);
}

// type: 'me' | 'them' | 'system' | 'warning' | 'nudge' | 'nudge-error'.
// opts.encrypted / opts.untrusted mark how a chat message travelled;
// opts.ts / opts.restored are for messages from history.
function appendMsg(jid, from, text, type, opts = {}) {
  const chat = chatWindows[jid];
  if (!chat) return null;
  const log = chat.log;
  let row;
  if (type !== 'me' && type !== 'them') {
    row = el('div', 'msg-' + type, text);
  } else {
    const ts = opts.ts || Date.now();
    stampTime(chat, ts);
    const mine = type === 'me';
    row = el('div', 'msg ' + (mine ? 'msg-me' : 'msg-them'));
    row.dataset.ts = ts;
    const meta = el('span', 'msg-meta');
    meta.append(el('span', 'msg-time', '[' + fmtTime(ts) + ']'), ' ', el('span', 'msg-expiry'), ' ');
    if (opts.encrypted) { const lock = el('span', 'msg-lock'); lock.appendChild(icon(ICON_LOCK)); meta.append(lock, ' '); }
    meta.append(el('span', 'nick', (mine ? ownName() : displayName(from)) + ':'), ' ');
    const main = el('div', 'msg-main');
    const bubble = el('div', 'bubble' + (opts.media ? ' media-bubble' : ''));
    if (opts.media) bubble.appendChild(mediaNode(opts.media, opts));
    else fillRich(bubble, text);
    main.append(meta, bubble);
    if (!opts.media && text) {
      const reply = el('button', 'reply-btn');
      reply.appendChild(icon(ICON_REPLY));
      reply.title = 'Reply (quotes this message)';
      reply.setAttribute('aria-label', 'Reply');
      reply.onclick = () => quoteInto(jid, text);
      main.appendChild(reply);
    }
    if (!opts.encrypted) main.append(el('span', 'msg-flag plain', 'Not encrypted'));
    else if (opts.untrusted) main.append(el('span', 'msg-flag untrusted', 'From an unverified device'));
    row.append(avatar(mine ? myJid : jid), main);
    paintExpiry(row, ts);
    if (!opts.restored) updatePreview(jid, opts.media ? mediaPreview(text, opts.media) : text, !mine);
  }
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

// Sends go through a per-chat queue so they leave in the order they were
// typed, even though encrypting is asynchronous. The message shows at once
// (dimmed until sent); if it can't be sent it's marked and the text goes back
// into the input box.
// Staged files go first, then the message as their caption.
async function sendMsg(jid) {
  const chat = chatWindows[jid];
  if (!chat) return;
  const staged = chat.staged.splice(0);
  if (staged.length) {
    renderTray(jid);
    for (const s of staged) { URL.revokeObjectURL(s.thumb); mediaUrls.delete(s.thumb); await sendAttachment(jid, s.file); }
  }
  sendText(jid, false);
}
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
    ? appendPriorityRow(jid, ownName(), text, { encrypted: encrypt })
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
      recordMessage(jid, { dir: 'out', kind: priority ? 'priority' : 'msg', text, ts: +row.dataset.ts, enc: encrypt, untrusted: false });
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
  const ts     = opts.ts || Date.now();
  const row    = el('div', 'msg-priority');
  row.dataset.ts = ts;
  const header = el('div', 'priority-header');
  header.append(el('span', null, 'Priority message:'), el('span', 'msg-expiry'),
    el('span', 'msg-time', '[' + fmtTime(ts) + '] ' + fromName));
  const body = el('div', 'priority-body');
  fillRich(body, text);
  row.append(header, body);
  if (!opts.encrypted) row.append(el('span', 'msg-flag plain', 'Not encrypted'));
  else if (opts.untrusted) row.append(el('span', 'msg-flag untrusted', 'From an unverified device'));
  return row;
}

function appendPriorityRow(jid, fromName, text, opts = {}) {
  const chat = chatWindows[jid];
  const row = makePriorityRow(fromName, text, opts);
  chat.log.appendChild(row);
  chat.log.scrollTop = chat.log.scrollHeight;
  paintExpiry(row, +row.dataset.ts);
  if (!opts.restored) updatePreview(jid, '[Priority] ' + text, fromName !== ownName());
  return row;
}

function appendPriorityMsg(jid, fromName, text, opts) {
  if (!chatWindows[jid]) return;
  const row = appendPriorityRow(jid, fromName, text, opts);
  const ack = el('div', 'priority-ack');
  const btn = el('button', 'priority-ack-btn', 'Mark as read');
  btn.onclick = () => ackPriority(row, btn);
  ack.appendChild(btn);
  row.appendChild(ack);
  chatWindows[jid].log.scrollTop = chatWindows[jid].log.scrollHeight;
}

function ackPriority(row, btn) {
  btn.textContent = 'Read';
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
    appendMsg(jid, null, 'Nudge limit reached! Please wait ' + wait + 's before sending another nudge.', 'nudge-error');
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
    const ts = Date.now();
    appendPriorityMsg(from, name, text, { ...opts, ts });
    recordMessage(from, { dir: 'in', kind: 'priority', text, ts, enc: opts.encrypted, untrusted: opts.untrusted });
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

// ── Formatting and quote threads (richtext.js) ───────────────────────────
// Message text is rendered as safe Markdown. The raw text is what's sent and
// kept, so other clients see readable text. Reply quotes a message with
// another ">" per line, so quotes of quotes nest into a thread.
function fillRich(node, text) {
  const { node: content, blocks } = Rich.render(text);
  node.appendChild(content);
  if (blocks) node.classList.add('has-blocks');
}

function quoteInto(jid, text) {
  const chat = chatWindows[jid];
  if (!chat) return;
  const input = chat.input;
  input.value = (input.value && !input.value.endsWith('\n') ? input.value + '\n' : input.value) + Rich.quote(text);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ── Files and media (media.js) ────────────────────────────────────────────
// Sent as encrypted uploads (see media.js). Received ones are fetched from
// our own server only. Photos load by themselves; everything else waits for a
// click, as does anything restored from history. Decrypted files live in
// memory for the session and are never written to disk by the app.
let uploadSvc  = null;       // { jid, max } once the server's upload service is found
let mediaCache = new Map();  // link text -> Promise<Uint8Array>
let mediaUrls  = new Set();  // blob: URLs we've made, revoked on sign-out

function discoverUploads(c) {
  Media.discover(stanza => iqP(c, stanza), myJid.split('@')[1])
    .then(svc => { if (c === conn) { uploadSvc = svc; refreshAttachButtons(); } })
    .catch(() => { /* no upload service */ });
}

function refreshAttachButtons() {
  Object.values(chatWindows).forEach(chat => {
    const b = chat.win.querySelector('.attach-btn');
    b.disabled = !uploadSvc;
    b.title = uploadSvc ? 'Send a file or photo (up to ' + fmtSize(uploadSvc.max) + ')' : 'File sharing isn\'t available on this server';
  });
}

function fmtSize(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

// A message body that's a file link (ours, from our own server), or null.
function mediaLink(text, encrypted) {
  const link = Media.parseLink(text) || (!encrypted ? Media.parsePlain(text) : null);
  if (!link) return null;
  if (!link.key && (Media.kindOf(link.ext) === 'file' || !Media.hostAllowed(link.host, myJid.split('@')[1]))) return null;
  return link;
}

const MEDIA_NAMES = { image: 'Photo', audio: 'Audio', video: 'Video', file: 'File' };
function mediaPreview(text, link) {
  link = link || Media.parseLink(text) || Media.parsePlain(text);
  return '[' + MEDIA_NAMES[Media.kindOf(link?.ext)] + ']';
}

function mediaNode(link, opts) {
  const box  = el('div', 'media');
  const kind = Media.kindOf(link.ext);
  const key  = link.url + '#' + (link.key ? link.name : '');

  const show = bytes => {
    const type = kind === 'file' ? 'application/octet-stream' : Media.mimeOf(link.ext);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    mediaUrls.add(url);
    let node;
    if (kind === 'image') {
      node = el('img', 'media-img');
      node.alt = 'Photo';
      node.src = url;
      node.onclick = () => openLightbox(url);
    } else if (kind === 'audio' || kind === 'video') {
      node = el(kind, 'media-' + kind);
      node.controls = true;
      node.preload = 'metadata';
      node.src = url;
    } else {
      node = el('a', 'media-file');
      node.append(icon(ICON_DOWNLOAD), ' ' + (link.ext ? link.ext.toUpperCase() + ' file' : 'File') + ' · ' + fmtSize(bytes.length));
      node.href = url;
      node.download = link.name;
    }
    box.replaceChildren(node);
    const log = box.closest('.chat-log');
    if (log && kind === 'image') node.onload = () => { log.scrollTop = log.scrollHeight; };
  };

  if (link.local) { show(link.local); return box; }

  if (!Media.hostAllowed(link.host, myJid.split('@')[1])) {
    box.appendChild(el('span', 'media-note', 'Not loaded: this file is hosted outside your server.'));
    return box;
  }

  const load = async () => {
    box.replaceChildren(el('span', 'media-note', 'Loading…'));
    try {
      if (!mediaCache.has(key)) {
        const p = Media.download(link, Media.MAX_BYTES);
        mediaCache.set(key, p);
        p.catch(() => mediaCache.delete(key));
      }
      const bytes = await mediaCache.get(key);
      if (box.isConnected || conn) show(bytes);
    } catch (e) {
      box.replaceChildren(el('span', 'media-note media-error', 'Couldn\'t load: ' + e.message + '.'));
      const retry = el('button', 'btn', 'Try again');
      retry.onclick = load;
      box.appendChild(retry);
    }
  };

  if (kind === 'image' && !opts.manual) { load(); return box; }
  const label = { image: 'Show photo', audio: 'Play audio', video: 'Load video', file: 'Download file' }[kind];
  const btn = el('button', 'btn media-load', label);
  btn.onclick = load;
  box.appendChild(btn);
  return box;
}

function openLightbox(url) {
  const box = document.getElementById('lightbox');
  box.querySelector('img').src = url;
  box.hidden = false;
}

function closeLightbox() {
  const box = document.getElementById('lightbox');
  box.hidden = true;
  box.querySelector('img').removeAttribute('src');
}

const MAX_STAGED = 10;

function stageFiles(jid, files) {
  const chat = chatWindows[jid];
  if (!chat || !files.length) return;
  if (!uploadSvc) { appendMsg(jid, null, 'This server doesn\'t offer file sharing.', 'nudge-error'); return; }
  const limit = Math.min(uploadSvc.max, Media.MAX_BYTES);
  for (const file of files) {
    if (chat.staged.length >= MAX_STAGED) { appendMsg(jid, null, 'At most ' + MAX_STAGED + ' files at a time.', 'nudge-error'); break; }
    if (file.size > limit) { appendMsg(jid, null, (file.name || 'That file') + ' is too large (the limit is ' + fmtSize(limit) + ').', 'nudge-error'); continue; }
    let thumb = '';
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { thumb = URL.createObjectURL(file); mediaUrls.add(thumb); }
    chat.staged.push({ file, thumb });
  }
  renderTray(jid);
  chat.input.focus();
}

function renderTray(jid) {
  const chat = chatWindows[jid];
  if (!chat) return;
  chat.tray.replaceChildren();
  chat.tray.hidden = !chat.staged.length;
  chat.input.placeholder = chat.staged.length
    ? 'Add a message (optional)…'
    : (encryptionState(jid) === 'off' ? 'Unencrypted message to ' : 'Encrypted message to ') + displayName(jid) + '…';
  chat.staged.forEach((s, i) => {
    const item = el('div', 'tray-item');
    if (s.thumb) { const t = el('img', 'tray-thumb'); t.alt = ''; t.src = s.thumb; item.appendChild(t); }
    else { const t = el('div', 'tray-thumb tray-file', (Media.extOf(s.file.name) || 'file').toUpperCase().slice(0, 4)); item.appendChild(t); }
    const info = el('div', 'tray-info');
    info.append(el('div', 'tray-name', s.file.name || 'Pasted image'), el('div', 'tray-size', fmtSize(s.file.size)));
    const remove = el('button', 'tray-remove');
    remove.title = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + (s.file.name || 'file'));
    remove.appendChild(icon(ICON_CLOSE));
    remove.onclick = () => { URL.revokeObjectURL(s.thumb); mediaUrls.delete(s.thumb); chat.staged.splice(chat.staged.indexOf(s), 1); renderTray(jid); };
    item.append(info, remove);
    chat.tray.appendChild(item);
  });
}

// ── Kaomoji ───────────────────────────────────────────────────────────────
// Plain-text faces instead of emoji. Inserted as typed; the formatter leaves
// them alone (see richtext.js).
const KAOMOJI = [
  ['Happy',   ['(^_^)', '(^o^)', '(＾▽＾)', '(≧◡≦)', '(*^‿^*)', 'ヽ(´▽`)/', '\\(^o^)/', '٩(◕‿◕)۶', '(´∀`)', '☆*:.｡.o(≧▽≦)o.｡.:*☆']],
  ['Love',    ['(｡♡‿♡｡)', '(◕‿◕)♡', '(づ｡◕‿‿◕｡)づ', '(*´▽`*)', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(´,,•ω•,,)♡']],
  ['Sad',     ['(T_T)', '(;_;)', '(╥_╥)', '(ಥ_ಥ)', '(´；ω；`)', '(つ﹏⊂)', 'orz']],
  ['Annoyed', ['(-_-)', '(¬_¬)', '(>_<)', '(ー_ー)!!', '(╯°□°)╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)']],
  ['Woof',    ['ʕ•ᴥ•ʔ', 'U・ᴥ・U', '∪･ω･∪', '(=^･ω･^=)', '(ᵔᴥᵔ)']],
  ['Other',   ['¯\\_(ツ)_/¯', '(・_・;)', '(O_O)', '(°o°)', '(^_~)', '(-.-)Zzz', '(｀･ω･´)ゞ', '(^_^)/']],
];

let kaomojiOpen = null; // jid of the chat whose menu is open

function closeKaomoji() {
  if (!kaomojiOpen) return;
  const chat = chatWindows[kaomojiOpen];
  kaomojiOpen = null;
  if (chat) { chat.kaomoji.hidden = true; chat.win.querySelector('.kaomoji-btn').setAttribute('aria-expanded', 'false'); }
}

function toggleKaomoji(jid) {
  const chat = chatWindows[jid];
  if (!chat) return;
  if (kaomojiOpen === jid) { closeKaomoji(); return; }
  closeKaomoji();
  if (!chat.kaomoji.childNodes.length) {
    for (const [label, faces] of KAOMOJI) {
      const group = el('div', 'kaomoji-group');
      group.appendChild(el('div', 'kaomoji-label', label));
      const grid = el('div', 'kaomoji-grid');
      faces.forEach(face => {
        const b = el('button', 'kaomoji-item', face);
        b.setAttribute('role', 'menuitem');
        b.onclick = () => insertKaomoji(jid, face);
        grid.appendChild(b);
      });
      group.appendChild(grid);
      chat.kaomoji.appendChild(group);
    }
  }
  chat.kaomoji.hidden = false;
  chat.win.querySelector('.kaomoji-btn').setAttribute('aria-expanded', 'true');
  kaomojiOpen = jid;
}

function insertKaomoji(jid, face) {
  const chat = chatWindows[jid];
  if (!chat) return;
  const ta = chat.input;
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  const pad = s > 0 && !/\s$/.test(ta.value.slice(0, s)) ? ' ' : '';
  ta.setRangeText(pad + face + ' ', s, e, 'end');
  closeKaomoji();
  ta.focus();
}

async function sendAttachment(jid, file) {
  const chat = chatWindows[jid];
  if (!chat || !conn) return;
  if (!uploadSvc) { appendMsg(jid, null, 'This server doesn\'t offer file sharing.', 'nudge-error'); return; }
  const limit = Math.min(uploadSvc.max, Media.MAX_BYTES);
  if (file.size > limit) { appendMsg(jid, null, (file.name || 'That file') + ' is too large (the limit is ' + fmtSize(limit) + ').', 'nudge-error'); return; }

  const c = conn, encrypt = chat.encrypt;
  let blob = file, ext = Media.extOf(file.name) || (file.type.split('/')[1] || '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  if (file.type.startsWith('image/')) ({ blob, ext } = await Media.prepareImage(file));
  if (c !== conn) return;
  const local = new Uint8Array(await blob.arrayBuffer());
  const ts = Date.now();
  const row = appendMsg(jid, myJid, '', 'me', { encrypted: encrypt, ts, media: { local, ext, name: file.name || 'file', url: '', host: '' } });
  row.classList.add('pending');

  chat.sendQueue = chat.sendQueue.then(async () => {
    try {
      const name = Media.newName(ext);
      let body, stanza;
      if (encrypt) {
        await omemoReady;
        if (c !== conn) return;
        if (!omemo?.ready) throw new Error('Encryption is unavailable' + (omemoError ? ': ' + omemoError : '') + '.');
        const { ct, secret } = await Media.encrypt(local);
        body = Media.toLink(await Media.upload(stanza => iqP(c, stanza), uploadSvc, name, ct), secret);
        const r = await omemo.encrypt(jid, body);
        stanza = r.stanza;
        noteSkipped(jid, r.skipped);
      } else {
        body = await Media.upload(stanza => iqP(c, stanza), uploadSvc, name, local);
        stanza = $msg({ to: jid, type: 'chat' }).c('body').t(body).up().c('x', { xmlns: 'jabber:x:oob' }).c('url').t(body).up().up();
      }
      if (c !== conn) return;
      c.send(stanza);
      row.classList.remove('pending');
      updatePreview(jid, mediaPreview(body), false);
      recordMessage(jid, { dir: 'out', kind: 'media', text: body, ts, enc: encrypt, untrusted: false });
    } catch (e) {
      if (c !== conn) return;
      row.classList.remove('pending');
      row.classList.add('failed');
      (row.querySelector('.msg-main') || row).appendChild(el('div', 'msg-failed', 'Not sent: ' + e.message));
    }
  });
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

function profilePictureSection() {
  const s = section('Profile picture');
  const row = el('div', 'profile-row');
  row.appendChild(avatar(myJid));
  const side = el('div', 'profile-side');
  side.appendChild(el('p', 'muted', 'Your contacts see this picture.'));
  const actions = el('div', 'device-actions');
  const file = el('input');
  file.type = 'file';
  file.accept = AVATAR_TYPES.join(',');
  file.hidden = true;
  const status = el('p', 'muted');
  const run = async (f) => {
    status.textContent = f ? 'Uploading…' : 'Removing…';
    try {
      await setOwnAvatar(f);
      status.textContent = '';
      renderModal();
    } catch (e) {
      status.textContent = 'That didn\'t work: ' + (e?.message || 'the server refused it') + '.';
    }
  };
  file.onchange = () => { if (file.files[0]) run(file.files[0]); };
  const change = el('button', 'btn', avatars[myJid] ? 'Change picture…' : 'Choose picture…');
  change.onclick = () => file.click();
  actions.append(change, file);
  if (avatars[myJid]) {
    const remove = el('button', 'btn danger', 'Remove');
    remove.onclick = () => run(null);
    actions.appendChild(remove);
  }
  side.append(actions, status);
  row.appendChild(side);
  s.appendChild(row);
  return s;
}

function renderSettings(body, token) {
  document.getElementById('modal-title').textContent = 'Settings';

  body.appendChild(nameSection());
  body.appendChild(statusSection());
  body.appendChild(profilePictureSection());
  body.appendChild(historySection());

  const theme = section('Theme');
  const row = el('div', 'device-actions');
  const sel = el('select', 'theme-select');
  sel.append(new Option('WeChat', 'wechat'), new Option('Retro (Windows 2000)', 'retro'));
  sel.value = document.documentElement.dataset.theme;
  sel.onchange = () => setTheme(sel.value);
  const mode = el('select', 'mode-select');
  mode.append(new Option('Automatic (follow system)', 'auto'), new Option('Light', 'light'), new Option('Dark', 'dark'));
  mode.value = document.documentElement.dataset.mode;
  mode.onchange = () => setMode(mode.value);
  mode.setAttribute('aria-label', 'Light or dark');
  sel.onchange = () => { setTheme(sel.value); renderModal(); };
  row.append(sel, mode);
  theme.appendChild(row);
  if (document.documentElement.dataset.theme === 'retro') {
    const saverRow = el('div', 'device-actions saver-row');
    const label = el('label', null, 'Screen saver:');
    const pick = el('select', 'saver-select');
    pick.id = 'sel-saver';
    label.htmlFor = pick.id;
    pick.append(new Option('woofr.chat logo', 'logo'), new Option('(None)', 'none'));
    pick.value = saverEnabled() ? 'logo' : 'none';
    pick.onchange = () => { setSaverEnabled(pick.value !== 'none'); preview.disabled = pick.value === 'none'; };
    const preview = el('button', 'btn', 'Preview');
    preview.disabled = !saverEnabled();
    preview.onclick = previewScreensaver;
    saverRow.append(label, pick, preview);
    theme.append(saverRow, el('p', 'muted', 'Shown when the session locks after ' + (LOCK_AFTER_MS / 60_000) + ' minutes idle.'));
  }
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
      'Your encryption keys and message history stay in this browser (encrypted with your password). ' +
      'Remove them if other people use this computer.'));
    const btn = el('button', 'btn danger', 'Remove this device\'s keys and history');
    btn.onclick = forgetThisDevice;
    const row = el('div', 'device-actions');
    row.appendChild(btn);
    forget.appendChild(row);
    body.appendChild(forget);
  }

  body.appendChild(aboutSection());
}

// Renaming is a roster update, so it syncs across your own devices and
// nobody else sees it. The roster item is resent whole, groups included.
function setLocalName(jid, name) {
  const b = buddies[jid];
  name = cleanName(name);
  const item = { jid };
  if (name) item.name = name;
  const q = $iq({ type: 'set' }).c('query', { xmlns: Strophe.NS.ROSTER }).c('item', item);
  (b.groups || []).forEach(g => q.c('group').t(g).up());
  return iqP(conn, q);
}

function contactSection(jid) {
  const b = buddies[jid] || {};
  const s = section('Name');
  s.append(el('p', 'muted', 'Address'), el('div', 'fingerprint', jid));
  if (b.theirs) s.append(el('p', 'muted', 'They call themselves'), el('div', null, b.theirs));
  if (!b.inRoster) {
    s.appendChild(el('p', 'muted', 'Add them as a contact to give them a nickname.'));
    return s;
  }
  s.appendChild(el('p', 'muted', 'Your nickname for them'));
  const row = el('div', 'device-actions');
  const text = el('input', 'status-input');
  text.type = 'text';
  text.maxLength = NAME_MAX;
  text.placeholder = b.theirs || jid.split('@')[0];
  text.value = b.local || '';
  text.spellcheck = false;
  text.setAttribute('aria-label', 'Your nickname for this contact');
  const save = el('button', 'btn primary', 'Save');
  const reset = el('button', 'btn', 'Use their name');
  const note = el('span', 'muted');
  const apply = async value => {
    note.textContent = 'Saving…';
    try { await setLocalName(jid, value); note.textContent = 'Saved.'; }
    catch (e) { note.textContent = 'That didn\'t work: ' + (e?.message || 'the server refused it') + '.'; }
  };
  save.onclick = () => apply(text.value);
  reset.onclick = () => { text.value = ''; apply(''); };
  text.onkeydown = e => { if (e.key === 'Enter') apply(text.value); };
  row.append(text, save, reset, note);
  s.append(row, el('p', 'muted', 'Only you see this, on all your devices. They aren\'t told.'));
  return s;
}

function renderContactSecurity(body, jid, token) {
  document.getElementById('modal-title').textContent = displayName(jid);
  body.appendChild(contactSection(jid));
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
      'This device\'s key changed. Messages to and from it are blocked. Only accept the new key if ' +
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
  if (!confirm('Remove this device\'s encryption keys and message history?\n\n' +
    'The history saved on this computer is deleted, encrypted messages sent to this device can no longer be ' +
    'read here, and you\'ll get a new fingerprint the next time you sign in on this computer.')) return;
  const c = conn;
  try {
    if (historyStore) await historyStore.clear();
    historyStore = null;
    history = new Map();
    sessionVault = null;
    clearInterval(expiryTimer);
    refreshExpiryLabels();
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

// ── New version notice ────────────────────────────────────────────────────
// A tab keeps running the code it loaded, even after a deploy. Every few
// minutes (and when the tab comes back to the foreground) the app re-fetches
// its own files and compares a hash with the copy it started with; if they
// differ, a banner offers a reload. It never reloads by itself: that would
// sign the user out mid-conversation.
const VERSION_FILES    = ['index.html', 'app.js', 'omemo.js', 'history.js', 'media.js', 'richtext.js', 'styles.css'];
const VERSION_CHECK_MS = 5 * 60_000;
let versionBaseline = null;
let versionTimer    = null;

async function currentVersion() {
  const parts = await Promise.all(VERSION_FILES.map(async f => {
    const r = await fetch(f, { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error(f + ' ' + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach(p => { all.set(p, at); at += p.length; });
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkVersion() {
  try {
    const v = await currentVersion();
    if (!versionBaseline) versionBaseline = v;
    else if (v !== versionBaseline) {
      document.getElementById('update-banner').hidden = false;
      clearInterval(versionTimer);
    }
  } catch { /* offline, or mid-deploy: try again later */ }
}

function startVersionCheck() {
  checkVersion();
  versionTimer = setInterval(checkVersion, VERSION_CHECK_MS);
}

// ── Screen saver (retro theme) ───────────────────────────────────────────
// The bouncing logo of a 2000s DVD player. It runs while the session is
// locked — any key or click brings back the unlock prompt, and it comes back
// after a minute of nothing — or as a preview from Settings. It only draws
// the logo; behind it there's nothing but the lock screen (or, for a preview,
// the app you were already looking at).
const SAVER_KEY       = 'woofr.screensaver'; // 'logo' | 'none' — not PHI
const SAVER_RETURN_MS = 60_000;
const SAVER_SPEED     = 110; // px per second
const SAVER_COLORS    = ['#ff6600', '#00b7ff', '#ff2bd6', '#7cff3a', '#ffe500', '#a066ff', '#ff3b3b', '#ffffff'];

let saver = null;            // { x, y, dx, dy, last, color, moved, raf } while it's showing
let saverReturnTimer = null;

function saverEnabled() {
  try { return localStorage.getItem(SAVER_KEY) !== 'none'; } catch { return true; }
}

function setSaverEnabled(on) {
  try { localStorage.setItem(SAVER_KEY, on ? 'logo' : 'none'); } catch { /* just don't remember it */ }
}

function startScreensaver() {
  if (saver) return;
  const box  = document.getElementById('screensaver');
  const logo = box.querySelector('.dvd-logo');
  box.hidden = false;
  const maxX = () => Math.max(0, box.clientWidth - logo.offsetWidth);
  const maxY = () => Math.max(0, box.clientHeight - logo.offsetHeight);
  const s = saver = {
    x: Math.random() * maxX(), y: Math.random() * maxY(),
    dx: Math.random() < 0.5 ? 1 : -1, dy: Math.random() < 0.5 ? 1 : -1,
    last: 0, color: 0, moved: 0, raf: 0,
  };
  const paint = () => {
    logo.style.transform = `translate(${s.x}px, ${s.y}px)`; // CSSOM — fine under the CSP
    logo.style.color = SAVER_COLORS[s.color];
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    s.x = maxX() / 2; s.y = maxY() / 2;
    paint();
    return;
  }
  const step = t => {
    if (saver !== s) return;
    const dt = s.last ? Math.min((t - s.last) / 1000, 0.1) : 0;
    s.last = t;
    s.x += s.dx * SAVER_SPEED * dt;
    s.y += s.dy * SAVER_SPEED * dt;
    let hits = 0;
    const w = maxX(), h = maxY();
    if (s.x <= 0 || s.x >= w) { s.dx = s.x <= 0 ? 1 : -1; s.x = Math.min(Math.max(s.x, 0), w); hits++; }
    if (s.y <= 0 || s.y >= h) { s.dy = s.y <= 0 ? 1 : -1; s.y = Math.min(Math.max(s.y, 0), h); hits++; }
    if (hits) s.color = (s.color + 1) % SAVER_COLORS.length;
    if (hits === 2) { // the corner!
      logo.classList.remove('corner');
      void logo.offsetWidth;
      logo.classList.add('corner');
    }
    paint();
    s.raf = requestAnimationFrame(step);
  };
  paint();
  s.raf = requestAnimationFrame(step);
}

function stopScreensaver() {
  if (!saver) return;
  cancelAnimationFrame(saver.raf);
  saver = null;
  document.getElementById('screensaver').hidden = true;
}

// Back to the logo if the lock screen is left alone.
function armSaverReturn() {
  clearTimeout(saverReturnTimer);
  if (!locked || document.documentElement.dataset.theme !== 'retro' || !saverEnabled()) return;
  saverReturnTimer = setTimeout(() => {
    if (!locked) return;
    if (document.getElementById('inp-unlock-pass').value) armSaverReturn();
    else startScreensaver();
  }, SAVER_RETURN_MS);
}

function onSaverInput(e) {
  if (!saver) {
    if (locked) armSaverReturn(); // activity on the lock screen
    return;
  }
  if (e.type === 'pointermove') {
    saver.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (saver.moved < 12) return; // a nudged desk isn't a person
  }
  if (e.type === 'keydown') {
    // The key that wakes it up shouldn't land in the password box.
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  stopScreensaver();
  if (locked) {
    document.getElementById('inp-unlock-pass').focus();
    armSaverReturn();
  }
}

function previewScreensaver() {
  closeModal();
  startScreensaver();
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
  idleAway = true;
  if (conn) { sendPresence(conn); renderOwnStatus(); }
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
  if (document.documentElement.dataset.theme === 'retro' && saverEnabled()) startScreensaver();
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
    idleAway = false;
    stopScreensaver();
    clearTimeout(saverReturnTimer);
    if (conn) { sendPresence(conn); renderOwnStatus(); }
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
  stopScreensaver();
  clearTimeout(saverReturnTimer);

  if (omemo) omemo.stop();
  omemo = null; omemoVault = null; omemoReady = null; omemoError = ''; omemoNotices = [];
  notedSkips = new Set();
  inbox = Promise.resolve();

  myJid = ''; buddies = {}; chatWindows = {}; activeChat = null; nudgeTimestamps = {};
  avatars = {}; avatarImages = {}; avatarAsked = new Set(); ownVcardHash = null;
  myShow = ''; myStatusText = ''; idleAway = false; requests = new Set();
  uploadSvc = null; mediaCache = new Map(); mediaUrls.forEach(u => URL.revokeObjectURL(u)); mediaUrls = new Set(); closeLightbox();
  myName = ''; namesAsked = new Set(); nameQueue = Promise.resolve(); sessionVault = null; historyStore = null; history = new Map(); clearInterval(expiryTimer); expiryTimer = null;
  document.getElementById('chat-subtitle').textContent = '';
  document.getElementById('my-dot').className = 'status-dot';
  document.getElementById('btn-my-status').textContent = '[online]';
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

  features = [NS_CAPS, NS_DISCO_INFO, NS_ATTENTION, Omemo.NOTIFY_FEATURE, NS_AVATAR_META + '+notify', NS_NICK + '+notify'].sort();
  capsVer  = computeCapsVer();

  applyTheme(savedTheme());
  applyMode(savedMode());
  document.querySelectorAll('.theme-select').forEach(s => { s.onchange = () => setTheme(s.value); });
  document.querySelectorAll('.mode-select').forEach(s => { s.onchange = () => setMode(s.value); });

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
  document.getElementById('nav-avatar').onclick        = openSettings;
  document.getElementById('btn-my-status').onclick     = openSettings;
  document.getElementById('nav-chats').onclick         = showBuddyPanelMobile;
  document.getElementById('btn-chat-security').onclick = () => openEncryptionDetails(activeChat);
  document.getElementById('mobile-back-btn').onclick   = showBuddyPanelMobile;
  document.getElementById('btn-unlock').onclick        = doUnlock;
  document.getElementById('btn-lock-sign-out').onclick = () => endSession();
  document.getElementById('inp-unlock-pass').onkeydown = e => { if (e.key === 'Enter') doUnlock(); };
  document.getElementById('modal-close').onclick       = closeModal;
  document.getElementById('lightbox').onclick          = closeLightbox;
  document.addEventListener('click', e => { if (kaomojiOpen && !e.target.closest('.kaomoji-menu')) closeKaomoji(); });
  document.getElementById('btn-update').onclick        = () => {
    // Reloading ends the session (everything is wiped), so ask first.
    if (!sessionActive || confirm('Reloading signs you out. Continue?')) location.reload();
  };
  startVersionCheck();
  document.getElementById('modal').onclick             = e => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (kaomojiOpen) closeKaomoji();
    else if (!document.getElementById('lightbox').hidden) closeLightbox();
    else if (modalState) closeModal();
  });

  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(ev =>
    document.addEventListener(ev, noteActivity, { capture: true, passive: true }));
  ['keydown', 'pointerdown', 'pointermove'].forEach(ev =>
    document.addEventListener(ev, onSaverInput, { capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkIdle();
    checkVersion();
    if (activeChat && chatVisible(activeChat)) markRead(activeChat);
  });
}

document.addEventListener('DOMContentLoaded', init);
