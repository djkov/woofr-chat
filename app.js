// woofr.chat client.
//
// This lives in its own file (not inline in index.html) so the CSP can forbid
// inline script entirely. Keep it that way: no inline on*="" handlers, and
// never put untrusted data (JIDs, roster names, message bodies) into innerHTML —
// build nodes and set textContent instead. See HIPAA.md.
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let conn = null;
let myJid = '';
let buddies = {}; // jid -> { name, show }
let chatWindows = {}; // jid -> { tab, win, log, input }
let activeChat = null;
let nudgeTimestamps = {}; // jid -> [ms, ...]
let sessionActive = false;

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
  requestNotifPermission();

  // Bind handlers to this connection: once it's torn down, any stanza still in
  // flight is dropped (and the handler removed) instead of being rendered into
  // a page we've just wiped.
  const live = fn => stanza => c === conn && fn(stanza);

  c.addHandler(live(onMessage),   null, 'message', 'chat');
  c.addHandler(live(onPresence),  null, 'presence');
  c.addHandler(live(onAttention), 'urn:xmpp:attention:0', 'message');

  c.send($pres().tree());
  c.sendIQ(
    $iq({type: 'get'}).c('query', {xmlns: Strophe.NS.ROSTER}),
    live(onRoster)
  );

  startIdleTimer();
  showBuddyList();
}

// ── Roster ─────────────────────────────────────────────────────────────────
function onRoster(iq) {
  iq.querySelectorAll('item').forEach(item => {
    const jid  = item.getAttribute('jid');
    const name = item.getAttribute('name') || jid;
    if (!buddies[bareJid(jid)]) buddies[bareJid(jid)] = { name, show: 'offline' };
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

function renderBuddyList() {
  const ul     = document.getElementById('buddy-list');
  const online  = Object.entries(buddies).filter(([,b]) => b.show !== 'offline');
  const offline = Object.entries(buddies).filter(([,b]) => b.show === 'offline');

  document.getElementById('buddy-count').textContent = online.length + ' online';
  ul.innerHTML = '';

  if (online.length) {
    const gh = document.createElement('li');
    gh.className = 'group-header';
    gh.textContent = '▼ Online (' + online.length + ')';
    ul.appendChild(gh);
    online.forEach(([jid, b]) => ul.appendChild(makeBuddyLi(jid, b)));
  }
  if (offline.length) {
    const gh = document.createElement('li');
    gh.className = 'group-header';
    gh.textContent = '▼ Offline (' + offline.length + ')';
    ul.appendChild(gh);
    offline.forEach(([jid, b]) => ul.appendChild(makeBuddyLi(jid, b)));
  }
}

function makeBuddyLi(jid, b) {
  const li  = document.createElement('li');
  const dot = document.createElement('div');
  dot.className = 'status-dot' + (b.show === 'offline' ? ' offline' : b.show === 'away' ? ' away' : '');
  const name = document.createElement('span');
  name.textContent = b.name || jid;
  li.appendChild(dot);
  li.appendChild(name);
  li.title   = jid;
  li.onclick = () => openChat(jid);
  return li;
}

// ── Messages ───────────────────────────────────────────────────────────────
function hasAttention(msg) {
  return msg.getElementsByTagNameNS('urn:xmpp:attention:0', 'attention').length > 0;
}

function onMessage(msg) {
  const from   = msg.getAttribute('from');
  const bare   = bareJid(from);
  const bodyEl = msg.querySelector('body');
  if (!bodyEl) return true;
  if (hasAttention(msg)) return true; // handled by onAttention
  if (!chatWindows[bare]) createChatWindow(bare);
  appendMsg(bare, bare, bodyEl.textContent, 'them');
  return true;
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
  setTimeout(() => chatWindows[jid]?.input.focus(), isMobileLayout() ? 300 : 50);
}

function createChatWindow(jid) {
  const tabs = document.getElementById('chat-tabs');
  const wins = document.getElementById('chat-windows');

  const tab = el('button', 'chat-tab', shortName(jid));
  const closeBtn = el('span', 'close-tab', '✕');
  closeBtn.onclick = e => closeChat(jid, e);
  tab.appendChild(closeBtn);
  tab.onclick = () => switchTab(jid);
  tabs.appendChild(tab);

  // Static markup only. Each window keeps direct references to its own
  // elements (rather than looking them up by an id derived from the JID, which
  // let e.g. a.b@x and a_b@x collide and send text to the wrong person).
  const win = el('div', 'chat-window');
  win.innerHTML = `
    <div class="chat-log"></div>
    <div class="chat-input-area">
      <div class="chat-toolbar">
        <button data-fmt="**"><b>B</b></button>
        <button data-fmt="_"><i>I</i></button>
        <button style="font-size:13px;" title="Smiley">:)</button>
        <span style="flex:1"></span>
        <button class="nudge-btn" title="Send Nudge (XEP-0224)">&#128293; Nudge!</button>
        <button class="priority-send-btn" title="Priority Message">&#9888; Priority</button>
      </div>
      <div class="chat-input-row">
        <textarea class="chat-input" spellcheck="false" autocomplete="off"></textarea>
        <div class="send-col">
          <button class="btn primary send-btn">Send</button>
          <button class="btn clear-btn">Clear</button>
        </div>
      </div>
    </div>`;

  const log   = win.querySelector('.chat-log');
  const input = win.querySelector('.chat-input');
  input.placeholder = 'Send a message to ' + jid + '…';
  input.onkeydown   = e => chatKey(e, jid);
  win.querySelectorAll('[data-fmt]').forEach(b => { b.onclick = () => fmtWrap(input, b.dataset.fmt); });
  win.querySelector('.nudge-btn').onclick         = () => sendNudge(jid);
  win.querySelector('.priority-send-btn').onclick = () => sendPriorityMsg(jid);
  win.querySelector('.send-btn').onclick          = () => sendMsg(jid);
  win.querySelector('.clear-btn').onclick         = () => { input.value = ''; };
  wins.appendChild(win);

  chatWindows[jid] = { tab, win, log, input };
  appendMsg(jid, null, 'Conversation with ' + jid + ' started at ' + now(), 'system');

  // Show tabs, hide placeholder on first chat
  tabs.style.display = '';
  document.getElementById('chat-placeholder').style.display = 'none';

  switchTab(jid);
}

function switchTab(jid) {
  if (activeChat) {
    chatWindows[activeChat]?.tab.classList.remove('active');
    chatWindows[activeChat]?.win.classList.remove('active');
  }
  activeChat = jid;
  chatWindows[jid].tab.classList.add('active');
  chatWindows[jid].win.classList.add('active');
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
      document.getElementById('chat-tabs').style.display = 'none';
      document.getElementById('chat-placeholder').style.display = '';
      document.getElementById('app-layout').classList.remove('mobile-chat-open');
    }
  }
}

function appendMsg(jid, from, text, type) {
  const log = chatWindows[jid]?.log;
  if (!log) return;
  const row = document.createElement('div');
  if (type === 'system') {
    row.className   = 'msg-system';
    row.textContent = text;
  } else if (type === 'nudge') {
    row.className   = 'msg-nudge';
    row.textContent = text;
  } else if (type === 'nudge-error') {
    row.className   = 'msg-nudge-error';
    row.textContent = text;
  } else {
    row.className = type === 'me' ? 'msg-me' : 'msg-them';
    const nick = type === 'me' ? myJid : (buddies[from]?.name || from);
    row.append(el('span', 'msg-time', '[' + now() + ']'), ' ', el('span', 'nick', nick + ':'), ' ', text);
  }
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function sendMsg(jid) {
  const ta   = chatWindows[jid]?.input;
  const text = ta?.value.trim();
  if (!text || !conn) return;
  conn.send($msg({to: jid, type: 'chat'}).c('body').t(text));
  appendMsg(jid, myJid, text, 'me');
  ta.value = '';
  ta.focus();
}

function chatKey(e, jid) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMsg(jid);
  }
}

// ── Priority Message ──────────────────────────────────────────────────────
let alertInterval = null;

function makePriorityRow(fromName, text) {
  const row    = el('div', 'msg-priority');
  const header = el('div', 'priority-header');
  header.append(el('span', null, '⚠ Priority Message (!):'), el('span', 'msg-time', '[' + now() + '] ' + fromName));
  row.append(header, el('div', 'priority-body', text));
  return row;
}

function sendPriorityMsg(jid) {
  const chat = chatWindows[jid];
  const ta   = chat?.input;
  const text = ta?.value.trim();
  if (!text || !conn) return;
  conn.send(
    $msg({to: jid, type: 'chat'})
      .c('body').t(text).up()
      .c('attention', {xmlns: 'urn:xmpp:attention:0'})
  );
  chat.log.appendChild(makePriorityRow(myJid, text));
  chat.log.scrollTop = chat.log.scrollHeight;
  ta.value = '';
  ta.focus();
}

function appendPriorityMsg(jid, fromName, text) {
  const log = chatWindows[jid]?.log;
  if (!log) return;
  const row = makePriorityRow(fromName, text);
  const ack = el('div', 'priority-ack');
  const btn = el('button', 'priority-ack-btn', '✓ Mark as Read');
  btn.onclick = () => ackPriority(row, btn);
  ack.appendChild(btn);
  row.appendChild(ack);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function ackPriority(row, btn) {
  btn.textContent = '✓ Read';
  btn.disabled    = true;
  row.style.borderColor = '#888';
  row.style.background  = '#f5f5f5';
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
  conn.send($msg({to: jid, type: 'chat'}).c('attention', {xmlns: 'urn:xmpp:attention:0'}));
  appendMsg(jid, null, '*** You sent a nudge to ' + shortName(jid) + ' ***', 'nudge');
  shakeWindow();
}

function onAttention(msg) {
  const from   = bareJid(msg.getAttribute('from'));
  const bodyEl = msg.querySelector('body');
  if (!chatWindows[from]) createChatWindow(from);
  const name = buddies[from]?.name || from;
  if (bodyEl) {
    appendPriorityMsg(from, name, bodyEl.textContent);
    startAlertLoop();
    notify('You have a new priority message.', { persist: true, tag: 'priority' });
  } else {
    appendMsg(from, null, '*** ' + name + ' sent you a nudge! ***', 'nudge');
    playNudgeSound();
    notify('Someone sent you a nudge.', { tag: 'nudge' });
  }
  shakeWindow();
  return true;
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
  document.getElementById('app-layout').style.display = 'none';
  document.getElementById('lock-panel').style.display = '';
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
    document.getElementById('lock-panel').style.display = 'none';
    document.getElementById('app-layout').style.display = 'flex';
    setStatus('Connected!', 'ok');
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

  myJid = ''; buddies = {}; chatWindows = {}; activeChat = null; nudgeTimestamps = {};
  document.getElementById('chat-tabs').replaceChildren();
  document.getElementById('chat-windows').replaceChildren();
  document.getElementById('buddy-list').replaceChildren();
  document.getElementById('buddy-count').textContent    = '0 online';
  document.getElementById('my-jid-display').textContent = '';
  document.getElementById('lock-jid').textContent       = '';
  document.getElementById('lock-error').textContent     = '';
  ['inp-pass', 'inp-unlock-pass', 'inp-add-buddy'].forEach(id => { document.getElementById(id).value = ''; });

  showLogin();
  setStatus(reason, type);

  // Deferred so that ending the session from inside one of Strophe's own status
  // callbacks (e.g. CONNFAIL) doesn't re-enter its teardown mid-flight.
  if (c) setTimeout(() => c.disconnect(), 0);
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showBuddyList() {
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('app-layout').style.display  = 'flex';
}

function showLogin() {
  document.getElementById('login-panel').style.display = '';
  document.getElementById('app-layout').style.display  = 'none';
  document.getElementById('lock-panel').style.display  = 'none';
  document.getElementById('app-layout').classList.remove('mobile-chat-open');
  document.getElementById('chat-tabs').style.display = 'none';
  document.getElementById('chat-placeholder').style.display = '';
  document.getElementById('btn-login').disabled = !window.isSecureContext;
}

function shortName(jid) {
  return (buddies[bareJid(jid)]?.name || jid).split('@')[0];
}

// ── Startup ────────────────────────────────────────────────────────────────
function init() {
  // PHI must never cross plain HTTP. HSTS covers repeat visits; this catches a
  // first visit or a misconfigured proxy. (localhost counts as secure for dev.)
  if (!window.isSecureContext) {
    document.getElementById('insecure-warning').style.display = '';
    document.getElementById('btn-login').disabled = true;
  }

  document.getElementById('btn-login').onclick         = doLogin;
  document.getElementById('btn-cancel').onclick        = doCancel;
  document.getElementById('inp-pass').onkeydown        = e => { if (e.key === 'Enter') doLogin(); };
  document.getElementById('btn-add-buddy').onclick     = addBuddy;
  document.getElementById('btn-sign-out').onclick      = doSignOut;
  document.getElementById('mobile-back-btn').onclick   = showBuddyPanelMobile;
  document.getElementById('btn-unlock').onclick        = doUnlock;
  document.getElementById('btn-lock-sign-out').onclick = () => endSession();
  document.getElementById('inp-unlock-pass').onkeydown = e => { if (e.key === 'Enter') doUnlock(); };

  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach(ev =>
    document.addEventListener(ev, noteActivity, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });
}

init();
