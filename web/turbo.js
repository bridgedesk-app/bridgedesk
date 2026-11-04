/* BridgeDesk — GPU engine ("Turbo").
 *
 * Why: in the standard WebRTC path Chromium encodes screen video in SOFTWARE (OpenH264 / libvpx) on
 * Windows even when the GPU can encode (measured on an Intel UHD 770 host: ~25 fps max, CPU-bound).
 * WebCodecs exposes the hardware encoder (Intel Quick Sync / NVENC / AMF via Media Foundation) directly.
 *
 * Pipeline (host):   capture track → MediaStreamTrackProcessor → VideoEncoder (hardware, realtime,
 *                    no B-frames) → fragments → unreliable/unordered RTCDataChannel
 * Pipeline (viewer): DataChannel → reassembly → VideoDecoder (hardware) → draw ONLY the newest frame
 *
 * Latency rules:
 *  - never queue stale frames: if the encoder or the network is behind, the frame is dropped
 *  - viewer renders the latest decoded frame only (older ones are closed)
 *  - a lost frame → viewer asks for a keyframe instead of waiting for retransmission
 *  - input/control messages use a separate reliable channel, so video congestion never blocks them
 */
(() => {
  'use strict';

  const SUPPORTED = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
    && typeof MediaStreamTrackProcessor !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  const CHANNEL_ID = 100;           // negotiated DataChannel id (both sides create it themselves)
  const FRAG = 15000;               // payload bytes per message (well below SCTP limits)
  const HDR = 16;                   // header bytes
  const MAX_BUFFERED = 2_000_000;   // bytes waiting in the DataChannel → drop new frames above this
  const KEY_INTERVAL_MS = 4000;     // safety keyframe even if nothing is lost

  // H.264 profiles to try, best first. Level 5.1 (…33) covers up to 2560×1440 @ 60 fps.
  const H264 = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e028'];

  function openChannel(pc) {
    const dc = pc.createDataChannel('bd-turbo', { negotiated: true, id: CHANNEL_ID, ordered: false, maxPacketLifeTime: 120 });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = MAX_BUFFERED / 4;
    return dc;
  }

  // ---------- capability check ----------
  // Returns { codec, hw:true } if this machine can encode H.264 in hardware, else null.
  // "prefer-hardware" in Chromium only succeeds with a real hardware encoder.
  async function hardwareEncoder(width = 1920, height = 1080, allowSoftware = false) {
    if (!SUPPORTED) return null;
    for (const codec of H264) {
      for (const accel of allowSoftware ? ['prefer-hardware', 'no-preference'] : ['prefer-hardware']) {
        try {
          const r = await VideoEncoder.isConfigSupported({
            codec, width, height, bitrate: 12_000_000, framerate: 60,
            hardwareAcceleration: accel, latencyMode: 'realtime', avc: { format: 'annexb' },
          });
          if (r.supported) return { codec, hw: accel === 'prefer-hardware' };
        } catch { /* try next */ }
      }
    }
    return null;
  }
  async function hardwareDecoder(codec) {
    if (!SUPPORTED) return null;
    for (const accel of ['prefer-hardware', 'no-preference']) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration: accel, optimizeForLatency: true });
        if (r.supported) return { codec, hw: accel === 'prefer-hardware', accel };
      } catch { /* */ }
    }
    return null;
  }

  // =====================================================================
  //  HOST: encoder + sender
  // =====================================================================
  function createSender({ pc, track, codec, hw, quality }) {
    const dc = openChannel(pc);
    let src = null, reader = null, gen = 0;           // current capture source (can be swapped: monitor switch)
    const st = {
      captured: 0, encoded: 0, dropEnc: 0, dropNet: 0, bytes: 0, keyframes: 0,
      encMs: 0, encN: 0, fps: { cap: 0, enc: 0 }, kbps: 0, w: 0, h: 0, bitrate: 0, codec, hw,
    };
    let encoder = null, cfgKey = '', frameId = 0, needKey = true, lastKeyAt = 0, stopped = false;
    let last = null, lastFrameAt = 0, q = Object.assign({}, quality);
    const sentAt = new Map();                        // timestamp → encode start (encode latency)
    const win = { t: performance.now(), cap: 0, enc: 0, bytes: 0 };

    function configure(w, h) {
      // even dimensions, capped by the quality preset
      let tw = w, th = h;
      if (q.maxH && th > q.maxH) { tw = Math.round(w * q.maxH / h); th = q.maxH; }
      tw -= tw % 2; th -= th % 2;
      const key = codec + tw + 'x' + th + '@' + q.bitrate + '/' + q.fps;
      if (encoder && key === cfgKey) return;
      if (encoder) { try { encoder.close(); } catch { /* */ } }
      encoder = new VideoEncoder({
        output: onChunk,
        error: (e) => { console.warn('[turbo] encoder', e); st.error = String(e && e.message || e); encoder = null; cfgKey = ''; },
      });
      encoder.configure({
        codec, width: tw, height: th, bitrate: q.bitrate, framerate: q.fps,
        hardwareAcceleration: hw ? 'prefer-hardware' : 'no-preference',
        latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'annexb' },
      });
      cfgKey = key; st.w = tw; st.h = th; st.bitrate = q.bitrate; needKey = true;
    }

    function onChunk(chunk) {
      const t0 = sentAt.get(chunk.timestamp);
      if (t0 != null) { st.encMs += performance.now() - t0; st.encN++; sentAt.delete(chunk.timestamp); }
      st.encoded++; win.enc++;
      if (dc.readyState !== 'open') return;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const id = (frameId = (frameId + 1) >>> 0);
      const count = Math.ceil(data.byteLength / FRAG) || 1;
      const key = chunk.type === 'key';
      if (key) st.keyframes++;
      for (let i = 0; i < count; i++) {
        const part = data.subarray(i * FRAG, Math.min(data.byteLength, (i + 1) * FRAG));
        const buf = new Uint8Array(HDR + part.byteLength);
        const v = new DataView(buf.buffer);
        v.setUint32(0, id); v.setUint16(4, i); v.setUint16(6, count);
        v.setUint8(8, key ? 1 : 0);
        v.setUint16(10, st.w); v.setUint16(12, st.h);
        buf.set(part, HDR);
        try { dc.send(buf); } catch { /* channel closing */ }
      }
      st.bytes += data.byteLength; win.bytes += data.byteLength;
    }

    function encode(frame, force) {
      if (!encoder || encoder.state !== 'configured') configure(frame.displayWidth, frame.displayHeight);
      else configure(frame.displayWidth, frame.displayHeight); // reconfigures only if size/quality changed
      if (!encoder) { frame.close(); return; }
      // never build a backlog: stale frames are worthless for a remote desktop
      if (!force && encoder.encodeQueueSize > 1) { st.dropEnc++; frame.close(); return; }
      if (!force && dc.bufferedAmount > MAX_BUFFERED) { st.dropNet++; frame.close(); needKey = true; return; }
      const now = performance.now();
      const keyFrame = needKey || now - lastKeyAt > KEY_INTERVAL_MS;
      if (keyFrame) { needKey = false; lastKeyAt = now; }
      sentAt.set(frame.timestamp, now);
      if (sentAt.size > 120) sentAt.clear();
      try { encoder.encode(frame, { keyFrame }); } catch (e) { st.error = String(e.message || e); }
      frame.close();
    }

    function setTrack(newTrack) {
      const old = { src, reader };
      src = newTrack.clone();                         // own copy, independent of the WebRTC path
      reader = new MediaStreamTrackProcessor({ track: src }).readable.getReader();
      const my = ++gen;
      needKey = true;
      if (old.reader) { try { old.reader.cancel(); } catch { /* */ } }
      if (old.src) { try { old.src.stop(); } catch { /* */ } }
      readLoop(reader, my);
    }

    async function readLoop(rd, my) {
      while (!stopped && my === gen) {
        let r;
        try { r = await rd.read(); } catch { break; }
        if (r.done || my !== gen) { if (r.value) r.value.close(); break; }
        const f = r.value;
        st.captured++; win.cap++;
        if (last) last.close();
        last = f.clone();
        lastFrameAt = performance.now();
        if (q.fps < 60 && st.lastEncAt && lastFrameAt - st.lastEncAt < 1000 / q.fps - 2) { f.close(); continue; }
        st.lastEncAt = lastFrameAt;
        encode(f, false);
      }
    }
    setTrack(track);

    // static screen: re-send the last frame a few times per second (keeps the picture alive,
    // lets a keyframe request be answered even when Windows produces no new frames)
    const idle = setInterval(() => {
      if (stopped || !last || dc.readyState !== 'open') return;
      if (performance.now() - lastFrameAt < 250 && !needKey) return;
      encode(new VideoFrame(last, { timestamp: Math.round(performance.now() * 1000) }), needKey);
    }, 250);

    // per-second rates
    const rates = setInterval(() => {
      const now = performance.now(), dt = (now - win.t) / 1000;
      st.fps.cap = Math.round(win.cap / dt); st.fps.enc = Math.round(win.enc / dt);
      st.kbps = Math.round(win.bytes * 8 / dt / 1000);
      st.buffered = dc.bufferedAmount;
      win.t = now; win.cap = 0; win.enc = 0; win.bytes = 0;
    }, 1000);

    return {
      stats: st,
      requestKey() { needKey = true; },
      setTrack,
      setQuality(nq) { q = Object.assign({}, q, nq); cfgKey = ''; needKey = true; },
      encodeLatency() { return st.encN ? st.encMs / st.encN : 0; },
      resetLatency() { st.encMs = 0; st.encN = 0; },
      stop() {
        stopped = true; clearInterval(idle); clearInterval(rates);
        try { reader && reader.cancel(); } catch { /* */ }
        try { encoder && encoder.close(); } catch { /* */ }
        if (last) { try { last.close(); } catch { /* */ } last = null; }
        try { src && src.stop(); } catch { /* */ }
        try { dc.close(); } catch { /* */ }
      },
    };
  }

  // =====================================================================
  //  VIEWER: receiver + decoder + latest-frame renderer
  // =====================================================================
  function createReceiver({ pc, canvas, codec, onKeyRequest }) {
    const dc = openChannel(pc);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const st = {
      frames: 0, decoded: 0, displayed: 0, lost: 0, keyReq: 0, bytes: 0, decMs: 0, decN: 0,
      fps: { recv: 0, dec: 0, disp: 0 }, low1: 0, freezes: 0, kbps: 0, w: 0, h: 0, hw: null, error: '',
    };
    const parts = new Map();            // frameId -> { count, got, key, chunks[], size }
    let lastDone = 0, waitKey = true, decoder = null, latest = null, raf = 0, lastKeyReq = 0, stopped = false;
    let lastPresent = 0, inFreeze = false;
    const intervals = [];               // display intervals (ms) of the last ~5 s
    const decStart = new Map();
    const win = { t: performance.now(), recv: 0, dec: 0, disp: 0, bytes: 0 };

    function askKey() {
      const now = performance.now();
      if (now - lastKeyReq < 300) return;
      lastKeyReq = now; st.keyReq++; waitKey = true;
      onKeyRequest();
    }

    function draw() {
      raf = 0;
      if (!latest) return;
      const f = latest; latest = null;
      if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
        canvas.width = f.displayWidth; canvas.height = f.displayHeight;
      }
      ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
      f.close();
      const now = performance.now();
      if (lastPresent) {
        const gap = now - lastPresent;
        intervals.push(gap); if (intervals.length > 300) intervals.shift();
      }
      lastPresent = now;
      st.displayed++; win.disp++;
    }

    async function makeDecoder() {
      const d = await hardwareDecoder(codec);
      st.hw = d ? d.hw : null;
      decoder = new VideoDecoder({
        output: (frame) => {
          const t0 = decStart.get(frame.timestamp);
          if (t0 != null) { st.decMs += performance.now() - t0; st.decN++; decStart.delete(frame.timestamp); }
          st.decoded++; win.dec++;
          if (latest) latest.close();   // keep only the newest frame
          latest = frame;
          if (!raf) raf = requestAnimationFrame(draw);
        },
        error: (e) => { st.error = String(e && e.message || e); console.warn('[turbo] decoder', e); decoder = null; askKey(); },
      });
      decoder.configure({ codec, hardwareAcceleration: d ? d.accel : 'no-preference', optimizeForLatency: true });
      waitKey = true;
    }

    function onComplete(id, f) {
      // anything older than this frame that is still incomplete is lost
      for (const k of parts.keys()) if (((id - k) | 0) > 0) { parts.delete(k); st.lost++; if (!f.key) askKey(); }
      if (lastDone && ((id - lastDone) | 0) > 1 && !f.key) askKey();   // gap = lost frame(s)
      lastDone = id;
      if (waitKey && !f.key) return;     // can't decode deltas without a keyframe
      if (f.key) waitKey = false;
      const data = new Uint8Array(f.size);
      let off = 0;
      for (const c of f.chunks) { data.set(c, off); off += c.byteLength; }
      st.w = f.w; st.h = f.h;
      if (!decoder || decoder.state === 'closed') { askKey(); return; }
      if (decoder.state !== 'configured') return;
      const ts = Math.round(performance.now() * 1000);
      decStart.set(ts, performance.now()); if (decStart.size > 120) decStart.clear();
      try { decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: ts, data })); }
      catch (e) { st.error = String(e.message || e); askKey(); }
    }

    dc.onmessage = (ev) => {
      const buf = ev.data; if (!(buf instanceof ArrayBuffer) || buf.byteLength < HDR) return;
      const v = new DataView(buf);
      const id = v.getUint32(0), idx = v.getUint16(4), count = v.getUint16(6), key = v.getUint8(8) === 1;
      st.bytes += buf.byteLength; win.bytes += buf.byteLength;
      if (lastDone && ((id - lastDone) | 0) <= 0) return;    // late fragment of an old frame
      let f = parts.get(id);
      if (!f) { f = { count, got: 0, key, chunks: new Array(count), size: 0, w: v.getUint16(10), h: v.getUint16(12) }; parts.set(id, f); }
      if (f.chunks[idx]) return;
      f.chunks[idx] = new Uint8Array(buf, HDR);
      f.got++; f.size += buf.byteLength - HDR;
      if (f.got === f.count) { parts.delete(id); st.frames++; win.recv++; onComplete(id, f); }
    };
    dc.onopen = () => askKey();

    const rates = setInterval(() => {
      const now = performance.now(), dt = (now - win.t) / 1000;
      st.fps.recv = Math.round(win.recv / dt); st.fps.dec = Math.round(win.dec / dt); st.fps.disp = Math.round(win.disp / dt);
      st.kbps = Math.round(win.bytes * 8 / dt / 1000);
      win.t = now; win.recv = 0; win.dec = 0; win.disp = 0; win.bytes = 0;
      if (intervals.length > 20) {
        const s = [...intervals].sort((a, b) => a - b);
        const p99 = s[Math.floor(s.length * 0.99) - 1] || s[s.length - 1];
        st.low1 = Math.round(1000 / p99);
        st.p50 = Math.round(s[Math.floor(s.length / 2)]);
        st.p99 = Math.round(p99);
      }
      // a freeze = no new frame for > 400 ms while frames were arriving before
      const frozen = lastPresent && now - lastPresent > 400 && st.displayed > 0;
      if (frozen && !inFreeze) st.freezes++;
      inFreeze = !!frozen;
      // decoder broken or nothing decodable for a while → ask for a keyframe
      if (!stopped && (waitKey || !decoder) && dc.readyState === 'open') askKey();
    }, 1000);

    makeDecoder().catch((e) => { st.error = String(e.message || e); });

    return {
      stats: st,
      decodeLatency() { return st.decN ? st.decMs / st.decN : 0; },
      resetLatency() { st.decMs = 0; st.decN = 0; },
      reconfigure: () => makeDecoder(),
      stop() {
        stopped = true; clearInterval(rates);
        if (raf) cancelAnimationFrame(raf);
        if (latest) { try { latest.close(); } catch { /* */ } latest = null; }
        try { decoder && decoder.close(); } catch { /* */ }
        try { dc.close(); } catch { /* */ }
      },
    };
  }

  window.BDTurbo = { SUPPORTED, hardwareEncoder, hardwareDecoder, createSender, createReceiver };
})();
