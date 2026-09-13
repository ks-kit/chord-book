/* metronome.js — メトロノームとタップテンポ
   依存なし → グローバル Metronome / TapTempo を公開する。

   発音は Web Audio の時刻で先に予約する（先読みスケジューラ）。
   setInterval の実行タイミングは揺れるので、そこで直接鳴らすとリズムがよれる。
   25ms ごとに「0.1秒先までに鳴らす分」を AudioContext の時刻で予約しておけば、
   タイマーが多少遅れても音は正確な時刻に鳴る。 */
const Metronome = (() => {
  'use strict';

  const LOOKAHEAD_MS = 25;     // 予約処理を回す間隔
  const SCHEDULE_AHEAD = 0.1;  // 何秒先まで予約しておくか

  let ctx = null;
  let timer = null;
  let nextTime = 0;
  let beat = 0;
  let bpm = 90;
  let beats = 4;
  let running = false;
  let rafId = null;
  const queue = [];            // 見た目の点滅用に、予約した拍を覚えておく
  const scheduled = [];        // 実際に予約した発音時刻（検証用に直近分だけ）
  const listeners = [];

  /** 音を出す準備。iPhone ではユーザーの操作の中で呼ぶ必要がある */
  function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('この端末では音を出せません');
      ctx = new AC();
    }
    // iPhone の消音スイッチで鳴らなくなるのを避ける（対応していれば）
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
        navigator.audioSession.type = 'playback';
      }
    } catch (e) { /* 非対応なら諦める */ }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** 1回ぶんのクリック音。小節頭は高く強く */
  function click(time, accent) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1120;
    const peak = accent ? 0.5 : 0.28;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(time);
    o.stop(time + 0.06);
  }

  let resyncs = 0;

  function scheduler() {
    /* 画面が裏に回るなどしてタイマーが大きく遅れると、予約が現在時刻に追いつかない。
       そのまま進めると溜まった拍を一気に鳴らしてしまうので、遅れた分は捨てて合わせ直す。 */
    if (nextTime < ctx.currentTime - 0.2) {
      nextTime = ctx.currentTime + 0.05;
      resyncs++;
    }
    while (nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const accent = beats > 1 && beat === 0;
      click(nextTime, accent);
      queue.push({ beat, time: nextTime });
      scheduled.push(nextTime);
      if (scheduled.length > 64) scheduled.shift();
      nextTime += 60 / bpm;
      beat = (beat + 1) % Math.max(1, beats);
    }
  }

  /** 予約した時刻が来た拍を、見た目に知らせる */
  function drawLoop() {
    if (!running) return;
    const now = ctx.currentTime;
    while (queue.length && queue[0].time <= now) {
      const q = queue.shift();
      for (const fn of listeners) { try { fn(q.beat, beats, q.time); } catch (e) {} }
    }
    rafId = requestAnimationFrame(drawLoop);
  }

  function start() {
    ensureContext();
    if (running) return;
    running = true;
    beat = 0;
    queue.length = 0;
    scheduled.length = 0;
    resyncs = 0;
    nextTime = ctx.currentTime + 0.06;
    scheduler();
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    rafId = requestAnimationFrame(drawLoop);
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    queue.length = 0;
    for (const fn of listeners) { try { fn(-1, beats); } catch (e) {} }
  }

  function setBpm(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return bpm;
    bpm = Math.max(30, Math.min(300, n));
    return bpm;
  }

  function setBeats(v) {
    const n = Math.round(Number(v));
    beats = [1, 2, 3, 4, 5, 6, 7].includes(n) ? n : 4;
    if (beat >= beats) beat = 0;
    return beats;
  }

  /** タップしたときの手応え用。今すぐ1回だけ鳴らす */
  function tick(accent) {
    ensureContext();
    click(ctx.currentTime + 0.005, !!accent);
  }

  return {
    start, stop, setBpm, setBeats, tick,
    isRunning: () => running,
    getBpm: () => bpm,
    getBeats: () => beats,
    onBeat: (fn) => listeners.push(fn),
    _stats: () => ({ scheduled: scheduled.slice(), resyncs, audioNow: ctx ? ctx.currentTime : 0 })
  };
})();


/* ───────── タップテンポ ─────────
   「たん、たん、たん」と叩いた間隔から BPM を出す。
   ・2秒以上あいたら新しく数え直す
   ・直近8回ぶんの間隔を使う
   ・中央値から大きく外れた間隔（叩き損ね）は除いて平均する */
const TapTempo = (() => {
  'use strict';

  const RESET_MS = 2000;
  const KEEP = 9;          // 打点を9個＝間隔8個まで覚える
  let taps = [];

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** 1回叩く。BPM が出せれば数値、まだなら null */
  function tap(now) {
    const t = (now == null) ? performance.now() : now;
    if (taps.length && t - taps[taps.length - 1] > RESET_MS) taps = [];
    taps.push(t);
    if (taps.length > KEEP) taps.shift();
    return current();
  }

  function current() {
    if (taps.length < 2) return null;
    const iv = [];
    for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
    const med = median(iv);
    const good = iv.filter(x => Math.abs(x - med) / med <= 0.25);
    const use = good.length ? good : iv;
    const avg = use.reduce((s, x) => s + x, 0) / use.length;
    const bpm = Math.round(60000 / avg);
    return Math.max(30, Math.min(300, bpm));
  }

  return {
    tap, current,
    count: () => taps.length,
    reset: () => { taps = []; }
  };
})();
