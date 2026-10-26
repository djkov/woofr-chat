// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jacob Kuznetsov

// Sending and receiving files (images, audio, video, anything else).
//
// Files go through the server's HTTP File Upload service (XEP-0363), and are
// encrypted first, the way Conversations, Dino and Gajim do it: AES-256-GCM
// in the browser, the ciphertext uploaded, and an `aesgcm://host/path#<iv><key>`
// link sent as the (OMEMO-encrypted) message body. The server only ever sees
// ciphertext; the key travels inside the end-to-end encrypted message.
'use strict';

const Media = (() => {
  const NS_UPLOAD   = 'urn:xmpp:http:upload:0';
  const NS_DISCO    = 'http://jabber.org/protocol/disco';
  const MAX_BYTES   = 25 * 1024 * 1024; // our own ceiling, whatever the server allows
  const IMAGE_MAX_PX = 2560;

  // What we'll show inline, by extension. The type of the Blob we build is
  // always taken from here — never from anything the sender claims — so a
  // file can't pretend to be something it isn't.
  const TYPES = {
    jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], png: ['image', 'image/png'],
    gif: ['image', 'image/gif'],  webp: ['image', 'image/webp'],
    mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'],  aac: ['audio', 'audio/aac'],
    ogg: ['audio', 'audio/ogg'],  oga: ['audio', 'audio/ogg'],  opus: ['audio', 'audio/ogg; codecs=opus'],
    wav: ['audio', 'audio/wav'],  weba: ['audio', 'audio/webm'],
    mp4: ['video', 'video/mp4'],  m4v: ['video', 'video/mp4'],  mov: ['video', 'video/quicktime'],
    webm: ['video', 'video/webm'], ogv: ['video', 'video/ogg'],
  };

  function extOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function kindOf(ext) { return (TYPES[ext] || ['file'])[0]; }
  function mimeOf(ext) { return (TYPES[ext] || [])[1] || 'application/octet-stream'; }

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  function unhex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  // Local dev servers are plain http; everywhere else https only.
  function schemeFor(host) {
    const name = host.replace(/:\d+$/, '');
    const localPage = ['localhost', '127.0.0.1'].includes(location.hostname);
    return localPage && ['localhost', '127.0.0.1'].includes(name) ? 'http' : 'https';
  }

  // "aesgcm://host/path.ext#<iv hex><key hex>" -> what we need to fetch and
  // decrypt it, or null. The IV is 12 bytes (16 in old clients), the key 32.
  function parseLink(text) {
    const m = /^aesgcm:\/\/([^\s/#?]+)(\/[^\s#?]*)#([0-9a-f]+)$/i.exec((text || '').trim());
    if (!m || ![88, 96].includes(m[3].length)) return null;
    const ivLen = m[3].length / 2 - 32;
    const raw = unhex(m[3]);
    return {
      host: m[1], path: m[2],
      url: schemeFor(m[1]) + '://' + m[1] + m[2],
      iv: raw.slice(0, ivLen), key: raw.slice(ivLen),
      name: decodeURIComponent(m[2].split('/').pop() || 'file').slice(-80),
      ext: extOf(m[2]),
    };
  }

  // A plain link to a file on our own server (what unencrypted chats use).
  function parsePlain(text) {
    let u;
    try { u = new URL((text || '').trim()); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || u.search || u.hash || u.username || u.password) return null;
    if (u.protocol === 'http:' && schemeFor(u.host) !== 'http') return null;
    return { host: u.host, path: u.pathname, url: u.href, iv: null, key: null,
             name: decodeURIComponent(u.pathname.split('/').pop() || 'file').slice(-80), ext: extOf(u.pathname) };
  }

  // Only our own server's files are fetched: the sender controls the link,
  // and fetching an address they chose would tell them when and from where
  // you opened the message.
  function hostAllowed(host, domain) {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    return name === domain || name.endsWith('.' + domain);
  }

  async function encrypt(bytes) {
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes); // tag appended
    return { ct: new Uint8Array(ct), secret: hex(iv) + hex(raw) };
  }

  async function download(link, limit) {
    const res = await fetch(link.url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(res.status === 404 ? 'it\'s no longer on the server' : 'the server answered ' + res.status);
    const size = +res.headers.get('content-length') || 0;
    if (size > limit + 16) throw new Error('it\'s too large');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > limit + 16) throw new Error('it\'s too large');
    if (!link.key) return buf;
    try {
      const key = await crypto.subtle.importKey('raw', link.key, 'AES-GCM', false, ['decrypt']);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: link.iv }, key, buf));
    } catch {
      throw new Error('it failed the integrity check');
    }
  }

  // Redraws a photo, which drops EXIF (location, camera, time) and shrinks
  // big ones. Animated GIFs and unknown formats are sent as they are.
  async function prepareImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return { blob: file, ext: extOf(file.name) };
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { return { blob: file, ext: extOf(file.name) }; }
    try {
      const scale = Math.min(1, IMAGE_MAX_PX / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const png = file.type !== 'image/jpeg';
      const blob = await new Promise(r => canvas.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.9));
      return blob ? { blob, ext: png ? 'png' : 'jpg' } : { blob: file, ext: extOf(file.name) };
    } finally {
      bmp.close();
    }
  }

  // The server's upload service and its size limit, if it has one.
  async function discover(iq, domain) {
    const items = await iq($iq({ type: 'get', to: domain }).c('query', { xmlns: NS_DISCO + '#items' }));
    for (const item of items.getElementsByTagName('item')) {
      const jid = item.getAttribute('jid');
      if (!jid) continue;
      let info;
      try { info = await iq($iq({ type: 'get', to: jid }).c('query', { xmlns: NS_DISCO + '#info' })); } catch { continue; }
      const features = [...info.getElementsByTagName('feature')].map(f => f.getAttribute('var'));
      if (!features.includes(NS_UPLOAD)) continue;
      let max = MAX_BYTES;
      for (const field of info.getElementsByTagName('field')) {
        if (field.getAttribute('var') === 'max-file-size') {
          const n = +field.getElementsByTagName('value')[0]?.textContent;
          if (n > 0) max = Math.min(max, n);
        }
      }
      return { jid, max };
    }
    return null;
  }

  // Uploads bytes and resolves to the file's address on the server.
  async function upload(iq, svc, name, bytes) {
    const slot = await iq($iq({ type: 'get', to: svc.jid }).c('request',
      { xmlns: NS_UPLOAD, filename: name, size: bytes.length, 'content-type': 'application/octet-stream' }));
    const put = slot.getElementsByTagName('put')[0], get = slot.getElementsByTagName('get')[0];
    const putUrl = put?.getAttribute('url'), getUrl = get?.getAttribute('url');
    if (!putUrl || !getUrl) throw new Error('the server didn\'t offer an upload slot');
    // Only these headers may be forwarded (the XEP's list); anything else is ignored.
    const headers = { 'Content-Type': 'application/octet-stream' };
    for (const h of put.getElementsByTagName('header')) {
      const n = h.getAttribute('name');
      if (/^(authorization|cookie|expires)$/i.test(n)) headers[n] = h.textContent.replace(/[\r\n]/g, '');
    }
    const res = await fetch(putUrl, { method: 'PUT', headers, body: bytes, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('the server refused the upload (' + res.status + ')');
    return getUrl;
  }

  // "https://host/path" -> "aesgcm://host/path#secret"
  const toLink = (getUrl, secret) => getUrl.replace(/^https?:\/\//, 'aesgcm://') + '#' + secret;

  function newName(ext) {
    const id = crypto.randomUUID().toUpperCase();
    return ext ? id + '.' + ext : id;
  }

  return { MAX_BYTES, TYPES, extOf, kindOf, mimeOf, parseLink, parsePlain, hostAllowed,
           encrypt, download, prepareImage, discover, upload, toLink, newName };
})();
