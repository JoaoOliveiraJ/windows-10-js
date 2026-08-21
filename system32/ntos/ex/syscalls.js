// ===========================================================================
// jsOS - system32/ntos/ex/syscalls.js: tabela de chamadas de sistema
// (numeradas). Programas de usuario (JS) nao tocam em VGA/Keyboard/os.*
// direto: passam por aqui.
// ===========================================================================

const Console = require('drivers/console/console');
const VFS = require('ntos/fs/vfs');
const Keyboard = require('drivers/input/keyboard');
const ObjMgr = require('ntos/ob/objmgr');

const table = {
    0:  ['print',   (s)        => Console.print(s)],
    1:  ['read',    (p)        => VFS.read(p)],
    2:  ['write',   (p, d)     => VFS.write(p, d)],
    3:  ['list',    ()         => VFS.list()],
    4:  ['remove',  (p)        => VFS.remove(p)],
    5:  ['exists',  (p)        => VFS.exists(p)],
    6:  ['meminfo', ()         => os.heapInfo()],
    7:  ['getchar', ()         => Keyboard.readKey()],
    8:  ['clear',   ()         => Console.clear()],
    9:  ['halt',    ()         => os.halt()],
    10: ['ramsize', ()         => os.ramSize()],
    11: ['open',    (p)        => ObjMgr.open(p)],
    12: ['close',   (h)        => ObjMgr.close(h)],
};
const byName = {};
for (const n in table) byName[table[n][0]] = Number(n);

function SYS(num, ...args) {
    const e = table[num];
    if (!e) throw new Error('syscall desconhecida: ' + num);
    return e[1](...args);
}
SYS.byName = byName;
SYS.table = table;

module.exports = SYS;
