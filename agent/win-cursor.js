// BridgeDesk — Windows cursor handling during a session (AnyDesk-style).
// The system cursors are made transparent while someone is connected, so the cursor is NOT
// baked into the video. The viewer draws its own local cursor instead (instant, smooth) and
// we tell it which shape to show (arrow, text, hand, resize…).
// Everything is restored when the session ends, when the app quits and on every app start.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const CreateCursor = user32.func('uintptr __stdcall CreateCursor(void *hInst, int xHot, int yHot, int w, int h, _In_ uint8_t *andPlane, _In_ uint8_t *xorPlane)');
const SetSystemCursor = user32.func('bool __stdcall SetSystemCursor(uintptr hcur, uint32 id)');
const SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, void *pv, uint32 winIni)');
const LoadCursorW = user32.func('uintptr __stdcall LoadCursorW(void *hInstance, uintptr id)');
const CURSORINFO = koffi.struct('BD_CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'uintptr', x: 'int32', y: 'int32' });
const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ BD_CURSORINFO *pci)');
const CI_SIZE = koffi.sizeof(CURSORINFO);

// system cursor id -> CSS cursor name for the viewer
const IDS = {
  32512: 'default', 32513: 'text', 32514: 'wait', 32515: 'crosshair', 32516: 'default',
  32642: 'nwse-resize', 32643: 'nesw-resize', 32644: 'ew-resize', 32645: 'ns-resize',
  32646: 'move', 32648: 'not-allowed', 32649: 'pointer', 32650: 'progress', 32651: 'help',
};

const AND = Buffer.alloc(128, 0xFF); // 32x32, fully transparent
const XOR = Buffer.alloc(128, 0x00);
let hidden = false;
let handleMap = null;

function buildMap() {
  handleMap = new Map();
  for (const id of Object.keys(IDS)) {
    try { handleMap.set(String(LoadCursorW(null, Number(id))), IDS[id]); } catch { /* */ }
  }
}

function hide() {
  if (hidden) return true;
  buildMap(); // handles stay the same after SetSystemCursor (only the image changes)
  let ok = true;
  for (const id of Object.keys(IDS)) {
    const h = CreateCursor(null, 0, 0, 32, 32, AND, XOR);
    if (!h || !SetSystemCursor(h, Number(id))) ok = false;
  }
  hidden = true;
  return ok;
}

function restore() {
  hidden = false;
  try { SystemParametersInfoW(0x0057 /* SPI_SETCURSORS */, 0, null, 0); } catch { /* */ }
}

// current cursor shape as a CSS name; 'none' = hidden or a custom cursor (then it is visible in the video)
function shape() {
  try {
    const ci = { cbSize: CI_SIZE, flags: 0, hCursor: 0, x: 0, y: 0 };
    if (!GetCursorInfo(ci)) return 'default';
    if (!(ci.flags & 1)) return 'none';
    if (!handleMap) buildMap();
    return handleMap.get(String(ci.hCursor)) || 'none';
  } catch { return 'default'; }
}

module.exports = { hide, restore, shape, isHidden: () => hidden };
