// BridgeDesk — separate small process for cursor handling (Windows).
// Runs outside the main app, so even an unexpected crash here can never take BridgeDesk down.
const c = require('./win-cursor');
let timer = null;
let last = '';

function stop() { clearInterval(timer); timer = null; }

process.on('message', (m) => {
  if (!m) return;
  if (m.cmd === 'hide') {
    const ok = c.hide();
    process.send({ hidden: ok });
    stop(); last = '';
    timer = setInterval(() => {
      const s = c.shape();
      if (s !== last) { last = s; process.send({ shape: s }); }
    }, 40);
  } else if (m.cmd === 'restore') {
    stop(); c.restore();
    process.send({ restored: true });
    if (m.exit) setTimeout(() => process.exit(0), 50);
  }
});
// parent gone -> always restore the cursor and quit
process.on('disconnect', () => { stop(); c.restore(); process.exit(0); });
