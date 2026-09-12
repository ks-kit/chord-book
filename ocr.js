/* ocr.js — スクリーンショットからコード譜を読み取る
   画像は端末内だけで処理する（どこにも送らない）。

   対応レイアウト
     A) セル型（Uta-Net 等）… コード名の真下に歌詞の断片が並ぶ
     B) 行型（U-フレット等）… コード行の下に歌詞行が1行
   どちらも「コード行＋歌詞行」のテキストに戻してから既存のパーサに渡す。

   依存: chords.js, parser.js, vendor/tesseract  → グローバル Ocr を公開する。 */
const Ocr = (() => {
  'use strict';

  /* Worker の中では相対パスの基準が変わるので、絶対URLにしておく */
  const BASE      = new URL('.', location.href).href;
  const TESS_JS   = BASE + 'vendor/tesseract/tesseract.min.js';
  const WORKER_JS = BASE + 'vendor/tesseract/worker.min.js';
  const CORE_PATH = BASE + 'vendor/tesseract';
  const LANG_PATH = BASE + 'vendor/tessdata';

  const JP = /[ぁ-ゖァ-ヺ一-鿿々ー]/;
  const FILLER = /^(\||\|\||%|~|〜|→|[xX×]\s?\d|N\.?C\.?|:\||\|:)$/;
  /* 押さえ方図から拾ってしまう記号 */
  const DIAGRAM_JUNK = /^[×✕xXoO0°・·•'"`´,.\-_|]{1,2}$/;

  let worker = null;
  let booting = null;
  let quiet = false;      // 読み直し中は進捗の表示を邪魔させない

  /* ───────── 起動 ───────── */

  function loadScript(src) {
    if (window.Tesseract) return Promise.resolve();

    // 同じタグを二重に入れない
    let s = document.querySelector('script[data-ocr-engine]');
    if (!s) {
      s = document.createElement('script');
      s.src = src;
      s.setAttribute('data-ocr-engine', '1');
      document.head.append(s);
    }

    return new Promise((ok, ng) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        err ? ng(err) : ok();
      };
      const timer = setTimeout(() => {
        finish(new Error('OCRエンジンの読み込みが終わりません（vendor/tesseract を確認してください）'));
      }, 60000);
      // onload が来ないことがあるので、グローバルの出現も見張る
      const poll = setInterval(() => { if (window.Tesseract) finish(null); }, 150);
      s.addEventListener('load', () => {
        if (window.Tesseract) finish(null);
        else finish(new Error('OCRエンジンを読み込めましたが初期化できませんでした'));
      });
      s.addEventListener('error', () => finish(new Error('OCRエンジンのファイルが見つかりません')));
      if (window.Tesseract) finish(null);
    });
  }

  async function getWorker(onStage) {
    if (worker) return worker;
    if (booting) return booting;

    booting = (async () => {
      onStage && onStage('エンジンを読み込み中…');
      await loadScript(TESS_JS);

      onStage && onStage('言語データを準備中…（初回だけ時間がかかります）');
      const w = await Tesseract.createWorker(['jpn', 'eng'], 1, {
        workerPath: WORKER_JS,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        logger: (m) => {
          if (onStage && !quiet && m.status === 'recognizing text') {
            onStage('読み取り中… ' + Math.round((m.progress || 0) * 100) + '%');
          }
        }
      });
      await w.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: '6'      // 一様なテキストの塊として扱う
      });
      worker = w;
      return w;
    })();

    try { return await booting; }
    finally { booting = null; }
  }

  /* ───────── 画像の下準備 ───────── */

  function loadImage(src) {
    return new Promise((ok, ng) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ng(new Error('画像を読み込めませんでした'));
      img.src = (src instanceof Blob) ? URL.createObjectURL(src) : src;
    });
  }

  /** 小さすぎる画像は拡大し、暗い画像（ダークテーマのスクショ）は白黒反転する */
  async function prepare(src) {
    const img = await loadImage(src);
    const MIN_W = 1900, MAX_W = 2600;
    let scale = 1;
    if (img.naturalWidth < MIN_W) scale = Math.min(3, MIN_W / img.naturalWidth);
    if (img.naturalWidth * scale > MAX_W) scale = MAX_W / img.naturalWidth;

    // 縦に長いスクショでメモリを使い切らないよう総画素数を抑える
    const MAX_PX = 9e6;
    const px0 = img.naturalWidth * img.naturalHeight * scale * scale;
    if (px0 > MAX_PX) scale *= Math.sqrt(MAX_PX / px0);

    const cv = document.createElement('canvas');
    cv.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
    cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(img, 0, 0, cv.width, cv.height);

    const data = cx.getImageData(0, 0, cv.width, cv.height);
    const px = data.data;
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 4 * 23) {
      sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      n++;
    }
    const mean = n ? sum / n : 255;
    const inverted = mean < 115;
    if (inverted) {
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; px[i + 2] = 255 - px[i + 2];
      }
      cx.putImageData(data, 0, 0);
    }
    return { canvas: cv, inverted, scale };
  }

  /* ───────── コード名の補正 ───────── */

  /* OCR が間違えやすい文字の置き換え候補 */
  const ALT = {
    '8': ['B'], 'B': ['8'], 'R': ['B'], 'P': ['F', 'E'], 'F': ['E', 'P'], 'E': ['F'],
    '6': ['G', 'b'], 'G': ['C', '6'], 'C': ['G'], 'Q': ['G'], 'O': ['D', '0'], '0': ['D', 'O'],
    'D': ['0', 'O'], '4': ['A'], 'A': ['4'], 'H': ['A'], 'K': ['A'],
    '5': ['S', 's'], 'S': ['5'], '9': ['g'], 'g': ['9'],
    '1': ['7', '/'], '7': ['1', '/'], '/': ['1', '7'], 'l': ['1', '/'], 'I': ['1'], '|': ['1', '/'],
    'Z': ['7'], 'z': ['7'], 'T': ['7'], '?': ['7'], '$': ['S'],
    'w': ['m'], 'M': ['m'], 'm': ['M'], 'n': ['m'], 'u': ['n'],
    '#': ['♯'], '±': ['#'], '＃': ['#'], 'b': ['6']
  };

  /** サイト固有の書き方をふつうのコード名に直す */
  function normalizeNotation(s) {
    let t = String(s || '')
      .replace(/[♯＃]/g, '#')
      .replace(/[♭]/g, 'b')
      .replace(/[（）()［］\[\]{}、,。．・"'’”`]/g, '')
      .trim();
    // AonC# のような書き方はそのまま通す（chords.js が理解する）
    return t;
  }

  /** 誤読を辞書に寄せる。読めなければ null */
  function snap(raw) {
    const t0 = normalizeNotation(raw);
    if (!t0 || t0.length > 10) return null;

    const seen = new Set();
    const queue = [[t0, 0]];
    let checked = 0;

    while (queue.length && checked < 700) {
      const [cand, depth] = queue.shift();
      if (seen.has(cand)) continue;
      seen.add(cand);
      checked++;

      for (const form of forms(cand)) {
        const norm = normalizeNotation(form);
        if (Chords.isChordToken(norm)) return Chords.parse(norm).text;
      }
      if (depth >= 2) continue;

      if (cand.includes('rn')) queue.push([cand.replace('rn', 'm'), depth + 1]);
      for (let i = 0; i < cand.length; i++) {
        const alts = ALT[cand[i]];
        if (alts) {
          for (const a of alts) queue.push([cand.slice(0, i) + a + cand.slice(i + 1), depth + 1]);
        }
        // 文字がダブって読まれることがある（AonCc# → AonC#）ので1文字落とす候補も見る
        if (depth === 0 && cand.length > 2) {
          queue.push([cand.slice(0, i) + cand.slice(i + 1), depth + 1]);
        }
      }
    }
    return null;
  }

  /** 大文字小文字の揺れを吸収した候補 */
  function forms(s) {
    if (!s) return [];
    const head = s[0].toUpperCase();
    return [...new Set([
      s,
      head + s.slice(1),
      head + s.slice(1).replace(/^MIN/i, 'm').replace(/^MAJ/i, 'maj'),
      head + s.slice(1).toLowerCase(),
      s.toUpperCase()
    ])];
  }

  /* ───────── 行の組み立て ───────── */

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  function collectWords(data) {
    const out = [];
    for (const b of (data.blocks || [])) {
      for (const p of (b.paragraphs || [])) {
        for (const l of (p.lines || [])) {
          for (const w of (l.words || [])) {
            const t = (w.text || '').trim();
            if (!t) continue;
            const bb = w.bbox || {};
            if (bb.x0 == null) continue;
            out.push({ text: t, x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1,
                       conf: (w.confidence == null ? 0 : w.confidence) });
          }
        }
      }
    }
    return out;
  }

  /** y座標で単語をまとめて行にする */
  function toLines(words) {
    if (!words.length) return [];
    const medH = median(words.map(w => w.y1 - w.y0)) || 20;
    const tol = medH * 0.6;

    const sorted = words.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const lines = [];
    for (const w of sorted) {
      const cy = (w.y0 + w.y1) / 2;
      const last = lines[lines.length - 1];
      if (last && Math.abs(cy - last.cy) <= tol) {
        last.words.push(w);
        last.cy = last.words.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / last.words.length;
      } else {
        lines.push({ cy, words: [w] });
      }
    }

    for (const l of lines) {
      l.words.sort((a, b) => a.x0 - b.x0);
      l.x0 = Math.min(...l.words.map(w => w.x0));
      l.x1 = Math.max(...l.words.map(w => w.x1));
      l.h  = median(l.words.map(w => w.y1 - w.y0)) || medH;
      l.conf = l.words.reduce((s, w) => s + w.conf, 0) / l.words.length;
      l.text = l.words.map(w => w.text).join(' ');
    }
    return lines;
  }

  /** OCR が単語ごとに入れた空白のうち、全角どうしの間のものを詰める */
  function tidy(s) {
    const ch = Array.from(String(s || ''));
    const ascii = (c) => !!c && /[\x20-\x7E]/.test(c);
    let out = '';
    for (let i = 0; i < ch.length; i++) {
      if (!/\s/.test(ch[i])) { out += ch[i]; continue; }
      let j = i;
      while (j < ch.length && /\s/.test(ch[j])) j++;
      const prev = out[out.length - 1] || '';
      const next = ch[j] || '';
      i = j - 1;
      if (prev && next && !ascii(prev) && !ascii(next)) continue;   // 全角どうしは詰める
      if (out) out += ' ';
    }
    return out.trim();
  }

  /* 作詞・作曲などのクレジット行 */
  const CREDIT_RE = /^(作詞|作曲|編曲|訳詞|補作|補作詞|Words|Music|Lyrics|Arrange)/i;

  /**
   * 譜面より前の部分から曲名とアーティストを拾う。
   * 曲名は他より文字が大きく組まれている、という手がかりを使う。
   */
  function sniffHeader(lines) {
    let firstChord = lines.findIndex(l => l.kind === 'chord');
    if (firstChord < 0) firstChord = lines.length;
    const head = lines.slice(0, Math.min(firstChord, 12));
    if (!head.length) return { title: '', artist: '' };

    const bodyH = median(lines.map(l => l.h)) || 1;
    let ti = -1, best = 0;
    head.forEach((l, i) => {
      if (CREDIT_RE.test(tidy(l.text))) return;
      if (l.h > best) { best = l.h; ti = i; }
    });

    let title = '', artist = '';
    const used = new Set();
    if (ti >= 0 && best >= bodyH * 1.22) {
      title = tidy(head[ti].text);
      used.add(ti);
      for (let i = ti + 1; i < head.length; i++) {
        const t = tidy(head[i].text);
        if (!t) continue;
        if (CREDIT_RE.test(t)) { used.add(i); continue; }
        if (t.length > 40) continue;
        artist = t;
        used.add(i);
        break;
      }
      /* 曲名が取れたなら、譜面より前はすべて曲情報とみなして本文から外す。
         「編曲」が「振曲」と誤読されるような揺れがあるため、
         語句で判定せず範囲で落とす。セクション見出しだけは残す。 */
      for (let i = 0; i < head.length; i++) {
        const t = tidy(head[i].text);
        if (!t) continue;
        if (Sheet.isSectionLine(t)) continue;
        used.add(i);
      }
    }
    // アーティストが取れなければ作詞・作曲から補う
    if (!artist) {
      for (const l of head) {
        const m = /^(?:作詞|作曲)[\s:：･・]*(.+)$/.exec(tidy(l.text));
        if (m) { artist = m[1].trim(); break; }
      }
    }
    return { title: title.slice(0, 60), artist: artist.slice(0, 60), used };
  }

  /** 押さえ方図から拾った記号だけの行を落とす */
  function isJunkLine(line) {
    const marks = line.words.filter(w => DIAGRAM_JUNK.test(w.text)).length;
    return line.words.length >= 3 && marks / line.words.length >= 0.7;
  }

  /** 「Am」「7」のように割れたコードを、近ければつなげる */
  function mergeSplitChords(line) {
    const ws = line.words;
    const out = [];
    let i = 0;
    while (i < ws.length) {
      let cur = ws[i];
      while (i + 1 < ws.length) {
        const nx = ws[i + 1];
        if (nx.x0 - cur.x1 > line.h * 0.55) break;
        const joined = cur.text + nx.text;
        if (!snap(joined)) break;
        if (snap(cur.text) && snap(nx.text) && joined.length > 7) break;
        cur = { text: joined, x0: cur.x0, x1: nx.x1,
                y0: Math.min(cur.y0, nx.y0), y1: Math.max(cur.y1, nx.y1),
                conf: Math.min(cur.conf, nx.conf) };
        i++;
      }
      out.push(cur);
      i++;
    }
    line.words = out;
    line.text = out.map(w => w.text).join(' ');
  }

  function classify(line) {
    if (JP.test(line.text)) { line.kind = 'lyric'; return; }
    mergeSplitChords(line);

    let chord = 0, other = 0;
    for (const w of line.words) {
      const s = snap(w.text);
      if (s) { w.chord = s; chord++; continue; }
      if (FILLER.test(w.text)) { w.filler = w.text; continue; }
      other++;
    }
    line.kind = (chord > 0 && chord >= Math.ceil((chord + other) * 0.6)) ? 'chord' : 'lyric';
    if (line.kind === 'lyric') for (const w of line.words) { delete w.chord; delete w.filler; }
  }

  /**
   * コード行を歌詞行の桁に合わせる。
   * 歌詞側の断片の並び順から桁を決めるので、ピクセルから桁を推定しない。
   */
  function pairToText(chordLine, lyricLine) {
    const frags = lyricLine.words;
    // 断片を左から連結したものが歌詞。各断片の開始桁を先に出す
    const startCol = [];
    let col = 0;
    for (const f of frags) {
      startCol.push(col);
      col += Sheet.displayWidth(f.text);
    }
    const lyricText = frags.map(f => f.text).join('');

    let out = '';
    for (const w of chordLine.words) {
      const label = w.chord || w.filler || w.text;
      // そのコードの真下（または直後）にある断片を探す
      let idx = -1, best = Infinity;
      for (let i = 0; i < frags.length; i++) {
        const d = Math.abs(frags[i].x0 - w.x0);
        if (d < best) { best = d; idx = i; }
      }
      let c = (idx >= 0 && best <= chordLine.h * 6) ? startCol[idx] : 0;
      if (out.length && c < out.length + 1) c = out.length + 1;
      out += ' '.repeat(Math.max(0, c - out.length)) + label;
    }
    return [out, lyricText];
  }

  /** 歌詞が無いコード行（イントロ等）を、間隔を保って文字列にする */
  function chordOnlyText(line) {
    const unit = Math.max(4, line.h * 0.55);
    let out = '';
    for (const w of line.words) {
      const label = w.chord || w.filler || w.text;
      let c = Math.max(0, Math.round((w.x0 - line.x0) / unit));
      if (out.length && c < out.length + 1) c = out.length + 1;
      out += ' '.repeat(Math.max(0, c - out.length)) + label;
    }
    return out;
  }

  function toSheetText(lines, skip) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (skip && skip.has(i)) continue;
      const L = lines[i];
      const prev = lines[i - 1];

      // 行間が大きく空いていたら区切りを入れる
      if (prev && (L.cy - prev.cy) > Math.max(prev.h, L.h) * 3.2) out.push('');

      if (L.kind !== 'chord') { out.push(tidy(L.text)); continue; }

      // 次に来る歌詞行と組にする（押さえ方図をまたぐぶん距離は緩めに見る）
      const nx = lines[i + 1];
      const pairable = nx && nx.kind === 'lyric' && !Sheet.isSectionLine(nx.text) &&
                       (nx.cy - L.cy) <= Math.max(L.h, nx.h) * 7;

      if (pairable) {
        const [c, l] = pairToText(L, nx);
        out.push(c);
        out.push(l);
        i++;
      } else {
        out.push(chordOnlyText(L));
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ───────── 歌詞行の読み直し ───────── */

  async function setLang(w, langs) {
    if (typeof w.reinitialize === 'function') { await w.reinitialize(langs, 1); return; }
    if (typeof w.initialize === 'function')   { await w.initialize(langs, 1); }
  }

  /**
   * 歌詞行だけを日本語モデル単独で読み直す。
   * 英字と混ざったモデルだと、小さい日本語が英字に化けるため。
   *
   * 1行ずつ認識すると1行あたり約1秒かかるので、
   * 歌詞行だけを切り出して1枚の画像に積み直し、まとめて1回で認識する。
   */
  async function refineLyrics(w, canvas, lines, onStage) {
    const targets = lines.filter(l => l.kind === 'lyric' && l.words.length);
    if (!targets.length) return 0;

    onStage && onStage('歌詞を読み直し中…');

    const PAD = 10, GAP = 18;
    let stackW = 0, stackH = PAD;
    const boxes = [];
    for (const l of targets) {
      const top = Math.min(...l.words.map(x => x.y0));
      const bot = Math.max(...l.words.map(x => x.y1));
      const py  = Math.round(l.h * 0.4);
      const sx  = Math.max(0, Math.round(l.x0 - 6));
      const sy  = Math.max(0, Math.round(top - py));
      const sw  = Math.max(8, Math.min(canvas.width  - sx, Math.round(l.x1 - l.x0 + 12)));
      const sh  = Math.max(8, Math.min(canvas.height - sy, Math.round(bot - top + py * 2)));
      boxes.push({ line: l, sx, sy, sw, sh, dy: stackH });
      stackH += sh + GAP;
      stackW = Math.max(stackW, sw);
    }
    stackH += PAD;
    stackW += PAD * 2;
    if (stackW < 16 || stackH < 16) return 0;

    const cv = document.createElement('canvas');
    cv.width = stackW;
    cv.height = stackH;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, stackW, stackH);
    for (const b of boxes) {
      cx.drawImage(canvas, b.sx, b.sy, b.sw, b.sh, PAD, b.dy, b.sw, b.sh);
    }

    quiet = true;
    let data;
    try {
      await setLang(w, 'jpn');
      await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
      const res = await w.recognize(cv, {}, { blocks: true });
      data = res.data;
    } catch (e) {
      data = null;
    } finally {
      try {
        await setLang(w, ['jpn', 'eng']);
        await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
      } catch (e) { /* 戻せなくても続行 */ }
      quiet = false;
    }
    if (!data) return 0;

    const got = collectWords(data);
    let fixed = 0;
    for (const b of boxes) {
      const mine = got.filter(g => {
        const cy = (g.y0 + g.y1) / 2;
        return cy >= b.dy - GAP / 2 && cy < b.dy + b.sh + GAP / 2;
      });
      if (!mine.length) continue;
      const joined = mine.map(g => g.text).join('');
      if (!JP.test(joined)) continue;        // 日本語が出てこないなら採用しない

      mine.sort((a, c) => a.x0 - c.x0);
      b.line.words = mine.map(g => ({
        text: g.text,
        x0: g.x0 - PAD + b.sx, x1: g.x1 - PAD + b.sx,
        y0: g.y0 - b.dy + b.sy, y1: g.y1 - b.dy + b.sy,
        conf: g.conf
      }));
      b.line.text = b.line.words.map(x => x.text).join(' ');
      fixed++;
    }
    return fixed;
  }

  /* ───────── 本体 ───────── */

  /**
   * 画像からコード譜のテキストを作る。
   * 返り値: {text, chordLines, lineCount, confidence, lowConf, inverted, raw, unread}
   */
  async function read(src, onStage) {
    const w = await getWorker(onStage);
    const { canvas, inverted } = await prepare(src);

    onStage && onStage('読み取り中… 0%');
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });

    const words = collectWords(data);
    let lines = toLines(words).filter(l => !isJunkLine(l));
    for (const l of lines) classify(l);

    // 歌詞行は日本語モデル単独で読み直す
    const refined = await refineLyrics(w, canvas, lines, onStage);

    const meta = sniffHeader(lines);
    const text = toSheetText(lines, meta.used);
    // ここで刈り込みはしない。誤読が1つ混ざった行をまるごと捨ててしまうため。
    // 画面のふちが写っていた場合は、編集画面の「譜面だけ取り出す」で手動で落とす。

    /* 直すべき箇所を、譜面に出てくる順に並べて返す。
       本文のどこかを指し示せるよう、書き出した文字列そのものを持たせる。

       疑わしさの判定に OCR の確度は使わない。長いコード名（AonC# など）は
       正しく読めていても確度が下がるので、信号にならないことを実測で確かめた。
       代わりに「曲のキーから外れていて、かつ数回しか出てこないコード」を挙げる。
       誤読はこの形で現れる（Bb→B のように、そこだけ調から外れる）。 */
    const counts = {};
    lines.forEach((l, li) => {
      if (l.kind !== 'chord' || (meta.used && meta.used.has(li))) return;
      for (const wd of l.words) if (wd.chord) counts[wd.chord] = (counts[wd.chord] || 0) + 1;
    });

    /* 終止和音からのキー推定は、抜粋だと外れて誤検出を生む。
       出てくるコードが一番よく収まる長音階を総当たりで探す。 */
    let inScale = null;
    const names = Object.keys(counts);
    if (names.length >= 4) {
      let best = null, total = 0;
      for (const n of names) total += counts[n];
      for (let t = 0; t < 12; t++) {
        const set = new Set([0, 2, 4, 5, 7, 9, 11].map(d => (t + d) % 12));
        let score = 0;
        for (const n of names) {
          const c = Chords.parse(n);
          if (c && set.has(Chords.NOTE_INDEX[c.root])) score += counts[n];
        }
        if (!best || score > best.score) best = { set, score };
      }
      // 大半が収まる音階が見つかった時だけ、外れ値の判定に使う
      if (best && total && best.score / total >= 0.8) inScale = best.set;
    }

    const offKey = (name) => {
      if (!inScale) return false;
      const c = Chords.parse(name);
      if (!c) return false;
      return !inScale.has(Chords.NOTE_INDEX[c.root]);
    };

    const marks = [];
    const unread = [], suspects = [];
    lines.forEach((l, li) => {
      if (l.kind !== 'chord') return;
      if (meta.used && meta.used.has(li)) return;
      for (const wd of l.words) {
        if (!wd.chord && !wd.filler) {
          marks.push({ text: wd.text, kind: 'unread' });
          if (!unread.includes(wd.text)) unread.push(wd.text);
        } else if (wd.chord && counts[wd.chord] <= 2 && offKey(wd.chord)) {
          marks.push({ text: wd.chord, kind: 'suspect' });
          if (!suspects.includes(wd.chord)) suspects.push(wd.chord);
        }
      }
    });

    return {
      text,
      removed: 0,
      refined,
      title: meta.title,
      artist: meta.artist,
      chordLines: lines.filter(l => l.kind === 'chord').length,
      lineCount: lines.length,
      confidence: words.length ? Math.round(words.reduce((s, x) => s + x.conf, 0) / words.length) : 0,
      lowConf: words.filter(x => x.conf < 65).length,
      unread: unread.slice(0, 12),
      suspects: suspects.slice(0, 12),
      marks: marks.slice(0, 60),
      inverted,
      raw: data.text || ''
    };
  }

  async function dispose() {
    if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; }
  }

  return { read, dispose, snap, normalizeNotation, _toLines: toLines, _classify: classify };
})();
