#!/usr/bin/env node
'use strict';
/**
 * docview - 指定フォルダ配下の HTML / Markdown を1画面で一覧・検索するローカルビューア
 *
 * 使い方:
 *   node server.js "C:\work\docs"
 *   node server.js "C:\work\docs" --port 9000 --no-open
 *
 * 依存パッケージなし（Node.js 18+）。127.0.0.1 のみで待ち受けます。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// ---------- 引数 ----------
const args = process.argv.slice(2);
const valueOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const ROOT = path.resolve(positional[0] || process.cwd());
const PORT = parseInt(valueOf('--port', '8765'), 10);
const NO_OPEN = args.includes('--no-open');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error('フォルダが見つかりません: ' + ROOT);
  process.exit(1);
}

// ---------- 探索 ----------
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '$RECYCLE.BIN', 'System Volume Information']);
const KIND = { '.html': 'html', '.htm': 'html', '.md': 'md', '.markdown': 'md' };
const HEAD_BYTES_SMALL = 16 * 1024;
const HEAD_BYTES_LARGE = 64 * 1024;

// タイトルは通常ファイル先頭の数KBにあるため、まず16KBだけ読む。
// バッファを使い切った（＝ファイルがまだ続く）のにタイトルが見つからない場合のみ64KBで読み直す。
function readHead(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    return { text: buf.toString('utf8', 0, n).replace(/^\uFEFF/, ''), truncated: n === size };
  } finally {
    fs.closeSync(fd);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function titleFromHead(head, kind) {
  let m;
  if (kind === 'html') {
    m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1].trim()) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
    m = head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) return decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    return '';
  }
  head = head.replace(/\r\n?/g, '\n');
  m = head.match(/^---\n(?:[\s\S]*?\n)?title:[ \t]*["']?(.+?)["']?[ \t]*\n(?:[\s\S]*?\n)?---/);
  if (m) return m[1].trim();
  m = head.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/\s*#+\s*$/, '').trim() : '';
}

function extractTitle(file, kind) {
  let head;
  try { head = readHead(file, HEAD_BYTES_SMALL); } catch { return ''; }
  let title = titleFromHead(head.text, kind);
  if (!title && head.truncated) {
    try { head = readHead(file, HEAD_BYTES_LARGE); } catch { return title; }
    title = titleFromHead(head.text, kind);
  }
  return title;
}

// ---------- タイトル抽出キャッシュ ----------
// ROOT ごとに OS の一時フォルダへ保存する。サイズと更新日時が前回と同じファイルは
// open/read を省略し、起動・再スキャンのたびに全件を読み直すコストをなくす。
const CACHE_FILE = path.join(
  os.tmpdir(), 'docview-cache',
  crypto.createHash('sha1').update(ROOT).digest('hex') + '.json'
);

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return data && data.root === ROOT && data.files ? data.files : {};
  } catch {
    return {};
  }
}

function saveCache(files) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ root: ROOT, files }));
  } catch {
    // キャッシュの保存に失敗しても致命的ではないので無視する
  }
}

let TITLE_CACHE = loadCache();

function scan() {
  const items = [];
  const nextCache = {};
  let cacheHits = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const kind = KIND[path.extname(e.name).toLowerCase()];
        if (!kind) continue;
        const full = path.join(dir, e.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        const parts = rel.split('/');

        const cached = TITLE_CACHE[rel];
        let title;
        if (cached && cached.kind === kind && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          title = cached.title;
          cacheHits++;
        } else {
          title = extractTitle(full, kind);
        }
        nextCache[rel] = { kind, size: st.size, mtimeMs: st.mtimeMs, title };

        items.push({
          kind,
          rel,
          folder: parts.length > 1 ? parts[0] : '(root)',
          name: e.name,
          title: title || e.name,
          created: Math.round(st.birthtimeMs || st.ctimeMs),
          modified: Math.round(st.mtimeMs),
        });
      }
    }
  };
  walk(ROOT);
  TITLE_CACHE = nextCache;
  saveCache(nextCache);
  return { items, cacheHits };
}

let ITEMS = [];
let SCANNED_AT = 0;
function rescan() {
  const t = Date.now();
  const result = scan();
  ITEMS = result.items;
  SCANNED_AT = Date.now();
  console.log(`スキャン完了: ${ITEMS.length} 件 (${SCANNED_AT - t} ms, キャッシュ命中 ${result.cacheHits} 件)`);
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.xml': 'application/xml',
};

const STATIC_ALLOW = new Set(['vendor/marked.min.js']);

function safePath(rel) {
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function decodePath(urlPath, prefix) {
  try {
    return urlPath.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

function sendFile(res, full, extraHeaders = {}) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, ...extraHeaders });
    fs.createReadStream(full).pipe(res);
  });
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), { 'Cache-Control': 'no-store' });

  if (p === '/api/items') return sendJson(res, { root: ROOT, scannedAt: SCANNED_AT, items: ITEMS });

  if (p === '/api/rescan' && req.method === 'POST') {
    rescan();
    return sendJson(res, { root: ROOT, scannedAt: SCANNED_AT, items: ITEMS });
  }

  if (p.startsWith('/static/')) {
    const rel = decodePath(p, '/static/');
    if (rel === null || !STATIC_ALLOW.has(rel)) { res.writeHead(404); return res.end('Not Found'); }
    return sendFile(res, path.join(PUBLIC_DIR, rel));
  }

  // 生ファイル配信（HTML内の相対パスのCSS・画像もそのまま解決される）
  if (p.startsWith('/raw/')) {
    const rel = decodePath(p, '/raw/');
    const full = rel === null ? null : safePath(rel);
    if (!full) { res.writeHead(403); return res.end('Forbidden'); }
    return sendFile(res, full);
  }

  // Markdown ビューア
  if (p.startsWith('/md/')) {
    const rel = decodePath(p, '/md/');
    const full = rel === null ? null : safePath(rel);
    if (!full || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not Found'); }
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
    const tpl = fs.readFileSync(path.join(PUBLIC_DIR, 'viewer.html'), 'utf8');
    const html = tpl
      .replace(/__BASE__/g, escHtml('/raw/' + enc(dir)))
      .replace(/__SRC__/g, escHtml('/raw/' + enc(rel)))
      .replace(/__NAME__/g, escHtml(path.basename(rel)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`ポート ${PORT} は使用中です。--port で別のポートを指定してください。`);
  else console.error(e);
  process.exit(1);
});

console.log('対象フォルダ: ' + ROOT);
rescan();
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('起動しました: ' + url + '  (Ctrl+C で停止)');
  if (!NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
