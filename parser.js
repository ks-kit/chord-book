/* parser.js — コピペしたコード譜のテキストを解析する
   「歌詞の上にコードが並ぶ」形式を主対象にする。
   依存: chords.js  → グローバル Sheet を公開する。 */
const Sheet = (() => {
  'use strict';

  // 全角判定（コードの桁位置を歌詞に合わせるため）
  const WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
  const JP_RE = /[ぁ-ゖァ-ヺ一-鿿々ー]/;

  // コード行に混ざっていても許す記号
  const FILLER = new Set([
    '|', '||', '|:', ':|', '/', '//', '///', '////', '%', '-', '–', '—', '~', '〜',
    '→', '>', '.', '·', '×2', '×3', '×4', 'x2', 'x3', 'x4', 'X2', 'X3', 'X4',
    'N.C.', 'NC', 'n.c.', 'repeat', 'Repeat', '*', '＊'
  ]);

  const SECTION_WORDS = /^(intro|verse|chorus|bridge|outro|solo|interlude|pre[\- ]?chorus|hook|riff|ending|coda|a\s*メロ|b\s*メロ|c\s*メロ|d\s*メロ|サビ|大サビ|ラスサビ|間奏|前奏|後奏|イントロ|アウトロ|ソロ|リフ|エンディング|繰り返し)/i;

  function charWidth(ch) { return WIDE_RE.test(ch) ? 2 : 1; }

  function displayWidth(str) {
    let w = 0;
    for (const ch of str) w += charWidth(ch);
    return w;
  }

  function stripWrap(tok) {
    return tok.replace(/^[（(\[【]+/, '').replace(/[）)\]】]+$/, '');
  }

  /** 桁を保ったまま扱いやすくする（全角スペース=幅2、タブ=4桁） */
  function flatten(line) {
    return String(line).replace(/　/g, '  ').replace(/	/g, '    ');
  }

  /** その行がコード行かどうか */
  function isChordLine(line) {
    const s = flatten(line);
    if (!s.trim()) return false;
    if (JP_RE.test(s)) return false;              // 日本語が混ざる行は歌詞
    const tokens = s.trim().split(/\s+/);
    if (tokens.length > 24) return false;
    let chordCount = 0;
    for (const raw of tokens) {
      const t = stripWrap(raw);
      if (!t) continue;
      if (Chords.isChordToken(t)) { chordCount++; continue; }
      if (FILLER.has(t)) continue;
      return false;                                // コードでも記号でもない語がある
    }
    return chordCount > 0;
  }

  function isSectionLine(line) {
    const s = line.trim();
    if (!s) return false;
    if (s.length > 24) return false;
    if (/^[\[【＜<（(※★☆■◆]/.test(s) && !isChordLine(s)) return true;
    if (SECTION_WORDS.test(s.replace(/[\[\]【】()（）:：]/g, '').trim())) return true;
    return false;
  }

  /** コード行から {text, col} の配列を取り出す（col は表示桁） */
  function extractChords(line) {
    const s = flatten(line);
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const token = stripWrap(m[0]);
      const col = displayWidth(s.slice(0, m.index));
      if (Chords.isChordToken(token)) {
        out.push({ text: token, col, filler: false });
      } else if (FILLER.has(token)) {
        out.push({ text: token, col, filler: true });
      }
    }
    return out;
  }

  /** 表示桁 col が、歌詞の何文字目にあたるかを返す */
  function colToIndex(lyric, col) {
    if (col <= 0) return 0;
    let w = 0, i = 0;
    const chars = Array.from(lyric);
    while (i < chars.length) {
      if (w >= col) return i;
      w += charWidth(chars[i]);
      i++;
    }
    return chars.length;
  }

  /** コード列と歌詞から、画面に並べるセグメントを作る */
  function buildSegments(chords, lyric) {
    const chars = Array.from(lyric != null ? lyric : '');
    const segs = [];
    const idxs = chords.map(c => colToIndex(chars.join(''), c.col));

    // 最初のコードより前に歌詞があれば、コード無しのセグメントとして先頭に置く
    if (chords.length === 0) {
      return [{ chord: null, lyric: chars.join('') }];
    }
    if (idxs[0] > 0) {
      segs.push({ chord: null, lyric: chars.slice(0, idxs[0]).join('') });
    }
    for (let i = 0; i < chords.length; i++) {
      const from = idxs[i];
      const to = (i + 1 < chords.length) ? idxs[i + 1] : chars.length;
      segs.push({
        chord: chords[i].filler ? null : chords[i].text,
        filler: chords[i].filler ? chords[i].text : null,
        lyric: chars.slice(from, Math.max(from, to)).join('')
      });
    }
    return segs;
  }

  /**
   * テキスト全体を解析して行の配列にする。
   * 返り値の各要素: {type:'section'|'line'|'blank', ...}
   */
  function parse(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        // 空行の連続は1つにまとめる
        if (out.length && out[out.length - 1].type !== 'blank') out.push({ type: 'blank' });
        i++;
        continue;
      }

      if (isChordLine(line)) {
        const chords = extractChords(line);
        const next = lines[i + 1];
        const hasLyric = next != null && next.trim() && !isChordLine(next) && !isSectionLine(next);
        if (hasLyric) {
          out.push({ type: 'line', segs: buildSegments(chords, next), hasChord: true, hasLyric: true });
          i += 2;
        } else {
          out.push({ type: 'line', segs: buildSegments(chords, ''), hasChord: true, hasLyric: false });
          i += 1;
        }
        continue;
      }

      if (isSectionLine(line)) {
        out.push({ type: 'section', text: line.trim() });
        i++;
        continue;
      }

      out.push({ type: 'line', segs: [{ chord: null, lyric: line.replace(/\s+$/, '') }], hasChord: false, hasLyric: true });
      i++;
    }

    // 末尾の空行を落とす
    while (out.length && out[out.length - 1].type === 'blank') out.pop();
    return out;
  }

  /** 使われているコードを出現順に並べて返す */
  function chordList(parsed) {
    const seen = new Set(), list = [];
    for (const row of parsed) {
      if (row.type !== 'line') continue;
      for (const s of row.segs) {
        if (s.chord && !seen.has(s.chord)) { seen.add(s.chord); list.push(s.chord); }
      }
    }
    return list;
  }

  /** 曲のキーを推定する（終止和音を優先して素朴に判定） */
  function guessKey(parsed) {
    let firstChord = null, lastChord = null;
    for (const row of parsed) {
      if (row.type !== 'line') continue;
      for (const s of row.segs) {
        if (!s.chord) continue;
        if (!firstChord) firstChord = s.chord;
        lastChord = s.chord;                       // 譜面上で最後に鳴るコード
      }
    }
    if (!lastChord) return null;
    const pick = Chords.parse(lastChord) || Chords.parse(firstChord);
    if (!pick) return null;
    const minor = /^(m|min|-)/.test(pick.quality) && !/^(maj|M7)/.test(pick.quality);
    return { root: pick.root, minor };
  }


  /* ───────── 貼り付けたページ全体から譜面だけを取り出す ───────── */

  // 単独で出てきたら譜面ではない行（サイトのボタンや見出し）
  const NOISE_RE = /^(広告|PR|スポンサー|Advertisement|関連曲|関連動画|おすすめ|ランキング|お気に入り|お気に入りに追加|印刷|印刷する|ログイン|ログアウト|会員登録|新規登録|もっと見る|もっと読む|続きを読む|閉じる|戻る|次へ|前へ|共有|シェア|ツイート|コピー|コピーしました|メニュー|検索|ホーム|トップ|一覧|全て|すべて|設定|ヘルプ|お問い合わせ|利用規約|プライバシーポリシー|Cookie|クッキー|[×✕✖◀▶▲▼←→↑↓]|\d+|[A-Za-z]{1,3})$/;

  function isNoiseLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (isChordLine(t)) return false;
    return NOISE_RE.test(t);
  }

  /**
   * ページごとコピーしたテキストから、コード譜の部分だけを抜き出す。
   * 返り値: {text, removed, titles}
   *   text    … 取り出した譜面
   *   removed … 捨てた行数
   *   titles  … 曲名らしき候補（譜面に近い順）
   */
  function clean(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n').map(l => l.replace(/\t/g, '    ').replace(/[ \u00a0]+$/, ''));

    // コード行の位置を集める
    const idx = [];
    lines.forEach((l, i) => { if (isChordLine(l)) idx.push(i); });
    if (idx.length < 2) {
      return { text: raw.trim(), removed: 0, titles: [] };   // 判断できないので触らない
    }

    // 離れているところで区切り、コード行が一番多い塊を譜面とみなす
    const GAP = 24;
    const groups = [];
    let cur = [idx[0]];
    for (let k = 1; k < idx.length; k++) {
      if (idx[k] - idx[k - 1] > GAP) { groups.push(cur); cur = [idx[k]]; }
      else cur.push(idx[k]);
    }
    groups.push(cur);
    groups.sort((a, b) => b.length - a.length);
    const g = groups[0];

    let start = g[0];
    let end = g[g.length - 1];

    // 最後のコード行に続く歌詞行は残す
    while (end + 1 < lines.length) {
      const nx = lines[end + 1];
      if (!nx.trim() || isChordLine(nx) || isSectionLine(nx) || isNoiseLine(nx)) break;
      end++;
      break;                                   // 歌詞は1行だけ拾う
    }
    // 直前にセクション見出しがあれば含める
    while (start > 0 && isSectionLine(lines[start - 1])) start--;

    // 曲名の候補を、譜面の手前から近い順に拾う
    const titles = [];
    for (let i = start - 1; i >= Math.max(0, start - 15) && titles.length < 4; i--) {
      const t = lines[i].trim();
      if (!t || t.length > 40) continue;
      if (isChordLine(t) || isSectionLine(t) || isNoiseLine(t)) continue;
      if (/^(カポ|capo|key|キー|コード|テンポ|bpm|演奏|楽器)/i.test(t)) continue;
      titles.push(t);
    }
    titles.sort((a, b) => (b.includes('/') || b.includes('／') ? 1 : 0) - (a.includes('/') || a.includes('／') ? 1 : 0));

    // 範囲内に紛れたボタン類を落とす
    const kept = lines.slice(start, end + 1).filter(l => !isNoiseLine(l));

    // 共通の字下げを取り除く（桁のずれを防ぐため全行そろえて削る）
    const indents = kept.filter(l => l.trim()).map(l => l.match(/^ */)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    const out = kept.map(l => l.slice(cut));

    const result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const removed = lines.filter(l => l.trim()).length -
                    result.split('\n').filter(l => l.trim()).length;
    return { text: result, removed: Math.max(0, removed), titles };
  }

  /** タイトル・アーティストらしき行を本文の先頭から拾う */
  function sniffMeta(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const meta = { title: '', artist: '' };
    for (let i = 0; i < Math.min(6, lines.length); i++) {
      const s = lines[i].trim();
      if (!s) continue;
      const m = /^(.+?)\s*[\/／]\s*(.+)$/.exec(s);
      if (m && !isChordLine(s)) { meta.title = m[1].trim(); meta.artist = m[2].trim(); break; }
      if (!meta.title && !isChordLine(s) && !isSectionLine(s) && s.length <= 40) { meta.title = s; }
    }
    return meta;
  }

  return { parse, clean, chordList, guessKey, sniffMeta, isChordLine, isSectionLine, displayWidth };
})();
