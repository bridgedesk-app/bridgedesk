// BridgeDesk — администраторски права в Windows.
// Без тях Windows не позволява да управляваш прозорци, пуснати „като администратор“
// (Task Manager, инсталатори, някои фирмени програми) — курсорът и клавиатурата „замръзват“ над тях.
const koffi = require('koffi');

const shell32 = koffi.load('shell32.dll');
const IsUserAnAdmin = shell32.func('bool __stdcall IsUserAnAdmin()');
const ShellExecuteW = shell32.func('intptr __stdcall ShellExecuteW(void *hwnd, str16 lpOperation, str16 lpFile, str16 lpParameters, str16 lpDirectory, int nShowCmd)');

function isAdmin() {
  try { return !!IsUserAnAdmin(); } catch { return false; }
}

// Стартира програмата отново с UAC. true = потребителят прие.
function relaunchAsAdmin(exe, args) {
  const params = args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ');
  try { return Number(ShellExecuteW(null, 'runas', exe, params, null, 1)) > 32; } catch { return false; }
}

module.exports = { isAdmin, relaunchAsAdmin };
