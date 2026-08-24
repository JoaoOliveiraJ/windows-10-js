// ===========================================================================
// jsOS - system32/ntos/cm/registry.js: Configuration Manager - o Registry.
//
// Hive em memoria: arvore case-insensitive de chaves com valores nomeados
// { type, data }. Handles numericos para drivers (Zw*). Semantica real:
// ZwCreateKey cria (ou abre) e devolve handle; ZwQueryValueKey le na forma
// KEY_VALUE_*_INFORMATION: { u32 TitleIndex, u32 Type, u32 DataLength, Data }.
// ===========================================================================

// no da hive: { name, children: Map(lowercase->no), values: Map(lowercase->{name,type,data}) }
function newKeyNode(name) {
    return { name: name || '', children: new Map(), values: new Map() };
}

const hiveRoot = newKeyNode('');

function split(path) {
    return String(path).split('\\').filter(s => s.length > 0);
}

function walk(path, create) {
    let node = hiveRoot;
    for (const part of split(path)) {
        const key = part.toLowerCase();
        if (!node.children.has(key)) {
            if (!create) return null;
            node.children.set(key, newKeyNode(part));
        }
        node = node.children.get(key);
    }
    return node;
}

// lista nomes de subchaves (para enumerar Services etc.)
function listKeys(path) {
    const node = walk(path, false);
    return node ? [...node.children.values()].map(c => c.name) : [];
}

// le um valor direto por caminho (sem handle; uso interno do kernel)
function readValueByPath(path, valueName) {
    const node = walk(path, false);
    if (!node) return null;
    return node.values.get(valueName.toLowerCase()) || null;
}

// ---- handles ----

let nextHandle = 0x100;
const handleTable = new Map();   // handle -> caminho absoluto da chave

function openOrCreate(path) {
    const node = walk(path, true);
    if (!node) return 0;
    const handle = nextHandle++;
    handleTable.set(handle, path);
    return handle;
}

function open(path) {
    if (!walk(path, false)) return 0;
    const handle = nextHandle++;
    handleTable.set(handle, path);
    return handle;
}

function getNode(handle) {
    const path = handleTable.get(handle);
    return path ? walk(path, false) : null;
}

// caminho absoluto de um handle (para delete/enumerate)
function getPath(handle) {
    return handleTable.get(handle) || null;
}

// remove a chave do handle da hive (devolve true se removeu)
function deleteKey(handle) {
    const path = handleTable.get(handle);
    if (!path) return false;
    const parts = split(path);
    if (parts.length === 0) return false;
    const name = parts[parts.length - 1].toLowerCase();
    const parent = walk('\\' + parts.slice(0, -1).join('\\'), false);
    if (!parent) return false;
    return parent.children.delete(name);
}

function closeHandle(handle) {
    return handleTable.delete(handle);
}

function setValue(handle, valueName, type, data) {
    const node = getNode(handle);
    if (!node) return false;
    node.values.set(valueName.toLowerCase(), { name: valueName, type, data });
    return true;
}

function getValue(handle, valueName) {
    const node = getNode(handle);
    if (!node) return null;
    return node.values.get(valueName.toLowerCase()) || null;
}

// remove um valor da chave (devolve true se existia) — RtlDeleteRegistryValue
function deleteValue(handle, valueName) {
    const node = getNode(handle);
    if (!node) return false;
    return node.values.delete(valueName.toLowerCase());
}

module.exports = { openOrCreate, open, getNode, getPath, deleteKey, closeHandle,
                   setValue, getValue, deleteValue, listKeys, readValueByPath };
