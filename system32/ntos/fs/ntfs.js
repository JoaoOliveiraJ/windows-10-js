// ===========================================================================
// jsOS - system32/ntos/fs/ntfs.js: driver NTFS (leitura) em JavaScript.
//
// Implementa de verdade: boot sector, MFT com fixup (USA), atributos
// residentes e nao-residentes (runlists com deltas sinalizados), $FILE_NAME
// e listagem de diretorio via $INDEX_ROOT. Escrita/journal: fora de escopo.
// ===========================================================================

const AtaPio = require('drivers/storage/ata-pio');

function u16(a, o) { return a[o] | (a[o + 1] << 8); }
function u32(a, o) { return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0; }
function u64(a, o) { return u32(a, o) + u32(a, o + 4) * 0x100000000; }
// inteiro sinalizado little-endian de n bytes (runlist)
function sint(a, o, n) {
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + a[o + i];
    if (n > 0 && (a[o + n - 1] & 0x80)) v -= Math.pow(256, n);
    return v;
}
function utf16(a, o, chars) {
    let s = '';
    for (let i = 0; i < chars; i++) s += String.fromCharCode(u16(a, o + i * 2));
    return s;
}

// ---- registro MFT (com fixup USA) ----

function readRecord(drive, vol, recno) {
    const off = vol.mftLcn * vol.clusterSize + recno * vol.recordSize;
    const lba = Math.floor(off / vol.sectorSize);
    const rec = AtaPio.readSectors(lba, vol.recordSize / vol.sectorSize, drive);
    if (String.fromCharCode(rec[0], rec[1], rec[2], rec[3]) !== 'FILE')
        throw new Error('NTFS: record sem magic FILE (rec ' + recno + ')');
    const usaOff = u16(rec, 4), usaCount = u16(rec, 6);
    const usn = u16(rec, usaOff);
    for (let i = 1; i < usaCount; i++) {
        const tail = i * vol.sectorSize - 2;
        if (u16(rec, tail) !== usn) throw new Error('NTFS: fixup USN invalido');
        rec[tail] = rec[usaOff + i * 2];
        rec[tail + 1] = rec[usaOff + i * 2 + 1];
    }
    return rec;
}

// ---- atributos ----

function eachAttr(rec, cb) {
    let off = u16(rec, 20);
    for (;;) {
        const type = u32(rec, off);
        if (type === 0xFFFFFFFF) break;
        const len = u32(rec, off + 4);
        const nonRes = rec[off + 8];
        if (nonRes) {
            cb(type, { nonRes: true, runOff: off + u16(rec, off + 32),
                       realSize: u64(rec, off + 48), recOff: off });
        } else {
            const vlen = u32(rec, off + 16), voff = u16(rec, off + 20);
            cb(type, { nonRes: false, value: rec.slice(off + voff, off + voff + vlen) });
        }
        if (!len) break;
        off += len;
    }
}

function findAttr(rec, type) {
    let found = null;
    eachAttr(rec, (t, a) => { if (t === type && !found) found = a; });
    return found;
}

// runlist -> [{lcn, count}]
function parseRuns(rec, runOff) {
    const runs = [];
    let o = runOff, lcn = 0;
    for (;;) {
        const h = rec[o];
        if (!h) break;
        const lenN = h & 0x0F, offN = h >> 4;
        const count = sint(rec, o + 1, lenN);
        lcn += sint(rec, o + 1 + lenN, offN);
        runs.push({ lcn, count });
        o += 1 + lenN + offN;
    }
    return runs;
}

// le o conteudo $DATA de um record (residente ou via runlist)
function readData(drive, vol, rec) {
    const data = findAttr(rec, 0x80);
    if (!data) return new Uint8Array(0);
    if (!data.nonRes) return data.value;
    const runs = parseRuns(rec, data.runOff);
    const out = new Uint8Array(data.realSize);
    let done = 0;
    for (const r of runs) {
        const chunk = AtaPio.readSectors(r.lcn * vol.sectorsPerCluster,
                                      r.count * vol.sectorsPerCluster, drive);
        const take = Math.min(chunk.length, out.length - done);
        out.set(chunk.slice(0, take), done);
        done += take;
        if (done >= out.length) break;
    }
    return out;
}

function fileNameOf(value) {
    const len = value[64];
    return utf16(value, 66, len);
}

// ---- mount ----

function mount(drive) {
    const bs = AtaPio.readSectors(0, 1, drive);
    const oem = utf16rawAscii(bs, 3, 8);
    if (oem !== 'NTFS    ') throw new Error('NTFS: assinatura ausente (' + oem + ')');
    const vol = {
        sectorSize: u16(bs, 11),
        sectorsPerCluster: bs[13],
        mftLcn: u64(bs, 48),
        recordSize: (() => { let v = bs[64]; if (v > 127) v -= 256;   /* i8 */
                             return v < 0 ? (1 << -v) : v; })(),
    };
    vol.clusterSize = vol.sectorSize * vol.sectorsPerCluster;

    // raiz = record 5 ('.')
    function rootIndex() {
        const root = readRecord(drive, vol, 5);
        const idx = findAttr(root, 0x90);   // $INDEX_ROOT
        if (!idx || idx.nonRes) throw new Error('NTFS: $INDEX_ROOT nao residente nao suportado');
        const v = idx.value;
        const entriesOff = u32(v, 16);
        let o = 16 + entriesOff;
        const names = [];
        for (;;) {
            const size = u16(v, o + 8), streamLen = u16(v, o + 10), flags = u16(v, o + 12);
            if (flags & 2) break;                       // ultima entrada
            const ref = v[o] | (v[o+1]<<8) | (v[o+2]<<16) | (v[o+3]*0x1000000) |
                        (v[o+4] * 0x100000000) + (v[o+5] * 0x10000000000);
            const stream = v.slice(o + 16, o + 16 + streamLen);
            names.push({ name: fileNameOf(stream), ref });
            o += size;
        }
        return names;
    }

    function findInRoot(path) {
        const want = path.replace(/^\//, '').toLowerCase();
        if (!want) return null;
        for (const e of rootIndex())
            if (e.name.toLowerCase() === want) return e;
        return null;
    }

    return {
        exists(path) { return findInRoot(path) !== null; },
        list() { return rootIndex().map(e => '/' + e.name); },
        size(path) {
            const e = findInRoot(path);
            if (!e) return -1;
            const rec = readRecord(drive, vol, e.ref);
            const data = readData(drive, vol, rec);
            return data.length;
        },
        readBytes(path) {
            const e = findInRoot(path);
            if (!e) return null;
            const rec = readRecord(drive, vol, e.ref);
            return readData(drive, vol, rec).buffer;
        },
        read(path) {
            const b = this.readBytes(path);
            if (!b) return null;
            const u = new Uint8Array(b);
            let s = '';
            for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
            return s;
        },
    };
}

function utf16rawAscii(a, o, n) {   // nome OEM do boot sector e ASCII puro
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(a[o + i]);
    return s;
}

module.exports = { mount };
