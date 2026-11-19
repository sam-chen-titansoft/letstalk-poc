/* Call Meter: dual-backend (Agora / LiveKit) call measurement page.
 * Measures, per call: join/publish time, accept -> first audible audio, loss, jitter, RTT,
 * Agora end-to-end delay, transport (UDP/TCP, candidate type), audio gaps, reconnects.
 * Callee "join mode" A (join after accept, like the app under study) vs B (pre-join muted on ring).
 */
'use strict';

const SDK_URLS = {
  agora: v => `https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@${v}/AgoraRTC_N-production.js`,
  livekit: 'https://cdn.jsdelivr.net/npm/livekit-client@2.23.0/dist/livekit-client.umd.js',
};

const DEFAULTS = {
  backend: 'agora', role: 'caller', joinMode: 'after-accept', audioSource: 'tone',
  room: 'callmeter-' + Math.random().toString(36).slice(2, 7), scenario: 'Wi-Fi', note: '', device: '',
  agoraVersion: '4.18.1', agoraAppId: '', agoraToken: '', agoraArea: '', agoraProxy: '0',
  lkUrl: '', lkKey: '', lkSecret: '',
  ringSec: 3, talkSec: 20, gapSec: 8, cycles: 30, noAudioSec: 30, levelThr: 0.05,
};
const CFG_KEY = 'callmeter.cfg.v1';
const REC_KEY = 'callmeter.records.v1';
const MAX_RECORDS = 600;

// ---------- small helpers ----------
const $ = id => document.getElementById(id);
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wallClock = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const fmtMs = v => (v == null || isNaN(v)) ? '-' : (v >= 10000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');
const fmtNum = (v, d = 1) => (v == null || isNaN(v)) ? '-' : Number(v).toFixed(d);
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = a => pct(a, 50);
function safeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

// ---------- config ----------
const cfg = Object.assign({}, DEFAULTS, safeGet(CFG_KEY, {}));
const FIELDS = ['backend', 'role', 'joinMode', 'audioSource', 'room', 'scenario', 'note', 'device',
  'agoraVersion', 'agoraAppId', 'agoraToken', 'agoraArea', 'agoraProxy', 'lkUrl', 'lkKey', 'lkSecret',
  'ringSec', 'talkSec', 'gapSec', 'cycles', 'noAudioSec', 'levelThr'];
const RELOAD_FIELDS = new Set(['backend', 'agoraVersion']);
const NUM_FIELDS = new Set(['ringSec', 'talkSec', 'gapSec', 'cycles', 'noAudioSec', 'levelThr']);

// Prefill from the URL hash (never sent to the server), e.g. #appid=…&room=…&role=callee&mode=pre-join
// The hash is removed from the address bar right after it is read. API secrets are deliberately not accepted here.
const HASH_KEYS = {
  appid: 'agoraAppId', token: 'agoraToken', room: 'room', role: 'role', mode: 'joinMode', backend: 'backend', ver: 'agoraVersion',
  area: 'agoraArea', proxy: 'agoraProxy', source: 'audioSource', scenario: 'scenario', device: 'device',
  lkurl: 'lkUrl', lkkey: 'lkKey', ring: 'ringSec', talk: 'talkSec', gap: 'gapSec', cycles: 'cycles',
};
function applyHashConfig() {
  if (!location.hash || location.hash.length < 2) return 0;
  const params = new URLSearchParams(location.hash.slice(1));
  let applied = 0;
  params.forEach((v, k) => {
    const f = HASH_KEYS[k.toLowerCase()];
    if (!f) return;
    // URLSearchParams turns '+' into a space; base64 tokens never contain spaces, so restore them.
    if (f === 'agoraToken' || f === 'agoraAppId') v = v.replace(/ /g, '+');
    cfg[f] = NUM_FIELDS.has(f) ? Number(v) : v;
    applied++;
  });
  if (applied) safeSet(CFG_KEY, cfg);
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  return applied;
}
applyHashConfig();
// Opening a new link while the page is already open only changes the hash (no reload): apply it, then reload
// so the SDK, role and identity all pick up the new settings.
window.addEventListener('hashchange', () => { if (applyHashConfig()) location.reload(); });
const identity = (cfg.role === 'caller' ? 'caller-' : 'callee-') + Math.random().toString(36).slice(2, 8);

// ---------- state ----------
const S = {
  engine: null, phase: 'idle', sdkReady: false,
  cur: null,              // active record (callee: one call; caller: one cycle of the peer)
  session: null,          // caller session (join/publish timings)
  remote: null,           // { mst, play, stop, playing, level }
  an: null,               // analyser
  aud: null,              // level/gap tracking for current record
  sampling: null, noAudioTimer: null,
  live: {}, lastRtt: null, connState: '-', reconnectStart: null,
  loop: null, cycleNo: 0, tone: null, audioCtx: null, wakeLock: null,
  records: safeGet(REC_KEY, []),
  prevIn: null,
};

// ---------- logging ----------
const logLines = [];
function logEvt(name, detail) {
  const line = `${wallClock()} ${name}${detail != null && detail !== '' ? ' ' + detail : ''}`;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  const el = $('log');
  if (el) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }
  if (S.cur) {
    const t = Math.round(now() - S.cur._t0);
    if (S.cur.events.length < 150) S.cur.events.push({ t, name, detail: detail == null ? '' : String(detail) });
  }
}

// ---------- audio ----------
function audioCtx() {
  if (!S.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    S.audioCtx = new AC();
  }
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume().catch(() => {});
  return S.audioCtx;
}

function makeToneTrack() {
  const ctx = audioCtx();
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = cfg.role === 'caller' ? 660 : 880;
  const gain = ctx.createGain();
  gain.gain.value = 0.2;
  const dst = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  osc.start();
  S.tone = osc;
  return dst.stream.getAudioTracks()[0];
}
function stopTone() {
  if (S.tone) { try { S.tone.stop(); } catch (e) { /* already stopped */ } S.tone = null; }
}

async function sourceTrack() {
  if (cfg.audioSource === 'tone') return makeToneTrack();
  if (cfg.audioSource === 'gum') {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return s.getAudioTracks()[0];
  }
  return null; // 'sdk': engine creates its own mic track
}

function attachAnalyser(mst) {
  detachAnalyser();
  const ctx = audioCtx();
  const ms = new MediaStream([mst]);
  // Chromium only feeds remote WebRTC audio into WebAudio when the stream is also attached to a media element.
  const el = new Audio();
  el.muted = true;
  el.srcObject = ms;
  el.play().catch(() => {});
  const src = ctx.createMediaStreamSource(ms);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  S.an = { el, src, an, buf: new Float32Array(an.fftSize) };
}
function detachAnalyser() {
  if (!S.an) return;
  try { S.an.src.disconnect(); } catch (e) { /* ignore */ }
  try { S.an.el.srcObject = null; } catch (e) { /* ignore */ }
  S.an = null;
}
function readLevel() {
  let lvl = 0;
  if (S.an) {
    S.an.an.getFloatTimeDomainData(S.an.buf);
    let sum = 0;
    for (let i = 0; i < S.an.buf.length; i++) sum += S.an.buf[i] * S.an.buf[i];
    lvl = Math.min(1, Math.sqrt(sum / S.an.buf.length) * 3);
  }
  if (S.remote && S.remote.level) {
    try { lvl = Math.max(lvl, S.remote.level() || 0); } catch (e) { /* ignore */ }
  }
  return lvl;
}

function newAud() {
  return { firstAt: null, soundNow: false, soundSince: null, silentSince: null, inGap: false, gaps: [], lastLevel: 0, gapActive: false };
}

// 20 Hz level loop: first-audio detection and gap detection.
const GAP_MIN_MS = 300;
function levelTick() {
  const t = now();
  const lvl = readLevel();
  const thr = Number(cfg.levelThr) || 0.05;
  const a = S.aud;
  $('levelBar').style.width = Math.round(lvl * 100) + '%';
  const suspended = !!(S.audioCtx && S.audioCtx.state !== 'running' && S.phase !== 'idle');
  $('audioWarn').style.display = suspended ? 'block' : 'none';
  if (suspended && !S.warnedSuspended) { S.warnedSuspended = true; logEvt('warn', 'AudioContext 未啟動，聲音偵測會失準'); }
  if (!a) return;
  a.lastLevel = lvl;
  const sound = lvl >= thr;
  if (sound && !a.soundNow) { a.soundSince = t; }
  if (!sound && a.soundNow) { a.silentSince = t; }
  a.soundNow = sound;

  const rec = S.cur;
  if (!rec) return;
  const canHear = cfg.role === 'caller' ? !!rec.acceptAt : (rec.acceptAt && S.remote && S.remote.playing);
  if (!rec.firstAudioAt && canHear && sound) onFirstAudio(t);

  // Gap tracking only makes sense with the continuous test tone.
  if (rec.firstAudioAt && cfg.audioSource === 'tone' && a.gapActive) {
    if (!sound) {
      if (a.silentSince && !a.inGap && t - a.silentSince >= GAP_MIN_MS) a.inGap = true;
    } else if (a.inGap) {
      const ms = t - a.silentSince;
      a.gaps.push({ at: Math.round(a.silentSince - rec._t0), ms: Math.round(ms) });
      logEvt('gap', `${Math.round(ms)} ms`);
      a.inGap = false;
    }
  }
}

function onFirstAudio(t) {
  const rec = S.cur;
  rec.firstAudioAt = t;
  rec.acceptToFirstAudioMs = Math.round(t - rec.acceptAt);
  S.aud.gapActive = true;
  S.aud.silentSince = null;
  setPhase('talking');
  logEvt('first_audio', `${rec.acceptToFirstAudioMs} ms after accept${rec.acceptEstimated ? ' (estimated)' : ''}`);
  if (S.noAudioTimer) { clearTimeout(S.noAudioTimer); S.noAudioTimer = null; }
}

// ---------- transport stats via hooked RTCPeerConnections ----------
async function collectPcStats() {
  let best = null;
  for (const pc of Array.from(window.__pcs || [])) {
    if (pc.connectionState === 'closed' || pc.signalingState === 'closed') { window.__pcs.delete(pc); continue; }
    let rep;
    try { rep = await pc.getStats(); } catch (e) { continue; }
    const byId = new Map();
    rep.forEach(r => byId.set(r.id, r));
    let inbound = null, pair = null;
    rep.forEach(r => {
      if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
        if (!inbound || (r.bytesReceived || 0) > (inbound.bytesReceived || 0)) inbound = r;
      }
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair;
    });
    if (!pair) rep.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
    const local = pair ? byId.get(pair.localCandidateId) : null;
    const c = { inbound, pair, local };
    if (!best || (inbound && (!best.inbound || (inbound.bytesReceived || 0) > (best.inbound.bytesReceived || 0)))) best = c;
  }
  return best;
}

async function sampleTick() {
  if (!S.engine) return;
  let st = null;
  try { st = await collectPcStats(); } catch (e) { /* ignore */ }
  const s = { lossPct: null, jitterMs: null, rttMs: null, kbps: null, proto: null, ctype: null };
  if (st) {
    const t = now();
    if (st.inbound) {
      const ib = st.inbound;
      if (S.prevIn && S.prevIn.id === ib.id) {
        const dRecv = (ib.packetsReceived || 0) - S.prevIn.packetsReceived;
        const dLost = Math.max(0, (ib.packetsLost || 0) - S.prevIn.packetsLost);
        const dBytes = (ib.bytesReceived || 0) - S.prevIn.bytesReceived;
        const dt = (t - S.prevIn.t) / 1000;
        s.lossPct = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : (dRecv === 0 ? null : 0);
        s.kbps = dt > 0 ? (dBytes * 8) / 1000 / dt : null;
      }
      S.prevIn = { id: ib.id, packetsReceived: ib.packetsReceived || 0, packetsLost: ib.packetsLost || 0, bytesReceived: ib.bytesReceived || 0, t };
      if (ib.jitter != null) s.jitterMs = ib.jitter * 1000;
    }
    if (st.pair && st.pair.currentRoundTripTime != null) s.rttMs = st.pair.currentRoundTripTime * 1000;
    if (st.local) {
      s.proto = (st.local.protocol || '').toLowerCase() || null;
      s.ctype = st.local.candidateType || null;
      if (st.local.relayProtocol) s.proto += '/relay-' + st.local.relayProtocol;
    }
  }
  const ex = S.engine.extraStats ? S.engine.extraStats() : {};
  if (s.rttMs == null && ex.sdkRtt != null) s.rttMs = ex.sdkRtt;
  s.e2eMs = ex.e2e != null ? ex.e2e : null;
  s.sdkLossPct = ex.sdkLoss != null ? ex.sdkLoss : null;
  if (s.rttMs != null) S.lastRtt = s.rttMs;
  S.live = Object.assign({}, S.live, s);
  const rec = S.cur;
  if (rec && rec.samples.length < 3600) {
    rec.samples.push({
      t: Math.round(now() - rec._t0), heard: !!rec.firstAudioAt,
      loss: s.lossPct == null ? null : +s.lossPct.toFixed(2), jit: s.jitterMs == null ? null : Math.round(s.jitterMs),
      rtt: s.rttMs == null ? null : Math.round(s.rttMs), kbps: s.kbps == null ? null : +s.kbps.toFixed(1),
      e2e: s.e2eMs, proto: s.proto, ctype: s.ctype, lvl: S.aud ? +S.aud.lastLevel.toFixed(3) : null,
    });
  }
}

function startSampling() {
  if (S.sampling) return;
  S.prevIn = null;
  S.sampling = setInterval(sampleTick, 1000);
}
function stopSampling() {
  if (S.sampling) { clearInterval(S.sampling); S.sampling = null; }
}

// ---------- engine callbacks ----------
const H = {
  event: (n, d) => logEvt(n, d),
  conn(state, reason) {
    S.connState = state;
    logEvt('conn', `${state}${reason ? ' (' + reason + ')' : ''}`);
    const rec = S.cur;
    if (rec && rec.connTrail.length < 40) rec.connTrail.push(state + (reason ? `(${reason})` : ''));
    if (state === 'RECONNECTING') {
      if (!S.reconnectStart) S.reconnectStart = now();
      if (rec) rec.reconnects++;
    } else if (state === 'CONNECTED' && S.reconnectStart) {
      const ms = Math.round(now() - S.reconnectStart);
      S.reconnectStart = null;
      logEvt('recovered', `${ms} ms`);
      if (rec) rec.recoveryMs.push(ms);
    }
  },
  netq(up, down) {
    S.live.netq = `${up} / ${down}`;
    const rec = S.cur;
    if (rec && typeof down === 'number') rec.worstDownQuality = Math.max(rec.worstDownQuality || 0, down);
  },
  remoteTrack(mst, play, stop, level) {
    S.remote = { mst, play, stop, level, playing: false };
    attachAnalyser(mst);
    if (S.cur && !S.cur.remoteTrackAt) S.cur.remoteTrackAt = now();
    logEvt('remote_audio_track');
    if (cfg.role === 'caller' || (S.cur && S.cur.acceptAt)) startPlayback();
  },
  remoteGone() {
    if (S.remote) { try { S.remote.stop(); } catch (e) { /* ignore */ } }
    S.remote = null;
    detachAnalyser();
    if (cfg.role === 'caller' && S.cur) finalize(S.cur.firstAudioAt ? 'ok' : 'remote_left');
  },
  message(m) {
    if (!m || !m.t) return;
    logEvt('msg', m.t + (m.cycle != null ? ' #' + m.cycle : ''));
    if (cfg.role !== 'caller') return;
    if (m.t === 'accept') {
      if (S.cur && S.cur.cycle === m.cycle && !S.cur.result) return; // duplicate accept for the same cycle
      if (S.cur) finalize(S.cur.firstAudioAt ? 'ok' : 'superseded');
      const rec = newRecord('caller');
      rec.cycle = m.cycle;
      rec.joinMode = m.joinMode || rec.joinMode;
      rec.peerScenario = m.scenario || '';
      rec.joinMs = S.session ? S.session.joinMs : null;
      rec.publishMs = S.session ? S.session.publishMs : null;
      const half = (S.lastRtt || 0) / 2;
      rec.acceptAt = now() - (m.sinceAcceptMs || 0) - half;
      rec.acceptEstimated = true;
      S.cur = rec;
      S.aud = newAud();
      // Sound may already be flowing (accept message can arrive just after the audio).
      if (S.remote && S.an) {
        const lvl = readLevel();
        if (lvl >= (Number(cfg.levelThr) || 0.05)) onFirstAudio(Math.max(rec.acceptAt, now() - 50));
      }
      setPhase('connecting');
    } else if (m.t === 'end') {
      if (S.cur && (m.cycle == null || S.cur.cycle === m.cycle)) {
        finalize(S.cur.firstAudioAt ? 'ok' : (m.result || 'no_audio'));
        setPhase('waiting');
      }
    }
  },
};

function startPlayback() {
  if (!S.remote || S.remote.playing) return;
  try { S.remote.play(); } catch (e) { logEvt('play_failed', e.message); }
  S.remote.playing = true;
  if (S.cur && !S.cur.playStartAt) S.cur.playStartAt = now();
}

// ---------- engines ----------
class AgoraEngine {
  constructor() { this.client = null; this.localTrack = null; this.joined = false; }
  label() { return 'agora ' + (window.AgoraRTC && AgoraRTC.VERSION); }
  async makeLocal(mst) {
    this.localTrack = cfg.audioSource === 'sdk'
      ? await AgoraRTC.createMicrophoneAudioTrack()
      : AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: mst });
  }
  async join(channel) {
    if (!cfg.agoraAppId) throw new Error('請先填 Agora App ID');
    if (cfg.agoraArea) {
      try { AgoraRTC.setArea({ areaCode: [cfg.agoraArea] }); logEvt('set_area', cfg.agoraArea); } catch (e) { logEvt('set_area_failed', e.message); }
    }
    const c = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.client = c;
    c.on('connection-state-change', (cur, prev, reason) => H.conn(cur, reason || ''));
    c.on('network-quality', q => H.netq(q.uplinkNetworkQuality, q.downlinkNetworkQuality));
    c.on('exception', e => logEvt('exception', `${e.code} ${e.msg}`));
    c.on('user-joined', u => logEvt('remote_joined', u.uid));
    c.on('user-left', (u, reason) => { logEvt('remote_left', `${u.uid} ${reason || ''}`); H.remoteGone(); });
    c.on('user-published', async (u, mt) => {
      logEvt('remote_published', mt);
      if (mt !== 'audio') return;
      try {
        await c.subscribe(u, 'audio');
        logEvt('subscribed');
        const t = u.audioTrack;
        H.remoteTrack(t.getMediaStreamTrack(), () => t.play(), () => { try { t.stop(); } catch (e) { /* ignore */ } },
          () => (t.getVolumeLevel ? t.getVolumeLevel() : 0));
      } catch (e) { logEvt('subscribe_failed', e.message); }
    });
    c.on('user-unpublished', (u, mt) => { logEvt('remote_unpublished', mt); if (mt === 'audio') H.remoteGone(); });
    c.on('stream-message', (uid, payload) => {
      try { H.message(JSON.parse(new TextDecoder().decode(payload))); } catch (e) { /* ignore */ }
    });
    if (Number(cfg.agoraProxy)) {
      try { c.startProxyServer(Number(cfg.agoraProxy)); logEvt('cloud_proxy', cfg.agoraProxy); } catch (e) { logEvt('cloud_proxy_failed', e.message); }
    }
    // Token: empty for an App-ID-only (testing mode) project; for a project with an App Certificate,
    // a temporary token generated for this channel name with uid 0 (any uid) from the Agora console.
    let uid;
    try {
      uid = await c.join(cfg.agoraAppId, channel, cfg.agoraToken ? cfg.agoraToken.trim() : null, null);
    } catch (e) {
      const m = String(e && e.message || e);
      if (/static key/i.test(m)) throw new Error(m + '（這個 Agora 專案啟用了 App Certificate，需要填臨時 Token，或把專案改成只用 App ID）');
      if (/token/i.test(m)) throw new Error(m + '（Token 無效、過期，或和頻道名稱不符）');
      throw e;
    }
    this.joined = true;
    logEvt('joined', 'uid ' + uid);
  }
  async publish() { await this.client.publish([this.localTrack]); logEvt('published'); }
  async setMuted(m) {
    if (this.localTrack.setMuted) await this.localTrack.setMuted(m);
    else await this.localTrack.setEnabled(!m);
    logEvt(m ? 'muted' : 'unmuted');
  }
  async send(obj) {
    if (!this.client || !this.joined) return;
    try { await this.client.sendStreamMessage(new TextEncoder().encode(JSON.stringify(obj)), true); }
    catch (e) { logEvt('send_failed', e.message); }
  }
  async leave() {
    try { if (this.localTrack) this.localTrack.close(); } catch (e) { /* ignore */ }
    this.localTrack = null;
    try { if (this.client) await this.client.leave(); } catch (e) { /* ignore */ }
    this.client = null;
    this.joined = false;
  }
  extraStats() {
    if (!this.client) return {};
    let ra = {};
    try { ra = this.client.getRemoteAudioStats ? this.client.getRemoteAudioStats() : {}; } catch (e) { /* ignore */ }
    const k = Object.keys(ra)[0];
    const r = k ? ra[k] : {};
    let rtc = {};
    try { rtc = this.client.getRTCStats ? this.client.getRTCStats() : {}; } catch (e) { /* ignore */ }
    return { e2e: r.end2EndDelay, sdkLoss: r.packetLossRate, sdkRtt: rtc.RTT };
  }
}

function b64url(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function liveKitToken(room, id) {
  if (!cfg.lkKey || !cfg.lkSecret) throw new Error('請先填 LiveKit API Key 和 Secret');
  const te = new TextEncoder();
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: cfg.lkKey, sub: id, name: id, nbf: nowSec - 10, exp: nowSec + 6 * 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const data = b64url(te.encode(JSON.stringify(header))) + '.' + b64url(te.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', te.encode(cfg.lkSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(data)));
  return data + '.' + b64url(sig);
}

class LiveKitEngine {
  constructor() { this.room = null; this.localTrack = null; this.joined = false; }
  label() { return 'livekit ' + (window.LivekitClient && LivekitClient.version); }
  async makeLocal(mst) {
    const LK = window.LivekitClient;
    this.localTrack = cfg.audioSource === 'sdk' ? await LK.createLocalAudioTrack() : new LK.LocalAudioTrack(mst, undefined, true);
  }
  async join(roomName) {
    const LK = window.LivekitClient;
    if (!cfg.lkUrl) throw new Error('請先填 LiveKit 伺服器網址');
    const token = await liveKitToken(roomName, identity);
    const room = new LK.Room({ adaptiveStream: false, dynacast: false });
    this.room = room;
    const E = LK.RoomEvent;
    room.on(E.ConnectionStateChanged, s => H.conn(String(s).toUpperCase(), ''));
    room.on(E.Reconnecting, () => logEvt('media_reconnecting'));
    room.on(E.SignalReconnecting, () => logEvt('signal_reconnecting'));
    room.on(E.Reconnected, () => logEvt('reconnected'));
    room.on(E.Disconnected, r => logEvt('disconnected', String(r)));
    room.on(E.ParticipantConnected, p => logEvt('remote_joined', p.identity));
    room.on(E.ParticipantDisconnected, p => { logEvt('remote_left', p.identity); H.remoteGone(); });
    room.on(E.TrackPublished, (pub) => logEvt('remote_published', pub.kind));
    room.on(E.TrackSubscribed, (track, pub, p) => {
      if (track.kind !== 'audio') return;
      logEvt('subscribed');
      H.remoteTrack(track.mediaStreamTrack,
        () => { const el = track.attach(); el.style.display = 'none'; document.body.appendChild(el); },
        () => { try { track.detach().forEach(e => e.remove()); } catch (e) { /* ignore */ } },
        () => (p && typeof p.audioLevel === 'number' ? p.audioLevel : 0));
    });
    room.on(E.TrackUnsubscribed, (track) => { if (track.kind === 'audio') H.remoteGone(); });
    room.on(E.ConnectionQualityChanged, (q, p) => { if (p && p === room.localParticipant) H.netq(q, q); });
    room.on(E.DataReceived, payload => {
      try { H.message(JSON.parse(new TextDecoder().decode(payload))); } catch (e) { /* ignore */ }
    });
    await room.connect(cfg.lkUrl, token, { autoSubscribe: true });
    this.joined = true;
    logEvt('joined', identity);
  }
  async publish() {
    const LK = window.LivekitClient;
    await this.room.localParticipant.publishTrack(this.localTrack, { source: LK.Track.Source.Microphone, dtx: false, red: true });
    logEvt('published');
  }
  async setMuted(m) {
    if (m) await this.localTrack.mute(); else await this.localTrack.unmute();
    logEvt(m ? 'muted' : 'unmuted');
  }
  async send(obj) {
    if (!this.room || !this.joined) return;
    try { await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true }); }
    catch (e) { logEvt('send_failed', e.message); }
  }
  async leave() {
    try { if (this.localTrack) this.localTrack.stop(); } catch (e) { /* ignore */ }
    this.localTrack = null;
    try { if (this.room) await this.room.disconnect(); } catch (e) { /* ignore */ }
    this.room = null;
    this.joined = false;
  }
  extraStats() { return {}; }
  resumeAudio() { try { if (this.room) this.room.startAudio(); } catch (e) { /* ignore */ } }
}

function newEngine() {
  S.engine = cfg.backend === 'livekit' ? new LiveKitEngine() : new AgoraEngine();
  return S.engine;
}

// ---------- records ----------
function newRecord(role) {
  const t0 = now();
  return {
    _t0: t0, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    startedAt: new Date().toISOString(), role, backend: cfg.backend,
    sdk: S.engine ? S.engine.label() : cfg.backend,
    joinMode: cfg.joinMode, audioSource: cfg.audioSource,
    area: cfg.backend === 'agora' ? (cfg.agoraArea || 'default') : '',
    proxy: cfg.backend === 'agora' ? String(cfg.agoraProxy) : '',
    scenario: cfg.scenario, note: cfg.note, device: cfg.device,
    ua: navigator.userAgent.slice(0, 160), cycle: null,
    ringAt: null, acceptAt: null, acceptEstimated: false, joinedAt: null, publishedAt: null,
    remoteTrackAt: null, playStartAt: null, firstAudioAt: null,
    joinMs: null, publishMs: null, acceptToFirstAudioMs: null,
    connTrail: [], reconnects: 0, recoveryMs: [], worstDownQuality: null,
    samples: [], events: [], result: null, error: '',
  };
}

function rel(rec, t) { return t == null ? null : Math.round(t - rec._t0); }

function summarize(rec) {
  const heard = rec.samples.filter(s => s.heard);
  const nums = k => heard.map(s => s[k]).filter(v => v != null && !isNaN(v));
  const protos = [...new Set(heard.map(s => s.proto).filter(Boolean))].join('|');
  const ctypes = [...new Set(heard.map(s => s.ctype).filter(Boolean))].join('|');
  const gaps = (S.aud && S.cur === rec) ? S.aud.gaps : [];
  const loss = nums('loss');
  const rtt = nums('rtt');
  return {
    id: rec.id, startedAt: rec.startedAt, role: rec.role, backend: rec.backend, sdk: rec.sdk,
    joinMode: rec.joinMode, audioSource: rec.audioSource, area: rec.area, proxy: rec.proxy,
    scenario: rec.scenario, peerScenario: rec.peerScenario || '', note: rec.note, device: rec.device, cycle: rec.cycle,
    result: rec.result, error: rec.error,
    acceptToFirstAudioMs: rec.acceptToFirstAudioMs, acceptEstimated: rec.acceptEstimated,
    joinMs: rec.joinMs, publishMs: rec.publishMs,
    ringToJoinedMs: rec.ringAt != null && rec.joinedAt != null ? Math.round(rec.joinedAt - rec.ringAt) : null,
    acceptToJoinedMs: rec.acceptAt != null && rec.joinedAt != null ? Math.round(rec.joinedAt - rec.acceptAt) : null,
    acceptToRemoteTrackMs: rec.acceptAt != null && rec.remoteTrackAt != null ? Math.round(rec.remoteTrackAt - rec.acceptAt) : null,
    talkSeconds: heard.length,
    avgLossPct: avg(loss) == null ? null : +avg(loss).toFixed(2),
    maxLossPct: loss.length ? Math.max(...loss) : null,
    avgJitterMs: avg(nums('jit')) == null ? null : Math.round(avg(nums('jit'))),
    avgRttMs: avg(rtt) == null ? null : Math.round(avg(rtt)),
    maxRttMs: rtt.length ? Math.max(...rtt) : null,
    avgE2eMs: avg(nums('e2e')) == null ? null : Math.round(avg(nums('e2e'))),
    avgKbps: avg(nums('kbps')) == null ? null : +avg(nums('kbps')).toFixed(1),
    gapCount: gaps.length, gapTotalMs: gaps.reduce((s, g) => s + g.ms, 0),
    longestGapMs: gaps.length ? Math.max(...gaps.map(g => g.ms)) : 0,
    reconnects: rec.reconnects, recoveryMs: rec.recoveryMs.join('|'),
    worstDownQuality: rec.worstDownQuality, protocol: protos, candidateType: ctypes,
    connTrail: rec.connTrail.join('>'),
  };
}

function finalize(result, error) {
  const rec = S.cur;
  if (!rec || rec.result) return;
  if (S.aud && S.aud.inGap && S.aud.silentSince) {
    S.aud.gaps.push({ at: rel(rec, S.aud.silentSince), ms: Math.round(now() - S.aud.silentSince), open: true });
  }
  rec.result = result;
  rec.error = error ? String(error) : '';
  if (S.audioCtx && S.audioCtx.state !== 'running') rec.error = (rec.error ? rec.error + '; ' : '') + 'audioctx_' + S.audioCtx.state;
  const summary = summarize(rec);
  const full = Object.assign({}, summary, {
    milestones: {
      ringAt: rel(rec, rec.ringAt), acceptAt: rel(rec, rec.acceptAt), joinedAt: rel(rec, rec.joinedAt),
      publishedAt: rel(rec, rec.publishedAt), remoteTrackAt: rel(rec, rec.remoteTrackAt),
      playStartAt: rel(rec, rec.playStartAt), firstAudioAt: rel(rec, rec.firstAudioAt),
    },
    gaps: S.aud ? S.aud.gaps : [], samples: rec.samples, events: rec.events,
  });
  S.records.push(full);
  if (S.records.length > MAX_RECORDS) S.records.splice(0, S.records.length - MAX_RECORDS);
  if (!safeSet(REC_KEY, S.records)) {
    // Storage full: drop per-second samples of older records and retry.
    S.records.forEach((r, i) => { if (i < S.records.length - 50) { r.samples = []; r.events = []; } });
    if (!safeSet(REC_KEY, S.records)) logEvt('storage_full', '請先匯出再清除紀錄');
  }
  logEvt('record_saved', `${result} accept→audio=${fmtMs(summary.acceptToFirstAudioMs)}`);
  S.cur = null;
  if (S.noAudioTimer) { clearTimeout(S.noAudioTimer); S.noAudioTimer = null; }
  renderSummary();
}

// ---------- flows ----------
function setPhase(p) {
  S.phase = p;
  const names = { idle: '閒置', ringing: '響鈴中', connecting: '連線中', talking: '通話中', waiting: '已加入，等待對方', dialing: '撥號中' };
  const el = $('phase');
  el.textContent = names[p] || p;
  el.className = 'phase-' + p;
  updateButtons();
}

async function callerDial() {
  if (!S.sdkReady) return;
  audioCtx();
  requestWakeLock();
  newEngine();
  setPhase('dialing');
  S.session = {};
  S.aud = newAud();
  try {
    const mst = await sourceTrack();
    await S.engine.makeLocal(mst);
    let t = now();
    await S.engine.join(cfg.room);
    S.session.joinMs = Math.round(now() - t);
    t = now();
    await S.engine.publish();
    S.session.publishMs = Math.round(now() - t);
    S.live.join = S.session.joinMs;
    S.live.publish = S.session.publishMs;
    startSampling();
    setPhase('waiting');
    S.engine.send({ t: 'hello', role: 'caller' });
  } catch (e) {
    logEvt('dial_failed', e.message || e);
    await callerHangup();
  }
}

async function callerHangup() {
  if (S.cur) finalize(S.cur.firstAudioAt ? 'ok' : 'aborted');
  stopSampling();
  if (S.remote) { try { S.remote.stop(); } catch (e) { /* ignore */ } }
  S.remote = null;
  detachAnalyser();
  if (S.engine) await S.engine.leave();
  stopTone();
  S.engine = null;
  setPhase('idle');
}

async function calleeRing() {
  if (!S.sdkReady || S.phase !== 'idle') return;
  audioCtx();
  requestWakeLock();
  newEngine();
  S.cycleNo++;
  const rec = newRecord('callee');
  rec.cycle = S.cycleNo;
  rec.ringAt = now();
  S.cur = rec;
  S.aud = newAud();
  S.live = {};
  setPhase('ringing');
  logEvt('ring', '#' + rec.cycle);
  try {
    // Like the app under study, the local audio source is ready before ringing in both modes.
    const mst = await sourceTrack();
    await S.engine.makeLocal(mst);
    if (cfg.joinMode === 'pre-join') {
      let t = now();
      await withTimeout(S.engine.join(cfg.room), (Number(cfg.noAudioSec) || 30) * 1000, 'join timeout');
      rec.joinMs = Math.round(now() - t);
      rec.joinedAt = now();
      await S.engine.setMuted(true);
      t = now();
      await S.engine.publish();
      rec.publishMs = Math.round(now() - t);
      rec.publishedAt = now();
      S.live.join = rec.joinMs;
      S.live.publish = rec.publishMs;
      startSampling();
    }
  } catch (e) {
    logEvt('ring_failed', e.message || e);
    await calleeHangup('join_failed', e.message || String(e));
  }
}

async function calleeAccept() {
  const rec = S.cur;
  if (!rec || S.phase !== 'ringing') return;
  audioCtx();
  rec.acceptAt = now();
  setPhase('connecting');
  logEvt('accept', '#' + rec.cycle);
  const timeoutMs = (Number(cfg.noAudioSec) || 30) * 1000;
  S.noAudioTimer = setTimeout(() => {
    if (S.cur === rec && !rec.firstAudioAt) { logEvt('no_audio_timeout', fmtMs(timeoutMs)); calleeHangup('no_audio'); }
  }, timeoutMs);
  const acceptMsg = () => ({ t: 'accept', cycle: rec.cycle, sinceAcceptMs: Math.round(now() - rec.acceptAt), joinMode: cfg.joinMode, scenario: cfg.scenario });
  try {
    if (S.engine.resumeAudio) S.engine.resumeAudio();
    if (cfg.joinMode === 'pre-join') {
      if (!S.engine.joined) throw new Error('pre-join 尚未完成');
      await S.engine.setMuted(false);
      S.engine.send(acceptMsg());
      startPlayback();
    } else {
      let t = now();
      await S.engine.join(cfg.room);
      rec.joinMs = Math.round(now() - t);
      rec.joinedAt = now();
      S.live.join = rec.joinMs;
      S.engine.send(acceptMsg());
      t = now();
      await S.engine.publish();
      rec.publishMs = Math.round(now() - t);
      rec.publishedAt = now();
      S.live.publish = rec.publishMs;
      // Re-send: some SDK versions drop data messages sent before the first publish. Caller ignores duplicates.
      S.engine.send(acceptMsg());
      startSampling();
      startPlayback();
    }
  } catch (e) {
    logEvt('accept_failed', e.message || e);
    await calleeHangup('join_failed', e.message || String(e));
  }
}

let hangingUp = false;
async function calleeHangup(result, error) {
  if (hangingUp) return;
  hangingUp = true;
  try {
    const rec = S.cur;
    if (S.engine && rec) await S.engine.send({ t: 'end', cycle: rec.cycle, result: result || '' });
    if (rec) finalize(result || (rec.firstAudioAt ? 'ok' : (rec.acceptAt ? 'no_audio' : 'aborted')), error);
    stopSampling();
    if (S.remote) { try { S.remote.stop(); } catch (e) { /* ignore */ } }
    S.remote = null;
    detachAnalyser();
    if (S.engine) await S.engine.leave();
    stopTone();
    S.engine = null;
    S.reconnectStart = null;
    setPhase('idle');
  } finally {
    hangingUp = false;
  }
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })])
    .finally(() => clearTimeout(t));
}

async function waitUntil(fn, timeoutMs) {
  const end = now() + timeoutMs;
  while (now() < end) { if (fn()) return true; await sleep(100); }
  return false;
}

async function runLoop() {
  const total = Math.max(1, Number(cfg.cycles) || 1);
  S.loop = { running: true, i: 0, total };
  updateButtons();
  logEvt('loop_start', `${total} cycles`);
  while (S.loop && S.loop.running && S.loop.i < total) {
    S.loop.i++;
    renderChips();
    await calleeRing();
    if (S.phase === 'ringing') {
      await sleep((Number(cfg.ringSec) || 3) * 1000);
      if (!S.loop || !S.loop.running) break;
      await calleeAccept();
      const rec = S.cur;
      await waitUntil(() => S.cur !== rec || (rec && rec.firstAudioAt), (Number(cfg.noAudioSec) || 30) * 1000 + 1000);
      if (S.cur === rec && rec.firstAudioAt) {
        await waitUntil(() => S.cur !== rec || !S.loop || !S.loop.running, (Number(cfg.talkSec) || 20) * 1000);
      }
      if (S.cur === rec) await calleeHangup();
    }
    if (!S.loop || !S.loop.running) break;
    await sleep((Number(cfg.gapSec) || 8) * 1000);
  }
  logEvt('loop_end');
  if (S.cur) await calleeHangup('aborted');
  S.loop = null;
  renderChips();
  updateButtons();
}

// ---------- UI ----------
function updateButtons() {
  const caller = cfg.role === 'caller';
  $('callerActions').hidden = !caller;
  $('calleeActions').hidden = caller;
  $('loopActions').hidden = caller;
  const looping = !!(S.loop && S.loop.running);
  $('btnDial').disabled = !S.sdkReady || S.phase !== 'idle';
  $('btnCallerHangup').disabled = S.phase === 'idle';
  $('btnRing').disabled = !S.sdkReady || S.phase !== 'idle' || looping;
  $('btnAccept').disabled = S.phase !== 'ringing' || looping;
  $('btnCalleeHangup').disabled = S.phase === 'idle' || looping;
  $('btnLoop').disabled = !S.sdkReady || (!looping && S.phase !== 'idle');
  $('btnLoop').textContent = looping ? '停止自動循環' : '開始自動循環';
  $('roleHint').textContent = caller
    ? '主叫：按「撥號」後保持在頻道並持續發送聲音。被叫每次接聽、掛斷，這裡都會自動記一筆。'
    : '被叫：可手動按「模擬來電」→「接聽」，或用自動循環連續測。兩支手機的頻道名稱要一樣。';
}

function renderChips() {
  $('chipBackend').textContent = cfg.backend === 'agora' ? `Agora ${cfg.agoraVersion}` : 'LiveKit';
  $('chipRole').textContent = cfg.role === 'caller' ? '主叫' : '被叫';
  $('chipMode').textContent = cfg.joinMode === 'pre-join' ? 'B 預先加入' : 'A 接聽後加入';
  $('chipScenario').textContent = cfg.scenario;
  const chip = $('chipLoop');
  if (S.loop) { chip.hidden = false; chip.textContent = `循環 ${S.loop.i}/${S.loop.total}`; } else chip.hidden = true;
}

function renderLive() {
  const s = S.live || {};
  const rec = S.cur;
  $('mAccept').textContent = rec && rec.acceptToFirstAudioMs != null ? fmtMs(rec.acceptToFirstAudioMs)
    : (rec && rec.acceptAt ? fmtMs(now() - rec.acceptAt) + '…' : '-');
  $('mJoin').textContent = fmtMs(s.join);
  $('mPublish').textContent = fmtMs(s.publish);
  $('mConn').textContent = S.connState || '-';
  $('mLoss').textContent = s.lossPct == null ? '-' : fmtNum(s.lossPct) + ' %';
  $('mJitter').textContent = s.jitterMs == null ? '-' : Math.round(s.jitterMs) + ' ms';
  $('mRtt').textContent = s.rttMs == null ? '-' : Math.round(s.rttMs) + ' ms';
  $('mE2e').textContent = s.e2eMs == null ? '-' : Math.round(s.e2eMs) + ' ms';
  $('mKbps').textContent = s.kbps == null ? '-' : fmtNum(s.kbps) + ' kbps';
  $('mProto').textContent = s.proto ? `${s.proto} ${s.ctype || ''}` : '-';
  const g = S.aud ? S.aud.gaps : [];
  $('mGaps').textContent = S.aud ? `${g.length} / ${fmtMs(g.reduce((x, y) => x + y.ms, 0))}` : '-';
  $('mNetq').textContent = s.netq || '-';
}

function renderSummary() {
  $('recCount').textContent = S.records.length;
  const groups = new Map();
  for (const r of S.records) {
    const key = [r.role, r.sdk, r.joinMode, r.area || '', r.proxy || '', r.scenario].join(' · ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const head = '<tr><th>分組（角色 · SDK · 模式 · 區域 · 代理 · 情境）</th><th>筆數</th><th>成功率</th><th>接聽→出聲 中位</th><th>P90</th><th>平均掉包</th><th>平均 RTT</th><th>斷音總長（平均）</th><th>重連</th></tr>';
  const rows = [];
  for (const [key, list] of groups) {
    const ok = list.filter(r => r.result === 'ok');
    const a2a = ok.map(r => r.acceptToFirstAudioMs).filter(v => v != null);
    const loss = ok.map(r => r.avgLossPct).filter(v => v != null);
    const rtt = ok.map(r => r.avgRttMs).filter(v => v != null);
    const gap = ok.map(r => r.gapTotalMs || 0);
    const okRate = list.length ? (ok.length / list.length) * 100 : 0;
    const cls = okRate >= 95 ? 'ok' : okRate >= 85 ? 'warn' : 'bad';
    rows.push(`<tr><td>${escapeHtml(key)}</td><td class="num">${list.length}</td><td class="num ${cls}">${okRate.toFixed(0)}%</td>` +
      `<td class="num">${fmtMs(median(a2a))}</td><td class="num">${fmtMs(pct(a2a, 90))}</td>` +
      `<td class="num">${loss.length ? avg(loss).toFixed(1) + '%' : '-'}</td><td class="num">${rtt.length ? Math.round(avg(rtt)) + ' ms' : '-'}</td>` +
      `<td class="num">${gap.length ? fmtMs(avg(gap)) : '-'}</td><td class="num">${list.reduce((s, r) => s + (r.reconnects || 0), 0)}</td></tr>`);
  }
  $('summary').innerHTML = rows.length ? head + rows.join('') : '<tr><td>還沒有紀錄</td></tr>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const file = typeof File === 'function' ? new File([blob], name, { type }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: name }).catch(() => fallbackDownload(name, blob));
    return;
  }
  fallbackDownload(name, blob);
}
function fallbackDownload(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function exportName(ext) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const dev = (cfg.device || 'device').replace(/[^\w-]+/g, '_');
  return `callmeter_${dev}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}
function exportCsv() {
  if (!S.records.length) return;
  const cols = Object.keys(S.records[0]).filter(k => !['milestones', 'gaps', 'samples', 'events'].includes(k));
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')].concat(S.records.map(r => cols.map(c => esc(r[c])).join(',')));
  download(exportName('csv'), '﻿' + lines.join('\n'), 'text/csv');
}
function exportJson() {
  if (!S.records.length) return;
  download(exportName('json'), JSON.stringify({ exportedAt: new Date().toISOString(), records: S.records }, null, 1), 'application/json');
}

function bindForm() {
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    el.value = cfg[f];
    el.addEventListener('change', () => {
      cfg[f] = NUM_FIELDS.has(f) ? Number(el.value) : el.value;
      safeSet(CFG_KEY, cfg);
      if (RELOAD_FIELDS.has(f)) { location.reload(); return; }
      applyVisibility();
      renderChips();
      updateButtons();
    });
  }
}
function applyVisibility() {
  document.querySelectorAll('.only-agora').forEach(e => { e.hidden = cfg.backend !== 'agora'; });
  document.querySelectorAll('.only-livekit').forEach(e => { e.hidden = cfg.backend !== 'livekit'; });
  const busy = S.phase !== 'idle';
  ['backend', 'role', 'joinMode', 'audioSource', 'room', 'agoraVersion', 'agoraAppId', 'agoraToken', 'agoraArea', 'agoraProxy', 'lkUrl', 'lkKey', 'lkSecret']
    .forEach(f => { const el = $(f); if (el) el.disabled = busy; });
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { S.wakeLock = null; if (S.phase !== 'idle') requestWakeLock(); }
  else if (S.phase !== 'idle') logEvt('page_hidden', '背景執行時計時與音訊可能被暫停');
});

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('無法載入 ' + src));
    document.head.appendChild(s);
  });
}

async function init() {
  const secure = window.isSecureContext;
  $('insecure').style.display = secure ? 'none' : 'block';
  bindForm();
  applyVisibility();
  renderChips();
  renderSummary();
  updateButtons();
  document.addEventListener('pointerdown', () => { if (S.audioCtx && S.audioCtx.state !== 'running') S.audioCtx.resume().catch(() => {}); }, true);
  const tickClock = () => { $('clock').textContent = wallClock(); requestAnimationFrame(tickClock); };
  requestAnimationFrame(tickClock);
  setInterval(levelTick, 50);
  setInterval(() => { renderLive(); applyVisibility(); }, 250);

  $('btnDial').onclick = callerDial;
  $('btnCallerHangup').onclick = callerHangup;
  $('btnRing').onclick = calleeRing;
  $('btnAccept').onclick = calleeAccept;
  $('btnCalleeHangup').onclick = () => calleeHangup();
  $('btnLoop').onclick = () => {
    if (S.loop && S.loop.running) { S.loop.running = false; logEvt('loop_stop_requested'); updateButtons(); }
    else { audioCtx(); runLoop(); }
  };
  $('btnExportCsv').onclick = exportCsv;
  $('btnExportJson').onclick = exportJson;
  $('btnClear').onclick = () => {
    if (!S.records.length) return;
    if (!confirm(`清除這支手機上的 ${S.records.length} 筆紀錄？清除前請先匯出。`)) return;
    S.records = [];
    safeSet(REC_KEY, S.records);
    renderSummary();
  };

  try {
    if (cfg.backend === 'livekit') await loadScript(SDK_URLS.livekit);
    else await loadScript(SDK_URLS.agora(cfg.agoraVersion));
    S.sdkReady = true;
    logEvt('sdk_loaded', cfg.backend === 'livekit' ? 'livekit-client ' + (window.LivekitClient && LivekitClient.version) : 'AgoraRTC ' + (window.AgoraRTC && AgoraRTC.VERSION));
    if (cfg.backend === 'agora' && window.AgoraRTC) {
      try { AgoraRTC.setLogLevel(2); } catch (e) { /* ignore */ }
      if (AgoraRTC.checkSystemRequirements && !AgoraRTC.checkSystemRequirements()) logEvt('warn', '此瀏覽器不符合 Agora 系統需求');
    }
  } catch (e) {
    const b = $('sdkError');
    b.textContent = 'SDK 載入失敗：' + e.message;
    b.style.display = 'block';
    logEvt('sdk_load_failed', e.message);
  }
  updateButtons();
}

init();
