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

  const QUALITY = {
    smooth: { maxH: 1080, maxBitrate: 16_000_000, fps: 60, hint: 'motion', pref: 'maintain-framerate' },
    hq: { maxH: 1080, maxBitrate: 20_000_000, fps: 60, hint: 'detail', pref: 'balanced' },
    native: { maxH: 0, maxBitrate: 35_000_000, fps: 60, hint: 'detail', pref: 'balanced' },
    saver: { maxH: 720, maxBitrate: 2_500_000, fps: 30, hint: 'motion', pref: 'balanced' },
  };
  const DEFAULT_Q = 'smooth';
  // Заснемаме направо в 1080p — при 4K монитор това е много по-леко за компютъра (по-малко забавяне)
  const CAPTURE = { video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false };

  // Предпочитаме H.264 — повечето видеокарти го кодират хардуерно (по-бързо, по-малко забавяне)
  function preferH264(sdp) {
    if (C.preferH264 === false) return sdp;
    const lines = sdp.split('\r\n');
    const mi = lines.findIndex((l) => l.startsWith('m=video'));
    if (mi < 0) return sdp;
    const h = new Set();
    lines.forEach((l) => { const m = /^a=rtpmap:(\d+) H264\/90000/i.exec(l); if (m) h.add(m[1]); });
    if (!h.size) return sdp;
    lines.forEach((l) => { const m = /^a=fmtp:(\d+) apt=(\d+)/.exec(l); if (m && h.has(m[2])) h.add(m[1]); });
    const parts = lines[mi].split(' ');
    const list = parts.slice(3);
    lines[mi] = [...parts.slice(0, 3), ...list.filter((p) => h.has(p)), ...list.filter((p) => !h.has(p))].join(' ');
    return lines.join('\r\n');
  }
  function tuneSdp(sdp) {
    sdp = preferH264(sdp);
    // висок начален битрейт — картината е ясна още от първата секунда
    const lines = sdp.split('\r\n');
    let inVideo = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) inVideo = lines[i].startsWith('m=video');
      if (inVideo && /^a=fmtp:\d+ /.test(lines[i]) && !/apt=/.test(lines[i]) && !/x-google-start-bitrate/.test(lines[i])) {
        lines[i] += ';x-google-start-bitrate=8000;x-google-min-bitrate=1500;x-google-max-bitrate=30000';
      }
    }
    return lines.join('\r\n');
  }

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

  async function accept(conn, name) {
    host.viewer = { conn, name, call: null, stream: null };
    host.quality = DEFAULT_Q;
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
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = QUALITY[host.quality || DEFAULT_Q].hint; } catch { /* */ }
    if (agent) host.viewer.stream = stream;

    // Windows: hide the cursor in the captured picture; the viewer draws a local, instant cursor
    let localCursor = false;
    if (agent && agent.hideCursor) { try { localCursor = await agent.hideCursor(); } catch { /* */ } }

    conn.send({
      t: 'ok',
      localCursor,
      control: !!agent,
      name: myName(),
      platform: agent ? agent.platform : 'web',
      screens: host.screens.map((s, i) => ({ i, name: s.name })),
      screen: host.screenIdx,
    });

    const call = host.peer.call(conn.peer, stream, { sdpTransform: tuneSdp });
    host.viewer.call = call;
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') applyQuality(host.quality || DEFAULT_Q);
        if (pc.connectionState === 'failed') endHostSession();
      });
    }
    track.addEventListener('ended', () => endHostSession());

    // диагностика към зрителя на всеки 2 секунди
    if (agent && agent.inputDiag) {
      let warned = 0;
      host.viewer.diagTimer = setInterval(async () => {
        if (!host.viewer || !host.viewer.conn.open) return;
        const d = await agent.inputDiag();
        try {
          const pc = host.viewer.call && host.viewer.call.peerConnection;
          if (pc) (await pc.getStats()).forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
              d.enc = r.encoderImplementation || '?';
              d.hw = r.powerEfficientEncoder;
              d.sendFps = r.framesPerSecond;
              d.limit = r.qualityLimitationReason;
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
    if (v.stream) v.stream.getTracks().forEach((t) => t.stop());
    clearInterval(v.diagTimer);
    if (agent) { agent.input({ t: 'ka' }); if (agent.restoreCursor) agent.restoreCursor(); agent.sessionState(false); }
    $('#hostActive').hidden = true;
    if (host.peer && host.peer.open) setNet('online', 'Ready to connect');
    // браузърното споделяне е приключило ли?
    if (!agent && host.stream && host.stream.getVideoTracks()[0].readyState === 'ended') stopHost();
  }

  function applyQuality(level) {
    const v = host.viewer; if (!v || !v.call || !v.call.peerConnection) return;
    if (!QUALITY[level]) level = DEFAULT_Q;
    host.quality = level;
    const q = QUALITY[level];
    const sender = v.call.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = q.maxBitrate;
    // резолюцията се сменя още при заснемането (не само при кодирането)
    if (sender.track && sender.track.applyConstraints) {
      const c = q.maxH
        ? { width: { max: Math.round(q.maxH * 16 / 9) }, height: { max: q.maxH }, frameRate: { max: q.fps } }
        : { frameRate: { max: q.fps } }; // без ограничение = оригиналната резолюция
      sender.track.applyConstraints(c).catch((e) => console.warn('constraints', e));
    }
    const h = (sender.track && sender.track.getSettings().height) || 1080;
    p.encodings[0].scaleResolutionDownBy = q.maxH && h > q.maxH * 1.05 ? h / q.maxH : 1;
    p.encodings[0].maxFramerate = q.fps;
    p.degradationPreference = q.pref;
    try { if (sender.track) sender.track.contentHint = q.hint; } catch { /* */ }
    sender.setParameters(p).catch((e) => console.warn('quality', e));
  }

  async function switchScreen(idx) {
    const v = host.viewer; if (!v || !agent || !host.screens[idx]) return;
    host.screenIdx = idx;
    await agent.selectScreen(host.screens[idx].id);
    const s = await captureScreen(host.screens[idx].id);
    const track = s.getVideoTracks()[0];
    try { track.contentHint = QUALITY[host.quality || DEFAULT_Q].hint; } catch { /* */ }
    const sender = v.call.peerConnection.getSenders().find((x) => x.track && x.track.kind === 'video');
    await sender.replaceTrack(track);
    if (v.stream) v.stream.getTracks().forEach((t) => t.stop());
    v.stream = s;
    track.addEventListener('ended', () => endHostSession());
  }

  function onViewerMsg(msg) {
    switch (msg.t) {
      case 'ping': host.viewer && host.viewer.conn.send({ t: 'pong', ts: msg.ts }); return;
      case 'q': applyQuality(msg.v); return;
      case 'screen': switchScreen(Number(msg.i)).catch(console.error); return;
      case 'bye': endHostSession(); return;
      case 'clip': if (agent) agent.setClipboard(String(msg.text || '').slice(0, 100_000)); return;
      case 'mm': case 'md': case 'mu': case 'wh': case 'kd': case 'ku': case 'kt': case 'ka':
        if (agent) agent.input(msg);
        return;
      default:
    }
  }

  // =====================================================================
  //  ЗРИТЕЛ — компютърът, от който управляваш
  // =====================================================================
  const view = { peer: null, conn: null, call: null, id: null, control: false, stats: null, ping: null, timeout: null, held: new Set(), ended: true };

  function connect(rawId, pass, isRetry) {
    const id = cleanId(rawId);
    if (id.length !== 9) return toast('The ID must be 9 digits', true);
    if (host.id && id === host.id) return toast('That is your own ID', true);
    view.id = id; view.pass = pass; view.ended = false;
    view.autoRetried = !!isRetry;
    showConnecting('Connecting…', 'Looking for computer ' + fmtId(id) + '.');

    const peer = new Peer(peerOpts());
    view.peer = peer;
    view.timeout = setTimeout(() => failView('No response. Check the ID and your internet connection.'), 25_000);

    peer.on('open', () => {
      const conn = peer.connect(C.idPrefix + id, { reliable: true, serialization: 'json' });
      view.conn = conn;
      conn.on('open', () => conn.send({ t: 'hello', pass: pass || '', name: myName(), v: 1 }));
      conn.on('data', onHostMsg);
      conn.on('close', () => endView(view.call ? 'The session ended' : null));
      conn.on('error', () => {});
    });
    peer.on('call', (call) => {
      view.call = call;
      call.answer(undefined, { sdpTransform: tuneSdp });
      call.on('stream', (s) => { lowLatency(call.peerConnection); showSession(s); });
      call.on('close', () => endView('The session ended'));
      const pc = call.peerConnection;
      if (pc) pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') endView('Could not establish a direct connection (try another network or a TURN server).', true);
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
        setViewCursor(view.localCursor ? 'default' : 'none');
        // Mac -> Windows/Linux: Cmd работи като Ctrl (Cmd+C, Cmd+V…)
        view.remapMeta = IS_MAC && view.hostPlatform && view.hostPlatform !== 'darwin';
        view.remapCtrl = !IS_MAC && view.hostPlatform === 'darwin';
        view.hostName = msg.name || 'Computer';
        setupScreens(msg.screens || [], msg.screen || 0);
        saveRecent(view.id, view.hostName);
        return;
      case 'deny': {
        if (msg.reason === 'restarting' && !view.autoRetried) {
          const id = view.id, pass = view.pass;
          view.ended = false; endView(null);
          showConnecting('Remote side is restarting', 'BridgeDesk on the other computer is switching to compatibility mode. Reconnecting in a few seconds…');
          view.retryTimer = setTimeout(() => { connect(id, pass, true); }, 14000);
          $('#ovConnecting').hidden = false;
          return;
        }
        const r = {
          pass: 'Wrong password.',
          rejected: 'The remote side declined the connection.',
          busy: 'The computer is already in another session.',
          locked: 'Too many wrong attempts. Try again in a minute.',
          capture: 'The remote computer could not capture its screen' + (msg.detail ? ' (' + msg.detail + ')' : '') + '.',
          restarting: 'BridgeDesk on the remote computer is restarting in compatibility mode. Reconnecting automatically…',
          'locked-screen': 'The remote computer is locked. Unlock it (sign in to Windows) and try again.',
          noscreen: 'No screen found on the remote computer — is the monitor off or is it in a Remote Desktop session?',
        }[msg.reason] || 'The connection was refused.';
        return failView(r);
      }
      case 'clipboard': setLocalClipboard(String(msg.text || '')); return;
      case 'diag': renderDiag(msg.d); return;
      case 'cur': if (view.localCursor) setViewCursor(String(msg.s || 'default')); return;
      case 'warn':
        if (msg.code === 'elevated') {
          toast('The active window on the remote computer is "' + msg.name + '", running as administrator — Windows blocks mouse and keyboard input to it.', true);
          return;
        }
        if (msg.code === 'blocked') toast(msg.isAdmin ? 'Windows on the remote computer is blocking input (e.g. lock screen or a UAC prompt).' : 'A window running as administrator is active on the remote computer — Windows blocks input to it. Run BridgeDesk as administrator there.', true);
        return;
      case 'pong': $('#stPing').textContent = Math.max(0, Math.round(performance.now() - msg.ts)); return;
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
    stage.style.cursor = v; video.style.cursor = v;
  }

  // --- панел „Диагностика“ ---
  function renderDiag(d) {
    const el = $('#diagPanel'); if (!el) return;
    view.lastDiag = d;
    const s = (k) => sentStats[k] || 0;
    const fg = d.foreground;
    const rows = [
      ['Remote input mode', d.mode + (d.isAdmin ? ' · administrator' : ' · standard user')],
      ['Remote capture / sent fps', (d.capFps != null ? Math.round(d.capFps) : '–') + ' / ' + (d.sendFps != null ? Math.round(d.sendFps) : '–')],
      ['Remote encoder', (d.enc || '–') + (d.hw === true ? ' · hardware' : d.hw === false ? ' · software' : '') + (d.sendRes ? ' · ' + d.sendRes : '')],
      ['Quality limited by', d.limit && d.limit !== 'none' ? d.limit.toUpperCase() : 'nothing'],
      ['Moves (sent / received)', s('mm') + ' / ' + d.mm],
      ['Clicks (sent / received)', (s('md') + s('mu')) + ' / ' + (d.md + d.mu)],
      ['Keys (sent / received)', (s('kd') + s('ku')) + ' / ' + (d.kd + d.ku)],
      ['Remote active window', fg ? (fg.name + (fg.elevated ? ' ⚠ administrator' : '')) : '—'],
      ['Blocked by Windows', String(d.sendFail || 0)],
      ['Errors', d.errors ? d.errors + ' — ' + d.lastError : '0'],
    ];
    el.innerHTML = '<b>Diagnostics</b>' + rows.map((r) => '<div class="diag-row"><span>' + r[0] + '</span><em>' + String(r[1]).replace(/[<>&]/g, '') + '</em></div>').join('');
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
    clearTimeout(view.timeout);
    releaseAllKeys();
    try { view.conn && view.conn.open && view.conn.send({ t: 'bye' }); } catch { /* */ }
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
    view.ping = setInterval(() => { try { view.conn.send({ t: 'ping', ts: performance.now() }); } catch { /* */ } }, 2000);
    view.stats = setInterval(async () => {
      const pc = view.call && view.call.peerConnection; if (!pc) return;
      const rep = await pc.getStats();
      let pairId = null;
      rep.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          if (r.framesPerSecond != null) $('#stFps').textContent = Math.round(r.framesPerSecond);
          if (r.frameHeight) $('#stRes').textContent = r.frameWidth + '×' + r.frameHeight;
          if (lastTs) $('#stRate').textContent = (((r.bytesReceived - lastBytes) * 8) / ((r.timestamp - lastTs) * 1000)).toFixed(1);
          lastBytes = r.bytesReceived; lastTs = r.timestamp;
        }
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null && !pairId) pairId = r.id;
      });
      if (pairId) {
        const pair = rep.get(pairId); const lc = pair && rep.get(pair.localCandidateId);
        if (lc) $('#stRoute').textContent = lc.candidateType === 'relay' ? 'via TURN' : 'direct';
      }
    }, 1000);
  }

  // --- вход: мишка и клавиатура ---
  const stage = $('#stage');
  const video = $('#remote');
  function norm(e) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
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
  $('#selQuality').onchange = (e) => { send({ t: 'q', v: e.target.value }); stage.focus(); };
  $('#selScreen').onchange = (e) => { send({ t: 'screen', i: Number(e.target.value) }); stage.focus(); };
  $('#btnWin').onclick = () => { send({ t: 'kt', keys: ['MetaLeft'] }); stage.focus(); };
  $('#btnAltTab').onclick = () => { send({ t: 'kt', keys: ['AltLeft', 'Tab'] }); stage.focus(); };
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
  function saveRecent(id, name) {
    const list = store.get('recent', []).filter((r) => r.id !== id);
    list.unshift({ id, name, at: Date.now() });
    store.set('recent', list.slice(0, 5));
    renderRecent();
  }
  function renderRecent() {
    const list = store.get('recent', []);
    const ul = $('#recentList'); ul.innerHTML = '';
    $('#recentWrap').hidden = !list.length;
    list.forEach((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button'); b.type = 'button';
      const sp = document.createElement('span'); sp.textContent = fmtId(r.id);
      const sm = document.createElement('small'); sm.textContent = r.name || '';
      b.append(sp, sm);
      b.onclick = () => { $('#inId').value = fmtId(r.id); $('#inPass').focus(); };
      li.appendChild(b); ul.appendChild(li);
    });
  }

  $('#inId').addEventListener('input', (e) => {
    const d = cleanId(e.target.value).slice(0, 9);
    e.target.value = fmtId(d);
  });
  $('#connectForm').addEventListener('submit', (e) => {
    e.preventDefault();
    connect($('#inId').value, $('#inPass').value.trim());
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
    if (!b) return;
    b.hidden = true; b.className = 'update-pill'; b.onclick = null;
    if (st.state === 'downloading') {
      b.hidden = false; b.classList.add('busy');
      b.textContent = 'Downloading version ' + (st.version || '') + (st.percent ? ' · ' + st.percent + '%' : '');
      t.textContent = 'downloading ' + (st.version || '');
    } else if (st.state === 'ready') {
      b.hidden = false;
      b.textContent = '↻ Update to ' + st.version;
      b.onclick = () => {
        if (host.viewer || !view.ended) return toast('End the current session first', true);
        b.textContent = 'Updating…'; agent.installUpdate();
      };
      t.textContent = 'version ' + st.version + ' is ready';
    } else if (st.state === 'checking') t.textContent = 'checking…';
    else if (st.state === 'none') t.textContent = st.dev ? 'development mode' : 'you have the latest version';
    else if (st.state === 'error') t.textContent = 'could not check';
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
  renderRecent();
  if (!agent) setNet('', 'Web version');
  if (agent) {
    document.body.classList.add('is-agent');
    agent.setTray(store.get('tray', true));
    startHost();
  }
})();
