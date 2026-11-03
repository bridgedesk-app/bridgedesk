// BridgeDesk settings. The same file is used by the web page and the desktop app.
window.MOST_CONFIG = {
  appName: 'BridgeDesk',

  // Prefix for IDs on the signaling server. Must be the same everywhere.
  idPrefix: 'bridgedesk-',

  // null = the free public PeerJS server (0.peerjs.com).
  // Your own server: { host: 'signal.example.com', port: 443, path: '/', secure: true }
  peer: null,

  // null = PeerJS default STUN/TURN.
  // Example with your own TURN (e.g. Cloudflare TURN):
  // [{ urls: 'stun:stun.cloudflare.com:3478' },
  //  { urls: 'turn:turn.cloudflare.com:3478', username: '...', credential: '...' }]
  iceServers: null,

  // H.264 (hardware encoding on most computers). false = let the browser choose.
  preferH264: true,

  // Where the desktop app is downloaded from (shown in the web version).
  downloadUrl: 'https://github.com/bridgedesk-app/bridgedesk/releases/latest',
};

// Development only: ?peer=localhost:9000 points to a local signaling server.
(function () {
  try {
    const p = new URLSearchParams(location.search).get('peer');
    if (p) {
      const [host, port] = p.split(':');
      window.MOST_CONFIG.peer = { host, port: Number(port || 9000), path: '/', secure: false };
    }
  } catch (e) { /* ignore */ }
})();
