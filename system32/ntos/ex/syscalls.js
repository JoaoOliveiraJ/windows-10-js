// ===========================================================================
// jsOS - system32/ntos/ex/syscalls.js: tabela de chamadas de sistema
// (numeradas). Programas de usuario (JS) nao tocam em VGA/Keyboard/os.*
// direto: passam por aqui.
// ===========================================================================

const Console = require('drivers/console/console');
const MemoryFileSystem = require('ntos/fs/memory-file-system');
const Keyboard = require('drivers/input/keyboard');
const ObjectManager = require('ntos/ob/object-manager');

const table = {
    0:  ['print',   (s)        => Console.print(s)],
    1:  ['read',    (p)        => MemoryFileSystem.read(p)],
    2:  ['write',   (p, d)     => MemoryFileSystem.write(p, d)],
    3:  ['list',    ()         => MemoryFileSystem.list()],
    4:  ['remove',  (p)        => MemoryFileSystem.remove(p)],
    5:  ['exists',  (p)        => MemoryFileSystem.exists(p)],
    6:  ['meminfo', ()         => os.getHeapInfo()],
    7:  ['getchar', ()         => Keyboard.readKey()],
    8:  ['clear',   ()         => Console.clear()],
    9:  ['halt',    ()         => os.halt()],
    10: ['ramsize', ()         => os.getRamSize()],
    11: ['open',    (p)        => ObjectManager.open(p)],
    12: ['close',   (h)        => ObjectManager.close(h)],
};
const byName = {};
for (const n in table) byName[table[n][0]] = Number(n);

function SystemCall(num, ...args) {
    const e = table[num];
    if (!e) throw new Error('syscall desconhecida: ' + num);
    return e[1](...args);
}
SystemCall.byName = byName;
SystemCall.table = table;

module.exports = SystemCall;
