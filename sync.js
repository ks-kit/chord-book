/* sync.js — Dropbox を使った端末間の曲データ同期
   依存なし → グローバル Sync を公開する。

   ■ 置き場所
     Dropbox の「アプリ専用フォルダ」（/アプリ/<アプリ名>/songs.json）。
     このアプリが触れるのはそのフォルダだけで、Dropbox の他のファイルは見えない。

   ■ 認証（PKCE）
     ブラウザだけのアプリは秘密鍵を安全に持てないので、Dropbox 公式の PKCE 方式を使う。
     App key は公開してよい値。秘密鍵は使わない。
     手順とパラメータは Dropbox 公式 SDK（dropbox-sdk-js の src/auth.js）で確認した。

   ■ まとめ方
     曲ごとに updatedAt が新しいほうを採用する（後から書いた方が勝つ）。
     削除は「消した印（deleted: true）」を残して他の端末へ伝え、90日たったら捨てる。
     他の端末と書き込みが重なったら、Dropbox の rev で気づいて取り直す。 */
const Sync = (() => {
  'use strict';

  /* Dropbox の開発者ページで作ったアプリの App key。公開してよい値。
     空のときは、画面から貼り付けた値（端末ごとに保存）を使う。 */
  const APP_KEY = '';

  const AUTH_URL  = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const API_URL   = 'https://api.dropboxapi.com/2/';
  const CONTENT_URL = 'https://content.dropboxapi.com/2/';

  const KEY_AUTH     = 'chordbook.dropbox.auth.v1';
  const KEY_APPKEY   = 'chordbook.dropbox.appkey.v1';
  const KEY_VERIFIER = 'chordbook.dropbox.verifier.v1';
  const KEY_STATE    = 'chordbook.sync.state.v1';

  const REMOTE_PATH = '/songs.json';
  const TOMBSTONE_DAYS = 90;

  /* ───────── 保存まわり ───────── */

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function write(key, val) {
    try {
      if (val == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* 保存できなくても続行 */ }
  }

  function appKey() {
    return APP_KEY || read(KEY_APPKEY) || '';
  }
  function setAppKey(k) {
    const v = String(k || '').trim();
    write(KEY_APPKEY, v || null);
    return v;
  }

  function configured() { return !!appKey(); }
  function connected() {
    const a = read(KEY_AUTH);
    return !!(a && a.refresh_token);
  }

  function state() { return read(KEY_STATE) || {}; }
  function setState(patch) { write(KEY_STATE, Object.assign(state(), patch)); }

  /** 戻り先。index.html の有無で揺れないよう、フォルダの URL にそろえる */
  function redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  /** ホーム画面に置いたアプリとして動いているか（iPhone は保存領域が Safari と別になる） */
  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    } catch (e) { return false; }
  }

  /* ───────── PKCE ───────── */

  function base64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function newVerifier() {
    const b = new Uint8Array(64);
    crypto.getRandomValues(b);
    return base64url(b).slice(0, 128);
  }

  async function challengeOf(verifier) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(hash));
  }

  /**
   * 接続を始める。
   *   useRedirect=true  … Dropbox の画面からこのアプリへ自動で戻る（PC のブラウザ向け）
   *   useRedirect=false … Dropbox の画面に出るコードを、アプリに貼り付けてもらう
   *                       （iPhone のホーム画面アプリは戻り先が Safari になり、
   *                         保存領域が別なので自動では戻れない）
   * 戻り値は開くべき URL。
   */
  async function beginConnect(useRedirect) {
    if (!configured()) throw new Error('App key が設定されていません');
    const verifier = newVerifier();
    write(KEY_VERIFIER, { v: verifier, redirect: !!useRedirect, at: Date.now() });
    const params = new URLSearchParams({
      client_id: appKey(),
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge: await challengeOf(verifier),
      code_challenge_method: 'S256'
    });
    if (useRedirect) params.set('redirect_uri', redirectUri());
    return AUTH_URL + '?' + params.toString();
  }

  /** 認可コードをトークンに換える */
  async function exchange(code) {
    const saved = read(KEY_VERIFIER);
    if (!saved || !saved.v) {
      throw new Error('接続の途中の情報が見つかりません。もう一度「接続」からやり直してください');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code).trim(),
      client_id: appKey(),
      code_verifier: saved.v
    });
    // 認可のときに戻り先を付けたなら、交換のときも同じ値を付ける決まり
    if (saved.redirect) body.set('redirect_uri', redirectUri());

    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) {
      throw new Error('Dropbox に接続できませんでした（' + (j.error_description || j.error || ('HTTP ' + r.status)) + '）');
    }
    write(KEY_AUTH, {
      refresh_token: j.refresh_token,
      access_token: j.access_token,
      expires_at: Date.now() + Math.max(0, (j.expires_in || 0) - 60) * 1000
    });
    write(KEY_VERIFIER, null);
    setState({ lastError: null, connectedAt: Date.now() });
    return true;
  }

  /** Dropbox から戻ってきたときの URL（?code=...）を処理する。何も無ければ null */
  async function handleRedirect() {
    const u = new URL(location.href);
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    if (!code && !err) return null;

    // 認可コードを URL に残さない
    ['code', 'state', 'error', 'error_description'].forEach(k => u.searchParams.delete(k));
    history.replaceState(null, '', u.pathname + u.search + u.hash);

    if (err) {
      throw new Error(err === 'access_denied' ? '接続がキャンセルされました' : ('Dropbox から戻れませんでした（' + err + '）'));
    }
    await exchange(code);
    return true;
  }

  /** 使える状態のアクセストークン。期限切れなら更新する */
  async function token(force) {
    const a = read(KEY_AUTH);
    if (!a || !a.refresh_token) throw new Error('Dropbox に接続していません');
    if (!force && a.access_token && Date.now() < (a.expires_at || 0)) return a.access_token;

    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: a.refresh_token,
        client_id: appKey()
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      if (j.error === 'invalid_grant') {
        write(KEY_AUTH, null);
        throw new Error('Dropbox との接続が切れました。もう一度接続してください');
      }
      throw new Error('Dropbox の認証を更新できませんでした（' + (j.error_description || j.error || ('HTTP ' + r.status)) + '）');
    }
    a.access_token = j.access_token;
    a.expires_at = Date.now() + Math.max(0, (j.expires_in || 0) - 60) * 1000;
    write(KEY_AUTH, a);
    return a.access_token;
  }

  /** Dropbox-API-Arg ヘッダは ASCII しか通らないので、それ以外は \uXXXX にする（公式 SDK と同じ処理） */
  function argHeader(obj) {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
      c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
  }

  /** 認証つきで呼び出す。トークンが失効していたら1回だけ更新してやり直す */
  async function call(url, init) {
    let t = await token(false);
    let r = await fetch(url, withAuth(init, t));
    if (r.status === 401) {
      t = await token(true);
      r = await fetch(url, withAuth(init, t));
    }
    return r;
  }
  function withAuth(init, t) {
    const h = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + t });
    return Object.assign({}, init, { headers: h });
  }

  async function errorText(r) {
    const j = await r.json().catch(() => null);
    return (j && (j.error_summary || j.error)) || ('HTTP ' + r.status);
  }

  /* ───────── 読み書き ───────── */

  async function download() {
    const r = await call(CONTENT_URL + 'files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': argHeader({ path: REMOTE_PATH }) }
    });
    if (r.status === 409) {
      const msg = await errorText(r);
      if (String(msg).indexOf('path/not_found') === 0) return { songs: [], rev: null };
      throw new Error('Dropbox から読めませんでした（' + msg + '）');
    }
    if (!r.ok) throw new Error('Dropbox から読めませんでした（' + (await errorText(r)) + '）');

    let rev = null;
    try { rev = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}').rev || null; } catch (e) {}
    const data = await r.json().catch(() => null);
    const songs = (data && Array.isArray(data.songs)) ? data.songs : [];
    return { songs, rev };
  }

  async function upload(songs, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await call(CONTENT_URL + 'files/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': argHeader({
          path: REMOTE_PATH, mode, autorename: false, mute: true, strict_conflict: true
        })
      },
      body: JSON.stringify({ app: 'chordbook', version: 1, savedAt: Date.now(), songs })
    });
    if (r.status === 409) {
      const msg = await errorText(r);
      if (/conflict/.test(msg)) return { conflict: true };
      throw new Error('Dropbox に書けませんでした（' + msg + '）');
    }
    if (!r.ok) throw new Error('Dropbox に書けませんでした（' + (await errorText(r)) + '）');
    const meta = await r.json().catch(() => ({}));
    return { rev: meta.rev || null };
  }

  /* ───────── まとめる ───────── */

  /** 曲ごとに新しいほうを採る。同時刻なら手元を優先 */
  function merge(local, remote) {
    const map = new Map();
    for (const s of (remote || [])) {
      if (s && s.id) map.set(s.id, s);
    }
    for (const s of (local || [])) {
      if (!s || !s.id) continue;
      const cur = map.get(s.id);
      if (!cur || (s.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(s.id, s);
    }
    const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
    return Array.from(map.values()).filter(s => !(s.deleted && (s.updatedAt || 0) < cutoff));
  }

  /** 中身が変わったかを軽く見分けるための指紋 */
  function signature(list) {
    return (list || [])
      .map(s => s.id + ':' + (s.updatedAt || 0) + ':' + (s.deleted ? 1 : 0))
      .sort()
      .join('|');
  }

  let running = null;

  /**
   * 同期する。
   *   getLocal()        … 今の手元の曲一覧を返す関数
   *   applyMerged(list) … まとめた結果を手元に反映する関数
   */
  function syncNow(getLocal, applyMerged) {
    if (running) return running;
    running = (async () => {
      setState({ busy: true });
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const remote = await download();
          const local = getLocal();
          const merged = merge(local, remote.songs);

          const needPush = signature(merged) !== signature(remote.songs);
          if (needPush) {
            const up = await upload(merged, remote.rev);
            if (up.conflict) continue;       // 他の端末が先に書いた。読み直してまとめ直す
          }
          const needPull = signature(merged) !== signature(local);
          if (needPull) applyMerged(merged);

          const count = merged.filter(s => !s.deleted).length;
          setState({ lastSync: Date.now(), lastError: null, busy: false, count });
          return { pulled: needPull, pushed: needPush, count };
        }
        throw new Error('ほかの端末と更新が重なりました。少し待ってからもう一度同期してください');
      } catch (e) {
        setState({ lastError: String(e && e.message ? e.message : e), busy: false });
        throw e;
      }
    })();
    return running.finally(() => { running = null; });
  }

  /** 接続を切る（この端末の認証情報を消す。Dropbox 側の曲データは残る） */
  async function disconnect() {
    try {
      const a = read(KEY_AUTH);
      if (a && a.access_token) {
        await fetch(API_URL + 'auth/token/revoke', {
          method: 'POST', headers: { Authorization: 'Bearer ' + a.access_token }
        });
      }
    } catch (e) { /* 取り消しに失敗しても手元は消す */ }
    write(KEY_AUTH, null);
    write(KEY_VERIFIER, null);
    setState({ lastSync: null, lastError: null, busy: false });
  }

  return {
    configured, connected, isStandalone, redirectUri,
    appKey, setAppKey, hasBuiltInKey: () => !!APP_KEY,
    beginConnect, exchange, handleRedirect,
    syncNow, disconnect, state,
    _merge: merge, _signature: signature
  };
})();
