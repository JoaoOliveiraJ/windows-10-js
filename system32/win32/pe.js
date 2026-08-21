// ===========================================================================
// jsOS - system32/win32/pe.js: loader de executaveis Windows PE32+ (x86-64), em JS.
//
// Faz o parse do PE, mapeia as secoes na memoria fisica (os.poke8), resolve
// a IAT contra o mini-kernel32 (win32.js + trampolins asm) e devolve o
// endereco do entry point para os.execAt().
//
// Limitacoes intencionais: ImageBase preferido (sem relocs), imports so por
// nome e so KERNEL32.dll.
// ===========================================================================

const Win32 = require('win32/win32');

const STUB_SIZE = 10;   // bytes por trampolim (ver host/win32thunk.asm)

function load(ab) {
    const v = new DataView(ab);
    const r16 = o => v.getUint16(o, true);
    const r32 = o => v.getUint32(o, true);
    const r8  = o => v.getUint8(o);

    if (r16(0) !== 0x5A4D) throw new Error('MZ ausente (nao e PE)');
    const peOff = r32(0x3C);
    if (r32(peOff) !== 0x00004550) throw new Error('assinatura PE ausente');

    const coff = peOff + 4;
    if (r16(coff) !== 0x8664) throw new Error('so suportamos PE x86-64');
    const nsec = r16(coff + 2);
    const optSize = r16(coff + 16);
    const opt = coff + 20;
    if (r16(opt) !== 0x20B) throw new Error('nao e PE32+');

    const entryRva    = r32(opt + 16);
    const imageBase   = r32(opt + 24) + r32(opt + 28) * 0x100000000; // u64
    const sizeOfImage = r32(opt + 56);
    const sizeOfHdrs  = r32(opt + 60);
    const importRva   = r32(opt + 112 + 8);   // DataDirectory[1] = Import
    const secTable    = opt + optSize;

    // RVA -> offset no arquivo (via tabela de secoes)
    function rvaToOff(rva) {
        for (let s = 0; s < nsec; s++) {
            const sh = secTable + s * 40;
            const vsize = r32(sh + 8), va = r32(sh + 12);
            const rawSize = r32(sh + 16), rawPtr = r32(sh + 20);
            if (rva >= va && rva < va + Math.max(vsize, rawSize))
                return rawPtr + (rva - va);
        }
        if (rva < sizeOfHdrs) return rva;
        throw new Error('RVA invalido: 0x' + rva.toString(16));
    }

    function readCStr(off) {
        let s = '';
        for (let b = r8(off); b !== 0; b = r8(++off)) s += String.fromCharCode(b);
        return s;
    }

    os.print('[pe] base=0x' + imageBase.toString(16) +
             ' imagem=' + sizeOfImage + ' bytes, ' + nsec + ' secoes');

    // zera a imagem (BSS) e copia headers + secoes para a memoria fisica
    for (let i = 0; i < sizeOfImage; i++) os.poke8(imageBase + i, 0);
    for (let i = 0; i < sizeOfHdrs; i++) os.poke8(imageBase + i, r8(i));
    for (let s = 0; s < nsec; s++) {
        const sh = secTable + s * 40;
        const va = r32(sh + 12), rawSize = r32(sh + 16), rawPtr = r32(sh + 20);
        for (let i = 0; i < rawSize; i++)
            os.poke8(imageBase + va + i, r8(rawPtr + i));
    }

    // imports: preenche a IAT com os trampolins Win32
    if (importRva) {
        const thunkBase = os.win32ThunkBase();
        let d = rvaToOff(importRva);
        for (;;) {
            const ilt = r32(d), nameRva = r32(d + 12), iat = r32(d + 16);
            if (ilt === 0 && nameRva === 0 && iat === 0) break;
            const dll = readCStr(rvaToOff(nameRva));
            os.print('[pe] imports de ' + dll);
            let j = 0;
            for (;;) {
                const eoff = rvaToOff(ilt) + j * 8;
                const lo = r32(eoff), hi = r32(eoff + 4);
                if (lo === 0 && hi === 0) break;
                if (hi & 0x80000000) throw new Error('import por ordinal nao suportado');
                const fname = readCStr(rvaToOff(lo) + 2);   // pula o hint (u16)
                const apiId = Win32.lookup(dll, fname);
                if (apiId < 0) throw new Error('API nao suportada: ' + dll + '!' + fname);
                const stub = thunkBase + apiId * STUB_SIZE;
                const iatAddr = imageBase + iat + j * 8;
                os.poke32(iatAddr, stub >>> 0);
                os.poke32(iatAddr + 4, Math.floor(stub / 0x100000000));
                os.print('[pe]   ' + fname + ' -> api #' + apiId);
                j++;
            }
            d += 20;
        }
    }

    const entry = imageBase + entryRva;
    os.print('[pe] entry point = 0x' + entry.toString(16));
    return entry;
}

module.exports = { load };
