// BridgeDesk — директен вход за Windows чрез SendInput (user32.dll)
// По-бързо и по-надеждно от nut-js: мишка в абсолютни координати върху целия работен плот,
// клавиатура по скан-кодове (работи с всяка подредба — БГ, EN и т.н.).
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('MOST_MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const KEYBDINPUT = koffi.struct('MOST_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const HARDWAREINPUT = koffi.struct('MOST_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_U = koffi.union('MOST_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('MOST_INPUT', { type: 'uint32', u: INPUT_U });
const INPUT_SIZE = koffi.sizeof(INPUT);

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, _In_ MOST_INPUT *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const POINT = koffi.struct('MOST_POINT', { x: 'int32', y: 'int32' });
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ MOST_POINT *p)');

const M = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
};
const K = { EXTENDED: 0x0001, KEYUP: 0x0002, SCANCODE: 0x0008 };

// SendInput връща 0, когато Windows блокира входа (напр. прозорец „като администратор“ е отпред)
let onBlocked = () => {};
function setOnBlocked(fn) { onBlocked = fn; }
function mouse(flags, dx = 0, dy = 0, data = 0) {
  const n = SendInput(1, { type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
  if (!n) onBlocked();
  return n;
}
function key(vk, scan, flags) {
  const n = SendInput(1, { type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
  if (!n) onBlocked();
  return n;
}

// физически пиксели -> 0..65535 върху виртуалния работен плот (всички монитори)
function absCoords(px, py) {
  const vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
  const vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
  return {
    dx: Math.round(((px - vx) * 65535) / Math.max(1, vw - 1)),
    dy: Math.round(((py - vy) * 65535) / Math.max(1, vh - 1)),
  };
}

const ABS = M.MOVE | M.ABSOLUTE | M.VIRTUALDESK;
const DOWN = [M.LEFTDOWN, M.MIDDLEDOWN, M.RIGHTDOWN];
const UP = [M.LEFTUP, M.MIDDLEUP, M.RIGHTUP];

function move(px, py) { const a = absCoords(px, py); mouse(ABS, a.dx, a.dy); }
// a = { dx, dy } вече в 0..65535 върху виртуалния работен плот
function moveAbs(a) { mouse(ABS, a.dx, a.dy); }
function buttonAbs(b, down, a) {
  const f = (down ? DOWN : UP)[b] ?? (down ? M.LEFTDOWN : M.LEFTUP);
  if (a) mouse(ABS | f, a.dx, a.dy); else mouse(f);
}
function button(b, down, px, py) {
  const f = (down ? DOWN : UP)[b] ?? (down ? M.LEFTDOWN : M.LEFTUP);
  if (typeof px === 'number') { const a = absCoords(px, py); mouse(ABS | f, a.dx, a.dy); } else mouse(f);
}
function wheel(dx, dy) {
  // положително dy от браузъра = надолу; в Windows положително = нагоре; 120 = едно щракване
  if (dy) mouse(M.WHEEL, 0, 0, -dy * 120);
  if (dx) mouse(M.HWHEEL, 0, 0, dx * 120);
}

// KeyboardEvent.code -> [скан-код, разширен?]  (set 1)
const SC = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06], Digit6: [0x07],
  Digit7: [0x08], Digit8: [0x09], Digit9: [0x0A], Digit0: [0x0B], Minus: [0x0C], Equal: [0x0D], Backspace: [0x0E],
  Tab: [0x0F], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16],
  KeyI: [0x17], KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1A], BracketRight: [0x1B], Enter: [0x1C],
  ControlLeft: [0x1D], KeyA: [0x1E], KeyS: [0x1F], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22], KeyH: [0x23],
  KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2A],
  Backslash: [0x2B], KeyZ: [0x2C], KeyX: [0x2D], KeyC: [0x2E], KeyV: [0x2F], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32],
  Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37], AltLeft: [0x38],
  Space: [0x39], CapsLock: [0x3A], F1: [0x3B], F2: [0x3C], F3: [0x3D], F4: [0x3E], F5: [0x3F], F6: [0x40],
  F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44], NumLock: [0x45, 1], ScrollLock: [0x46], Numpad7: [0x47],
  Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4A], Numpad4: [0x4B], Numpad5: [0x4C], Numpad6: [0x4D],
  NumpadAdd: [0x4E], Numpad1: [0x4F], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  NumpadEnter: [0x1C, 1], ControlRight: [0x1D, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1], AltRight: [0x38, 1],
  Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4B, 1], ArrowRight: [0x4D, 1], End: [0x4F, 1],
  ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1],
  MetaLeft: [0x5B, 1], MetaRight: [0x5C, 1], OSLeft: [0x5B, 1], OSRight: [0x5C, 1], ContextMenu: [0x5D, 1],
};
// клавиши, които се пращат като виртуален код
const VK = {
  Pause: 0x13, AudioVolumeMute: 0xAD, AudioVolumeDown: 0xAE, AudioVolumeUp: 0xAF,
  MediaTrackNext: 0xB0, MediaTrackPrevious: 0xB1, MediaStop: 0xB2, MediaPlayPause: 0xB3,
  F13: 0x7C, F14: 0x7D, F15: 0x7E, F16: 0x7F, F17: 0x80, F18: 0x81, F19: 0x82, F20: 0x83,
};

function keyEvent(code, down) {
  const sc = SC[code];
  if (sc) { key(0, sc[0], K.SCANCODE | (sc[1] ? K.EXTENDED : 0) | (down ? 0 : K.KEYUP)); return true; }
  const vk = VK[code];
  if (vk) { key(vk, 0, down ? 0 : K.KEYUP); return true; }
  return false;
}

// ---------- Кой прозорец е отпред и пуснат ли е „като администратор“ ----------
// Ако е, а BridgeDesk не е, Windows тихо игнорира мишката и клавиатурата (UIPI).
const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)');
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint8_t *buf, _Inout_ uint32 *size)');
const OpenProcessToken = advapi32.func('bool __stdcall OpenProcessToken(void *h, uint32 access, _Out_ void **tok)');
const GetTokenInformation = advapi32.func('bool __stdcall GetTokenInformation(void *tok, int cls, _Out_ uint8_t *info, uint32 len, _Out_ uint32 *ret)');

function foreground() {
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return { name: '(none — lock screen or UAC?)', elevated: null };
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid[0]);
    if (!h) return { pid: pid[0], name: '?', elevated: true };
    let name = '?';
    const buf = Buffer.alloc(1040); const size = [520];
    if (QueryFullProcessImageNameW(h, 0, buf, size)) name = buf.toString('utf16le', 0, size[0] * 2).split('\\').pop();
    let elevated = null;
    const tok = [null];
    if (OpenProcessToken(h, 0x0008 /* TOKEN_QUERY */, tok)) {
      const info = Buffer.alloc(4); const ret = [0];
      if (GetTokenInformation(tok[0], 20 /* TokenElevation */, info, 4, ret)) elevated = info.readUInt32LE(0) !== 0;
      CloseHandle(tok[0]);
    } else elevated = true; // отказан достъп = по-високи права
    CloseHandle(h);
    return { pid: pid[0], name, elevated };
  } catch (e) { return { name: 'error: ' + e.message, elevated: null }; }
}

// Проверка при старт: преместваме мишката там, където вече е (невидимо). 0 = SendInput не работи.
function selfTest() {
  const p = {};
  if (!GetCursorPos(p)) return false;
  const a = absCoords(p.x, p.y);
  const n = SendInput(1, { type: 0, u: { mi: { dx: a.dx, dy: a.dy, mouseData: 0, dwFlags: ABS, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
  return n === 1;
}

module.exports = { selfTest, foreground, move, moveAbs, button, buttonAbs, wheel, keyEvent, setOnBlocked };
