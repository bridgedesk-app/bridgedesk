// BridgeDesk — изпълнение на мишка и клавиатура на управлявания компютър
// Windows: директно през SendInput (win-input.js). macOS/Linux: nut-js.
let nut = null;
let win = null;
let screenApi = null;
let displayId = null;
let chain = Promise.resolve();
let pendingMove = null;
const held = new Set();   // натиснати клавиши (code)
// диагностика
const stats = { mm: 0, md: 0, mu: 0, wh: 0, kd: 0, ku: 0, errors: 0, lastError: '', sendFail: 0 };
const buttons = new Set(); // натиснати бутони на мишката

if (process.platform === 'win32') {
  try {
    win = require('./win-input');
    if (!win.selfTest()) { console.error('[input] SendInput self-test failed, using nut-js'); win = null; }
  } catch (e) { console.error('[input] SendInput unavailable, using nut-js:', e.message); win = null; }
}

function lib() {
  if (!nut) {
    nut = require('@nut-tree-fork/nut-js');
    nut.mouse.config.autoDelayMs = 0;
    nut.mouse.config.mouseSpeed = 100000;
    nut.keyboard.config.autoDelayMs = 0;
  }
  return nut;
}

function init(screen) { screenApi = screen; }
function setOnBlocked(fn) { if (win) win.setOnBlocked(() => { stats.sendFail++; fn(); }); }
function setDisplay(id) { displayId = id; }

function currentDisplay() {
  const all = screenApi.getAllDisplays();
  return all.find((d) => String(d.id) === String(displayId)) || screenApi.getPrimaryDisplay();
}

// нормализирани (0..1) координати -> точка в координатите на системата
function toXY(x, y) {
  const d = currentDisplay();
  const b = d.bounds;
  const cx = Math.min(Math.max(x, 0), 0.9999), cy = Math.min(Math.max(y, 0), 0.9999);
  const dip = { x: Math.round(b.x + cx * b.width), y: Math.round(b.y + cy * b.height) };
  if (process.platform === 'win32') return screenApi.dipToScreenPoint(dip); // физически пиксели
  if (process.platform === 'linux') return { x: Math.round(dip.x * d.scaleFactor), y: Math.round(dip.y * d.scaleFactor) };
  return dip; // macOS — логически точки
}
// Windows: нормализирани координати -> 0..65535 върху виртуалния работен плот.
// Всичко се смята от Electron във физически пиксели, без значение от мащаба (100/125/150%) и броя монитори.
function toAbs(x, y) {
  const all = screenApi.getAllDisplays();
  const d = currentDisplay();
  const phys = (disp) => screenApi.dipToScreenRect(null, disp.bounds);
  const r = phys(d);
  let vx = Infinity, vy = Infinity, vr = -Infinity, vb = -Infinity;
  for (const disp of all) { const q = phys(disp); vx = Math.min(vx, q.x); vy = Math.min(vy, q.y); vr = Math.max(vr, q.x + q.width); vb = Math.max(vb, q.y + q.height); }
  const cx = Math.min(Math.max(x, 0), 1), cy = Math.min(Math.max(y, 0), 1);
  const px = r.x + cx * (r.width - 1), py = r.y + cy * (r.height - 1);
  return {
    dx: Math.round(((px - vx) * 65535) / Math.max(1, vr - vx - 1)),
    dy: Math.round(((py - vy) * 65535) / Math.max(1, vb - vy - 1)),
  };
}
function toPoint(x, y) { const p = toXY(x, y); return new (lib().Point)(p.x, p.y); }

// ---------- nut-js (macOS / Linux) ----------
const CODE = {
  Escape: 'Escape', Tab: 'Tab', CapsLock: 'CapsLock', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', OSLeft: 'LeftSuper', OSRight: 'RightSuper',
  ContextMenu: 'Menu',
  Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash', IntlBackslash: 'Backslash',
  Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Grave', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  NumpadAdd: 'Add', NumpadSubtract: 'Subtract', NumpadMultiply: 'Multiply', NumpadDivide: 'Divide', NumpadDecimal: 'Decimal', NumpadEqual: 'NumPadEqual',
  NumLock: 'NumLock', PrintScreen: 'Print', ScrollLock: 'ScrollLock', Pause: 'Pause',
  AudioVolumeMute: 'AudioMute', AudioVolumeDown: 'AudioVolDown', AudioVolumeUp: 'AudioVolUp',
  MediaPlayPause: 'AudioPlay', MediaTrackNext: 'AudioNext', MediaTrackPrevious: 'AudioPrev',
};
function keyOf(code) {
  const { Key } = lib();
  let name = CODE[code];
  if (!name) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) name = m[1];
    else if ((m = /^Digit(\d)$/.exec(code))) name = 'Num' + m[1];
    else if ((m = /^Numpad(\d)$/.exec(code))) name = 'NumPad' + m[1];
    else if ((m = /^F(\d{1,2})$/.exec(code))) name = 'F' + m[1];
  }
  return name && Key[name] !== undefined ? Key[name] : null;
}
const wheelAmount = (t) => (process.platform === 'darwin' ? Math.abs(t) * 30 : Math.abs(t));

async function runNut(msg) {
  const n = lib();
  const btn = [n.Button.LEFT, n.Button.MIDDLE, n.Button.RIGHT][msg.b] ?? n.Button.LEFT;
  switch (msg.t) {
    case 'mm': await n.mouse.setPosition(toPoint(msg.x, msg.y)); break;
    case 'md': await n.mouse.setPosition(toPoint(msg.x, msg.y)); await n.mouse.pressButton(btn); break;
    case 'mu':
      if (typeof msg.x === 'number') await n.mouse.setPosition(toPoint(msg.x, msg.y));
      await n.mouse.releaseButton(btn);
      break;
    case 'wh':
      if (msg.dy > 0) await n.mouse.scrollDown(wheelAmount(msg.dy));
      if (msg.dy < 0) await n.mouse.scrollUp(wheelAmount(msg.dy));
      if (msg.dx > 0) await n.mouse.scrollRight(wheelAmount(msg.dx));
      if (msg.dx < 0) await n.mouse.scrollLeft(wheelAmount(msg.dx));
      break;
    case 'kd': { const k = keyOf(msg.c); if (k !== null) await n.keyboard.pressKey(k); break; }
    case 'ku': { const k = keyOf(msg.c); if (k !== null) await n.keyboard.releaseKey(k); break; }
    default:
  }
}

// ---------- общо ----------
function runWin(msg) {
  switch (msg.t) {
    case 'mm': win.moveAbs(toAbs(msg.x, msg.y)); break;
    case 'md': win.buttonAbs(msg.b, true, toAbs(msg.x, msg.y)); break;
    case 'mu': win.buttonAbs(msg.b, false, typeof msg.x === 'number' ? toAbs(msg.x, msg.y) : null); break;
    case 'wh': win.wheel(msg.dx || 0, msg.dy || 0); break;
    case 'kd': win.keyEvent(msg.c, true); break;
    case 'ku': win.keyEvent(msg.c, false); break;
    default:
  }
}

async function run(msg) {
  // проследяваме натиснатото, за да го пуснем при прекъсване
  if (msg.t === 'kd') held.add(msg.c);
  if (msg.t === 'ku') held.delete(msg.c);
  if (msg.t === 'md' && buttons.has(msg.b)) await run({ t: 'mu', b: msg.b }); // бутон „залепнал“ долу — пускаме го
  if (msg.t === 'md') buttons.add(msg.b);
  if (msg.t === 'mu') buttons.delete(msg.b);

  if (msg.t === 'kt') { // натисни и пусни комбинация (напр. Alt+Tab)
    const keys = msg.keys || [];
    for (const c of keys) await run({ t: 'kd', c });
    for (const c of [...keys].reverse()) await run({ t: 'ku', c });
    return;
  }
  if (msg.t === 'ka') { // пусни всичко
    const ks = [...held]; const bs = [...buttons];
    for (const c of ks) { try { await run({ t: 'ku', c }); } catch { /* */ } }
    for (const b of bs) { try { await run({ t: 'mu', b }); } catch { /* */ } }
    return;
  }
  if (win) {
    try { runWin(msg); return; } catch (e) { logErr(e); console.error('[input] SendInput error, falling back to nut-js'); win = null; }
  }
  await runNut(msg);
}

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (stats[msg.t] !== undefined) stats[msg.t]++;
  // Движенията на мишката се сливат — изпълняваме само последното чакащо
  if (msg.t === 'mm') {
    const already = pendingMove !== null;
    pendingMove = msg;
    if (already) return;
    chain = chain.then(() => { const m = pendingMove; pendingMove = null; return m && run(m); }).catch(logErr);
    return;
  }
  chain = chain.then(() => run(msg)).catch(logErr);
}

function logErr(e) {
  stats.errors++; stats.lastError = String(e && e.message ? e.message : e).slice(0, 160);
  console.error('[input]', stats.lastError);
}
function diag() {
  return { ...stats, mode: win ? 'SendInput' : 'nut-js', foreground: win && win.foreground ? win.foreground() : null };
}

module.exports = { init, setDisplay, handle, setOnBlocked, diag, mode: () => (win ? 'sendinput' : 'nut-js') };
