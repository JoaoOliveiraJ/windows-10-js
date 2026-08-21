// ===========================================================================
// jsOS - system32/shell/shell.js: REPL interativo (o "cmd.exe" do jsOS).
// Roda como processo gerador no escalonador (yield entre teclas).
// ===========================================================================

const Console = require('drivers/console/console');
const VFS = require('ntos/fs/vfs');
const Keyboard = require('drivers/input/keyboard');
const Scheduler = require('ntos/ps/scheduler');
const Memory = require('ntos/mm/memory');
const SYS = require('ntos/ex/syscalls');
const ObjMgr = require('ntos/ob/objmgr');
const PE = require('win32/pe');

const HELP = [
    'help              esta ajuda',
    'version           versao do jsOS',
    'clear             limpa a tela',
    'echo <txt>        imprime texto',
    'mem               uso do heap/RAM',
    'ls                lista arquivos do VFS',
    'cat <arq>         mostra conteudo',
    'write <arq> <txt> grava arquivo',
    'rm <arq>          remove arquivo',
    'run <arq.js>      executa programa JS do VFS',
    'exec <arq.exe>    executa .exe Windows (PE32+) nativo',
    'objects           namespace do Object Manager (estilo NT)',
    'ps                lista processos',
    'spawn <arq.js>    cria processo (arquivo retorna function*)',
    'kill <pid>        mata processo',
    'selftest          roda o autoteste do kernel',
    'halt              desliga',
];

// aceita caminhos estilo Windows (C:\foo, C:/foo, \foo) -> canonico '/foo'
function normPath(p) {
    if (!p) return p;
    p = String(p);
    const m = p.match(/^([A-Za-z]):[\\\/]?(.*)$/);
    if (m) return '/' + m[2].replace(/\\/g, '/');
    return p.replace(/\\/g, '/');
}

function cmdHelp()      { HELP.forEach(l => Console.print(l)); }
function cmdVersion()   { Console.print('jsOS v' + Kernel.VERSION); }
function cmdClear()     { Console.clear(); }
function cmdEcho(args)  { Console.print(args.join(' ')); }
function cmdMem()       { Memory.cmdMem(); }

function cmdLs() {
    const list = VFS.list();
    if (list.length === 0) { Console.print('(vazio)'); return; }
    Console.print(' Volume em C: montado em \\FS');
    list.forEach(f => Console.print('  C:' + f.replace(/\//g, '\\') + '  (' + VFS.size(f) + ' bytes)'));
}

function cmdCat(args) {
    const p = normPath(args[0]);
    const d = VFS.read(p);
    if (d === null) Console.print('arquivo nao encontrado: ' + args[0]);
    else if (d instanceof ArrayBuffer) Console.print('<arquivo binario, ' + d.byteLength + ' bytes>');
    else Console.print(d);
}

function cmdWrite(args) {
    if (args.length < 2) { Console.print('uso: write <arq> <texto>'); return; }
    VFS.write(normPath(args[0]), args.slice(1).join(' '));
    Console.print('gravado: ' + args[0]);
}

function cmdRm(args) {
    Console.print(VFS.remove(normPath(args[0])) ? 'removido' : 'nao encontrado');
}

function cmdRun(args) {
    const src = VFS.read(normPath(args[0]));
    if (src === null) { Console.print('arquivo nao encontrado: ' + args[0]); return; }
    try {
        const prog = new Function('SYS', src);
        const ret = prog(SYS);
        if (ret !== undefined) Console.print('= ' + ret);
    } catch (e) {
        Console.print('erro no programa: ' + e.message);
    }
}

function cmdExec(args) {
    // executa um .exe Windows (PE32+) nativo, via PE loader + mini-kernel32
    const buf = VFS.readBytes(normPath(args[0]));
    if (!buf) { Console.print('nao e PE/binario ou nao existe: ' + args[0]); return; }
    try {
        const entry = PE.load(buf);
        os.execAt(entry);
        Console.print('[pe] programa encerrado, de volta ao shell');
    } catch (e) {
        Console.print('erro no loader PE: ' + e.message);
    }
}

function cmdPs() {
    const ps = Scheduler.list();
    Console.print('PID  STATE    NAME');
    ps.forEach(p => Console.print(
        String(p.pid).padEnd(5) + p.state.padEnd(9) + p.name));
}

function cmdSpawn(args) {
    const src = VFS.read(args[0]);
    if (src === null) { Console.print('arquivo nao encontrado: ' + args[0]); return; }
    try {
        // convencao: o arquivo retorna uma funcao geradora function*(SYS)
        const makeProc = new Function(src)();
        const pid = Scheduler.spawn(args[0], makeProc, SYS);
        Console.print('processo ' + pid + ' criado (' + args[0] + ')');
    } catch (e) {
        Console.print('erro ao criar processo: ' + e.message);
    }
}

function cmdKill(args) {
    const pid = parseInt(args[0], 10);
    Console.print(Scheduler.kill(pid) ? 'processo morto' : 'pid nao encontrado');
}

function cmdSelftest() {
    require('ntos/test/selftest').run();
    Console.print('selftest passou');
}

function cmdObjects() {
    ObjMgr.dump().forEach(l => Console.print(l));
}

function cmdHalt() { Console.print('desligando...'); os.halt(); }

const commands = {
    help: cmdHelp, version: cmdVersion, clear: cmdClear, echo: cmdEcho,
    mem: cmdMem, ls: cmdLs, cat: cmdCat, write: cmdWrite, rm: cmdRm,
    run: cmdRun, ps: cmdPs, spawn: cmdSpawn, kill: cmdKill, exec: cmdExec,
    objects: cmdObjects, selftest: cmdSelftest, halt: cmdHalt,
};

function exec(line) {
    const parts = line.trim().split(/\s+/).filter(x => x);
    if (parts.length === 0) return;
    const cmd = commands[parts[0]];
    if (cmd) cmd(parts.slice(1));
    else Console.print('comando desconhecido: ' + parts[0] + " (tente 'help')");
}

// processo gerador: yield quando nao ha tecla -> cede a CPU
function* main() {
    Console.print('');
    Console.print("jsOS shell - digite 'help'");
    let line = '';
    Console.write('jsOS> ');
    for (;;) {
        const k = Keyboard.pollKey();
        if (k === null) { yield; continue; }
        if (k === '\n') {
            Console.write('\n');
            exec(line);
            line = '';
            Console.write('jsOS> ');
            continue;
        }
        if (k === '\b') {
            if (line.length > 0) { line = line.slice(0, -1); Console.write('\b'); }
            continue;
        }
        if (k.length === 1) { line += k; Console.write(k); }
    }
}

module.exports = { main, exec };
