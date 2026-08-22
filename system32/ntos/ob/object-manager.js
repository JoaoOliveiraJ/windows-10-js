// ===========================================================================
// jsOS - system32/ntos/ob/objmgr.js: Object Manager (a fundacao estilo Windows NT).
//
// Tudo e objeto: arquivos, dispositivos, processos, drivers. Os objetos
// vivem num namespace unico em arvore ('\Device\Console', '\FS\README'),
// case-insensitive como no NT, e sao acessados por HANDLES com contagem
// de referencia (ObOpenObjectByName / ObReference / ObClose).
//
// Sistemas de arquivos e drivers se montam/registram aqui: um no pode ter
// um `mount` que delega o resto do caminho (ex: '\FS\' -> MemoryFileSystem).
// ===========================================================================

// no do namespace: { name, type, children: Map|null, mount|null, data, refs }
const root = {
    name: '',
    type: 'Directory',
    children: new Map(),
    mount: null,
    data: null,
    refs: 0,
};

function split(path) {
    return String(path).split('\\').filter(s => s.length > 0);
}

// resolve um caminho ate um no. Retorna { node, rest } - se o no tem mount,
// `rest` e o caminho restante dentro do sistema montado. Segue links
// simbolicos (SymbolicLink) como o NT segue \DosDevices\C:.
function resolve(path, depth) {
    depth = depth || 0;
    if (depth > 8) return { node: null, rest: null };   // loop de links
    let node = root;
    const parts = split(path);
    for (let i = 0; i < parts.length; i++) {
        if (node.mount) return { node, rest: parts.slice(i).join('/') };
        if (!node.children) return { node: null, rest: null };
        const next = node.children.get(parts[i].toLowerCase());
        if (!next) return { node: null, rest: null };
        if (next.type === 'SymbolicLink') {
            const rest = parts.slice(i + 1).join('\\');
            return resolve(next.data + (rest ? '\\' + rest : ''), depth + 1);
        }
        node = next;
    }
    if (node.mount) return { node, rest: '' };
    return { node, rest: null };
}

function createDirectory(path) {
    let node = root;
    for (const part of split(path)) {
        const key = part.toLowerCase();
        if (!node.children.has(key)) {
            node.children.set(key, {
                name: part, type: 'Directory', children: new Map(),
                mount: null, data: null, refs: 0,
            });
        }
        node = node.children.get(key);
    }
    return node;
}

// cria um objeto dentro de um diretorio (parentPath + name)
function createObject(parentPath, name, type, data) {
    const parent = resolve(parentPath).node;
    if (!parent || !parent.children) throw new Error('dir inexistente: ' + parentPath);
    const key = name.toLowerCase();
    if (parent.children.has(key)) throw new Error('objeto ja existe: ' + parentPath + '\\' + name);
    const obj = { name, type, children: null, mount: null, data, refs: 0 };
    parent.children.set(key, obj);
    return obj;
}

// monta um sistema de arquivos num diretorio (fs = { read, write, exists, list })
function mount(path, fs) {
    const node = createDirectory(path);
    node.mount = fs;
    return node;
}

// link simbolico (ex: \DosDevices\C: -> \FS), seguido pelo resolve()
function createSymlink(path, target) {
    const parts = split(path);
    const name = parts[parts.length - 1];
    const parentPath = '\\' + parts.slice(0, -1).join('\\');
    return createObject(parentPath === '\\' ? '\\' : parentPath, name, 'SymbolicLink', target);
}

// ---- handles (ObOpenObjectByName / ObClose) ----

let nextHandle = 1;
const handleTable = new Map();   // handle -> objeto

function open(path) {
    let { node, rest } = resolve(path);
    if (!node) return 0;
    if (node.mount) {
        // delega ao FS montado: vira um objeto File temporario
        let fspath = '/' + rest;
        if (!node.mount.exists(fspath)) {
            // fallback case-insensitive dentro do FS montado (como NT/Win32)
            const want = rest.toLowerCase();
            const hit = node.mount.list().find(f => f.slice(1).toLowerCase() === want);
            if (!hit) return 0;
            fspath = hit;
        }
        node = {
            name: fspath.slice(1), type: 'File', children: null,
            mount: node.mount, data: fspath, refs: 0,
        };
    }
    node.refs++;
    const h = nextHandle++;
    handleTable.set(h, node);
    return h;
}

function getObject(handle) {
    return handleTable.get(handle) || null;
}

function close(handle) {
    const node = handleTable.get(handle);
    if (!node) return false;
    node.refs--;
    handleTable.delete(handle);
    return true;
}

function refs(path) {
    const { node } = resolve(path);
    return node ? node.refs : -1;
}

// ---- dump da arvore (para debug/shell) ----

function dump() {
    const out = [];
    (function walk(node, prefix) {
        out.push(prefix + '\\' + (node.name || '') +
                 '  [' + node.type + (node.mount ? ', mount' : '') +
                 ', refs=' + node.refs + ']');
        if (node.children)
            for (const child of node.children.values()) walk(child, prefix + '\\' + (node.name || ''));
    })(root, '');
    return out;
}

// lookup publico (resolve sem delegar a mounts: para Device/Driver/DriverEntry)
function lookup(path) {
    return resolve(path).node;
}

// remove um objeto do namespace (devolve true se removeu)
function unlink(path) {
    const parts = split(path);
    if (parts.length === 0) return false;
    const name = parts[parts.length - 1].toLowerCase();
    const parentPath = '\\' + parts.slice(0, -1).join('\\');
    const parent = resolve(parentPath === '\\' ? '\\' : parentPath).node;
    if (!parent || !parent.children) return false;
    return parent.children.delete(name);
}

module.exports = { createDirectory, createObject, createSymlink, mount, open,
                   getObject, close, refs, dump, lookup, unlink, resolve };
