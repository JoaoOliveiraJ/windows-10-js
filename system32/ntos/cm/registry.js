// ===========================================================================
// jsOS - system32/ntos/cm/registry.js: Configuration Manager - o Registry.
//
// Hive em memoria: arvore case-insensitive de chaves com valores nomeados
// { type, data }. Handles numericos para drivers (Zw*). Semantica real:
// ZwCreateKey cria (ou abre) e devolve handle; ZwQueryValueKey le na forma
// KEY_VALUE_*_INFORMATION: { u32 TitleIndex, u32 Type, u32 DataLength, Data }.
// ===========================================================================

// no da hive: { children: Map(lowercase->no), values: Map(lowercase->{name,type,data}) }
function newKeyNode() {
    return { children: new Map(), values: new Map() };
}

const hiveRoot = newKeyNode();

function split(path) {
    return String(path).split('\\').filter(s => s.length > 0);
}

function walk(path, create) {
    let node = hiveRoot;
    for (const part of split(path)) {
        const key = part.toLowerCase();
        if (!node.children.has(key)) {
            if (!create) return null;
            node.children.set(key, newKeyNode());
        }
        node = node.children.get(key);
    }
    return node;
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

module.exports = { openOrCreate, open, getNode, closeHandle, setValue, getValue };
