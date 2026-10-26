// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jacob Kuznetsov

// Message formatting: a small, safe subset of Markdown, plus quote threads.
//
//   **bold**  *italic*  _italic_  ~~strike~~  `code`  [text](https://link)
//   ```            fenced code block
//   # Heading           headings (# to ######)
//   | a | b |          tables, with a |---|---| line under the header
//   - item / 1. item   lists
//   > quoted           quotes nest: >> a reply to a quote, >>> and so on
//   \*             a backslash shows the next symbol literally
//
// Everything is built as DOM nodes with textContent — no innerHTML, ever — so
// a message can't inject markup. Links must be http(s). The raw text is what
// gets sent, stored and quoted, so other clients just see readable text.
'use strict';

const Rich = (() => {
  const MAX_SPAN  = 400;   // longest emphasis/code/link run, so odd input can't make matching slow
  const MAX_DEPTH = 6;     // how deep quotes nest on screen
  const MAX_QUOTE_LINES = 12;

  const URL_RE = String.raw`https?:\/\/[^\s<>()\[\]]{1,500}`;
  // One alternation, earliest match wins. Groups: 1 escape, 2 code, 3 link text, 4 link url,
  // 5 bold, 6 strike, 7 italic (*), 8 italic (_), 9 bare url.
  const INLINE = new RegExp(
    String.raw`(?<!¯)\\([\\\x60*_~>\[\]#\-.!])` +
    String.raw`|\x60([^\x60\n]{1,${MAX_SPAN}})\x60` +
    String.raw`|\[([^\[\]\n]{1,${MAX_SPAN}})\]\((${URL_RE})\)` +
    String.raw`|\*\*(?=\S)([^\n]{1,${MAX_SPAN}}?)(?<=\S)\*\*` +
    String.raw`|~~(?=\S)([^\n]{1,${MAX_SPAN}}?)(?<=\S)~~` +
    // Single * and _ only start emphasis after a space or an opening bracket, and
    // wrap something that starts with a letter or digit, so kaomoji such as
    // (^_^) and (*^‿^*) stay as typed.
    String.raw`|(?<![^\s(\[{>"'])\*(?=[\p{L}\p{N}])([^\n*]{1,${MAX_SPAN}}?)(?<=[\p{L}\p{N}.,!?)"'])\*(?![\p{L}\p{N}*])` +
    String.raw`|(?<![^\s(\[{>"'])_(?=[\p{L}\p{N}])([^\n_]{1,${MAX_SPAN}}?)(?<=[\p{L}\p{N}.,!?)"'])_(?![\p{L}\p{N}_])` +
    String.raw`|(${URL_RE})`, 'gu');

  function mk(tag, text) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    return e;
  }

  function safeUrl(u) {
    try {
      const url = new URL(u);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function link(label, url) {
    const a = mk('a');
    a.href = url.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.title = url.href;
    return a;
  }

  // Trailing punctuation belongs to the sentence, not the address.
  function trimUrl(raw) {
    const m = /[.,;:!?'"]+$/.exec(raw);
    return m ? [raw.slice(0, -m[0].length), m[0]] : [raw, ''];
  }

  function inline(text, parent) {
    let last = 0;
    // matchAll scans with its own copy of the pattern, so the nested calls
    // below can't disturb this level's position.
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) parent.append(m[1]);
      else if (m[2] != null) parent.appendChild(mk('code', m[2]));
      else if (m[3] != null) {
        const url = safeUrl(m[4]);
        if (!url) parent.append(m[0]);
        else {
          const a = link(m[3], url);
          a.textContent = m[3];
          // The label can say anything, so show where it really goes.
          if (!/^https?:/i.test(m[3])) a.append(' (' + url.host + ')');
          parent.appendChild(a);
        }
      } else if (m[5] != null) { const b = mk('strong'); inline(m[5], b); parent.appendChild(b); }
      else if (m[6] != null) { const s = mk('del'); inline(m[6], s); parent.appendChild(s); }
      else if (m[7] != null || m[8] != null) { const i = mk('em'); inline(m[7] ?? m[8], i); parent.appendChild(i); }
      else if (m[9] != null) {
        const [raw, tail] = trimUrl(m[9]);
        const url = safeUrl(raw);
        if (!url) parent.append(m[9]);
        else { const a = link(raw, url); a.textContent = raw; parent.appendChild(a); if (tail) parent.append(tail); }
      }
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  // ── Tables (| a | b | with a |---|---| line under the header) ──
  const MAX_ROWS = 100, MAX_COLS = 10;
  const SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  // Splits a row on | (not inside `code`, and not when written \|).
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '', tick = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
      else if (c === '`') { tick = !tick; cur += c; }
      else if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function isTableStart(lines, i) {
    return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && SEPARATOR.test(lines[i + 1]) &&
      splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
  }

  // Builds the table and returns how many lines it used.
  function table(lines, i, root) {
    const head = splitRow(lines[i]).slice(0, MAX_COLS);
    const align = splitRow(lines[i + 1]).slice(0, MAX_COLS).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
    const wrap = mk('div'); wrap.className = 'md-table-wrap';
    const t = mk('table'), thead = mk('thead'), tbody = mk('tbody');
    const row = (cells, tag, parent) => {
      const tr = mk('tr');
      head.forEach((_, c) => {
        const cell = mk(tag);
        if (align[c]) cell.className = 'align-' + align[c];
        inline(cells[c] ?? '', cell);
        tr.appendChild(cell);
      });
      parent.appendChild(tr);
    };
    row(head, 'th', thead);
    let j = i + 2;
    for (; j < lines.length && lines[j].trim() && lines[j].includes('|') && j - i - 2 < MAX_ROWS; j++) row(splitRow(lines[j]), 'td', tbody);
    while (j < lines.length && lines[j].trim() && lines[j].includes('|')) j++; // rows past the cap are dropped
    t.append(thead, tbody);
    wrap.appendChild(t);
    root.appendChild(wrap);
    return j - i;
  }

  const QUOTE = /^((?:>[ \t]?)+)(.*)$/;
  const BULLET = /^[ \t]{0,3}[-*+][ \t]+(.*)$/;
  const NUMBER = /^[ \t]{0,3}(\d{1,3})[.)][ \t]+(.*)$/;

  // text -> { node, blocks } where `blocks` says there's quote/code/list
  // structure (so the bubble can lay itself out as blocks).
  function render(text) {
    const root = document.createDocumentFragment();
    const lines = String(text).split('\n');
    let blocks = false;
    let quotes = [];           // stack of open <blockquote>s
    let list = null;           // open <ul>/<ol>
    let fence = null;          // open code block lines
    let para = null;           // the current run of plain lines
    let paraLines = 0;

    const closeList = () => { list = null; };
    const closePara = () => { para = null; paraLines = 0; };
    const container = () => quotes.length ? quotes[quotes.length - 1] : root;
    const closeAll = () => { quotes = []; closeList(); closePara(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (fence) {
        if (/^```\s*$/.test(line)) { const pre = mk('pre'); pre.appendChild(mk('code', fence.join('\n'))); container().appendChild(pre); fence = null; }
        else fence.push(line);
        continue;
      }
      if (/^```[\w+-]*\s*$/.test(line) && lines.slice(i + 1).some(l => /^```\s*$/.test(l))) {
        closeList(); closePara(); fence = []; blocks = true; continue;
      }

      const q = QUOTE.exec(line);
      if (q) {
        const depth = Math.min((q[1].match(/>/g) || []).length, MAX_DEPTH);
        closeList();
        if (quotes.length !== depth) closePara();
        while (quotes.length > depth) quotes.pop();
        while (quotes.length < depth) {
          const bq = mk('blockquote');
          bq.dataset.depth = quotes.length + 1;
          container().appendChild(bq);
          quotes.push(bq);
        }
        blocks = true;
        if (para && para.parentNode === container() && paraLines) para.append(document.createElement('br'));
        else { para = mk('div'); container().appendChild(para); paraLines = 0; }
        inline(q[2], para); paraLines++;
        continue;
      }

      if (quotes.length) { quotes = []; closePara(); }

      const h = /^[ \t]{0,3}(#{1,6})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (h) {
        closeList(); closePara();
        const head = mk('div');
        head.className = 'md-h md-h' + Math.min(h[1].length, 3);
        inline(h[2], head);
        root.appendChild(head);
        blocks = true;
        continue;
      }

      if (isTableStart(lines, i)) {
        closeList(); closePara();
        i += table(lines, i, root) - 1;
        blocks = true;
        continue;
      }

      const b = BULLET.exec(line), n = NUMBER.exec(line);
      if (b || n) {
        closePara();
        const tag = b ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) { list = mk(tag); if (n) list.start = +n[1]; root.appendChild(list); }
        const li = mk('li'); inline(b ? b[1] : n[2], li); list.appendChild(li);
        blocks = true;
        continue;
      }
      closeList();

      if (!line.trim()) { closePara(); if (blocks) root.appendChild(document.createElement('br')); else root.append('\n'); continue; }
      if (blocks) {
        if (para && para.parentNode === root && paraLines) para.append(document.createElement('br'));
        else { para = mk('div'); root.appendChild(para); paraLines = 0; }
        inline(line, para); paraLines++;
      } else {
        if (i > 0) root.append('\n');
        inline(line, root);
      }
    }
    if (fence) { const pre = mk('pre'); pre.appendChild(mk('code', fence.join('\n'))); container().appendChild(pre); }
    return { node: root, blocks };
  }

  // Quoting a message for a reply: every line gets one more ">" (and a space
  // after the first), so quotes of quotes nest: "> hey" becomes ">> hey".
  function quote(text) {
    let lines = String(text).replace(/\n+$/, '').split('\n');
    let cut = false;
    if (lines.length > MAX_QUOTE_LINES) { lines = lines.slice(-MAX_QUOTE_LINES); cut = true; }
    const out = lines.map(l => (/^>/.test(l) ? '>' : '> ') + l);
    return (cut ? ['> …'] : []).concat(out).join('\n') + '\n';
  }

  // What to show in a one-line preview: no quote arrows or markup characters.
  function plain(text) {
    const lines = String(text).split('\n').map(l => l.replace(/^[>\s]+/, '').trim()).filter(Boolean);
    return (lines[lines.length - 1] || String(text)).replace(/\*\*|~~|`|(?<!\w)[*_]|[*_](?!\w)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }

  return { render, quote, plain };
})();
