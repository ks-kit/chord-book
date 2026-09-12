/* chords.js — コード名の解析・移調・押さえ方図の生成
   依存なし。グローバル Chords を公開する。 */
const Chords = (() => {
  'use strict';

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  const NOTE_INDEX = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'Fb': 4,
    'E#': 5, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8,
    'A': 9, 'A#': 10, 'Bb': 10, 'B': 11, 'Cb': 11, 'B#': 0
  };

  /* コード品質のホワイトリスト。
     ここに無い綴りは「コードではない」と判定する（歌詞行の誤判定を防ぐため）。 */
  const QUALITIES = new Set([
    '', 'M', 'maj', 'major',
    'm', 'min', '-', 'mi',
    '5', '6', '69', '6/9', 'm6', 'min6', 'M6',
    '7', 'maj7', 'M7', 'Maj7', 'ma7', 'Δ', 'Δ7', 'm7', 'min7', 'mi7', '-7',
    'mM7', 'mMaj7', 'mmaj7', 'minmaj7', 'm#7',
    '9', 'maj9', 'M9', 'm9', 'min9', '69',
    '11', 'm11', 'maj11', 'M11', '13', 'm13', 'maj13', 'M13',
    'dim', 'dim7', 'o', 'o7', '°', '°7', 'm7-5', 'm7b5', 'ø', 'ø7', 'min7b5',
    'aug', 'aug7', '+', '+5', '+7', '7+5', '7#5', '7-5', '7b5',
    '7b9', '7#9', '7-9', '7+9', '9#5', '9b5', '13b9', '7b13',
    'sus', 'sus2', 'sus4', '7sus', '7sus4', '7sus2', '9sus4', 'sus4add9',
    'add2', 'add4', 'add9', 'add11', 'madd9', 'm add9', '2', '4',
    'maj7sus4', 'M7sus4', 'maj7#11', 'M7#11', '7#11', 'm6/9', 'm69'
  ]);

  const BODY_RE  = /^([A-G][#b♯♭]?)(.*)$/;
  /* ベース音は小文字で書かれていることもあるので拾えるようにする */
  const SLASH_RE = /^(.+?)\/([A-Ga-g][#b♯♭]?)$/;
  const ON_RE    = /^(.+?)on([A-Ga-g][#b♯♭]?)$/i;

  /**
   * 「Am7/G」「AonC#」などを {root, quality, bass, sep} に分解する。
   * sep は分数コードの区切り方（'/' か 'on'）。元の書き方を保つために覚えておく。
   * コードでなければ null。
   */
  function parse(token) {
    if (!token) return null;
    let t = String(token).trim().replace(/[♯]/g, '#').replace(/[♭]/g, 'b');
    if (!t) return null;
    t = t.replace(/[、,。]+$/, '');          // 末尾の装飾は落とす

    let sep = null, body = t, bassRaw = null;
    let m = SLASH_RE.exec(t);
    if (m) { sep = '/'; body = m[1]; bassRaw = m[2]; }
    else {
      m = ON_RE.exec(t);
      if (m) { sep = 'on'; body = m[1]; bassRaw = m[2]; }
    }

    const mb = BODY_RE.exec(body);
    if (!mb) return null;
    const root = normalizeNote(mb[1]);
    if (root == null) return null;
    const quality = (mb[2] || '').trim();
    if (!QUALITIES.has(quality)) return null;

    let bass = null;
    if (bassRaw) {
      bass = normalizeNote(bassRaw);
      if (bass == null) return null;
    }
    return { root, quality, bass, sep, text: build(root, quality, bass, sep) };
  }

  /** 元の区切り方（/ または on）を保ったままコード名を組み立てる */
  function build(root, quality, bass, sep) {
    return root + quality + (bass ? (sep === 'on' ? 'on' : '/') + bass : '');
  }

  function normalizeNote(n) {
    if (!n) return null;
    const s = n[0].toUpperCase() + n.slice(1).replace(/♯/g, '#').replace(/♭/g, 'b');
    return (s in NOTE_INDEX) ? s : null;
  }

  function isChordToken(token) {
    return parse(token) !== null;
  }

  /** 半音単位で移調した表記を返す。preferFlat で ♭表記に寄せる。 */
  function transpose(chordObj, semitones, preferFlat) {
    if (!chordObj) return null;
    const names = preferFlat ? FLAT : SHARP;
    const shift = (i) => names[((NOTE_INDEX[i] + semitones) % 12 + 12) % 12];
    const root = shift(chordObj.root);
    const bass = chordObj.bass ? shift(chordObj.bass) : null;
    return {
      root, quality: chordObj.quality, bass, sep: chordObj.sep,
      text: build(root, chordObj.quality, bass, chordObj.sep)
    };
  }

  function transposeText(token, semitones, preferFlat) {
    const c = parse(token);
    if (!c) return token;
    return transpose(c, semitones, preferFlat).text;
  }

  /** 半音数からキー名（メジャー基準）を返す。 */
  function noteName(index, preferFlat) {
    const names = preferFlat ? FLAT : SHARP;
    return names[((index % 12) + 12) % 12];
  }

  /* ───────── 押さえ方図 ─────────
     frets は 6弦→1弦 の順。-1 = ミュート、0 = 開放。 */

  const OPEN_SHAPES = {
    'C':      [-1, 3, 2, 0, 1, 0],
    'C7':     [-1, 3, 2, 3, 1, 0],
    'Cmaj7':  [-1, 3, 2, 0, 0, 0],
    'C6':     [-1, 3, 2, 2, 1, 0],
    'Cadd9':  [-1, 3, 2, 0, 3, 0],
    'Csus4':  [-1, 3, 3, 0, 1, 1],
    'D':      [-1, -1, 0, 2, 3, 2],
    'D7':     [-1, -1, 0, 2, 1, 2],
    'Dmaj7':  [-1, -1, 0, 2, 2, 2],
    'Dm':     [-1, -1, 0, 2, 3, 1],
    'Dm7':    [-1, -1, 0, 2, 1, 1],
    'D6':     [-1, -1, 0, 2, 0, 2],
    'Dsus4':  [-1, -1, 0, 2, 3, 3],
    'Dsus2':  [-1, -1, 0, 2, 3, 0],
    'Dadd9':  [-1, -1, 0, 2, 3, 0],
    'E':      [0, 2, 2, 1, 0, 0],
    'E7':     [0, 2, 0, 1, 0, 0],
    'Emaj7':  [0, 2, 1, 1, 0, 0],
    'Em':     [0, 2, 2, 0, 0, 0],
    'Em7':    [0, 2, 0, 0, 0, 0],
    'Esus4':  [0, 2, 2, 2, 0, 0],
    'Eadd9':  [0, 2, 4, 1, 0, 0],
    'F':      [1, 3, 3, 2, 1, 1],
    'Fmaj7':  [-1, -1, 3, 2, 1, 0],
    'F6':     [-1, -1, 3, 2, 3, 1],
    'G':      [3, 2, 0, 0, 0, 3],
    'G7':     [3, 2, 0, 0, 0, 1],
    'Gmaj7':  [3, 2, 0, 0, 0, 2],
    'G6':     [3, 2, 0, 0, 0, 0],
    'Gsus4':  [3, 3, 0, 0, 1, 3],
    'Gadd9':  [3, 0, 0, 2, 0, 3],
    'A':      [-1, 0, 2, 2, 2, 0],
    'A7':     [-1, 0, 2, 0, 2, 0],
    'Amaj7':  [-1, 0, 2, 1, 2, 0],
    'Am':     [-1, 0, 2, 2, 1, 0],
    'Am7':    [-1, 0, 2, 0, 1, 0],
    'Asus4':  [-1, 0, 2, 2, 3, 0],
    'Asus2':  [-1, 0, 2, 2, 0, 0],
    'Aadd9':  [-1, 0, 2, 4, 2, 0],
    'B7':     [-1, 2, 1, 2, 0, 2],
    'Bm':     [-1, 2, 4, 4, 3, 2],
    'Bm7':    [-1, 2, 0, 2, 0, 2],
    // よく出る分数コード
    'C/G':    [3, 3, 2, 0, 1, 0],
    'C/E':    [0, 3, 2, 0, 1, 0],
    'D/F#':   [2, 0, 0, 2, 3, 2],
    'D/A':    [-1, 0, 0, 2, 3, 2],
    'G/B':    [-1, 2, 0, 0, 3, 3],
    'F/C':    [-1, 3, 3, 2, 1, 1],
    'Am/G':   [3, 0, 2, 2, 1, 0],
    'Em/B':   [-1, 2, 2, 0, 0, 0],
    'A/C#':   [-1, 4, 2, 2, 2, 0],
    'E/G#':   [4, 2, 2, 1, 0, 0]
  };

  /* 辞書の中でバレーを使う形（fret = バレーするフレット、from..to = 弦の範囲 / 0=6弦） */
  const OPEN_BARRE = {
    'F':    { fret: 1, from: 0, to: 5 },
    'F/C':  { fret: 1, from: 1, to: 5 },
    'Bm':   { fret: 2, from: 1, to: 5 },
    'Csus4':{ fret: 1, from: 4, to: 5 }
  };

  /* バレーコードの相対形。0 = 人差し指のバレー位置。 */
  const E_SHAPES = {
    '':      [0, 2, 2, 1, 0, 0],
    'm':     [0, 2, 2, 0, 0, 0],
    '7':     [0, 2, 0, 1, 0, 0],
    'm7':    [0, 2, 0, 0, 0, 0],
    'maj7':  [0, 2, 1, 1, 0, 0],
    'sus4':  [0, 2, 2, 2, 0, 0],
    '6':     [0, 2, 2, 1, 2, 0],
    'm6':    [0, 2, 2, 0, 2, 0],
    '9':     [0, 2, 0, 1, 0, 2],
    'm9':    [0, 2, 0, 0, 0, 2],
    'dim':   [0, 1, 2, 0, -1, -1],
    'aug':   [0, 3, 2, 1, 1, 0],
    'm7b5':  [0, 1, 0, 0, -1, -1],
    'sus2':  [0, 2, 4, 4, 0, 0]
  };

  const A_SHAPES = {
    '':      [-1, 0, 2, 2, 2, 0],
    'm':     [-1, 0, 2, 2, 1, 0],
    '7':     [-1, 0, 2, 0, 2, 0],
    'm7':    [-1, 0, 2, 0, 1, 0],
    'maj7':  [-1, 0, 2, 1, 2, 0],
    'sus4':  [-1, 0, 2, 2, 3, 0],
    '6':     [-1, 0, 2, 2, 2, 2],
    'm6':    [-1, 0, 2, 2, 1, 2],
    '9':     [-1, 0, 1, 0, 2, 0],
    'm9':    [-1, 0, 1, 0, 1, 0],
    'dim':   [-1, 0, 1, 2, 1, -1],
    'aug':   [-1, 0, 3, 2, 2, 1],
    'm7b5':  [-1, 0, 1, 0, 1, -1],
    'sus2':  [-1, 0, 2, 2, 0, 0]
  };

  /* 表記ゆれをバレー形のキーに寄せる */
  const QUALITY_ALIAS = {
    '': '', 'M': '', 'maj': '', 'major': '',
    'm': 'm', 'min': 'm', '-': 'm', 'mi': 'm',
    '7': '7', 'maj7': 'maj7', 'M7': 'maj7', 'Maj7': 'maj7', 'ma7': 'maj7', 'Δ7': 'maj7', 'Δ': 'maj7',
    'm7': 'm7', 'min7': 'm7', 'mi7': 'm7', '-7': 'm7',
    'sus4': 'sus4', 'sus': 'sus4', '4': 'sus4', 'sus2': 'sus2', '2': 'sus2',
    '6': '6', 'M6': '6', 'm6': 'm6', 'min6': 'm6',
    '9': '9', 'm9': 'm9', 'min9': 'm9',
    'dim': 'dim', 'dim7': 'dim', 'o': 'dim', 'o7': 'dim', '°': 'dim', '°7': 'dim',
    'aug': 'aug', '+': 'aug', '+5': 'aug',
    'm7b5': 'm7b5', 'm7-5': 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', 'min7b5': 'm7b5',
    '7sus4': '7', '9sus4': '7', 'add9': '', 'add2': '', 'madd9': 'm',
    '11': '9', 'm11': 'm9', '13': '9', 'm13': 'm9', 'maj9': 'maj7', 'M9': 'maj7'
  };

  /* 開放弦の音（6弦→1弦）。ベース音を鳴らす弦を探すのに使う。
     OPEN_MIDI は実際の音の高さ。弦の番号だけで「低い音」を判断すると、
     5弦6フレット(Eb)より4弦開放(D)のほうが低い、という取り違えが起きる。 */
  const OPEN_MIDI  = [40, 45, 50, 55, 59, 64];   // E A D G B E
  const OPEN_PITCH = OPEN_MIDI.map(p => p % 12);

  /** バレーで押さえ方を作る（ベースは考えない） */
  function barreShape(c) {
    const q = QUALITY_ALIAS[c.quality];
    if (q === undefined) return null;
    const rootIdx = NOTE_INDEX[c.root];

    const candidates = [];
    if (E_SHAPES[q]) {
      const fret = ((rootIdx - 4) % 12 + 12) % 12;   // 6弦開放 = E
      candidates.push({ base: fret === 0 ? 12 : fret, rel: E_SHAPES[q], from: 0 });
    }
    if (A_SHAPES[q]) {
      const fret = ((rootIdx - 9) % 12 + 12) % 12;   // 5弦開放 = A
      candidates.push({ base: fret === 0 ? 12 : fret, rel: A_SHAPES[q], from: 1 });
    }
    if (!candidates.length) return null;

    candidates.sort((a, b) => a.base - b.base);
    const pick = candidates[0];
    const frets = pick.rel.map(f => (f < 0 ? -1 : f + pick.base));
    // 人差し指でバレーする範囲（相対0のところ）
    let to = -1;
    for (let i = 5; i >= 0; i--) { if (pick.rel[i] === 0) { to = i; break; } }
    return { frets, barre: (to > pick.from) ? { fret: pick.base, from: pick.from, to } : null };
  }

  /**
   * 指定のベース音が一番低く鳴るように押さえ方を組み替える。
   * ベース音を出せる弦を探し、それより低い弦は鳴らさない。
   * どうしても無理なら null（その時だけベースを省く）。
   */
  function applyBass(frets, bassPC, rootPC) {
    const played = frets.filter(f => f > 0);
    const lo = played.length ? Math.min(...played) : 0;
    const hi = played.length ? Math.max(...played) : 0;

    const results = [];
    for (let i = 0; i < 6; i++) {
      const need = ((bassPC - OPEN_PITCH[i]) % 12 + 12) % 12;
      for (const f of [need, need + 12]) {
        if (f > 14) continue;
        // 手が届く範囲に収まるか（開放弦はいつでも可）
        if (f > 0 && played.length && Math.max(hi, f) - Math.min(lo, f) > 4) continue;

        const out = frets.slice();
        out[i] = f;
        // ベースより低く鳴ってしまう弦は、弦の番号に関係なく鳴らさない
        const bassPitch = OPEN_MIDI[i] + f;
        for (let k = 0; k < 6; k++) {
          if (k === i) continue;
          if (out[k] >= 0 && OPEN_MIDI[k] + out[k] < bassPitch) out[k] = -1;
        }

        const sounding = out.filter(x => x >= 0);
        if (sounding.length < 3) continue;         // 弦が減りすぎた形は採らない

        const pcs = new Set();
        out.forEach((x, k) => { if (x >= 0) pcs.add((OPEN_PITCH[k] + x) % 12); });

        const fs = sounding.filter(x => x > 0);
        const span = fs.length ? Math.max(...fs) - Math.min(...fs) : 0;

        results.push({ out, i, f, open: f === 0, n: sounding.length,
                       span, hasRoot: pcs.has(rootPC) });
      }
    }
    if (!results.length) return null;

    /* ベース弦を高い位置に取るとコードのルートまで消えてしまう（AonG に A が無い等）ので、
       ルートが残ることを最優先する。
       そのうえで弾きやすさを見る。弦の本数を重く見すぎると
       GonA が「6弦5フレット＋Gの形」という押さえにくい形になるため、
       開放弦でベースが出せることを厚めに評価し、指の開きは減点する。 */
    const score = (x) =>
      (x.hasRoot ? 100 : 0) + x.n * 1.5 + (x.open ? 6 : 0) +
      (5 - x.i) * 2 - x.f * 0.3 - x.span * 0.8;
    results.sort((a, b) => score(b) - score(a));
    return results[0].out;
  }

  /**
   * ベース弦を置き換えたせいでコードのルートが消えた場合に、
   * より高い弦で鳴らし直す（Am7/D のようにルートが1本しか無い形で起きる）。
   */
  function ensureRoot(frets, rootPC) {
    const has = frets.some((f, i) => f >= 0 && (OPEN_PITCH[i] + f) % 12 === rootPC);
    if (has) return frets;

    /* 今のベース音（一番低く鳴っている音）より下に足さない。
       そして、ベースを押さえている弦そのものは絶対に書き換えない
       （書き換えるとベースが消える。F9onE で実際に起きた）。 */
    let bassPitch = Infinity, bassIdx = -1;
    frets.forEach((f, i) => {
      if (f < 0) return;
      const p = OPEN_MIDI[i] + f;
      if (p < bassPitch) { bassPitch = p; bassIdx = i; }
    });
    if (bassIdx < 0) return frets;

    const played = frets.filter(f => f > 0);
    const lo = played.length ? Math.min(...played) : 0;
    const hi = played.length ? Math.max(...played) : 0;

    const cands = [];
    for (let i = 0; i < 6; i++) {
      if (i === bassIdx) continue;                       // ベースの弦は触らない
      const need = ((rootPC - OPEN_PITCH[i]) % 12 + 12) % 12;
      for (const f of [need, need + 12]) {
        if (f > 14) continue;
        if (OPEN_MIDI[i] + f < bassPitch) continue;      // ベースより低くなる場所は使わない
        if (f > 0 && played.length && Math.max(hi, f) - Math.min(lo, f) > 4) continue;
        cands.push({ i, f });
      }
    }
    if (!cands.length) return frets;

    cands.sort((a, b) => (a.f - b.f) || (a.i - b.i));   // 低いフレット・低い弦から
    const out = frets.slice();
    out[cands[0].i] = cands[0].f;
    return out;
  }

  /** 弦を組み替えたあとのバレー範囲を引き直す */
  function fixBarre(frets, barre) {
    if (!barre) return null;
    const idxs = [];
    frets.forEach((f, i) => { if (f === barre.fret) idxs.push(i); });
    if (idxs.length < 2) return null;
    return { fret: barre.fret, from: idxs[0], to: idxs[idxs.length - 1] };
  }

  /** コード名から押さえ方を返す。{frets, baseFret, exact, barre} / 見つからなければ null */
  function shape(name) {
    const c = parse(name);
    if (!c) return null;

    // 1) 辞書に完全一致があればそれを使う
    const canonical = c.root + c.quality + (c.bass ? '/' + c.bass : '');
    if (OPEN_SHAPES[canonical]) {
      return normalizeShape(OPEN_SHAPES[canonical], true, OPEN_BARRE[canonical]);
    }

    // 2) 本体（ベース抜き）の押さえ方を用意する
    const body = c.root + c.quality;
    let frets, barre;
    if (OPEN_SHAPES[body]) {
      frets = OPEN_SHAPES[body].slice();
      barre = OPEN_BARRE[body] || null;
    } else {
      const gen = barreShape(c);
      if (!gen) return null;
      frets = gen.frets;
      barre = gen.barre;
    }

    if (!c.bass) return normalizeShape(frets, true, barre);

    // 3) 分数コードは、ベース音が一番低く鳴るように組み替える
    let withBass = applyBass(frets, NOTE_INDEX[c.bass], NOTE_INDEX[c.root]);
    if (!withBass) return normalizeShape(frets, false, barre);
    withBass = ensureRoot(withBass, NOTE_INDEX[c.root]);
    return normalizeShape(withBass, true, fixBarre(withBass, barre));
  }

  function normalizeShape(frets, exact, barre) {
    const played = frets.filter(f => f > 0);
    const min = played.length ? Math.min(...played) : 1;
    const max = played.length ? Math.max(...played) : 1;
    // 5フレットの窓に収まらない場合のみ、開始フレットをずらす
    const baseFret = (max > 5) ? min : 1;
    return { frets: frets.slice(), baseFret, exact: !!exact, barre: barre || null };
  }

  /** 押さえ方図の SVG 文字列を返す。 */
  function diagramSVG(name, opt) {
    const o = Object.assign({ width: 132, height: 168 }, opt || {});
    const s = shape(name);
    if (!s) return '';
    const FRETS = 5, STRINGS = 6;
    const padX = 16, padTop = 26, padBottom = 14;
    const w = o.width, h = o.height;
    const gridW = w - padX * 2;
    const gridH = h - padTop - padBottom;
    const dx = gridW / (STRINGS - 1);
    const dy = gridH / FRETS;
    const parts = [];

    parts.push(`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="diagram" role="img" aria-label="${escapeAttr(name)} の押さえ方">`);

    // ナット（1フレットから始まる時は太線）
    if (s.baseFret === 1) {
      parts.push(`<rect x="${padX - 1}" y="${padTop - 4}" width="${gridW + 2}" height="4" class="nut"/>`);
    } else {
      parts.push(`<text x="${padX - 6}" y="${padTop + dy * 0.7}" class="basefret" text-anchor="end">${s.baseFret}</text>`);
    }

    // フレット線
    for (let i = 0; i <= FRETS; i++) {
      const y = padTop + dy * i;
      parts.push(`<line x1="${padX}" y1="${y}" x2="${padX + gridW}" y2="${y}" class="fret"/>`);
    }
    // 弦
    for (let i = 0; i < STRINGS; i++) {
      const x = padX + dx * i;
      parts.push(`<line x1="${x}" y1="${padTop}" x2="${x}" y2="${padTop + gridH}" class="string"/>`);
    }

    // バレー（人差し指で押さえる範囲）
    if (s.barre) {
      const rel = s.barre.fret - s.baseFret + 1;
      const y = padTop + dy * (rel - 0.5);
      parts.push(`<line x1="${padX + dx * s.barre.from}" y1="${y}" x2="${padX + dx * s.barre.to}" y2="${y}" class="barre"/>`);
    }

    // 各弦の印（左から6弦→1弦。frets も 6弦→1弦の順）
    s.frets.forEach((f, i) => {
      const x = padX + dx * i;
      if (f === -1) {
        parts.push(`<text x="${x}" y="${padTop - 8}" class="mark-x" text-anchor="middle">×</text>`);
      } else if (f === 0) {
        parts.push(`<circle cx="${x}" cy="${padTop - 12}" r="4.2" class="mark-o"/>`);
      } else {
        const y = padTop + dy * (f - s.baseFret + 0.5);
        parts.push(`<circle cx="${x}" cy="${y}" r="6.2" class="dot"/>`);
      }
    });

    parts.push('</svg>');
    return parts.join('');
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  return {
    SHARP, FLAT, NOTE_INDEX,
    parse, isChordToken, transpose, transposeText, noteName,
    shape, diagramSVG
  };
})();
