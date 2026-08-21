// ===========================================================================
// jsOS - system32/ntos/fs/vfs.js: sistema de arquivos em memoria (namespace plano).
// Guarda texto (string) ou binario (ArrayBuffer, ex: .exe).
// ===========================================================================

const files = new Map();   // path -> string | ArrayBuffer

function norm(p) {
    if (!p) return '/';
    if (p[0] !== '/') p = '/' + p;
    return p;
}

module.exports = {
    write(p, data)     { files.set(norm(p), String(data)); return true; },
    writeBytes(p, ab)  { files.set(norm(p), ab); return true; },
    read(p)            { p = norm(p); return files.has(p) ? files.get(p) : null; },
    readBytes(p)       { const d = files.get(norm(p)); return (d instanceof ArrayBuffer) ? d : null; },
    isBinary(p)        { return files.get(norm(p)) instanceof ArrayBuffer; },
    exists(p)          { return files.has(norm(p)); },
    remove(p)          { return files.delete(norm(p)); },
    list()             { return [...files.keys()].sort(); },
    size(p)            { const d = files.get(norm(p)); return d ? (d.byteLength ?? d.length) : -1; },
};
