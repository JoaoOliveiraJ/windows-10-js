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

// area de imagens carregadas em runtime (drivers de terceiros etc.) —
// ver ntos/mm/memory-map.js; o build usa os slots baixos, o loader os altos
const RUNTIME_IMAGE_BASE = 0x1900000;
const RUNTIME_IMAGE_SLOT = 0x80000;          // 512KB por imagem
const RUNTIME_IMAGE_TOP  = 0x1F00000;
let nextRuntimeImageBase = RUNTIME_IMAGE_BASE;

// resolvedores de DLL registrados: quem importa o que (kernel32, ntoskrnl...)
const resolvers = [];

function registerResolver(dllPattern, lookupFunction, lookupOrdinal) {
    resolvers.push({ dllPattern, lookupFunction, lookupOrdinal });
}

function resolveImport(dllName, functionName) {
    for (const r of resolvers) {
        if (r.dllPattern.test(dllName)) return r.lookupFunction(dllName, functionName);
    }
    return -1;
}

// import por ORDINAL (ILT com bit alto): o resolvedor mapeia ordinal -> id
function resolveOrdinal(dllName, ordinal) {
    for (const r of resolvers) {
        if (r.dllPattern.test(dllName))
            return r.lookupOrdinal ? r.lookupOrdinal(dllName, ordinal) : -1;
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
    const preferredBase  = readUint32(optionalHeader + 24) +
                           readUint32(optionalHeader + 28) * 0x100000000;
    const sizeOfImage    = readUint32(optionalHeader + 56);
    const sizeOfHeaders  = readUint32(optionalHeader + 60);
    const exportTableRva = readUint32(optionalHeader + 112);     // DataDirectory[0]
    const importTableRva = readUint32(optionalHeader + 112 + 8); // DataDirectory[1]
    const relocTableRva  = readUint32(optionalHeader + 112 + 5 * 8); // [5] .reloc
    const relocTableSize = readUint32(optionalHeader + 112 + 5 * 8 + 4);
    const sectionTable   = optionalHeader + optionalHeaderSize;

    // base real de carga: a preferida se utilizavel (identidade < 4GB e fora
    // do heap); senao, um slot da area de runtime e RELOCACAO via .reloc
    let imageBase = preferredBase;
    let relocationDelta = 0;
    if (preferredBase >= 0x100000000 || preferredBase + sizeOfImage > 0x2000000) {
        if (nextRuntimeImageBase + sizeOfImage > RUNTIME_IMAGE_TOP)
            throw new Error('area de imagens de runtime cheia');
        imageBase = nextRuntimeImageBase;
        nextRuntimeImageBase += Math.ceil(sizeOfImage / RUNTIME_IMAGE_SLOT) *
                                RUNTIME_IMAGE_SLOT;
        relocationDelta = imageBase - preferredBase;
    }

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

    // RELOCACAO real (IMAGE_BASE_RELOCATION / DIR64): aplica o delta quando
    // a imagem nao carregou na base preferida (como o loader do Windows)
    if (relocationDelta !== 0) {
        if (!relocTableRva) throw new Error('imagem sem .reloc e base ocupada');
        let relocCount = 0;
        const relocEnd = rvaToFileOffset(relocTableRva) + relocTableSize;
        let blockOffset = rvaToFileOffset(relocTableRva);
        while (blockOffset < relocEnd) {
            const pageRva = readUint32(blockOffset);
            const blockSize = readUint32(blockOffset + 4);
            if (blockSize === 0) break;
            const entryCount = (blockSize - 8) / 2;
            for (let e = 0; e < entryCount; e++) {
                const entry = readUint16(blockOffset + 8 + e * 2);
                const entryType = entry >> 12;
                const entryOffset = entry & 0xFFF;
                const targetAddress = imageBase + pageRva + entryOffset;
                if (entryType === 10) {          // IMAGE_REL_BASED_DIR64
                    const value = os.readPhysical32(targetAddress) +
                        os.readPhysical32(targetAddress + 4) * 0x100000000;
                    const relocated = value + relocationDelta;
                    os.writePhysical32(targetAddress, relocated >>> 0);
                    os.writePhysical32(targetAddress + 4,
                        Math.floor(relocated / 0x100000000) >>> 0);
                    relocCount++;
                } else if (entryType === 2) {    // HIGHLOW (32-bit)
                    const value = os.readPhysical32(targetAddress) >>> 0;
                    os.writePhysical32(targetAddress,
                        (value + relocationDelta) >>> 0);
                    relocCount++;
                } else if (entryType === 1) {    // HIGH (high 16 de um valor 32)
                    const value = os.readPhysical16(targetAddress);
                    const fullValue = (value << 16) + relocationDelta;
                    os.writePhysical16(targetAddress,
                        (Math.floor(fullValue / 0x10000)) & 0xFFFF);
                    relocCount++;
                } else if (entryType !== 0) {    // 0 = ABSOLUTE (padding)
                    throw new Error('reloc tipo ' + entryType + ' nao suportado');
                }
            }
            blockOffset += blockSize;
        }
        os.debugPrint('[pe] relocada p/ 0x' + imageBase.toString(16) +
                      ' (' + relocCount + ' fixups)');
    }

    // GS security cookie: a CRT do driver (__security_init_cookie) faz
    // fail-fast se o cookie for 0 ou o default do link (0x2B992DDFA232) —
    // o Windows inicializa com entropia no load, via campo SecurityCookie do
    // IMAGE_LOAD_CONFIG_DIRECTORY (DataDirectory[10], offset 0x58 no x64).
    // O campo guarda a VA do cookie — ja relocada acima. Semeamos la (com
    // fallback p/ varredura do default quando nao ha load config).
    //
    // A semente e' inteira e exata (doubles perderiam bits): 48 bits (o topo
    // de 16 bits fica zero — o __security_check_cookie exige), nunca 0 nem o
    // default.
    {
        const GS_DEFAULT_LOW  = 0x2DDFA232;
        const GS_DEFAULT_HIGH = 0x2B99;
        const tsc = os.rdtsc();
        let seedLow  = (tsc >>> 0) ^ (imageBase >>> 0);
        let seedHigh = (Math.floor(tsc / 0x100000000) ^ 0x9E37) & 0xFFFF;
        if ((seedLow | seedHigh) === 0) seedLow = 0x2545F491;
        if (seedHigh === GS_DEFAULT_HIGH && seedLow === GS_DEFAULT_LOW)
            seedLow ^= 0x10F3;

        let cookieAddress = 0;
        const loadConfigRva  = readUint32(optionalHeader + 112 + 10 * 8);
        const loadConfigSize = readUint32(optionalHeader + 112 + 10 * 8 + 4);
        if (loadConfigRva && loadConfigSize >= 0x60) {
            // SecurityCookie (u64) em +0x58: VA de execucao do cookie
            const field = imageBase + loadConfigRva + 0x58;
            cookieAddress = os.readPhysical32(field) +
                            os.readPhysical32(field + 4) * 0x100000000;
            if (cookieAddress < imageBase ||
                cookieAddress >= imageBase + sizeOfImage)
                cookieAddress = 0;   // campo invalido: cai p/ varredura
        }
        if (!cookieAddress) {
            for (let scan = imageBase; scan < imageBase + sizeOfImage; scan += 4) {
                if ((os.readPhysical32(scan) >>> 0) !== GS_DEFAULT_LOW) continue;
                if ((os.readPhysical32(scan + 4) >>> 0) !== GS_DEFAULT_HIGH) continue;
                cookieAddress = scan;
                break;
            }
        }
        if (cookieAddress) {
            os.writePhysical32(cookieAddress, seedLow >>> 0);
            os.writePhysical32(cookieAddress + 4, seedHigh >>> 0);
            // DEBUG TEMP: watchpoint de hardware no cookie (pega o escritor
            // de corrupcao intermitente — ver lifecycle.js)
            os.armDataWriteWatchpoint(cookieAddress >>> 0);
            os.debugPrint('[pe] security cookie semeado em 0x' +
                          cookieAddress.toString(16));
        }
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
                let apiId;
                let functionLabel;
                if (hi & 0x80000000) {
                    // import por ordinal: bits baixos = numero do ordinal
                    const ordinal = lo & 0xFFFF;
                    apiId = resolveOrdinal(dllName, ordinal);
                    if (apiId < 0)
                        throw new Error('API nao suportada: ' + dllName +
                                        ' ordinal #' + ordinal);
                    functionLabel = 'ordinal #' + ordinal;
                } else {
                    const functionName = readCString(rvaToFileOffset(lo) + 2); // pula o hint
                    apiId = resolveImport(dllName, functionName);
                    if (apiId < 0) throw new Error('API nao suportada: ' + dllName + '!' + functionName);
                    functionLabel = functionName;
                }
                if (apiId >= os.getWin32ThunkCount())
                    throw new Error('apiId ' + apiId + ' alem da tabela de trampolins (' +
                                    os.getWin32ThunkCount() + ') — aumente MAX_WIN32 no asm');
                const thunkAddress = thunkTableBase + apiId * STUB_SIZE;
                const iatAddress = imageBase + iatRva + slot * 8;
                os.writePhysical32(iatAddress, thunkAddress >>> 0);
                os.writePhysical32(iatAddress + 4, Math.floor(thunkAddress / 0x100000000));
                os.debugPrint('[pe]   ' + functionLabel + ' -> api #' + apiId);
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
