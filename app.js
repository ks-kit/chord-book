/* app.js — コード帳 本体 */
(() => {
  'use strict';

  const $  = (id) => document.getElementById(id);
  const KEY_SONGS = 'chordbook.songs.v1';
  const KEY_PREFS = 'chordbook.prefs.v1';
  const LF = String.fromCharCode(10);

  const FONT_PX    = [13, 15, 17, 19, 21, 24, 27];
  const FONT_LABEL = ['極小', '小', '標準', '大', '特大', '特大＋', '最大'];
  const DEFAULT_FONT = 2;

  /* 押さえやすいコード（カポ提案の判定用） */
  const EASY = new Set(['C', 'D', 'E', 'F', 'G', 'A', 'Am', 'Bm', 'Dm', 'Em',
                        'A7', 'B7', 'C7', 'D7', 'E7', 'G7', 'Am7', 'Bm7', 'Dm7', 'Em7',
                        'Cmaj7', 'Dmaj7', 'Emaj7', 'Fmaj7', 'Gmaj7', 'Amaj7',
                        'Asus4', 'Dsus4', 'Esus4', 'Asus2', 'Dsus2', 'Cadd9',
                        'C/G', 'C/E', 'D/F#', 'G/B', 'F/C', 'Am/G', 'Em/B']);

  /* キーごとの慣用表記。true = ♭ で書くのが自然なキー
     （メジャー: C Db D Eb E F F# G Ab A Bb B / マイナー: Cm C#m Dm Ebm Em Fm F#m Gm G#m Am Bbm Bm） */
  const FLAT_KEY_MAJOR = [false, true,  false, true,  false, true,  false, false, true,  false, true,  false];
  const FLAT_KEY_MINOR = [true,  false, true,  true,  false, true,  false, true,  false, false, true,  false];

  let songs = [];
  let prefs = { theme: 'dark', speed: 8 };
  let current = null;        // 表示中の曲
  let parsed = [];           // 解析結果
  let editingId = null;
  let pastedRaw = null;      // 取り出す前の、貼り付けたままのテキスト
  let lastClean = null;
  let preferFlat = false;    // 画面に出すコードの表記（カポ込み）
  let textFlat = false;      // 元の譜面が♭寄りか
  let songKey = null;        // 推定キー（原曲）
  let wakeLock = null;

  /* ══════════ 保存 ══════════ */

  function loadAll() {
    try { songs = JSON.parse(localStorage.getItem(KEY_SONGS) || '[]'); }
    catch (e) { songs = []; }
    if (!Array.isArray(songs)) songs = [];
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY_PREFS) || '{}')); }
    catch (e) { /* 既定のまま */ }
  }

  function saveSongs() {
    try {
      localStorage.setItem(KEY_SONGS, JSON.stringify(songs));
    } catch (e) {
      toast('保存できませんでした。端末の空き容量を確認してください');
    }
  }

  function savePrefs() {
    try { localStorage.setItem(KEY_PREFS, JSON.stringify(prefs)); } catch (e) {}
  }

  function newId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ══════════ 画面遷移 ══════════ */

  function show(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('is-active');
    $('screen-' + name).classList.add('is-active');
    closeMenu();
    if (name !== 'view') { stopScroll(); releaseWake(); }
    else { requestWake(); }
  }

  /* ══════════ ライブラリ ══════════ */

  function renderLibrary() {
    const q = ($('search').value || '').trim().toLowerCase();
    const list = $('song-list');
    list.textContent = '';

    const shown = songs
      .filter(s => !q || (s.title + ' ' + (s.artist || '')).toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    $('empty-state').hidden = songs.length > 0;
    list.hidden = songs.length === 0;

    for (const s of shown) {
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = s.id;

      const main = document.createElement('div');
      main.className = 'card__main';
      const t = document.createElement('p');
      t.className = 'card__title';
      t.textContent = s.title || '(無題)';
      const m = document.createElement('p');
      m.className = 'card__meta';
      const bits = [];
      if (s.artist) bits.push(s.artist);
      if (s.capo) bits.push('カポ' + s.capo);
      if (s.transpose) bits.push((s.transpose > 0 ? '+' : '') + s.transpose + '半音');
      m.textContent = bits.join('　');
      main.append(t, m);

      const k = document.createElement('span');
      k.className = 'card__key';
      k.textContent = songKeyLabel(s);

      card.append(main, k);
      card.addEventListener('click', () => openSong(s.id));
      list.append(card);
    }

    if (q && !shown.length) {
      const p = document.createElement('p');
      p.className = 'empty__body';
      p.style.padding = '28px 0';
      p.style.textAlign = 'center';
      p.textContent = '見つかりませんでした';
      list.append(p);
    }
  }

  function songKeyLabel(s) {
    try {
      const key = Sheet.guessKey(Sheet.parse(s.body));
      if (!key) return '—';
      const idx = Chords.NOTE_INDEX[key.root] + (s.transpose || 0);
      return Chords.noteName(idx, soundingFlat(s, key, preferFlatOf(s.body))) + (key.minor ? 'm' : '');
    } catch (e) { return '—'; }
  }

  function preferFlatOf(text) {
    const flats  = (String(text).match(/[A-G]b/g) || []).length;
    const sharps = (String(text).match(/[A-G]#/g) || []).length;
    return flats > sharps;
  }

  /** キーの慣用表記から、そのキーを♭で書くべきかを返す */
  function flatForKey(rootIdx, minor, fallback) {
    if (rootIdx == null) return !!fallback;
    const i = ((rootIdx % 12) + 12) % 12;
    return (minor ? FLAT_KEY_MINOR : FLAT_KEY_MAJOR)[i];
  }

  /** 画面に出すコードの♯/♭（カポ込みの「押さえるキー」に合わせる） */
  function displayFlat(song, key, textFlat) {
    if (!key) return !!textFlat;
    return flatForKey(Chords.NOTE_INDEX[key.root] + (song.transpose || 0) - (song.capo || 0), key.minor, textFlat);
  }

  /** 鳴っているキーの♯/♭（カポは関係ない） */
  function soundingFlat(song, key, textFlat) {
    if (!key) return !!textFlat;
    return flatForKey(Chords.NOTE_INDEX[key.root] + (song.transpose || 0), key.minor, textFlat);
  }

  /* ══════════ 編集 ══════════ */

  function openEditor(id) {
    editingId = id || null;
    const s = id ? songs.find(x => x.id === id) : null;
    $('edit-heading').textContent = s ? '曲を編集' : '曲を追加';
    $('f-title').value  = s ? (s.title || '')  : '';
    $('f-artist').value = s ? (s.artist || '') : '';
    $('f-body').value   = s ? (s.body || '')   : '';
    $('btn-delete').hidden = !s;
    $('parse-report').hidden = true;
    pastedRaw = null;
    lastClean = null;
    $('lookup').hidden = true;
    $('ocr-status').hidden = true;
    $('fixlist').hidden = true;
    fixMarks = [];
    show('edit');
  }

  function saveEditor() {
    const body = $('f-body').value;
    if (!body.trim()) { toast('コード譜を貼り付けてください'); return; }

    let title  = $('f-title').value.trim();
    let artist = $('f-artist').value.trim();
    if (!title) {
      const meta = Sheet.sniffMeta(body);
      title  = meta.title  || '(無題)';
      if (!artist) artist = meta.artist || '';
    }

    if (editingId) {
      const s = songs.find(x => x.id === editingId);
      Object.assign(s, { title, artist, body, updatedAt: Date.now() });
    } else {
      songs.push({
        id: newId(), title, artist, body,
        transpose: 0, capo: 0, font: DEFAULT_FONT,
        createdAt: Date.now(), updatedAt: Date.now()
      });
    }
    saveSongs();
    renderLibrary();
    show('library');
    toast('保存しました');
  }

  /* ══════════ 画像から読み取る ══════════ */

  /** クリップボードから画像を取り出す（Snipping Tool やスクショのコピー） */
  function imageFromClipboard(e) {
    const dt = e.clipboardData || window.clipboardData;
    if (!dt) return null;
    if (dt.files && dt.files.length) {
      for (const f of dt.files) if (f.type && f.type.indexOf('image/') === 0) return f;
    }
    if (dt.items) {
      for (const it of dt.items) {
        if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
          const f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    return null;
  }

  /* ══════════ 直す箇所への案内 ══════════ */

  let fixMarks = [];

  /** 読めなかった語・自信の低いコードを、本文の位置に飛べるボタンとして並べる */
  function renderFixList(marks, base) {
    const box = $('fixlist');
    const counter = {};
    fixMarks = (marks || []).map(m => {
      counter[m.text] = (counter[m.text] || 0) + 1;
      return { text: m.text, kind: m.kind, nth: counter[m.text], base };
    });

    if (!fixMarks.length) { box.hidden = true; box.innerHTML = ''; return; }

    const nUnread = fixMarks.filter(m => m.kind === 'unread').length;
    const nSus    = fixMarks.length - nUnread;
    const bits = [];
    if (nUnread) bits.push(`読めなかった <b>${nUnread}</b> 件`);
    if (nSus)    bits.push(`自信が低い <b>${nSus}</b> 件`);

    box.hidden = false;
    box.innerHTML =
      `<p class="fixlist__msg">${bits.join('　/　')}<br>` +
      'タップすると本文のその場所が選ばれます。そのまま正しいコードを打って上書きしてください。</p>' +
      fixMarks.map((m, i) =>
        `<button class="fixchip fixchip--${m.kind}" data-i="${i}">${esc(m.text)}</button>`
      ).join('');
  }

  /** その語が本文のどこにあるかを探して選択する */
  function jumpToMark(i, chip) {
    const m = fixMarks[i];
    if (!m) return;
    const ta = $('f-body');

    // 同じ語が複数あるので、何番目のものかを数えて探す
    let pos = -1, at = m.base - 1;
    for (let c = 0; c < m.nth; c++) {
      pos = ta.value.indexOf(m.text, at + 1);
      if (pos < 0) break;
      at = pos;
    }
    if (pos < 0) pos = ta.value.indexOf(m.text, m.base);
    if (pos < 0) pos = ta.value.indexOf(m.text);
    if (pos < 0) { toast('見つかりません。もう直したようです'); return; }

    ta.focus();
    ta.setSelectionRange(pos, pos + m.text.length);

    // 該当行が画面の外なら、見える位置までスクロールする
    const lineNo = ta.value.slice(0, pos).split(LF).length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const top = lineNo * lh;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lh * 2) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
    }
    // フォーム自体も本文が見える位置へ
    ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (chip) chip.classList.add('is-done');
  }

  /* ══════════ 曲名の照合（ネット） ══════════ */

  let lookupHits = [];

  /** Apple の楽曲検索で候補を引く。キー不要・ブラウザから直接呼べる */
  async function searchSong(term) {
    const url = 'https://itunes.apple.com/search?country=JP&media=music&entity=song&limit=12&term=' +
                encodeURIComponent(term);
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const seen = new Set(), out = [];
    for (const x of (j.results || [])) {
      if (!x.trackName) continue;
      const key = x.trackName + '|' + (x.artistName || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: x.trackName, artist: x.artistName || '' });
      if (out.length >= 6) break;
    }
    return out;
  }

  async function runLookup() {
    const title = $('f-title').value.trim();
    const artist = $('f-artist').value.trim();
    const box = $('lookup');

    if (!title && !artist) { toast('曲名を入れてから押してください'); return; }

    box.hidden = false;
    box.innerHTML = '<p class="lookup__msg">照合中…</p>';
    try {
      let hits = await searchSong([title, artist].filter(Boolean).join(' '));
      // 見つからなければ曲名だけで引き直す（アーティスト名が誤読されている場合）
      if (!hits.length && title && artist) hits = await searchSong(title);
      if (!hits.length) {
        box.innerHTML = '<p class="lookup__msg">見つかりませんでした。曲名を直してもう一度試してください。</p>';
        return;
      }
      lookupHits = hits;
      box.innerHTML = '<p class="lookup__msg">近いものを選ぶと、曲名とアーティストが入ります</p>' +
        hits.map((h, i) =>
          `<button class="lookup__item" data-i="${i}"><b>${esc(h.title)}</b><span>${esc(h.artist)}</span></button>`
        ).join('');
    } catch (e) {
      box.innerHTML = '<p class="lookup__msg">照合できませんでした（' +
                      esc(e && e.message ? e.message : String(e)) + '）</p>';
    }
  }

  /* ───── 画像をまたいだ重複の除去 ───── */

  /** 比較用に、空白と記号を落として正規化する */
  function normForCmp(s) {
    return String(s || '').replace(/[\s　]/g, '').replace(/[|:%~〜→,.'"]/g, '');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** OCRの揺れを許して同じ行かどうかを見る */
  function sameLine(a, b) {
    const x = normForCmp(a), y = normForCmp(b);
    if (!x && !y) return true;
    if (!x || !y) return false;
    if (x === y) return true;
    const d = levenshtein(x, y);
    return d / Math.max(x.length, y.length) <= 0.25;
  }

  /**
   * 前の本文の末尾と新しい行の先頭が重なっていれば、その分を落とす。
   * サビの繰り返しを誤って消さないよう、3行以上そろった時だけ重複とみなす。
   */
  function dropOverlap(prevLines, newLines) {
    const limit = Math.min(60, prevLines.length, newLines.length);
    for (let k = limit; k >= 3; k--) {
      let hit = true;
      for (let i = 0; i < k; i++) {
        if (!sameLine(prevLines[prevLines.length - k + i], newLines[i])) { hit = false; break; }
      }
      if (hit) return { lines: newLines.slice(k), dropped: k };
    }
    return { lines: newLines, dropped: 0 };
  }

  async function runOcr(file, index, total) {
    const btn = $('btn-ocr'), st = $('ocr-status');
    btn.disabled = true;
    st.hidden = false;
    const head = (total > 1) ? `[${index + 1}/${total}枚目] ` : '';
    const stage = (msg) => { st.textContent = head + msg; };
    stage('準備中…');

    try {
      const r = await Ocr.read(file, stage);
      if (!r.text || !r.text.trim()) {
        st.innerHTML = '文字を読み取れませんでした。<br>' +
          '譜面の部分だけを切り取る、ページの文字サイズを大きくする、' +
          'ダイアグラム表示をOFFにする、のいずれかを試してください。';
        return;
      }

      // すでに本文があれば下に足す。重なっている行は落とす
      const ta = $('f-body');
      const before = ta.value.replace(/\s+$/, '');
      let dropped = 0;
      if (before.trim()) {
        const prevLines = before.split(LF);
        const res = dropOverlap(prevLines, r.text.split(LF));
        dropped = res.dropped;
        const add = res.lines.join(LF).replace(/^\s+/, '');
        ta.value = add ? (before + LF + (dropped ? '' : LF) + add) : before;
      } else {
        ta.value = r.text;
      }
      const base = Math.max(0, ta.value.length - r.text.length);
      pastedRaw = null;
      lastClean = null;

      // 画像の上部に曲名・アーティストが写っていれば拾う（空欄のときだけ）
      let filled = '';
      if (r.title && !$('f-title').value.trim()) {
        $('f-title').value = r.title;
        filled = r.title;
      }
      if (r.artist && !$('f-artist').value.trim()) {
        $('f-artist').value = r.artist;
        filled += (filled ? ' / ' : '') + r.artist;
      }
      renderParseReport();
      renderFixList(r.marks, base);

      let msg = head + `<b>${r.chordLines}</b> 行のコードを読み取りました（確度 <b>${r.confidence}</b>%）`;
      if (filled) msg += `<br>曲名・アーティストを拾いました: <b>${esc(filled)}</b>`;
      if (dropped) {
        msg += `<br>前の画像と重なっていた <b>${dropped}</b> 行を除きました。` +
               '<span class="warn">繰り返しの多い曲では消しすぎることがあるので、つながり目を確認してください。</span>';
      }
      if (r.inverted) msg += '<br>暗い画像だったので白黒を反転して処理しました。';
      if (r.confidence < 78) {
        msg += '<br><span class="warn">画像の文字が小さいようです。' +
               'ページの文字サイズを大きくして撮り直すと精度が上がります。</span>';
      }
      msg += '<br>♭や♯は読み落とすことがあります。' +
             '続けて別の画像を読み込むと下に足していきます。' +
             '<b>保存する前に本文を見て直してください。</b>';
      st.innerHTML = msg;
    } catch (e) {
      st.innerHTML = '読み取りに失敗しました: ' + esc(e && e.message ? e.message : String(e));
    } finally {
      btn.disabled = false;
    }
  }

  /** 貼り付けたテキストから譜面部分だけを取り出す */
  function applyClean() {
    const before = $('f-body').value;
    if (!before.trim()) return;

    const res = Sheet.clean(before);
    if (res.text && res.text !== before.trim() && res.removed > 0) {
      pastedRaw = before;
      lastClean = res;
      $('f-body').value = res.text;
    } else {
      pastedRaw = null;
      lastClean = null;
    }
    fillMeta(res.titles, $('f-body').value);
    renderParseReport();
  }

  function restorePasted() {
    if (pastedRaw == null) return;
    $('f-body').value = pastedRaw;
    pastedRaw = null;
    lastClean = null;
    renderParseReport();
  }

  /** 曲名・アーティストが空なら候補で埋める */
  function fillMeta(titles, body) {
    if ($('f-title').value.trim()) return;
    const line = (titles && titles[0]) || '';
    const m = /^(.+?)\s*[\/／]\s*(.+)$/.exec(line);
    if (m) {
      $('f-title').value = m[1].trim();
      if (!$('f-artist').value.trim()) $('f-artist').value = m[2].trim();
      return;
    }
    if (line) { $('f-title').value = line; return; }
    const meta = Sheet.sniffMeta(body);
    if (meta.title) $('f-title').value = meta.title;
    if (!$('f-artist').value.trim() && meta.artist) $('f-artist').value = meta.artist;
  }

  function renderParseReport() {
    const body = $('f-body').value;
    const p = Sheet.parse(body);
    const chords = Sheet.chordList(p);
    const lyricLines = p.filter(r => r.type === 'line' && r.hasLyric).length;
    const chordLines = p.filter(r => r.type === 'line' && r.hasChord).length;
    const sections = p.filter(r => r.type === 'section').length;
    const unknown = chords.filter(c => !Chords.shape(c));

    const el = $('parse-report');
    el.hidden = false;
    let html = '';
    if (pastedRaw != null && lastClean) {
      html += `<div class="parse-report__head">ページから譜面部分だけを取り出しました` +
              `（<b>${lastClean.removed}</b> 行を除外）` +
              `<button class="linkbtn" data-act="restore">貼ったままに戻す</button></div>`;
    } else {
      const maybe = Sheet.clean(body);
      if (maybe.removed > 0) {
        html += `<div class="parse-report__head">譜面以外が <b>${maybe.removed}</b> 行混ざっているようです` +
                `<button class="linkbtn" data-act="doclean">譜面だけ取り出す</button></div>`;
      }
    }
    html += `<b>${chordLines}</b> 行にコードを認識　/　歌詞 <b>${lyricLines}</b> 行`;
    if (sections) html += `　/　セクション <b>${sections}</b> 個`;
    html += '<br>';
    if (chords.length) {
      html += chords.map(c => `<span class="chip">${esc(c)}</span>`).join('');
      if (unknown.length) {
        html += `<br>押さえ方図を出せないコード: ${unknown.map(esc).join(', ')}`;
      }
    } else {
      html += 'コードが1つも見つかりませんでした。<br>コードと歌詞が別の行になっているか確認してください。';
    }
    el.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ══════════ 表示 ══════════ */

  function openSong(id) {
    current = songs.find(s => s.id === id);
    if (!current) return;
    if (current.transpose == null) current.transpose = 0;
    if (current.capo == null) current.capo = 0;
    if (current.font == null) current.font = DEFAULT_FONT;

    parsed = Sheet.parse(current.body);
    textFlat = preferFlatOf(current.body);
    songKey = Sheet.guessKey(parsed);
    preferFlat = displayFlat(current, songKey, textFlat);

    $('view-title').textContent = current.title || '(無題)';
    $('view-sub').textContent = current.artist || '';
    $('sheet').scrollTop = 0;
    $('scroll-speed').value = prefs.speed;
    $('scroll-speed-label').textContent = prefs.speed;

    renderSheet();
    show('view');
  }

  /** 表示するコード = 原曲 + 転調 − カポ */
  function shift() {
    return (current.transpose || 0) - (current.capo || 0);
  }

  function renderSheet() {
    preferFlat = displayFlat(current, songKey, textFlat);
    const host = $('sheet');
    host.textContent = '';
    host.style.setProperty('--fs', FONT_PX[current.font] + 'px');

    const sh = shift();
    const frag = document.createDocumentFragment();

    for (const row of parsed) {
      if (row.type === 'blank') {
        const d = document.createElement('div');
        d.className = 'row row--blank';
        frag.append(d);
        continue;
      }
      if (row.type === 'section') {
        const d = document.createElement('div');
        d.className = 'row row--section';
        d.textContent = row.text;
        frag.append(d);
        continue;
      }

      const line = document.createElement('div');
      line.className = 'row line' + (row.hasChord ? '' : ' line--nochord') +
                       (row.hasLyric ? '' : ' line--chordonly');

      for (const seg of row.segs) {
        const s = document.createElement('span');
        s.className = 'seg' + (seg.chord || seg.filler ? '' : ' seg--nochord');

        const ch = document.createElement('span');
        if (seg.chord) {
          ch.className = 'seg__ch seg__ch--tap';
          ch.textContent = sh ? Chords.transposeText(seg.chord, sh, preferFlat) : seg.chord;
          ch.dataset.chord = ch.textContent;
        } else if (seg.filler) {
          ch.className = 'seg__ch seg__ch--filler';
          ch.textContent = seg.filler;
        } else {
          // コードが無い枠。ふつうの空白だと CSS の空白処理で消えて枠の高さが 0 になり、
          // ベースライン揃えの基準がずれるので、消えない空白を入れる
          ch.className = 'seg__ch';
          ch.textContent = String.fromCharCode(160);
        }

        const ly = document.createElement('span');
        ly.className = 'seg__ly';
        ly.textContent = seg.lyric || '';

        s.append(ch, ly);
        line.append(s);
      }
      frag.append(line);
    }

    host.append(frag);
    updateToolbar();
  }

  function updateToolbar() {
    const key = songKey;
    const t = current.transpose || 0;
    const capo = current.capo || 0;

    // 転調ボタンには「鳴るキー」を出す
    if (key) {
      const sFlat = soundingFlat(current, key, textFlat);
      const sounding = Chords.noteName(Chords.NOTE_INDEX[key.root] + t, sFlat) + (key.minor ? 'm' : '');
      $('key-value').textContent = sounding + (t ? `（${t > 0 ? '+' : ''}${t}）` : '');
    } else {
      $('key-value').textContent = t ? `${t > 0 ? '+' : ''}${t}半音` : '原曲キー';
    }
    $('capo-value').textContent = capo ? capo + 'フレット' : 'なし';
    $('font-value').textContent = FONT_LABEL[current.font];

    // 補足行：押さえる形と、カポの提案
    const parts = [];
    if (key) {
      const played = Chords.noteName(Chords.NOTE_INDEX[key.root] + t - capo, preferFlat) + (key.minor ? 'm' : '');
      if (capo) parts.push(`カポ${capo}フレットで ${played} の形を押さえる`);
    }
    const sug = suggestCapo();
    if (sug && sug.capo !== capo && sug.current < 0.7) {
      parts.push(`カポ${sug.capo}にすると ${sug.label} の形で弾けます`);
    }
    $('capo-hint').textContent = parts.join('　/　');
  }

  /** 開放弦の使えるコードが一番多くなるカポ位置を探す */
  function suggestCapo() {
    const list = Sheet.chordList(parsed);
    if (!list.length) return null;
    const t = current.transpose || 0;
    const scoreAt = (capo) => {
      const shifted = list.map(c => Chords.transposeText(c, t - capo, preferFlat));
      return shifted.filter(c => EASY.has(c)).length / shifted.length;
    };
    const currentScore = scoreAt(current.capo || 0);
    let best = null;
    for (let capo = 0; capo <= 7; capo++) {
      const shifted = list.map(c => Chords.transposeText(c, t - capo, preferFlat));
      const score = shifted.filter(c => EASY.has(c)).length / shifted.length;
      if (!best || score > best.score + 1e-9) {
        const key = songKey;
        best = {
          capo, score,
          label: key
            ? Chords.noteName(Chords.NOTE_INDEX[key.root] + t - capo, preferFlat) + (key.minor ? 'm' : '')
            : shifted[0]
        };
      }
    }
    // 今より明らかに楽になる時だけ提案する
    if (best) best.current = currentScore;
    return (best && best.score >= 0.85 && best.score > currentScore + 0.2) ? best : null;
  }

  /* ══════════ ツールバー操作 ══════════ */

  function onToolbarAction(act) {
    if (!current) return;
    switch (act) {
      case 'key-up':    current.transpose = clamp((current.transpose || 0) + 1, -11, 11); break;
      case 'key-down':  current.transpose = clamp((current.transpose || 0) - 1, -11, 11); break;
      case 'key-reset': current.transpose = 0; break;
      case 'capo-up':   current.capo = clamp((current.capo || 0) + 1, 0, 11); break;
      case 'capo-down': current.capo = clamp((current.capo || 0) - 1, 0, 11); break;
      case 'capo-reset':current.capo = 0; break;
      case 'font-up':   current.font = clamp(current.font + 1, 0, FONT_PX.length - 1); break;
      case 'font-down': current.font = clamp(current.font - 1, 0, FONT_PX.length - 1); break;
      case 'font-reset':current.font = DEFAULT_FONT; break;
      default: return;
    }
    current.updatedAt = Date.now();
    saveSongs();
    renderSheet();
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ══════════ 自動スクロール ══════════ */

  let rafId = null, lastTs = 0, carry = 0;

  function startScroll() {
    if (rafId) return;
    $('btn-scroll').classList.add('is-on');
    $('btn-scroll').textContent = '❚❚';
    lastTs = 0; carry = 0;
    requestWake();
    rafId = requestAnimationFrame(tick);
  }

  function stopScroll() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    const b = $('btn-scroll');
    if (b) { b.classList.remove('is-on'); b.textContent = '▶'; }
  }

  function tick(ts) {
    const el = $('sheet');
    if (lastTs) {
      const dt = Math.min(100, ts - lastTs) / 1000;
      const px = prefs.speed * 1.7 * dt + carry;   // 速度1 ≒ 1.7px/秒
      const step = Math.floor(px);
      carry = px - step;
      if (step > 0) {
        const before = el.scrollTop;
        el.scrollTop = before + step;
        if (el.scrollTop <= before && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
          stopScroll();
          return;
        }
      }
    }
    lastTs = ts;
    rafId = requestAnimationFrame(tick);
  }

  /* ══════════ 画面スリープ防止 ══════════ */

  async function requestWake() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    catch (e) { /* 非対応・不許可なら諦める */ }
  }

  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('screen-view').classList.contains('is-active')) requestWake();
  });

  /* ══════════ 押さえ方シート ══════════ */

  function openChordSheet(name) {
    const body = $('cs-body');
    body.innerHTML = '';
    $('cs-name').textContent = name;

    const svg = Chords.diagramSVG(name);
    if (svg) {
      body.innerHTML = svg;
      const s = Chords.shape(name);
      const notes = [];
      if (s && !s.exact) notes.push('分数コードのベース音は省いた形です');
      if (s && s.baseFret > 1) notes.push(s.baseFret + 'フレットから始まる形です');
      const capo = current && current.capo ? current.capo : 0;
      if (capo) notes.push(`カポ${capo}フレットを基準に押さえます`);
      $('cs-note').textContent = notes.join('。');
    } else {
      body.innerHTML = '<p style="color:var(--text-dim);font-size:13px;margin:8px 0;">このコードの押さえ方図は用意がありません。</p>';
      $('cs-note').textContent = '';
    }

    $('backdrop').hidden = false;
    $('chordsheet').hidden = false;
  }

  function openAllChords() {
    if (!current) return;
    const sh = shift();
    const list = Sheet.chordList(parsed).map(c => sh ? Chords.transposeText(c, sh, preferFlat) : c);
    const uniq = [...new Set(list)];

    $('cs-name').textContent = 'この曲のコード';
    const body = $('cs-body');
    body.className = 'chordsheet__body';
    body.innerHTML = '<div class="chordgrid">' + uniq.map(c => {
      const svg = Chords.diagramSVG(c);
      return `<figure>${svg || '<div style="height:120px"></div>'}<figcaption>${esc(c)}</figcaption></figure>`;
    }).join('') + '</div>';
    body.style.display = 'block';
    body.style.maxHeight = '58vh';
    body.style.overflowY = 'auto';
    $('cs-note').textContent = uniq.length + ' 種類';
    $('backdrop').hidden = false;
    $('chordsheet').hidden = false;
  }

  function closeChordSheet() {
    $('chordsheet').hidden = true;
    $('backdrop').hidden = true;
    const body = $('cs-body');
    body.style.display = '';
    body.style.maxHeight = '';
    body.style.overflowY = '';
  }

  /* ══════════ メニュー ══════════ */

  function openMenu(context) {
    const menu = $('menu');
    const items = [];
    if (context === 'view') {
      items.push(['edit', 'この曲を編集'], ['allchords', '使うコードを一覧で見る'],
                 ['reset', '転調・カポをリセット']);
    }
    items.push(['export', 'バックアップを書き出す'], ['import', 'バックアップを読み込む'],
               ['theme', '表示テーマを切り替え']);

    menu.innerHTML = items.map(([a, l]) =>
      `<button class="menu__item" data-act="${a}">${l}</button>`).join('');
    menu.hidden = false;
  }

  function closeMenu() { $('menu').hidden = true; }

  function onMenuAction(act) {
    closeMenu();
    switch (act) {
      case 'edit':      openEditor(current.id); break;
      case 'allchords': openAllChords(); break;
      case 'reset':
        current.transpose = 0; current.capo = 0;
        saveSongs(); renderSheet(); toast('リセットしました');
        break;
      case 'export':    exportBackup(); break;
      case 'import':    $('import-file').click(); break;
      case 'theme':     toggleTheme(); break;
    }
  }

  /* ══════════ バックアップ ══════════ */

  function exportBackup() {
    const data = JSON.stringify({ app: 'chordbook', version: 1, exportedAt: new Date().toISOString(), songs }, null, 1);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `コード帳_${stamp}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(songs.length + '曲を書き出しました');
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); }
      catch (e) { toast('読み込めませんでした'); return; }
      const incoming = Array.isArray(data) ? data : (data && data.songs);
      if (!Array.isArray(incoming)) { toast('バックアップの形式が違います'); return; }

      const known = new Set(songs.map(s => s.id));
      let added = 0, updated = 0;
      for (const s of incoming) {
        if (!s || !s.body) continue;
        if (known.has(s.id)) {
          const old = songs.find(x => x.id === s.id);
          if ((s.updatedAt || 0) > (old.updatedAt || 0)) { Object.assign(old, s); updated++; }
        } else {
          songs.push(Object.assign({ id: newId(), transpose: 0, capo: 0, font: DEFAULT_FONT, createdAt: Date.now(), updatedAt: Date.now() }, s));
          added++;
        }
      }
      saveSongs();
      renderLibrary();
      toast(`${added}曲を追加${updated ? `、${updated}曲を更新` : ''}しました`);
    };
    reader.readAsText(file);
  }

  /* ══════════ テーマ・トースト ══════════ */

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', prefs.theme === 'light' ? 'light' : 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', prefs.theme === 'light' ? '#fbfaf7' : '#15171c');
  }

  function toggleTheme() {
    prefs.theme = (prefs.theme === 'light') ? 'dark' : 'light';
    savePrefs();
    applyTheme();
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ══════════ サンプル曲 ══════════ */

  const SAMPLE = [
    'ふるさと / 文部省唱歌（サンプル）',
    '',
    '【1番】',
    'C            G7',
    'うさぎ追いし かの山',
    'F            C',
    'こぶな釣りし かの川',
    'G7       C',
    '夢は今も めぐりて',
    'F          C       G7  C',
    '忘れがたき ふるさと',
    '',
    '【2番】',
    'C            G7',
    'いかにいます 父母',
    'F            C',
    'つつがなしや 友がき',
    'G7       C',
    '雨に風に つけても',
    'F          C       G7  C',
    '思いいずる ふるさと'
  ].join('\n');

  function addSample() {
    songs.push({
      id: newId(), title: 'ふるさと', artist: '文部省唱歌（サンプル）',
      body: SAMPLE, transpose: 0, capo: 0, font: DEFAULT_FONT,
      createdAt: Date.now(), updatedAt: Date.now()
    });
    saveSongs();
    renderLibrary();
    toast('サンプル曲を追加しました');
  }

  /* ══════════ イベント ══════════ */

  function bind() {
    $('btn-add').addEventListener('click', () => openEditor(null));
    $('btn-sample').addEventListener('click', addSample);
    $('search').addEventListener('input', renderLibrary);

    $('btn-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      $('menu').hidden ? openMenu('library') : closeMenu();
    });
    $('btn-view-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      $('menu').hidden ? openMenu('view') : closeMenu();
    });
    $('menu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) onMenuAction(b.dataset.act);
    });
    document.addEventListener('click', (e) => {
      if (!$('menu').hidden && !e.target.closest('#menu')) closeMenu();
    });

    $('btn-edit-cancel').addEventListener('click', () => {
      show(editingId && current && editingId === current.id ? 'view' : 'library');
    });
    $('btn-edit-save').addEventListener('click', () => {
      const id = editingId;
      saveEditor();
      if (id && current && current.id === id) openSong(id);
    });
    $('btn-preview').addEventListener('click', renderParseReport);
    $('fixlist').addEventListener('click', (e) => {
      const b = e.target.closest('.fixchip');
      if (b) jumpToMark(Number(b.dataset.i), b);
    });

    $('btn-lookup').addEventListener('click', runLookup);
    $('lookup').addEventListener('click', (e) => {
      const b = e.target.closest('.lookup__item');
      if (!b) return;
      const h = lookupHits[Number(b.dataset.i)];
      if (!h) return;
      $('f-title').value = h.title;
      $('f-artist').value = h.artist;
      $('lookup').hidden = true;
      toast('曲名を入れ替えました');
    });

    $('btn-ocr').addEventListener('click', () => $('ocr-file').click());
    $('ocr-file').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      // 名前順に並べて、1枚ずつ順番に読む
      files.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
      for (let i = 0; i < files.length; i++) await runOcr(files[i], i, files.length);
    });
    $('parse-report').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="restore"]')) restorePasted();
      if (e.target.closest('[data-act="doclean"]')) applyClean();
    });
    $('f-body').addEventListener('input', () => {
      // 手で直した後に「貼ったままに戻す」を押すと、その修正が消えてしまうので取り下げる
      if (pastedRaw != null && lastClean && $('f-body').value !== lastClean.text) {
        pastedRaw = null;
        lastClean = null;
        if (!$('parse-report').hidden) renderParseReport();
      }
    });
    // 編集画面にいる間は、どこで貼り付けても画像を受け取る
    document.addEventListener('paste', (e) => {
      if (!$('screen-edit').classList.contains('is-active')) return;
      const img = imageFromClipboard(e);
      if (!img) return;
      e.preventDefault();
      runOcr(img, 0, 1);
    });

    $('f-body').addEventListener('paste', (e) => {
      if (imageFromClipboard(e)) return;      // 画像は上の処理にまかせる
      let pasted = '';
      try { pasted = ((e.clipboardData || window.clipboardData).getData('text') || ''); } catch (err) {}
      // 貼り付け後の内容で判断したいので次のフレームまで待つ
      setTimeout(() => {
        const now = $('f-body').value;
        // 丸ごと置き換わった時だけ自動で取り出す（一部だけの貼り付けを刈らないため）
        if (pasted && now.trim() === pasted.trim()) applyClean();
        else renderParseReport();
      }, 0);
    });
    $('btn-paste').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast('クリップボードが空です'); return; }
        $('f-body').value = text;
        applyClean();
      } catch (e) {
        toast('貼り付けできませんでした。枠を長押しして貼り付けてください');
      }
    });
    $('btn-delete').addEventListener('click', () => {
      if (!editingId) return;
      if (!confirm('この曲を削除します。元に戻せません。')) return;
      songs = songs.filter(s => s.id !== editingId);
      saveSongs();
      renderLibrary();
      current = null;
      show('library');
      toast('削除しました');
    });

    $('btn-back').addEventListener('click', () => { show('library'); renderLibrary(); });

    $('toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) onToolbarAction(b.dataset.act);
    });
    $('btn-toolbar-toggle').addEventListener('click', () => {
      $('toolbar').classList.toggle('is-collapsed');
    });
    $('btn-scroll').addEventListener('click', () => { rafId ? stopScroll() : startScroll(); });
    $('scroll-speed').addEventListener('input', (e) => {
      prefs.speed = Number(e.target.value);
      $('scroll-speed-label').textContent = prefs.speed;
      savePrefs();
    });

    // 譜面のコードをタップ
    $('sheet').addEventListener('click', (e) => {
      const ch = e.target.closest('.seg__ch--tap');
      if (ch) openChordSheet(ch.dataset.chord);
    });
    // 譜面を手で触ったら自動スクロールは止める
    $('sheet').addEventListener('touchstart', () => { if (rafId) stopScroll(); }, { passive: true });
    $('sheet').addEventListener('wheel',      () => { if (rafId) stopScroll(); }, { passive: true });

    $('cs-close').addEventListener('click', closeChordSheet);
    $('backdrop').addEventListener('click', closeChordSheet);

    $('import-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importBackup(f);
      e.target.value = '';
    });

    window.addEventListener('keydown', (e) => {
      if (!$('screen-view').classList.contains('is-active')) return;
      if (e.key === 'Escape') { closeChordSheet(); return; }
      if (e.key === ' ') { e.preventDefault(); rafId ? stopScroll() : startScroll(); }
    });
  }

  /* ══════════ 起動 ══════════ */

  loadAll();
  applyTheme();
  bind();
  renderLibrary();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
