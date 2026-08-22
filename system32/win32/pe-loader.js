// ===========================================================================
// jsOS - system32/win32/pe-loader.js: loader de executaveis Windows PE32+
// (x86-64), 100% JavaScript.
//
// Faz o parse do PE, mapeia as secoes na memoria fisica (os.writePhysical8),
// e resolve a IAT contra as tabelas registradas (kernel32 -> win32.js,
// ntoskrnl.exe -> ntoskrnl.js) apontando para os trampolins asm.
//
// Limitacoes intencionais: ImageBase preferido (sem relocs), imports so por
// nome (nao por ordinal).
// ===========================================================================

const STUB_SIZE = 10;   // bytes por trampolim (ver hal/win32/win32thunk.asm)

// resolvedores de DLL registrados: quem importa o que (kernel32, ntoskrnl...)
const resolvers = [];

function registerResolver(dllPattern, lookupFunction) {
    resolvers.push({ dllPattern, lookupFunction });
}

function resolveImport(dllName, functionName) {
    for (const r of resolvers) {
        if (r.dllPattern.test(dllName)) return r.lookupFunction(dllName, functionName);
    }
    return -1;
}

function load(fileBuffer) {
    const view = new DataView(fileBuffer);
    const readUint16 = o => view.getUint16(o, true);
    const readUint32 = o => view.getUint32(o, true);
    const readUint8  = o => view.getUint8(o);

    if (readUint16(0) !== 0x5A4D) throw new Error('MZ ausente (nao e PE)');
    const peHeaderOffset = readUint32(0x3C);
    if (readUint32(peHeaderOffset) !== 0x00004550) throw new Error('assinatura PE ausente');

    const coffHeader = peHeaderOffset + 4;
    if (readUint16(coffHeader) !== 0x8664) throw new Error('so suportamos PE x86-64');
    const sectionCount = readUint16(coffHeader + 2);
    const optionalHeaderSize = readUint16(coffHeader + 16);
    const optionalHeader = coffHeader + 20;
    if (readUint16(optionalHeader) !== 0x20B) throw new Error('nao e PE32+');

    const entryPointRva  = readUint32(optionalHeader + 16);
    const imageBase      = readUint32(optionalHeader + 24) +
                           readUint32(optionalHeader + 28) * 0x100000000;
    const sizeOfImage    = readUint32(optionalHeader + 56);
    const sizeOfHeaders  = readUint32(optionalHeader + 60);
    const exportTableRva = readUint32(optionalHeader + 112);     // DataDirectory[0]
    const importTableRva = readUint32(optionalHeader + 112 + 8); // DataDirectory[1]
    const sectionTable   = optionalHeader + optionalHeaderSize;

    // RVA -> offset no arquivo (via tabela de secoes)
    function rvaToFileOffset(rva) {
        for (let s = 0; s < sectionCount; s++) {
            const sh = sectionTable + s * 40;
            const virtualSize = readUint32(sh + 8), virtualAddress = readUint32(sh + 12);
            const rawSize = readUint32(sh + 16), rawPointer = readUint32(sh + 20);
            if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize))
                return rawPointer + (rva - virtualAddress);
        }
        if (rva < sizeOfHeaders) return rva;
        throw new Error('RVA invalido: 0x' + rva.toString(16));
    }

    function readCString(offset) {
        let s = '';
        for (let b = readUint8(offset); b !== 0; b = readUint8(++offset))
            s += String.fromCharCode(b);
        return s;
    }

    os.debugPrint('[pe] base=0x' + imageBase.toString(16) +
                  ' imagem=' + sizeOfImage + ' bytes, ' + sectionCount + ' secoes');

    // zera a imagem (BSS) e copia headers + secoes para a memoria fisica
    for (let i = 0; i < sizeOfImage; i++) os.writePhysical8(imageBase + i, 0);
    for (let i = 0; i < sizeOfHeaders; i++) os.writePhysical8(imageBase + i, readUint8(i));
    for (let s = 0; s < sectionCount; s++) {
        const sh = sectionTable + s * 40;
        const virtualAddress = readUint32(sh + 12);
        const rawSize = readUint32(sh + 16), rawPointer = readUint32(sh + 20);
        for (let i = 0; i < rawSize; i++)
            os.writePhysical8(imageBase + virtualAddress + i, readUint8(rawPointer + i));
    }

    // imports: preenche a IAT com os enderecos dos trampolins
    if (importTableRva) {
        const thunkTableBase = os.getWin32ThunkTable();
        let descriptor = rvaToFileOffset(importTableRva);
        for (;;) {
            const iltRva = readUint32(descriptor);
            const nameRva = readUint32(descriptor + 12);
            const iatRva = readUint32(descriptor + 16);
            if (iltRva === 0 && nameRva === 0 && iatRva === 0) break;
            const dllName = readCString(rvaToFileOffset(nameRva));
            os.debugPrint('[pe] imports de ' + dllName);
            let slot = 0;
            for (;;) {
                const entryOffset = rvaToFileOffset(iltRva) + slot * 8;
                const lo = readUint32(entryOffset), hi = readUint32(entryOffset + 4);
                if (lo === 0 && hi === 0) break;
                if (hi & 0x80000000) throw new Error('import por ordinal nao suportado');
                const functionName = readCString(rvaToFileOffset(lo) + 2); // pula o hint
                const apiId = resolveImport(dllName, functionName);
                if (apiId < 0) throw new Error('API nao suportada: ' + dllName + '!' + functionName);
                const thunkAddress = thunkTableBase + apiId * STUB_SIZE;
                const iatAddress = imageBase + iatRva + slot * 8;
                os.writePhysical32(iatAddress, thunkAddress >>> 0);
                os.writePhysical32(iatAddress + 4, Math.floor(thunkAddress / 0x100000000));
                os.debugPrint('[pe]   ' + functionName + ' -> api #' + apiId);
                slot++;
            }
            descriptor += 20;
        }
    }

    const entryPoint = imageBase + entryPointRva;

    // diretorio de exports (DataDirectory[0]): nome -> endereco absoluto
    const exports = {};
    if (exportTableRva) {
        const dir = rvaToFileOffset(exportTableRva);
        const numberOfNames = readUint32(dir + 24);
        const addressOfFunctions = readUint32(dir + 28);
        const addressOfNames = readUint32(dir + 32);
        const addressOfOrdinals = readUint32(dir + 36);
        for (let i = 0; i < numberOfNames; i++) {
            const nameRva = readUint32(rvaToFileOffset(addressOfNames) + i * 4);
            const ordinal = readUint16(rvaToFileOffset(addressOfOrdinals) + i * 2);
            const functionRva = readUint32(rvaToFileOffset(addressOfFunctions) +
                                           ordinal * 4);
            exports[readCString(rvaToFileOffset(nameRva))] = imageBase + functionRva;
        }
    }

    os.debugPrint('[pe] entry point = 0x' + entryPoint.toString(16));
    return { entryPoint, imageBase, sizeOfImage, exports };
}

module.exports = { load, registerResolver };
