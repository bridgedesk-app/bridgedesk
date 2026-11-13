/* BridgeDesk — логика на уеб страницата и на десктоп приложението.
 * В браузъра: свързване към друг компютър + споделяне на екрана само за преглед.
 * В десктоп приложението (window.most съществува): пълно управление.
 */
(() => {
  'use strict';

  const C = window.MOST_CONFIG;
  const agent = window.most || null; // мост към Electron (preload.js)
  const $ = (s) => document.querySelector(s);

  // ---------- помощни ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('most.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('most.' + k, JSON.stringify(v)); } catch { /* */ } },
  };
  const rnd = (n) => { const a = new Uint32Array(n); crypto.getRandomValues(a); return a; };
  const randomDigits = (n) => { let s = String(1 + (rnd(1)[0] % 9)); rnd(n - 1).forEach((x) => { s += x % 10; }); return s; };
  const randomPass = () => { const ch = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(rnd(6), (x) => ch[x % ch.length]).join(''); };
  const fmtId = (id) => String(id).replace(/(\d{3})(?=\d)/g, '$1 ');
  const cleanId = (s) => String(s).replace(/\D/g, '');
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const myName = () => store.get('name', '') || (agent ? agent.hostname : '') || 'Guest';

  function peerOpts() {
    const o = { debug: 1 };
    if (C.peer && C.peer.host) Object.assign(o, C.peer);
    if (C.iceServers) o.config = { iceServers: C.iceServers };
    return o;
  }

  let toastTimer;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 3200);
  }
  function setNet(state, text) {
    const p = $('#netStatus'); p.className = 'pill ' + state; p.querySelector('b').textContent = text;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy', true); }
  }

  // Режими на картината. maxH = най-голяма височина (1080 = Full HD), 0 = оригинална резолюция.
  // ---------- Permanent password: stored only as a salted SHA-256 hash ----------
  async function sha(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function hashPass(pass, salt) { return sha(salt + ':' + pass); }
  function permInfo() { return store.get('permHash', null); }
  async function permMatches(pass) {
    const p = permInfo();
    if (!p || !pass) return false;
    return (await hashPass(pass, p.salt)) === p.hash;
  }
  async function setPerm(pass) {
    if (!pass) { store.set('permHash', null); return; }
    const salt = Array.from(rnd(4), (x) => x.toString(16)).join('');
    store.set('permHash', { salt, hash: await hashPass(pass, salt) });
  }
  // older versions kept it in plain text — convert once
  (async () => { const old = store.get('perm', ''); if (old) { await setPerm(old); store.set('perm', null); } })();

  // Performance presets (each one really changes capture size, frame rate, bitrate and encoder hints)
  const QUALITY = {
    balanced: { maxH: 1080, maxBitrate: 12_000_000, fps: 60, hint: 'motion', pref: 'maintain-framerate', label: 'Balanced' },
    hq: { maxH: 1440, maxBitrate: 25_000_000, fps: 60, hint: 'detail', pref: 'balanced', label: 'High quality' },
    perf: { maxH: 720, maxBitrate: 6_000_000, fps: 60, hint: 'motion', pref: 'maintain-framerate', label: 'Max performance' },
  };
  // Automatic: starts at 1080p and steps down/up this ladder based on measured drops and congestion
  const AUTO_LADDER = [
    { maxH: 1080, maxBitrate: 12_000_000, fps: 60 },
    { maxH: 900, maxBitrate: 8_000_000, fps: 60 },
    { maxH: 720, maxBitrate: 5_000_000, fps: 60 },
    { maxH: 540, maxBitrate: 3_000_000, fps: 60 },
  ].map((x) => Object.assign({ hint: 'motion', pref: 'maintain-framerate', label: 'Auto ' + x.maxH + 'p' }, x));
  const DEFAULT_Q = 'auto';
  // older viewers may still send the previous preset names
  const LEGACY_Q = { smooth: 'balanced', native: 'hq', saver: 'perf' };
  function presetFor(level) {
    if (level === 'auto') return AUTO_LADDER[Math.min(host.autoIdx || 0, AUTO_LADDER.length - 1)];
    return QUALITY[LEGACY_Q[level] || level] || QUALITY.balanced;
  }
  // Заснемаме направо в 1080p — при 4K монитор това е много по-леко за компютъра (по-малко забавяне)
  const CAPTURE = { video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false };

  // ---------- Codec choice ----------
  // The host checks which codecs its GPU can encode in hardware (Media Capabilities "powerEfficient")
  // and puts them first in the offer. Hardware encoding = smooth 60 fps with almost no CPU load.
  const CODECS = {
    H265: { re: /^(H265|HEVC)$/i, test: 'video/H265' },
    H264: { re: /^H264$/i, test: 'video/H264;profile-level-id=42e01f;packetization-mode=1' },
    VP9: { re: /^VP9$/i, test: 'video/VP9' },
    AV1: { re: /^AV1$/i, test: 'video/AV1' },
    VP8: { re: /^VP8$/i, test: 'video/VP8' },
  };
  let codecOrder = ['H264', 'VP8', 'H265', 'VP9', 'AV1']; // H.264 (OpenH264) is the lightest software encoder
  let codecInfo = 'default';
  async function detectHardwareCodecs() {
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.encodingInfo) return;
    const hw = [];
    // Only H.265 is trusted: Chromium sends H.265 exclusively with a hardware encoder. For VP9/AV1/H.264
    // "powerEfficient" does not guarantee WebRTC really uses the GPU (tested: VP9 still ran on libvpx).
    for (const name of ['H265']) {
      try {
        const r = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType: CODECS[name].test, width: 1920, height: 1080, bitrate: 12_000_000, framerate: 60, scalabilityMode: 'L1T1' },
        });
        if (r.supported && r.powerEfficient) hw.push(name);
      } catch { /* */ }
    }
    if (hw.length) {
      codecOrder = [...hw, ...codecOrder.filter((c) => !hw.includes(c))];
      codecInfo = 'hardware: ' + hw.join(', ') + ' (used if the viewer can decode it)';
    } else codecInfo = 'no hardware H.265 — using H.264';
  }

  function preferCodecs(sdp, order) {
    const lines = sdp.split('\r\n');
    const mi = lines.findIndex((l) => l.startsWith('m=video'));
    if (mi < 0) return sdp;
    const parts = lines[mi].split(' ');
    const list = parts.slice(3);
    const nameOf = {}; const fmtp = {};
    lines.forEach((l) => {
      let m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l); if (m) nameOf[m[1]] = m[2];
      m = /^a=fmtp:(\d+) (.*)$/.exec(l); if (m) fmtp[m[1]] = m[2];
    });
    const codecKey = (pt) => Object.keys(CODECS).find((k) => CODECS[k].re.test(nameOf[pt] || '')) || null;
    const h264rank = (pt) => {
      const f = fmtp[pt] || ''; let r = 5;
      if (/profile-level-id=42e0/i.test(f)) r = 0; else if (/profile-level-id=4200/i.test(f)) r = 1;
      else if (/profile-level-id=4d/i.test(f)) r = 2; else if (/profile-level-id=64/i.test(f)) r = 3;
      if (!/packetization-mode=1/.test(f)) r += 10;
      return r;
    };
    const primary = list.filter((pt) => codecKey(pt));
    primary.sort((a, b) => {
      const ka = order.indexOf(codecKey(a)), kb = order.indexOf(codecKey(b));
      if (ka !== kb) return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb);
      return codecKey(a) === 'H264' ? h264rank(a) - h264rank(b) : 0;
    });
    const rest = list.filter((pt) => !primary.includes(pt)); // rtx, red, ulpfec…
    lines[mi] = [...parts.slice(0, 3), ...primary, ...rest].join(' ');
    return lines.join('\r\n');
  }

  // high start bitrate so the picture is sharp from the first second (added to every video codec)
  function addBitrateHints(sdp) {
    const lines = sdp.split('\r\n');
    const HINT = 'x-google-start-bitrate=8000;x-google-min-bitrate=1500;x-google-max-bitrate=30000';
    const out = []; let inVideo = false;
    const hasFmtp = new Set();
    lines.forEach((l) => { const m = /^a=fmtp:(\d+) /.exec(l); if (m) hasFmtp.add(m[1]); });
    for (const l of lines) {
      if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
      if (inVideo && /^a=fmtp:\d+ /.test(l) && !/apt=|x-google-start-bitrate/.test(l)) { out.push(l + ';' + HINT); continue; }
      out.push(l);
      const m = inVideo && /^a=rtpmap:(\d+) (VP8|VP9|AV1|H265)\//i.exec(l);
      if (m && !hasFmtp.has(m[1])) out.push('a=fmtp:' + m[1] + ' ' + HINT);
    }
    return out.join('\r\n');
  }
  // Remove a codec (and its RTX / fmtp / rtcp-fb lines) from the SDP entirely.
  function stripCodec(sdp, re) {
    const lines = sdp.split('\r\n');
    const pts = new Set();
    lines.forEach((l) => { const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l); if (m && re.test(m[2])) pts.add(m[1]); });
    if (!pts.size) return sdp;
    lines.forEach((l) => { const m = /^a=fmtp:(\d+) apt=(\d+)/.exec(l); if (m && pts.has(m[2])) pts.add(m[1]); });
    const out = [];
    for (const l of lines) {
      const m = /^a=(rtpmap|fmtp|rtcp-fb):(\d+)[ ]/.exec(l);
      if (m && pts.has(m[2])) continue;
      if (l.startsWith('m=video')) { const p = l.split(' '); out.push([...p.slice(0, 3), ...p.slice(3).filter((x) => !pts.has(x))].join(' ')); continue; }
      out.push(l);
    }
    return out.join('\r\n');
  }
  // H.265 produced a black screen (encoder delivered 0 frames) — never negotiate it.
  const noH265 = (sdp) => stripCodec(sdp, /^(H265|HEVC)$/i);
  const tuneOffer = (sdp) => addBitrateHints(preferCodecs(noH265(sdp), codecOrder)); // host
  const tuneAnswer = (sdp) => addBitrateHints(noH265(sdp));                        // viewer

  // =====================================================================
  //  ХОСТ — компютърът, който се показва/управлява
  // =====================================================================
  const host = {
    peer: null, id: null, pass: null,
    viewer: null,          // { conn, call, name }
    stream: null,          // при браузър: споделеният екран
    screens: [], screenIdx: 0,
    fails: 0, lockUntil: 0, idRetries: 0,
  };

  function startHost() {
    host.id = store.get('id', null) || randomDigits(9);
    store.set('id', host.id);
    if (!host.pass) {
      const kept = store.get('keepPass', null); // паролата се запазва при автоматичен рестарт
      host.pass = kept && Date.now() - kept.at < 180_000 ? kept.pass : randomPass();
      store.set('keepPass', null);
    }
    $('#myId').textContent = fmtId(host.id);
    $('#myPass').textContent = host.pass;
    $('#hostIdle').hidden = true;
    $('#hostReady').hidden = false;
    $('#btnStopShare').hidden = !!agent;
    updateHostNote();
    setNet('busy', 'Connecting…');

    const peer = new Peer(C.idPrefix + host.id, peerOpts());
    host.peer = peer;
    peer.on('open', () => { host.idRetries = 0; setNet('online', 'Ready to connect'); });
    peer.on('connection', handleIncoming);
    peer.on('disconnected', () => {
      setNet('busy', 'Reconnecting…');
      setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1500);
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        // старата сесия още е регистрирана — изчакваме и опитваме пак
        peer.destroy();
        // ID-то НЕ се сменя — то е адресът на компютъра. Опитваме отново, докато се освободи.
        host.idRetries++;
        setTimeout(startHost, Math.min(3000 * host.idRetries, 15000));
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        setNet('offline', 'Server unreachable');
        setTimeout(() => { if (!peer.destroyed) { peer.destroy(); startHost(); } }, 5000);
      } else {
        console.warn('[host]', e.type, e);
      }
    });
  }

  function stopHost() {
    endHostSession();
    if (host.peer) { host.peer.destroy(); host.peer = null; }
    if (host.stream) { host.stream.getTracks().forEach((t) => t.stop()); host.stream = null; }
    $('#hostIdle').hidden = false;
    $('#hostReady').hidden = true;
    setNet('', 'Web version');
  }

  function updateHostNote() {
    const n = $('#hostNote');
    if (!agent) {
      n.className = 'note warn';
      n.textContent = 'View-only mode — the other side can see your screen but cannot control it.';
    } else if (permInfo()) {
      n.className = 'note';
      n.textContent = 'Permanent password is on — it allows access without confirmation.';
    } else {
      n.className = 'note';
      n.textContent = 'Without a password you will be asked to accept each connection.';
    }
  }

  function handleIncoming(conn) {
    let authed = false;
    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!authed) {
        if (msg.t !== 'hello') return conn.close();
        if (host.viewer) { conn.send({ t: 'deny', reason: 'busy' }); return setTimeout(() => conn.close(), 300); }
        if (Date.now() < host.lockUntil) { conn.send({ t: 'deny', reason: 'locked' }); return setTimeout(() => conn.close(), 300); }
        const name = String(msg.name || 'Guest').slice(0, 40);
        if (msg.pass) {
          if (msg.pass === host.pass || await permMatches(msg.pass)) {
            authed = true; host.fails = 0; return accept(conn, name);
          }
          if (++host.fails >= 5) { host.lockUntil = Date.now() + 60_000; host.fails = 0; }
          conn.send({ t: 'deny', reason: 'pass' });
          return setTimeout(() => conn.close(), 300);
        }
        conn.send({ t: 'wait' });
        const yes = await askIncoming(name, conn);
        if (!conn.open) return;
        if (!yes) { conn.send({ t: 'deny', reason: 'rejected' }); return setTimeout(() => conn.close(), 300); }
        authed = true; return accept(conn, name);
      }
      onViewerMsg(msg);
    });
    conn.on('close', () => {
      closeIncomingIfFor(conn);
      if (host.viewer && host.viewer.conn === conn) endHostSession();
    });
    conn.on('error', () => {});
  }

  // --- диалог „Входяща връзка“ ---
  let incomingResolve = null, incomingConn = null;
  function askIncoming(name, conn) {
    $('#incName').textContent = name;
    $('#incWhat').textContent = agent ? 'is controlling this computer' : 'see your screen';
    $('#ovIncoming').hidden = false;
    if (agent) agent.focus();
    incomingConn = conn;
    return new Promise((res) => {
      incomingResolve = (v) => { $('#ovIncoming').hidden = true; incomingResolve = null; incomingConn = null; res(v); };
      setTimeout(() => incomingResolve && incomingResolve(false), 60_000);
    });
  }
  function closeIncomingIfFor(conn) { if (incomingConn === conn && incomingResolve) incomingResolve(false); }

  // Заснемане на екрана — опитваме няколко начина, защото Windows понякога отказва първия
  async function captureScreen(id) {
    const errors = [];
    const tries = [
      () => navigator.mediaDevices.getDisplayMedia(CAPTURE),
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
      () => navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 60 } } }),
      () => navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id } } }),
    ];
    for (const t of tries) {
      try {
        const s = await t();
        if (s && s.getVideoTracks().length) return s;
      } catch (e) { errors.push((e && (e.name + ': ' + e.message)) || String(e)); }
    }
    const err = new Error(errors[errors.length - 1] || 'unknown');
    err.all = errors;
    throw err;
  }

  async function getHostStream() {
    if (!agent) return host.stream; // в браузъра вече е избран при „Сподели“
    if (agent.screenState) {
      const st = await agent.screenState();
      if (st && st.locked) { const e = new Error('locked'); e.code = 'locked'; throw e; }
    }
    host.screens = await agent.listScreens();
    if (!host.screens.length) { const e = new Error('No screen found'); e.code = 'noscreen'; throw e; }
    if (host.screenIdx >= host.screens.length) host.screenIdx = 0;
    await agent.selectScreen(host.screens[host.screenIdx].id);
    return captureScreen(host.screens[host.screenIdx].id);
  }

  // resolves true as soon as the capture delivers its first frame
  function waitFirstFrame(pump, track, ms) {
    return new Promise((resolve) => {
      if (!track || track.readyState !== 'live') return resolve(false);
      const t0 = performance.now();
      if (pump) {
        const iv = setInterval(() => {
          if (pump.stats.total > 0) { clearInterval(iv); resolve(true); }
          else if (performance.now() - t0 > ms || track.readyState !== 'live') { clearInterval(iv); resolve(false); }
        }, 50);
        return;
      }
      const vid = document.createElement('video');
      vid.muted = true; vid.srcObject = new MediaStream([track]);
      let done = false;
      const fin = (r) => { if (done) return; done = true; try { vid.pause(); vid.srcObject = null; } catch { /* */ } resolve(r); };
      if (vid.requestVideoFrameCallback) vid.requestVideoFrameCallback(() => fin(true));
      vid.addEventListener('loadeddata', () => { if (!vid.requestVideoFrameCallback) fin(true); });
      vid.play().catch(() => {});
      setTimeout(() => fin(false), ms);
    });
  }

  // ---------- Frame pump ----------
  // Windows only delivers a new captured frame when something on the screen changes. With a static
  // screen (and the remote cursor hidden) no frames arrive at all: the viewer stays black after
  // connecting, or keeps showing the previous monitor after a switch. The pump re-sends the last
  // frame at least 10 times per second, so the picture always arrives and never freezes.
  function makePump(track) {
    if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') return null;
    try {
      const proc = new MediaStreamTrackProcessor({ track });
      const gen = new MediaStreamTrackGenerator({ kind: 'video' });
      const reader = proc.readable.getReader();
      const writer = gen.writable.getWriter();
      let last = null, lastAt = 0, pending = 0, stopped = false;
      const stats = { raw: 0, rawFps: 0, dropped: 0, total: 0, t0: performance.now() };
      const write = async (frame) => {
        pending++;
        try { await writer.write(frame); } catch { try { frame.close(); } catch { /* */ } }
        pending--;
      };
      (async () => {
        while (!stopped) {
          let r;
          try { r = await reader.read(); } catch { break; }
          if (r.done) break;
          const f = r.value;
          stats.raw++; stats.total++;
          const now = performance.now();
          if (now - stats.t0 >= 1000) { stats.rawFps = Math.round(stats.raw * 1000 / (now - stats.t0)); stats.raw = 0; stats.t0 = now; }
          if (last) last.close();
          last = f.clone();
          lastAt = performance.now();
          const out = new VideoFrame(f, { timestamp: Math.round(performance.now() * 1000) });
          f.close();
          if (pending >= 3) { out.close(); stats.dropped++; continue; } // only drop if the encoder is really behind
          write(out);
        }
      })();
      const timer = setInterval(() => {
        if (stopped || !last || pending) return;
        if (performance.now() - lastAt < 95) return;
        lastAt = performance.now();
        write(new VideoFrame(last, { timestamp: Math.round(performance.now() * 1000) }));
      }, 100);
      return {
        stats,
        track: gen,
        stop() {
          stopped = true; clearInterval(timer);
          try { reader.cancel(); } catch { /* */ }
          if (last) { try { last.close(); } catch { /* */ } last = null; }
          try { gen.stop(); } catch { /* */ }
          try { track.stop(); } catch { /* */ }
        },
      };
    } catch (e) { console.warn('pump', e); host.pumpError = String((e && e.message) || e).slice(0, 80); return null; }
  }

  // ---------- GPU engine (host side) ----------
  const TURBO_SW = /[?&]turboSW=1/.test(location.search);
  let turboCapPromise = null;
  function turboCap() {
    if (!turboCapPromise) {
      turboCapPromise = (window.BDTurbo && agent ? window.BDTurbo.hardwareEncoder(1920, 1080, TURBO_SW) : Promise.resolve(null))
        .catch(() => null);
    }
    return turboCapPromise;
  }

  async function startTurbo(sw) {
    const v = host.viewer; if (!v || v.turbo) return;
    // sw = backup path requested by the viewer (standard video gave no picture): software WebCodecs is fine
    const cap = (await turboCap()) || (sw && window.BDTurbo ? await window.BDTurbo.hardwareEncoder(1920, 1080, true).catch(() => null) : null);
    const pc = v.conn.peerConnection;
    if (!cap || !pc || !v.rawTrack) { v.conn.send({ t: 'turbo-no', reason: cap ? 'no-channel' : 'no-hardware-encoder' }); return; }
    const q = presetFor(host.quality || DEFAULT_Q);
    v.turbo = window.BDTurbo.createSender({ pc, track: v.rawTrack, codec: cap.codec, hw: cap.hw, latency: cap.latency, limit: { maxH: cap.maxH, maxFps: cap.maxFps }, quality: { maxH: q.maxH, fps: q.fps, bitrate: q.maxBitrate } });
    // pause the WebRTC video while the GPU engine runs (saves the CPU it was burning)
    if (v.rtcSender) v.rtcSender.replaceTrack(null).catch(() => {});
    v.conn.send({ t: 'turbo-ok', codec: cap.codec, hw: cap.hw, sw: !!sw });
  }
  function stopTurbo() {
    const v = host.viewer; if (!v || !v.turbo) return;
    v.turbo.stop(); v.turbo = null;
    if (v.rtcSender) v.rtcSender.replaceTrack(v.pump ? v.pump.track : v.rawTrack).catch(() => {});
  }

  // Automatic mode: step the ladder down on measured trouble, back up after a calm period
  function autoTick() {
    const v = host.viewer; if (!v || host.quality !== 'auto') return;
    const now = performance.now();
    let trouble = false;
    if (v.turbo) {
      const t = v.turbo.stats;
      const drops = t.dropEnc + t.dropNet, prev = v.autoPrevDrops || 0;
      v.autoPrevDrops = drops;
      if (drops - prev > 6 || t.buffered > 1_000_000) trouble = true;
    } else if (v.lastLimit === 'cpu' || v.lastLimit === 'bandwidth') trouble = true;
    if (v.viewerTrouble) { trouble = true; v.viewerTrouble = false; }
    if (trouble) {
      v.calmSince = now;
      if ((host.autoIdx || 0) < AUTO_LADDER.length - 1 && now - (v.autoChangedAt || 0) > 3000) {
        host.autoIdx = (host.autoIdx || 0) + 1; v.autoChangedAt = now; applyQuality('auto');
      }
    } else if ((host.autoIdx || 0) > 0 && now - (v.calmSince || now) > 12000 && now - (v.autoChangedAt || 0) > 12000) {
      host.autoIdx -= 1; v.autoChangedAt = now; v.calmSince = now; applyQuality('auto');
    }
    if (!v.calmSince) v.calmSince = now;
  }

  // The video (standard engine) runs on its own peer connection. If it fails or never delivers a
  // picture, it is rebuilt — the control connection and the session stay up (no more black screen).
  function placeVideoCall(v) {
    if (!v || !host.peer) return;
    if (v.call) { try { v.call.close(); } catch { /* */ } }
    const current = v.pump ? v.pump.track : v.rawTrack;
    const stream = current ? new MediaStream([current]) : v.sendStream;
    const call = host.peer.call(v.conn.peer, stream, { sdpTransform: tuneOffer });
    v.call = call;
    const pc = call.peerConnection;
    // keep the video sender itself: its track is swapped (monitor switch, GPU engine on/off)
    v.rtcSender = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (v.turbo && v.rtcSender) v.rtcSender.replaceTrack(null).catch(() => {});
    if (pc) {
      pc.addEventListener('connectionstatechange', () => {
        if (host.viewer !== v || v.call !== call) return;
        if (pc.connectionState === 'connected') applyQuality(host.quality || DEFAULT_Q);
        if (pc.connectionState === 'failed' && v.conn.open) {
          v.recalls = (v.recalls || 0) + 1;
          if (v.recalls <= 5) setTimeout(() => { if (host.viewer === v) placeVideoCall(v); }, 500);
        }
      });
    }
  }

  async function accept(conn, name) {
    host.viewer = { conn, name, call: null, stream: null };
    host.quality = DEFAULT_Q;
    host.autoIdx = 0;
    let stream;
    try {
      stream = await getHostStream();
      if (!stream) throw new Error('no stream');
    } catch (e) {
      console.error('capture failed', e, e && e.all);
      const detail = e && e.code ? e.code : ((e && e.message) || String(e)).slice(0, 200);
      // Windows: опитваме се да се поправим сами — рестарт без администратор / в съвместим режим
      const fixable = agent && agent.recover && agent.platform === 'win32' && /NotReadable|Could not start|AbortError|NotFound/i.test(detail);
      const kind = fixable ? (agent.isAdmin ? 'admin' : (!agent.captureCompat ? 'compat' : null)) : null;
      if (kind) {
        conn.send({ t: 'deny', reason: 'restarting', detail });
        host.viewer = null;
        store.set('keepPass', { pass: host.pass, at: Date.now() });
        $('#hostNote').className = 'note warn';
        $('#hostNote').textContent = 'Screen capture failed — restarting in compatibility mode…';
        setTimeout(() => { try { conn.close(); } catch { /* */ } agent.recover(kind); }, 500);
        return;
      }
      conn.send({ t: 'deny', reason: e && e.code === 'locked' ? 'locked-screen' : e && e.code === 'noscreen' ? 'noscreen' : 'capture', detail });
      $('#hostNote').className = 'note warn';
      $('#hostNote').textContent = 'Could not share the screen: ' + detail;
      host.viewer = null;
      return setTimeout(() => conn.close(), 300);
    }
    // Capture health check (AnyDesk-style): the picture must actually produce frames. If the capture
    // gives a live track that never delivers a frame (stuck Windows capture session), capture again;
    // if that also stays empty, restart BridgeDesk on this computer — the viewer reconnects by itself.
    let track = stream.getVideoTracks()[0];
    let pump = agent ? makePump(track) : null;
    if (agent) {
      let healthy = await waitFirstFrame(pump, track, 3000);
      host.capHealth = healthy ? 'ok' : 'no frames (retrying)';
      if (!healthy && host.viewer && host.viewer.conn === conn) {
        if (pump) pump.stop();
        stream.getTracks().forEach((t) => t.stop());
        await new Promise((r) => setTimeout(r, 400));
        try { stream = await getHostStream(); } catch (e) { stream = null; }
        track = stream && stream.getVideoTracks()[0];
        pump = track ? makePump(track) : null;
        healthy = track ? await waitFirstFrame(pump, track, 3000) : false;
        host.capHealth = healthy ? 'ok (after re-capture)' : 'no frames';
      }
      if (!host.viewer || host.viewer.conn !== conn) { if (pump) pump.stop(); if (stream) stream.getTracks().forEach((t) => t.stop()); return; }
      const lastRestart = +(store.get('capRestartAt') || 0);
      if (!healthy && agent.recover && Date.now() - lastRestart > 180000) {
        if (pump) pump.stop();
        if (stream) stream.getTracks().forEach((t) => t.stop());
        store.set('capRestartAt', Date.now());
        store.set('keepPass', { pass: host.pass, at: Date.now() });
        conn.send({ t: 'deny', reason: 'restarting', detail: 'no-frames' });
        host.viewer = null;
        $('#hostNote').className = 'note warn';
        $('#hostNote').textContent = 'Screen capture stopped delivering frames — restarting BridgeDesk…';
        setTimeout(() => { try { conn.close(); } catch { /* */ } agent.recover('restart'); }, 500);
        return;
      }
      if (!stream) { conn.send({ t: 'deny', reason: 'capture', detail: 'no-frames' }); host.viewer = null; return setTimeout(() => conn.close(), 300); }
    }
    try { track.contentHint = presetFor(host.quality || DEFAULT_Q).hint; } catch { /* */ }
    if (agent) host.viewer.stream = stream;
    // desktop app: send through the frame pump (keeps frames flowing on a static screen)
    let sendStream = stream;
    host.viewer.rawTrack = track;
    if (pump) {
      host.viewer.pump = pump;
      try { pump.track.contentHint = track.contentHint; } catch { /* */ }
      sendStream = new MediaStream([pump.track]);
    }

    // Windows: hide the cursor in the captured picture; the viewer draws a local, instant cursor
    let localCursor = false;
    if (agent && agent.hideCursor) { try { localCursor = await agent.hideCursor(); } catch { /* */ } }

    const cap = await turboCap();
    conn.send({
      t: 'ok',
      turbo: cap ? { codec: cap.codec, hw: cap.hw, maxH: cap.maxH, maxFps: cap.maxFps } : null,
      localCursor,
      files: !!(agent && agent.fileBegin),
      control: !!agent,
      name: myName(),
      platform: agent ? agent.platform : 'web',
      screens: host.screens.map((s, i) => ({ i, name: s.name })),
      screen: host.screenIdx,
    });

    host.viewer.sendStream = sendStream;
    placeVideoCall(host.viewer);
    track.addEventListener('ended', () => { if (host.viewer && host.viewer.rawTrack === track) endHostSession(); });

    host.viewer.autoTimer = setInterval(autoTick, 1000);
    hostFileChannel(host.viewer);

    // диагностика към зрителя на всеки 2 секунди
    if (agent && agent.inputDiag) {
      let warned = 0;
      host.viewer.diagTimer = setInterval(async () => {
        if (!host.viewer || !host.viewer.conn.open) return;
        const d = await agent.inputDiag();
        try {
          const pc = host.viewer.call && host.viewer.call.peerConnection;
          d.codecInfo = codecInfo;
          d.capHealth = host.capHealth; d.pumpErr = host.pumpError || '';
          d.capFrames = host.viewer.pump ? host.viewer.pump.stats.total : null;
          d.capBackend = agent.platform === 'win32' ? (agent.captureCompat ? 'DXGI' : 'WGC') : '';
          try { const rt = host.viewer.rawTrack; d.trackState = rt ? rt.readyState + (rt.muted ? ' · muted' : '') : 'none'; } catch { /* */ }
          if (host.viewer.pump) { d.rawFps = host.viewer.pump.stats.rawFps; d.dropped = host.viewer.pump.stats.dropped; }
          const tv = host.viewer.turbo;
          if (tv) {
            const t = tv.stats;
            d.turbo = { cap: t.fps.cap, enc: t.fps.enc, dropEnc: t.dropEnc, dropNet: t.dropNet, encMs: +tv.encodeLatency().toFixed(1),
              kbps: t.kbps, buffered: t.buffered || 0, w: t.w, h: t.h, codec: t.codec, hw: t.hw, keyframes: t.keyframes, error: t.error || '' };
            tv.resetLatency();
          }
          d.preset = host.quality === 'auto' ? presetFor('auto').label : (QUALITY[host.quality] || {}).label;
          if (!host.probeResult && window.BDTurbo) { host.probeResult = 'checking…'; window.BDTurbo.probe().then((r) => { host.probeResult = r; }); }
          d.probe = host.probeResult;
          if (agent.gpuProfiles && !host.gpuProfiles) { host.gpuProfiles = '…'; agent.gpuProfiles().then((r) => { host.gpuProfiles = r; }).catch(() => {}); }
          d.vea = host.gpuProfiles;
          if (agent.metrics) { try { d.res = await agent.metrics(); } catch { /* */ } }
          const st = pc ? await pc.getStats() : null;
          if (st) st.forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
              d.enc = r.encoderImplementation || '?';
              const cc = r.codecId && st.get(r.codecId); if (cc) d.codec = cc.mimeType.replace('video/', '');
              d.hw = r.powerEfficientEncoder;
              d.sendFps = r.framesPerSecond;
              d.limit = r.qualityLimitationReason;
              host.viewer.lastLimit = r.qualityLimitationReason;
              d.sendRes = r.frameWidth ? r.frameWidth + '×' + r.frameHeight : '';
            }
            if (r.type === 'media-source' && r.kind === 'video') d.capFps = r.framesPerSecond;
          });
        } catch { /* */ }
        host.viewer.conn.send({ t: 'diag', d });
        const fg = d.foreground;
        if (fg && fg.elevated && !d.isAdmin && Date.now() - warned > 15000) {
          warned = Date.now();
          host.viewer.conn.send({ t: 'warn', code: 'elevated', name: fg.name });
        }
      }, 2000);
    }

    $('#activeName').textContent = name;
    $('#activeMode').textContent = agent ? 'is controlling this computer' : 'is viewing your screen';
    $('#hostActive').hidden = false;
    setNet('busy', 'In session');
    if (agent) agent.sessionState(true, name);
  }

  function endHostSession() {
    const v = host.viewer;
    if (!v) return;
    host.viewer = null;
    try { v.conn.send({ t: 'bye' }); } catch { /* */ }
    try { v.call && v.call.close(); } catch { /* */ }
    setTimeout(() => { try { v.conn.close(); } catch { /* */ } }, 200);
    if (v.turbo) { try { v.turbo.stop(); } catch { /* */ } v.turbo = null; }
    try { v.fileDc && v.fileDc.close(); } catch { /* */ }
    if (v.pump) v.pump.stop();
    if (v.stream) v.stream.getTracks().forEach((t) => t.stop());
    clearInterval(v.diagTimer); clearInterval(v.autoTimer);
    if (agent) { agent.input({ t: 'ka' }); if (agent.restoreCursor) agent.restoreCursor(); agent.sessionState(false); }
    $('#hostActive').hidden = true;
    if (host.peer && host.peer.open) setNet('online', 'Ready to connect');
    // браузърното споделяне е приключило ли?
    if (!agent && host.stream && host.stream.getVideoTracks()[0].readyState === 'ended') stopHost();
  }

  function applyQuality(level) {
    const v = host.viewer; if (!v) return;
    level = LEGACY_Q[level] || level;
    if (level !== 'auto' && !QUALITY[level]) level = DEFAULT_Q;
    if (level === 'auto' && host.quality !== 'auto') host.autoIdx = 0;
    host.quality = level;
    const q = presetFor(level);
    if (v.turbo) v.turbo.setQuality({ maxH: q.maxH, fps: q.fps, bitrate: q.maxBitrate });
    if (!v.call || !v.call.peerConnection) return;
    const sender = v.call.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    // constraints on the capture track apply to both engines
    const src0 = v.rawTrack;
    if (src0 && src0.applyConstraints) {
      src0.applyConstraints({ width: { max: Math.round(q.maxH * 16 / 9) }, height: { max: q.maxH }, frameRate: { max: q.fps } })
        .catch((e) => console.warn('constraints', e));
    }
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = q.maxBitrate;
    // резолюцията се сменя още при заснемането (не само при кодирането)
    const src = v.rawTrack || sender.track;
    // the capture itself is already limited to the preset size (constraints above) — scaling here again
    // shrank 720p to 800×450 (measured), so the encoder keeps the captured size
    p.encodings[0].scaleResolutionDownBy = 1;
    p.encodings[0].maxFramerate = q.fps;
    p.degradationPreference = q.pref;
    try { if (sender.track) sender.track.contentHint = q.hint; } catch { /* */ }
    try { if (src) src.contentHint = q.hint; } catch { /* */ }
    sender.setParameters(p).catch((e) => console.warn('quality', e));
  }

  async function switchScreen(idx) {
    const v = host.viewer; if (!v || !agent || !host.screens[idx]) return;
    host.screenIdx = idx;
    await agent.selectScreen(host.screens[idx].id);
    const s = await captureScreen(host.screens[idx].id);
    const track = s.getVideoTracks()[0];
    try { track.contentHint = presetFor(host.quality || DEFAULT_Q).hint; } catch { /* */ }
    const pump = makePump(track);
    if (pump) { try { pump.track.contentHint = track.contentHint; } catch { /* */ } }
    const oldPump = v.pump, oldStream = v.stream;
    // GPU engine: just swap its capture source; WebRTC sender stays paused
    if (v.turbo) v.turbo.setTrack(track);
    else if (v.rtcSender) await v.rtcSender.replaceTrack(pump ? pump.track : track);
    v.pump = pump; v.rawTrack = track; v.stream = s;
    if (oldPump) oldPump.stop();
    if (oldStream) oldStream.getTracks().forEach((t) => t.stop());
    track.addEventListener('ended', () => { if (host.viewer === v && v.rawTrack === track) endHostSession(); });
    applyQuality(host.quality || DEFAULT_Q); // same resolution / fps limits for the new monitor
    if (v.conn.open) v.conn.send({ t: 'screen-ok', i: idx });
  }

  function onViewerMsg(msg) {
    switch (msg.t) {
      case 'ping': host.viewer && host.viewer.conn.send({ t: 'pong', ts: msg.ts }); return;
      case 'q': applyQuality(msg.v); return;
      case 'screen': // one switch at a time
        host.switching = (host.switching || Promise.resolve()).then(() => switchScreen(Number(msg.i))).catch(console.error);
        return;
      case 'bye': endHostSession(); return;
      case 'turbo': if (msg.on) startTurbo(!!msg.sw).catch(console.error); else stopTurbo(); return;
      case 'recall': if (host.viewer) placeVideoCall(host.viewer); return;
      case 'kf': if (host.viewer && host.viewer.turbo) host.viewer.turbo.requestKey(); return;
      case 'vstat': if (host.viewer && msg.trouble) host.viewer.viewerTrouble = true; return;
      case 'clip': if (agent) agent.setClipboard(String(msg.text || '').slice(0, 100_000)); return;
      case 'mm': case 'md': case 'mu': case 'wh': case 'kd': case 'ku': case 'kt': case 'ka': case 'ch':
        if (agent) agent.input(msg);
        return;
      default:
    }
  }

  // =====================================================================
  //  ЗРИТЕЛ — компютърът, от който управляваш
  // =====================================================================
  const view = { peer: null, conn: null, call: null, id: null, control: false, stats: null, ping: null, timeout: null, held: new Set(), ended: true };

  // AnyDesk-style: if a running session drops (network hiccup, Wi-Fi switch, sleep), reconnect by itself
  // with the same password instead of throwing the user back to the start screen.
  let reconn = { n: 0 };
  function connectionLost() {
    if (view.ended || !view.sessionShown || !view.id) return false;
    if (reconn.id !== view.id || performance.now() - (reconn.at || 0) > 60000) reconn = { id: view.id, n: 0 };
    if (reconn.n >= 4) return false;
    reconn.n++; reconn.at = performance.now();
    const id = view.id, pass = view.pass, opts = { remember: view.remember, usedSaved: view.usedSaved };
    endView(null);
    showConnecting('Connection lost', 'Reconnecting automatically (attempt ' + reconn.n + ')…');
    $('#ovConnecting').hidden = false;
    view.retryTimer = setTimeout(() => { if (view.ended) connect(id, pass, false, opts); }, 1500 * reconn.n);
    return true;
  }

  function connect(rawId, pass, isRetry, opts) {
    opts = opts || {};
    const id = cleanId(rawId);
    if (id.length !== 9) return toast('The ID must be 9 digits', true);
    if (host.id && id === host.id) return toast('That is your own ID', true);
    view.id = id; view.pass = pass; view.ended = false;
    view.sessionShown = false; view.recallCount = 0; view.noPicSince = 0; view.backupAsked = false;
    view.autoRetried = !!isRetry;
    if (!isRetry) { view.remember = !!opts.remember; view.usedSaved = !!opts.usedSaved; }
    showConnecting('Connecting…', 'Looking for computer ' + fmtId(id) + '.');

    const peer = new Peer(peerOpts());
    view.peer = peer;
    view.timeout = setTimeout(() => failView('No response. Check the ID and your internet connection.'), 25_000);

    peer.on('open', () => {
      const conn = peer.connect(C.idPrefix + id, { reliable: true, serialization: 'json' });
      view.conn = conn;
      conn.on('open', () => conn.send({ t: 'hello', pass: pass || '', name: myName(), v: 1 }));
      conn.on('data', onHostMsg);
      conn.on('close', () => { if (!connectionLost()) endView(view.call ? 'The session ended' : null); });
      conn.on('error', () => {});
    });
    peer.on('call', (call) => {
      if (view.call && view.call !== call) { const old = view.call; view.call = null; try { old.close(); } catch { /* */ } }
      view.call = call;
      call.answer(undefined, { sdpTransform: tuneAnswer });
      call.on('stream', (s) => { lowLatency(call.peerConnection); showSession(s); });
      call.on('close', () => { if (view.call === call && !view.recalling && !connectionLost()) endView('The session ended'); });
      const pc = call.peerConnection;
      if (pc) pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' && !connectionLost()) endView('Could not establish a direct connection (try another network or a TURN server).', true);
      });
    });
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') failView('Computer with ID ' + fmtId(id) + ' is not online.');
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') failView('Cannot reach the signaling server.');
      else console.warn('[view]', e.type, e);
    });
  }

  function onHostMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'wait':
        clearTimeout(view.timeout);
        view.timeout = setTimeout(() => failView('The remote side did not respond in time.'), 65_000);
        showConnecting('Waiting for approval', 'The remote side needs to click "Accept".');
        return;
      case 'ok':
        clearTimeout(view.timeout);
        view.control = !!msg.control;
        view.hostPlatform = msg.platform || '';
        view.localCursor = !!msg.localCursor && !!msg.control;
        view.files = !!msg.files && !!msg.control;
        $('#btnFile').hidden = !view.files;
        view.fileDc = view.files ? openFileChannel(view.conn.peerConnection) : null;
        setViewCursor(view.localCursor ? 'default' : 'none');
        // Mac -> Windows/Linux: Cmd работи като Ctrl (Cmd+C, Cmd+V…)
        view.remapMeta = IS_MAC && view.hostPlatform && view.hostPlatform !== 'darwin';
        view.remapCtrl = !IS_MAC && view.hostPlatform === 'darwin';
        view.hostName = msg.name || 'Computer';
        view.hostTurbo = msg.turbo || null;
        maybeStartTurbo();
        // the video connection must deliver a stream within 6 s, otherwise rebuild it
        view.streamTries = 0;
        const waitStream = () => {
          view.streamTimer = setTimeout(() => {
            if (view.ended || view.sessionShown) return;
            if (view.receiver && view.receiver.stats.displayed > 0) { showSession(new MediaStream()); return; }
            if (view.streamTries >= 2 && startBackupPath()) {
              view.streamTries++;
              showConnecting('Connecting video…', 'Using the backup path for the picture.');
              waitStream();
              return;
            }
            if (++view.streamTries <= 4 && view.conn && view.conn.open) {
              showConnecting('Connecting video…', 'The picture connection is being rebuilt (attempt ' + view.streamTries + ').');
              send({ t: 'recall' });
              waitStream();
            } else failView('Could not establish the video connection. Check the internet on both computers and try again.');
          }, 6000);
        };
        waitStream();
        setupScreens(msg.screens || [], msg.screen || 0);
        saveRecent(view.id, view.hostName);
        if (view.remember && view.pass && !view.usedSaved) savePass(view.id, view.pass);
        return;
      case 'deny': {
        if (msg.reason === 'restarting' && !view.autoRetried) {
          const id = view.id, pass = view.pass;
          view.ended = false; endView(null);
          showConnecting('Remote side is restarting', 'BridgeDesk on the other computer is restarting its screen capture. Reconnecting in a few seconds…');
          view.retryTimer = setTimeout(() => { connect(id, pass, true); }, 14000);
          $('#ovConnecting').hidden = false;
          return;
        }
        if (msg.reason === 'pass' && view.usedSaved) {
          forgetPass(view.id);
          return failView('The saved password for this computer no longer works — enter it again.');
        }
        const r = {
          pass: 'Wrong password.',
          rejected: 'The remote side declined the connection.',
          busy: 'The computer is already in another session.',
          locked: 'Too many wrong attempts. Try again in a minute.',
          capture: 'The remote computer could not capture its screen' + (msg.detail ? ' (' + msg.detail + ')' : '') + '.',
          restarting: 'BridgeDesk on the remote computer is restarting its screen capture. Reconnecting automatically…',
          'locked-screen': 'The remote computer is locked. Unlock it (sign in to Windows) and try again.',
          noscreen: 'No screen found on the remote computer — is the monitor off or is it in a Remote Desktop session?',
        }[msg.reason] || 'The connection was refused.';
        return failView(r);
      }
      case 'clipboard': setLocalClipboard(String(msg.text || '')); return;
      case 'diag': renderDiag(msg.d); return;
      case 'turbo-ok':
        view.turboHostHw = !!msg.hw;
        if (msg.sw && !view.receiver && !view.ended) startReceiver(msg.codec);
        return;
      case 'turbo-no':
        stopTurboView(false);
        if (view.enginePref === 'turbo') toast('GPU engine not available on the remote computer (' + (msg.reason || '?') + ') — using Standard.', true);
        return;
      case 'screen-ok': toast('Showing screen ' + (Number(msg.i) + 1)); return;
      case 'cur': if (view.localCursor) setViewCursor(String(msg.s || 'default')); return;
      case 'warn':
        if (msg.code === 'elevated') {
          toast('The active window on the remote computer is "' + msg.name + '", running as administrator — Windows blocks mouse and keyboard input to it.', true);
          return;
        }
        if (msg.code === 'blocked') toast(msg.isAdmin ? 'Windows on the remote computer is blocking input (e.g. lock screen or a UAC prompt).' : 'A window running as administrator is active on the remote computer — Windows blocks input to it. Run BridgeDesk as administrator there.', true);
        return;
      case 'fdone': fileDone(msg); return;
      case 'pong': view.lastPong = performance.now(); $('#stPing').textContent = Math.max(0, Math.round(performance.now() - msg.ts)); return;
      case 'bye': endView('The remote side ended the session'); return;
      default:
    }
  }

  // минимален буфер при показване — картината излиза веднага щом пристигне
  function lowLatency(pc) {
    if (!pc) return;
    pc.getReceivers().forEach((r) => {
      try { r.jitterBufferTarget = 0; } catch { /* */ }
      try { r.playoutDelayHint = 0; } catch { /* */ }
    });
  }

  // --- клипборд ---
  let lastClip = '';
  async function setLocalClipboard(text) {
    if (!text) return;
    lastClip = text;
    try {
      if (agent) agent.setClipboard(text);
      else await navigator.clipboard.writeText(text);
    } catch { /* браузърът позволява запис само когато прозорецът е на фокус */ }
  }
  async function pushLocalClipboard() { // браузър: прочитаме клипборда и го пращаме отсреща
    try {
      const t = await navigator.clipboard.readText();
      if (t && t !== lastClip) { lastClip = t; send({ t: 'clip', text: t.slice(0, 200000) }); }
    } catch { /* няма разрешение */ }
  }
  if (agent && agent.onCursorShape) {
    agent.onCursorShape((sh) => { if (host.viewer && host.viewer.conn.open) host.viewer.conn.send({ t: 'cur', s: sh }); });
  }
  if (agent && agent.onInputBlocked) {
    agent.onInputBlocked((d) => { if (host.viewer && host.viewer.conn.open) host.viewer.conn.send({ t: 'warn', code: 'blocked', isAdmin: d.isAdmin }); });
  }
  if (agent && agent.onClipboard) {
    agent.onClipboard((text) => {
      if (host.viewer && host.viewer.conn.open) host.viewer.conn.send({ t: 'clipboard', text });
      else if (!view.ended && view.conn && view.conn.open && view.control) { lastClip = text; send({ t: 'clip', text }); }
    });
  }

  // local cursor drawn by the viewer (moves instantly, like AnyDesk)
  const CURSORS = new Set(['default', 'text', 'wait', 'crosshair', 'nwse-resize', 'nesw-resize', 'ew-resize', 'ns-resize', 'move', 'not-allowed', 'pointer', 'progress', 'help', 'none']);
  function setViewCursor(c) {
    const v = CURSORS.has(c) ? c : 'default';
    stage.style.cursor = v; video.style.cursor = v; if (canvasEl) canvasEl.style.cursor = v;
  }

  // --- панел „Диагностика“ ---
  function renderDiag(d) {
    const el = $('#diagPanel'); if (!el) return;
    view.lastDiag = d;
    const s = (k) => sentStats[k] || 0;
    const fg = d.foreground;
    const n = view.net || {};
    const r = view.receiver && view.turboActive ? view.receiver.stats : null;
    const t = d.turbo;
    const ms = (x) => (x == null || isNaN(x) ? '–' : x + ' ms');
    const rows = [];
    const sec = (title) => rows.push([title]);
    const row = (a, b) => rows.push([a, b == null ? '–' : b]);

    sec('Engine');
    row('Video engine', r ? 'GPU (WebCodecs) · ' + (t && t.hw ? 'hardware encode' : 'software encode') + ' · ' + (r.hw ? 'hardware decode' : 'software decode')
      : 'Standard (WebRTC)' + (view.receiver ? ' · GPU starting…' : ''));
    row('Mode', d.preset || '–');
    row('GPU engine on remote', view.hostTurbo ? (view.hostTurbo.hw ? 'available · ' + view.hostTurbo.codec + (view.hostTurbo.maxH ? ' · up to ' + view.hostTurbo.maxH + 'p' + view.hostTurbo.maxFps : '') : 'software only') : 'not available');

    sec('Pipeline (capture → encode → network → decode → display)');
    if (r && t) {
      row('Capture fps (Windows)', t.cap);
      row('Encoded fps · encode time', t.enc + ' · ' + ms(t.encMs));
      row('Encoder', (t.codec || '') + ' · ' + (t.w ? t.w + '×' + t.h : '') + ' · ' + (t.hw ? 'hardware' : 'software'));
      row('Received / decoded / displayed fps', r.fps.recv + ' / ' + r.fps.dec + ' / ' + r.fps.disp);
      row('Decode time', ms(+view.receiver.decodeLatency().toFixed(1)));
      row('1% low fps · frame time p50 / p99', (r.low1 || '–') + ' · ' + (r.p50 || '–') + ' / ' + (r.p99 || '–') + ' ms');
      row('Dropped: encoder / network / lost', t.dropEnc + ' / ' + t.dropNet + ' / ' + r.lost);
      row('Freezes (>400 ms) · keyframe requests', r.freezes + ' · ' + r.keyReq);
      if (t.error || r.error) row('Engine error', (t.error || '') + ' ' + (r.error || ''));
      view.receiver.resetLatency();
    } else {
      row('Capture fps (Windows)', d.rawFps != null ? d.rawFps + (d.dropped ? ' (pump dropped ' + d.dropped + ')' : '') : '–');
      row('Capture · health', [d.capBackend, d.trackState, d.capHealth, d.capFrames != null ? d.capFrames + ' frames' : (d.pumpErr ? 'pump: ' + d.pumpErr : 'no pump')].filter(Boolean).join(' · ') || '–');
      row('Encoded / sent fps', (d.capFps != null ? Math.round(d.capFps) : '–') + ' / ' + (d.sendFps != null ? Math.round(d.sendFps) : '–'));
      row('Encoder', (d.codec ? d.codec + ' · ' : '') + (d.enc || '–') + (d.hw === true ? ' · hardware' : d.hw === false ? ' · software' : '') + (d.sendRes ? ' · ' + d.sendRes : ''));
      row('Decoded / displayed fps', (n.decFps != null ? Math.round(n.decFps) : '–') + ' / ' + presented.fps);
      row('Decoder · decode time', (view.decoder || '–') + ' · ' + ms(n.decMs));
      row('1% low fps · frame time p99', (presented.low1 || '–') + ' · ' + ms(presented.p99));
      row('Jitter buffer', ms(n.jbMs));
      row('Frames dropped · freezes', (n.dropped != null ? n.dropped : '–') + ' · ' + (n.freezes != null ? n.freezes + ' (' + (n.freezeSec || 0).toFixed(1) + ' s)' : '–'));
      row('Quality limited by', d.limit && d.limit !== 'none' ? d.limit.toUpperCase() : 'nothing');
    }

    sec('Network');
    row('Route · RTT', ($('#stRoute').textContent || '–') + ' · ' + ms(n.rtt != null ? n.rtt : +$('#stPing').textContent || null));
    if (r && t) row('Bitrate · send queue', (t.kbps / 1000).toFixed(1) + ' Mbps · ' + Math.round((t.buffered || 0) / 1024) + ' KB');
    else row('Jitter · packets lost', ms(n.jitter) + ' · ' + (n.lost != null ? n.lost + ' / ' + (n.recvPk || 0) : '–'));

    sec('Remote computer');
    row('GPU', (d.gpuName || '?') + ' · video encode ' + (d.gpuEncode || '?'));
    row('HW encode profiles (Chromium)', d.vea || '–');
    row('WebCodecs hardware probe', d.probe || '–');
    if (d.res) row('BridgeDesk CPU · memory', d.res.cpu + ' % · ' + d.res.memMB + ' MB');
    row('Input mode', d.mode + (d.isAdmin ? ' · administrator' : ' · standard user'));
    row('Active window', fg ? (fg.name + (fg.elevated ? ' ⚠ administrator' : '')) : '—');

    sec('Input');
    row('Moves · clicks · keys (sent / received)', s('mm') + '/' + d.mm + ' · ' + (s('md') + s('mu')) + '/' + (d.md + d.mu) + ' · ' + (s('kd') + s('ku')) + '/' + (d.kd + d.ku));
    row('Blocked by Windows · errors', (d.sendFail || 0) + ' · ' + (d.errors ? d.errors + ' — ' + d.lastError : '0'));

    const esc = (x) => String(x).replace(/[<>&]/g, '');
    el.innerHTML = '<b>Diagnostics</b>' + rows.map((x) => (x.length === 1
      ? '<div class="diag-sec">' + esc(x[0]) + '</div>'
      : '<div class="diag-row"><span>' + esc(x[0]) + '</span><em>' + esc(x[1]) + '</em></div>')).join('');
  }


  // ---------- GPU engine (viewer side) ----------
  const canvasEl = $('#turboCanvas');
  view.enginePref = store.get('engine', 'auto');
  // Backup path (like AnyDesk's single connection): the picture travels over the control connection,
  // which is up whenever the session is up. Used when the separate video connection gives no picture.
  function startBackupPath() {
    if (view.receiver || view.backupAsked || !window.BDTurbo || !window.BDTurbo.SUPPORTED) return false;
    view.backupAsked = true;
    toast('No picture over the video connection — switching to the backup path…');
    send({ t: 'turbo', on: true, sw: true });
    return true;
  }
  function startReceiver(codec) {
    const pc = view.conn && view.conn.peerConnection;
    if (!pc || view.receiver) return;
    view.receiver = window.BDTurbo.createReceiver({ pc, canvas: canvasEl, codec, onKeyRequest: () => send({ t: 'kf' }) });
    view.turboStartedAt = performance.now();
    view.turboPrevLost = 0;
  }
  async function maybeStartTurbo() {
    if (view.receiver || view.enginePref === 'standard') return;
    const ht = view.hostTurbo;
    if (!ht || !window.BDTurbo || !window.BDTurbo.SUPPORTED) {
      if (view.enginePref === 'turbo') toast(ht ? 'This computer cannot decode the GPU stream — using Standard.' : 'The remote computer has no hardware encoder for the GPU engine — using Standard.', true);
      return;
    }
    // Auto only uses the GPU engine when the host really encodes in hardware
    if (view.enginePref === 'auto' && !ht.hw) return;
    const dec = await window.BDTurbo.hardwareDecoder(ht.codec);
    const pc = view.conn && view.conn.peerConnection;
    if (!dec || !pc || view.ended) return;
    view.receiver = window.BDTurbo.createReceiver({ pc, canvas: canvasEl, codec: ht.codec, onKeyRequest: () => send({ t: 'kf' }) });
    view.turboStartedAt = performance.now();
    view.turboPrevLost = 0;
    send({ t: 'turbo', on: true });
  }
  function activateTurboView() {
    view.turboActive = true;
    canvasEl.hidden = false; video.hidden = true;
    const tag = $('#sesMode'); tag.textContent = 'control · GPU'; tag.className = 'tag control turbo';
    setViewCursor(stage.style.cursor || (view.localCursor ? 'default' : 'none'));
  }

  // =====================================================================
  //  File transfer (viewer -> remote computer): saved in Downloads\BridgeDesk
  //  Own ordered, reliable data channel on the control connection (encrypted like everything else).
  // =====================================================================
  const FILE_CH = 101, FCHUNK = 60 * 1024, FBUF = 4 * 1024 * 1024;
  function openFileChannel(pc) {
    if (!pc) return null;
    try {
      const dc = pc.createDataChannel('bd-files', { negotiated: true, id: FILE_CH, ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = FBUF / 4;
      return dc;
    } catch (e) { console.warn('files', e); return null; }
  }
  function hostFileChannel(v) {
    const dc = openFileChannel(v.conn.peerConnection);
    if (!dc) return;
    v.fileDc = dc;
    let chain = Promise.resolve();
    const names = new Map();
    dc.onmessage = (ev) => {
      const b = new Uint8Array(ev.data), type = b[0], dv = new DataView(ev.data), id = dv.getUint32(1);
      chain = chain.then(async () => {
        if (!agent || !agent.fileBegin) { if (type === 3) v.conn.send({ t: 'fdone', id, ok: false, error: 'this computer cannot receive files' }); return; }
        if (type === 1) {
          const size = dv.getFloat64(5), name = new TextDecoder().decode(b.subarray(13));
          const r = await agent.fileBegin(id, name, size);
          names.set(id, r && r.ok ? r.name : null);
          if (!r || !r.ok) v.conn.send({ t: 'fdone', id, ok: false, error: (r && r.error) || 'cannot save' });
        } else if (type === 2) {
          if (names.get(id)) agent.fileChunk(id, b.slice(5));
        } else if (type === 3 || type === 4) {
          if (!names.get(id)) return;
          const r = await agent.fileEnd(id, type === 3);
          names.delete(id);
          if (type === 3) {
            v.conn.send({ t: 'fdone', id, ok: !!(r && r.ok), name: r && r.name, error: r && r.error });
            if (r && r.ok) { toast('Received file "' + r.name + '" — saved in Downloads › BridgeDesk'); host.lastReceived = r.path; }
          }
        }
      }).catch((e) => console.warn('file', e));
    };
    // session dropped mid-transfer: discard the half-written files
    dc.onclose = () => { chain = chain.then(async () => { for (const [id, n] of names) if (n) await agent.fileEnd(id, false); names.clear(); }); };
  }

  let fileSeq = 0, fileBusy = false;
  const fileQueue = [], fileWait = new Map();
  function sendFiles(list) {
    if (!view.files || !view.fileDc) return toast('The remote computer cannot receive files (update BridgeDesk there).', true);
    for (const f of list) fileQueue.push(f);
    if (!fileBusy) pumpFiles();
  }
  function fileDone(msg) {
    const w = fileWait.get(msg.id); if (!w) return;
    fileWait.delete(msg.id); w(msg);
  }
  async function pumpFiles() {
    fileBusy = true;
    let sent = 0, failed = 0;
    while (fileQueue.length) {
      const f = fileQueue.shift(), dc = view.fileDc;
      if (!dc || view.ended) { failed++; continue; }
      if (dc.readyState !== 'open') await new Promise((r) => { dc.addEventListener('open', r, { once: true }); setTimeout(r, 5000); });
      if (dc.readyState !== 'open') { failed++; continue; }
      const id = ++fileSeq;
      const nameB = new TextEncoder().encode(f.name);
      const head = new Uint8Array(13 + nameB.length); const hv = new DataView(head.buffer);
      head[0] = 1; hv.setUint32(1, id); hv.setFloat64(5, f.size); head.set(nameB, 13);
      const done = new Promise((r) => fileWait.set(id, r));
      dc.send(head);
      let off = 0, lastShow = 0, aborted = false;
      while (off < f.size) {
        if (view.ended || dc.readyState !== 'open') { aborted = true; break; }
        if (dc.bufferedAmount > FBUF) { await new Promise((r) => { dc.addEventListener('bufferedamountlow', r, { once: true }); setTimeout(r, 1000); }); continue; }
        const part = new Uint8Array(await f.slice(off, off + FCHUNK).arrayBuffer());
        const pkt = new Uint8Array(5 + part.length); pkt[0] = 2; new DataView(pkt.buffer).setUint32(1, id); pkt.set(part, 5);
        dc.send(pkt);
        off += part.length;
        if (performance.now() - lastShow > 300) { lastShow = performance.now(); toast('Sending "' + f.name + '" — ' + Math.floor(off * 100 / Math.max(1, f.size)) + '%'); }
      }
      if (aborted) { fileWait.delete(id); failed++; continue; }
      const end = new Uint8Array(5); end[0] = 3; new DataView(end.buffer).setUint32(1, id);
      dc.send(end);
      const r = await Promise.race([done, new Promise((res) => setTimeout(() => res({ ok: false, error: 'no answer' }), 120000))]);
      if (r.ok) sent++; else { failed++; toast('Could not send "' + f.name + '": ' + (r.error || 'error'), true); }
    }
    fileBusy = false;
    if (sent && !failed) toast(sent === 1 ? 'File sent — saved in Downloads › BridgeDesk on the remote computer' : sent + ' files sent — saved in Downloads › BridgeDesk on the remote computer');
    else if (sent) toast(sent + ' sent, ' + failed + ' failed', true);
  }

  function stopTurboView(sendOff) {
    if (view.receiver) { try { view.receiver.stop(); } catch { /* */ } view.receiver = null; }
    const was = view.turboActive;
    view.turboActive = false;
    canvasEl.hidden = true; video.hidden = false;
    if (view.control) { const tag = $('#sesMode'); tag.textContent = 'control'; tag.className = 'tag control'; }
    if (sendOff && view.conn && view.conn.open) send({ t: 'turbo', on: false });
    return was;
  }
  // Standard engine: no picture within 5 s (or picture stopped and never came back) → rebuild the
  // video connection. The control connection stays up, so the session is not lost.
  function videoWatch() {
    if (view.turboActive || view.ended) return;
    const now = performance.now();
    const hasPicture = video.videoWidth > 0 && presented.fps > 0;
    if (hasPicture) { view.noPicSince = 0; return; }
    if (!view.noPicSince) view.noPicSince = now;
    const limit = video.videoWidth > 0 ? 6000 : 4000;   // a static screen still gets ~10 fps from the host
    if (now - view.noPicSince > limit && (view.recallCount || 0) >= 1 && startBackupPath()) { view.noPicSince = now; return; }
    if (now - view.noPicSince > limit && (view.recallCount || 0) < 4 && view.conn && view.conn.open) {
      view.recallCount = (view.recallCount || 0) + 1;
      view.noPicSince = now;
      view.recalling = true; setTimeout(() => { view.recalling = false; }, 3000);
      send({ t: 'recall' });
      toast('No picture yet — reconnecting the video…');
    }
  }

  // called every second from the stats loop
  function turboWatch() {
    const r = view.receiver; if (!r) return;
    const t = r.stats;
    if (!view.turboActive && t.displayed > 0) activateTurboView();
    // no picture after 6 s → fall back to the standard engine automatically
    if (!view.turboActive && performance.now() - view.turboStartedAt > 6000) {
      stopTurboView(true);
      toast('GPU engine did not start — switched back to Standard.', true);
      return;
    }
    // tell the host when frames are being lost (Automatic mode steps down)
    if (t.lost - view.turboPrevLost > 2) send({ t: 'vstat', trouble: true });
    view.turboPrevLost = t.lost;
  }

  // displayed-frame counter for the standard engine (requestVideoFrameCallback = real presented frames)
  const presented = { n: 0, fps: 0, intervals: [], last: 0, low1: 0, p99: 0, t: performance.now() };
  function trackPresented() {
    if (!video.requestVideoFrameCallback) return;
    const cb = (now) => {
      if (presented.last) { presented.intervals.push(now - presented.last); if (presented.intervals.length > 300) presented.intervals.shift(); }
      presented.last = now; presented.n++;
      if (!view.ended) video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }
  function presentedTick() {
    const now = performance.now(), dt = (now - presented.t) / 1000;
    presented.fps = Math.round(presented.n / dt); presented.n = 0; presented.t = now;
    if (presented.intervals.length > 20) {
      const s = [...presented.intervals].sort((a, b) => a - b);
      presented.p99 = Math.round(s[Math.floor(s.length * 0.99) - 1] || s[s.length - 1]);
      presented.low1 = Math.round(1000 / presented.p99);
    }
  }

  function showConnecting(title, text) {
    $('#connTitle').textContent = title; $('#connText').textContent = text; $('#ovConnecting').hidden = false;
  }
  function failView(text) {
    if (view.ended) return;
    endView(null);
    toast(text, true);
  }

  function showSession(stream) {
    $('#ovConnecting').hidden = true;
    const video = $('#remote');
    video.srcObject = stream;
    video.play().catch(() => {});
    clearTimeout(view.streamTimer);
    if (view.sessionShown) return;      // video connection was rebuilt — keep the running session UI
    view.sessionShown = true;
    $('#home').hidden = true;
    const s = $('#session'); s.hidden = false;
    s.classList.toggle('control', view.control);
    s.classList.toggle('view-only', !view.control);
    $('#sesName').textContent = view.hostName || 'Computer';
    $('#sesId').textContent = fmtId(view.id);
    const tag = $('#sesMode');
    tag.textContent = view.control ? 'control' : 'view only';
    tag.className = 'tag' + (view.control ? ' control' : '');
    $('#selQuality').value = DEFAULT_Q;
    $('#stage').focus();
    trackPresented();
    startStats();
    if (agent) agent.sessionState(true, 'view');
  }

  function setupScreens(list, cur) {
    const sel = $('#selScreen');
    sel.innerHTML = '';
    list.forEach((s) => { const o = document.createElement('option'); o.value = s.i; o.textContent = 'Screen ' + (s.i + 1); sel.appendChild(o); });
    sel.value = cur;
    sel.hidden = list.length < 2;
  }

  function endView(msg, err) {
    if (view.ended) return;
    view.ended = true;
    clearTimeout(view.timeout); clearTimeout(view.streamTimer);
    view.sessionShown = false;
    releaseAllKeys();
    try { view.conn && view.conn.open && view.conn.send({ t: 'bye' }); } catch { /* */ }
    stopTurboView(false);
    fileQueue.length = 0;
    try { view.fileDc && view.fileDc.close(); } catch { /* */ } view.fileDc = null;
    try { view.call && view.call.close(); } catch { /* */ }
    try { view.peer && view.peer.destroy(); } catch { /* */ }
    view.peer = view.conn = view.call = null;
    clearInterval(view.stats); clearInterval(view.ping);
    $('#remote').srcObject = null;
    stage.style.cursor = ''; video.style.cursor = '';
    $('#ovConnecting').hidden = true;
    $('#session').hidden = true;
    $('#session').classList.remove('fs');
    $('#home').hidden = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (agent) agent.sessionState(false);
    if (msg) toast(msg, err);
  }

  // --- статистики ---
  function startStats() {
    let lastBytes = 0, lastTs = 0;
    clearInterval(view.stats); clearInterval(view.ping);
    view.lastPong = performance.now();
    view.ping = setInterval(() => {
      try { view.conn.send({ t: 'ping', ts: performance.now() }); } catch { /* */ }
      if (view.sessionShown && performance.now() - view.lastPong > 8000) connectionLost();
    }, 2000);
    view.net = {};
    view.stats = setInterval(async () => {
      presentedTick();
      turboWatch();
      videoWatch();
      const pc = view.call && view.call.peerConnection; if (!pc) return;
      const rep = await pc.getStats();
      let pairId = null;
      if (view.turboActive && view.receiver) {
        const t = view.receiver.stats;
        $('#stFps').textContent = t.fps.disp;
        if (t.w) $('#stRes').textContent = t.w + '×' + t.h;
        $('#stRate').textContent = (t.kbps / 1000).toFixed(1);
      }
      rep.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && !view.turboActive) {
          const n = view.net;
          n.jitter = r.jitter != null ? Math.round(r.jitter * 1000) : null;
          n.lost = r.packetsLost; n.recvPk = r.packetsReceived;
          n.freezes = r.freezeCount; n.freezeSec = r.totalFreezesDuration;
          n.dropped = r.framesDropped;
          if (r.jitterBufferEmittedCount) n.jbMs = Math.round(r.jitterBufferDelay / r.jitterBufferEmittedCount * 1000);
          if (r.framesDecoded) n.decMs = +(r.totalDecodeTime / r.framesDecoded * 1000).toFixed(1);
          n.decFps = r.framesPerSecond;
          $('#stFps').textContent = presented.fps || (r.framesPerSecond != null ? Math.round(r.framesPerSecond) : '–');
          if (r.frameHeight) $('#stRes').textContent = r.frameWidth + '×' + r.frameHeight;
          if (r.decoderImplementation) view.decoder = r.decoderImplementation + (r.powerEfficientDecoder ? ' · hardware' : r.powerEfficientDecoder === false ? ' · software' : '');
          if (lastTs && !view.turboActive) $('#stRate').textContent = (((r.bytesReceived - lastBytes) * 8) / ((r.timestamp - lastTs) * 1000)).toFixed(1);
          lastBytes = r.bytesReceived; lastTs = r.timestamp;
        }
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null && !pairId) pairId = r.id;
      });
      if (pairId) {
        const pair = rep.get(pairId); const lc = pair && rep.get(pair.localCandidateId);
        if (pair && pair.currentRoundTripTime != null) view.net.rtt = Math.round(pair.currentRoundTripTime * 1000);
        if (lc) $('#stRoute').textContent = lc.candidateType === 'relay' ? 'via TURN' : 'direct';
      }
    }, 1000);
  }

  // --- вход: мишка и клавиатура ---
  const stage = $('#stage');
  const video = $('#remote');
  function norm(e) {
    const el = view.turboActive ? canvasEl : video;
    const r = el.getBoundingClientRect();
    const vw = view.turboActive ? canvasEl.width : video.videoWidth, vh = view.turboActive ? canvasEl.height : video.videoHeight;
    if (!vw || !vh) return null;
    const sc = Math.min(r.width / vw, r.height / vh);
    const cw = vw * sc, ch = vh * sc;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    const x = (e.clientX - ox) / cw, y = (e.clientY - oy) / ch;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
  }
  const canSend = () => view.control && view.conn && view.conn.open && !$('#session').hidden;
  const sentStats = {};
  const send = (m) => { try { view.conn.send(m); if (m && m.t) sentStats[m.t] = (sentStats[m.t] || 0) + 1; } catch { /* */ } };

  const pressedButtons = new Set();
  let pendingMove = null, moveRaf = 0;
  stage.addEventListener('mousemove', (e) => {
    if (!canSend()) return;
    const p = norm(e); if (!p) return;
    pendingMove = p;
    if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; if (pendingMove) send({ t: 'mm', ...pendingMove }); pendingMove = null; });
  });
  stage.addEventListener('mousedown', (e) => {
    stage.focus();
    if (!canSend()) return;
    const p = norm(e); if (!p) return;
    e.preventDefault();
    pressedButtons.add(e.button);
    send({ t: 'md', b: e.button, ...p });
  });
  window.addEventListener('mouseup', (e) => {
    if (!canSend() || !pressedButtons.delete(e.button)) return;
    const p = norm(e) || {};
    send({ t: 'mu', b: e.button, ...p });
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  let wheelAcc = 0, wheelAccX = 0;
  stage.addEventListener('wheel', (e) => {
    if (!canSend()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    wheelAcc += e.deltaY * k; wheelAccX += e.deltaX * k;
    const dy = Math.trunc(wheelAcc / 100), dx = Math.trunc(wheelAccX / 100);
    if (dy || dx) { send({ t: 'wh', dx, dy }); wheelAcc -= dy * 100; wheelAccX -= dx * 100; }
  }, { passive: false });

  const mapCode = (c) => {
    if (view.remapMeta) return { MetaLeft: 'ControlLeft', MetaRight: 'ControlRight' }[c] || c;          // Mac -> Windows
    if (view.remapCtrl) return { ControlLeft: 'MetaLeft', ControlRight: 'MetaRight' }[c] || c;          // Windows -> Mac
    return c;
  };
  // Докато четем клипборда за Ctrl+V, задържаме следващите клавиши, за да запазим реда им
  let vPending = false; const keyQueue = [];
  const sendKey = (m) => { if (vPending) keyQueue.push(m); else send(m); };
  window.addEventListener('keydown', (e) => {
    if (!canSend() || !$('#ovSettings').hidden) return;
    if (e.target && e.target.tagName === 'SELECT') return;
    e.preventDefault();
    if (!e.code) { if (e.key && e.key.length === 1) sendKey({ t: 'ch', s: e.key }); return; }
    const c = mapCode(e.code);
    if (e.repeat && view.held.has(c)) { sendKey({ t: 'kd', c, r: 1 }); return; }
    view.held.add(c);
    if (!agent && !vPending && c === 'KeyV' && (e.ctrlKey || e.metaKey)) {
      vPending = true;
      pushLocalClipboard().finally(() => {
        send({ t: 'kd', c: 'KeyV' });
        vPending = false;
        while (keyQueue.length) send(keyQueue.shift());
      });
      return;
    }
    sendKey({ t: 'kd', c });
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!canSend()) return;
    e.preventDefault();
    if (!e.code) return;
    const c = mapCode(e.code);
    view.held.delete(c);
    sendKey({ t: 'ku', c });
  }, true);
  window.addEventListener('focus', () => { if (!agent && canSend()) pushLocalClipboard(); });
  window.addEventListener('blur', releaseAllKeys);
  function releaseAllKeys() {
    if (view.held.size && view.conn && view.conn.open) send({ t: 'ka' });
    view.held.clear();
  }

  // --- лента с инструменти ---
  $('#btnDiag').onclick = () => { $('#diagPanel').hidden = !$('#diagPanel').hidden; stage.focus(); };
  $('#btnHang').onclick = () => endView('The session ended');
  $('#selEngine').value = view.enginePref;
  $('#selEngine').onchange = (e) => {
    view.enginePref = e.target.value; store.set('engine', view.enginePref);
    if (view.enginePref === 'standard') { if (stopTurboView(true)) toast('Standard engine'); }
    else maybeStartTurbo();
    stage.focus();
  };
  $('#selQuality').onchange = (e) => { send({ t: 'q', v: e.target.value }); stage.focus(); };
  $('#selScreen').onchange = (e) => { send({ t: 'screen', i: Number(e.target.value) }); toast('Switching to screen ' + (Number(e.target.value) + 1) + '…'); stage.focus(); };
  $('#btnWin').onclick = () => { send({ t: 'kt', keys: ['MetaLeft'] }); stage.focus(); };
  $('#btnAltTab').onclick = () => { send({ t: 'kt', keys: ['AltLeft', 'Tab'] }); stage.focus(); };
  $('#btnFile').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { const l = [...e.target.files]; e.target.value = ''; if (l.length) sendFiles(l); };
  stage.addEventListener('dragover', (e) => { if (view.files && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  stage.addEventListener('drop', (e) => {
    if (!view.files || !e.dataTransfer) return;
    e.preventDefault();
    const l = [...e.dataTransfer.files].filter((f) => f.size > 0 || f.type);
    if (l.length) sendFiles(l); else toast('Folders cannot be sent — send the files inside them.', true);
  });
  $('#btnClip').onclick = async () => {
    try {
      const text = agent ? await agent.getClipboard() : await navigator.clipboard.readText();
      if (!text) return toast('The clipboard is empty', true);
      send({ t: 'clip', text });
      toast('Text is in the remote clipboard — press Ctrl+V there');
    } catch { toast('The browser did not allow clipboard access', true); }
    stage.focus();
  };
  $('#btnFull').onclick = async () => {
    const s = $('#session');
    if (!document.fullscreenElement) {
      try { await s.requestFullscreen(); if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {}); } catch { /* */ }
    } else { document.exitFullscreen().catch(() => {}); }
  };
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    $('#session').classList.toggle('fs', fs);
    stage.focus();
  });
  // показване на лентата при приближаване към горния ръб в цял екран
  $('#session').addEventListener('mousemove', (e) => {
    const tb = $('#toolbar');
    if ($('#session').classList.contains('fs')) tb.classList.toggle('peek', e.clientY < 6 || tb.matches(':hover'));
  });

  // =====================================================================
  //  ПОСЛЕДНИ ВРЪЗКИ, НАСТРОЙКИ, СТАРТ
  // =====================================================================
  // ---------- Recent connections + remembered passwords ----------
  // In the desktop app passwords are encrypted by the operating system (Windows DPAPI / macOS Keychain).
  function saveRecent(id, name) {
    const old = store.get('recent', []);
    const prev = old.find((r) => r.id === id) || {};
    const list = old.filter((r) => r.id !== id);
    list.unshift({ ...prev, id, name, at: Date.now() });
    store.set('recent', list.slice(0, 8));
    renderRecent();
  }
  async function savePass(id, pass) {
    let pw = null, enc = 'plain';
    if (agent && agent.encrypt) { pw = await agent.encrypt(pass); enc = 'os'; }
    if (!pw) { pw = btoa(unescape(encodeURIComponent(pass))); enc = 'plain'; }
    const list = store.get('recent', []).map((r) => (r.id === id ? { ...r, pw, enc } : r));
    store.set('recent', list);
    renderRecent();
  }
  async function loadPass(r) {
    if (!r || !r.pw) return null;
    try {
      if (r.enc === 'os') return agent && agent.decrypt ? await agent.decrypt(r.pw) : null;
      return decodeURIComponent(escape(atob(r.pw)));
    } catch { return null; }
  }
  function forgetPass(id) {
    store.set('recent', store.get('recent', []).map((r) => { if (r.id !== id) return r; const c = { ...r }; delete c.pw; delete c.enc; return c; }));
    renderRecent();
  }
  function removeRecent(id) {
    store.set('recent', store.get('recent', []).filter((r) => r.id !== id));
    renderRecent();
  }
  function renderRecent() {
    const list = store.get('recent', []);
    const ul = $('#recentList'); ul.innerHTML = '';
    $('#recentWrap').hidden = !list.length;
    list.forEach((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'recent-main';
      const left = document.createElement('div'); left.className = 'recent-left';
      const sp = document.createElement('span'); sp.textContent = fmtId(r.id);
      const sm = document.createElement('small'); sm.textContent = r.name || '';
      left.append(sp, sm);
      const right = document.createElement('em');
      right.className = r.pw ? 'recent-go saved' : 'recent-go';
      right.textContent = r.pw ? '🔑 Connect' : 'Connect';
      b.append(left, right);
      b.title = r.pw ? 'Password saved — click to connect' : 'Click to connect (you will be asked for a password or the other side must accept)';
      b.onclick = async () => {
        if (r.pw) {
          const pw = await loadPass(r);
          if (pw) { connect(r.id, pw, false, { usedSaved: true }); return; }
          forgetPass(r.id);
        }
        $('#inId').value = fmtId(r.id);
        $('#inPass').focus();
      };
      const x = document.createElement('button'); x.type = 'button'; x.className = 'recent-x';
      x.title = r.pw ? 'Forget saved password' : 'Remove from list';
      x.textContent = '×';
      x.onclick = () => (r.pw ? forgetPass(r.id) : removeRecent(r.id));
      li.append(b, x); ul.appendChild(li);
    });
  }

  $('#inId').addEventListener('input', (e) => {
    const d = cleanId(e.target.value).slice(0, 9);
    e.target.value = fmtId(d);
  });
  $('#connectForm').addEventListener('submit', (e) => {
    e.preventDefault();
    connect($('#inId').value, $('#inPass').value.trim(), false, { remember: $('#inRemember').checked });
  });
  $('#btnCancelConn').onclick = () => { clearTimeout(view.retryTimer); view.ended = false; endView(null); };
  $('#btnAccept').onclick = () => incomingResolve && incomingResolve(true);
  $('#btnReject').onclick = () => incomingResolve && incomingResolve(false);
  $('#btnKick').onclick = () => endHostSession();
  $('#btnNewPass').onclick = () => { host.pass = randomPass(); $('#myPass').textContent = host.pass; toast('New password'); };
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => copy(b.dataset.copy === 'id' ? host.id : host.pass);
  });

  $('#btnShare').onclick = async () => {
    try {
      host.stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE);
      host.stream.getVideoTracks()[0].addEventListener('ended', () => { if (!host.viewer) stopHost(); });
      startHost();
    } catch { toast('Screen sharing was denied', true); }
  };
  $('#btnStopShare').onclick = stopHost;
  $('#btnDownload').href = C.downloadUrl;

  // настройки
  $('#btnSettings').onclick = async () => {
    $('#setName').value = store.get('name', '');
    $('#agentSettings').hidden = !agent;
    if (agent) {
      const hasPerm = !!permInfo();
      $('#permStatus').textContent = hasPerm ? 'On — enter the current password to change or remove it' : 'Off';
      $('#permStatus').className = 'perm-status' + (hasPerm ? ' on' : '');
      $('#setPermOld').hidden = !hasPerm;
      $('#permRemoveRow').hidden = !hasPerm;
      $('#setPermOld').value = ''; $('#setPerm').value = ''; $('#setPerm2').value = '';
      $('#setPermRemove').checked = false;
      $('#setAuto').checked = await agent.getAutostart();
      $('#setTray').checked = store.get('tray', true);
      if (agent.getAdmin) {
        const a = await agent.getAdmin();
        $('#adminRow').hidden = !a.supported;
        $('#setAdmin').checked = a.want;
        $('#adminState').innerHTML = a.isAdmin ? '<span class="ok">✓ Currently running as administrator</span>' : '<span class="bad">Currently running without administrator rights</span>';
        $('#btnRelaunchAdmin').hidden = a.isAdmin;
      }
    }
    $('#ovSettings').hidden = false;
  };
  $('#btnRelaunchAdmin').onclick = () => {
    if (host.viewer || !view.ended) return toast('End the current session first', true);
    agent.relaunchAdmin();
  };
  $('#btnSetCancel').onclick = () => { $('#ovSettings').hidden = true; };
  $('#btnSetSave').onclick = async () => {
    if (agent) {
      const oldP = $('#setPermOld').value, newP = $('#setPerm').value, newP2 = $('#setPerm2').value;
      const remove = $('#setPermRemove').checked;
      if (newP || newP2 || remove) {
        if (permInfo() && !(await permMatches(oldP))) return toast('The current password is incorrect', true);
        if (remove) await setPerm('');
        else {
          if (newP.length < 8) return toast('The new password must be at least 8 characters', true);
          if (newP !== newP2) return toast('The new passwords do not match', true);
          await setPerm(newP);
        }
      }
      agent.setAutostart($('#setAuto').checked);
      store.set('tray', $('#setTray').checked);
      agent.setTray($('#setTray').checked);
      if (agent.setAdmin) agent.setAdmin($('#setAdmin').checked);
      updateHostNote();
    }
    store.set('name', $('#setName').value.trim());
    $('#ovSettings').hidden = true;
    toast('Saved');
  };

  // обновления (само в приложението)
  function showUpdate(st) {
    const b = $('#btnUpdate'), t = $('#updText');
    const banner = $('#updBanner');
    if (!b || !banner) return;
    b.hidden = true; b.onclick = null;
    banner.hidden = true; banner.className = 'upd-banner'; banner.onclick = null;
    if (st.state === 'downloading') {
      banner.hidden = false; banner.classList.add('busy');
      $('#updTitle').textContent = 'New update ' + (st.version ? 'v' + st.version + ' ' : '') + 'is downloading…';
      $('#updSub').innerHTML = (st.percent ? st.percent + '%' : 'starting') + '<span class="upd-bar"><i></i></span>';
      $('#updSub').querySelector('.upd-bar i').style.width = (st.percent || 2) + '%'; // set via JS (CSP blocks inline styles)
      t.textContent = 'downloading ' + (st.version || '');
    } else if (st.state === 'ready') {
      banner.hidden = false;
      $('#updTitle').textContent = 'New update available' + (st.version ? ' — v' + st.version : '');
      $('#updSub').textContent = 'Click here to update';
      $('#updCta').textContent = 'Update now';
      banner.onclick = () => {
        if (host.viewer || !view.ended) return toast('End the current session first, then click Update', true);
        $('#updTitle').textContent = 'Updating…';
        $('#updSub').textContent = 'BridgeDesk will restart in a few seconds';
        banner.classList.add('busy');
        agent.installUpdate();
      };
      // small reminder in the session toolbar too
      b.hidden = false; b.className = 'update-pill'; b.textContent = '↑ Update ready';
      b.onclick = () => toast('End the session, then click the gold banner to update');
      t.textContent = 'version ' + st.version + ' is ready';
    } else if (st.state === 'checking') t.textContent = 'checking…';
    else if (st.state === 'none') t.textContent = st.dev ? 'development mode' : 'you have the latest version';
    else if (st.state === 'error') t.textContent = 'could not check' + (st.message ? ' (' + String(st.message).slice(0, 60) + ')' : '');
  }
  if (agent && agent.onUpdate) {
    $('#appVersion').textContent = agent.version || '—';
    agent.onUpdate(showUpdate);
    agent.updateState().then(showUpdate);
    $('#btnCheckUpd').onclick = () => agent.checkUpdates();
  }

  // macOS: показваме кои разрешения липсват, докато не бъдат дадени
  async function checkMacPerms() {
    if (!agent || !agent.macPerms) return;
    const p = await agent.macPerms();
    if (!p) return;
    const box = $('#macPerms');
    box.hidden = p.screen && p.access;
    if (p.screen && p.access) clearInterval(macPermTimer);
    $('#permScreen').innerHTML = (p.screen ? '<span class="ok">✓</span> ' : '✗ ') + 'Screen Recording';
    $('#permAccess').innerHTML = (p.access ? '<span class="ok">✓</span> ' : '✗ ') + 'Accessibility (mouse & keyboard)';
    box.querySelector('[data-perm="screen"]').hidden = p.screen;
    box.querySelector('[data-perm="access"]').hidden = p.access;
  }
  document.querySelectorAll('[data-perm]').forEach((b) => { b.onclick = () => agent.macOpenSettings(b.dataset.perm); });
  const rl = $('#btnRelaunch'); if (rl) rl.onclick = (e) => { e.preventDefault(); agent.relaunch(); };
  let macPermTimer = 0;
  if (agent && agent.macPerms && agent.platform === 'darwin') { checkMacPerms(); macPermTimer = setInterval(checkMacPerms, 3000); }

  // старт
  // (no codec auto-preference any more: H.264 is used; see preferCodecs)
  renderRecent();
  if (!agent) setNet('', 'Web version');
  if (agent) {
    document.body.classList.add('is-agent');
    agent.setTray(store.get('tray', true));
    startHost();
  }
})();
