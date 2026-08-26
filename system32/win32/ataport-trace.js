// ===========================================================================
// jsOS - system32/win32/ataport-trace.js: diagnostico TEMPORARIO — intercepta
// as funcoes de porta que o atapi.sys importa do ataport.SYS. Como a IAT do
// atapi recebe o endereco nativo do ataport (nativo->nativo, invisivel ao no
// [api] e ao trace IDE do QEMU), enfiar um stub nativo que empilha a porta
// (rcx) num ring e repassa p/ a funcao real e' a unica forma de ver QUE porta
// o atapi usa no scan. Sem breakpoints sob WHPX — isto substitui o debugger.
//
// stub (x86-64, rcx = porta). Guarda a porta num ring global de 256 entradas:
//   push rax ; push rbx
//   mov rax, [ringHead]            (abs)
//   mov rbx, ringBase              (imm64)
//   mov [rbx + rax*8], rcx
//   inc rax ; and rax, 0xff
//   mov [ringHead], rax            (abs)
//   pop rbx ; pop rax
//   mov rax, realFunc ; jmp rax
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

// funcoes de porta do ataport que o atapi usa (rcx = porta IDE)
// funcoes do ataport que o atapi usa no scan (rcx = 1o arg: porta / delay us /
// contexto — registrar rcx mostra o fluxo exato apos o reset do canal)
const HOOKED_FUNCTIONS = [
    'AtaPortReadPortUchar',
    'AtaPortWritePortUchar',
    'AtaPortWritePortUlong',
    'AtaPortReadPortBufferUshort',
    'AtaPortWritePortBufferUshort',
    'AtaPortGetDeviceBase',
    'AtaPortStallExecution',
    'AtaPortQuerySystemTime',
    'AtaPortNotification',
    'AtaPortRequestCallback',
    'AtaPortGetPhysicalAddress',
    'AtaPortGetUnCachedExtension',
    'AtaPortGetScatterGatherList',
    'AtaPortBuildRequestSenseIrb',
    'AtaPortCompleteRequest',
];

const STUB_SIZE = 96;
const RING_ENTRIES = 128;

let stubPage = 0;
let recordPage = 0;   // [0]=ringHead (indice), [8..]=ring de portas (u64)

function writeBytes(address, bytes) {
    for (let i = 0; i < bytes.length; i++)
        GuestMemory.writeGuest8(address + i, bytes[i]);
}
function qword(v) {   // little-endian 64-bit
    const b = [];
    let rest = v;
    for (let i = 0; i < 8; i++) { b.push(rest % 256); rest = Math.floor(rest / 256); }
    return b;
}
function dword(v) {   // little-endian 32-bit (enderecos < 4GB)
    return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
}

// monta o stub: grava rcx em ring1 (porta) e rdx em ring2 (valor/2o arg),
// e salta p/ a funcao real
function buildStub(stubAddress, realAddress, functionIndex) {
    const ringHead = recordPage;
    const ring1Base = recordPage + 8;                  // portas (rcx)
    const ring2Base = recordPage + 8 + RING_ENTRIES * 8; // valores (rdx)
    const tag = (functionIndex + 1) * 0x1000000000000;   // (idx+1) << 48
    const code = [
        0x50,                                             // push rax
        0x53,                                             // push rbx
        0x48, 0x8B, 0x04, 0x25, ...dword(ringHead),       // mov rax, [ringHead]
        0x48, 0xBB, ...qword(ring1Base),                  // mov rbx, ring1Base
        0x48, 0x89, 0x0C, 0xC3,                           // mov [rbx+rax*8], rcx
        0x48, 0xBB, ...qword(ring2Base),                  // mov rbx, ring2Base
        0x48, 0x89, 0x14, 0xC3,                           // mov [rbx+rax*8], rdx
        0x48, 0xFF, 0xC0,                                 // inc rax
        0x48, 0x25, 0xFF, 0x00, 0x00, 0x00,               // and rax, 0xff
        0x48, 0x89, 0x04, 0x25, ...dword(ringHead),       // mov [ringHead], rax
        0x5B,                                             // pop rbx
        0x58,                                             // pop rax
        0x48, 0xB8, ...qword(realAddress),                // mov rax, realFunc
        0xFF, 0xE0,                                       // jmp rax
    ];
    writeBytes(stubAddress, code);
}

// ---- detour em funcoes do atapi (HwFindAdapter 0x1630 / HwStartIo 0x1710) ----
// Conta quantas vezes cada uma e' chamada — prova se o ataport emite comandos
// (HwStartIo) ou so' faz o setup (HwFindAdapter). 0x1630 e' o CONTROLE (sei que
// roda no setup) p/ validar que o detour funciona.
const ATAPI_FUNCS = [   // [rva, nome]
    [0x1630, 'cb0'],
    [0x16a0, 'cb1'],
    [0x1710, 'cb2'],
    [0x17a0, 'cb3'],
    [0x1940, 'cb4'],
    [0x1a50, 'cb5'],
];
let funcCounterBase = 0;
const funcCounterByName = {};

function instrumentAtapiFunction(atapiBase, rva, name, slotIndex) {
    const target = atapiBase + rva;
    const stub = GuestMemory.guestAllocPage();
    const counterAddr = funcCounterBase + slotIndex * 8;
    GuestMemory.writeGuest64(counterAddr, 0);
    // le a 1a instrucao (tamanho variavel) p/ realocar; so' suporto o prologo
    // mov [rsp+N],reg (48 89 5C/6C/74/7C 24 XX) que e' seguro realocar
    const b0 = os.readPhysical8(target);
    const b1 = os.readPhysical8(target + 1);
    const b2 = os.readPhysical8(target + 2);
    let prologueLen = 0;
    let prologue = [];
    if (b0 === 0x48 && b1 === 0x89 && (b2 & 0xC7) === 0x44) {
        prologueLen = 5;
        prologue = [b0, b1, b2, os.readPhysical8(target + 3),
                    os.readPhysical8(target + 4)];
    } else if (b0 === 0x8B && (b1 & 0xC7) === 0x81) {
        prologueLen = 6;   // mov eax/..., [rcx+disp32]  (8B xx)
        for (let i = 0; i < 6; i++) prologue.push(os.readPhysical8(target + i));
    } else if (b0 === 0x53 || (b0 === 0x40 && b1 === 0x53)) {
        // push rbx (53 ou 40 53) seguido de sub rsp,imm8 (48 83 EC XX):
        // realoca os 6 bytes (seguro — sem referencias relativas)
        if (os.readPhysical8(target + 2) === 0x48 &&
            os.readPhysical8(target + 3) === 0x83 &&
            os.readPhysical8(target + 4) === 0xEC) {
            prologueLen = 6;
            for (let i = 0; i < 6; i++)
                prologue.push(os.readPhysical8(target + i));
        } else {
            os.debugPrint('[ataport-trace] ' + name + ': prologo push nao suportado, pulo');
            return;
        }
    } else {
        os.debugPrint('[ataport-trace] ' + name + ': prologo desconhecido (' +
                      b0.toString(16) + '), pulo');
        return;
    }
    // stub: inc [counter]; <prologo realocado>; jmp target+prologueLen
    const stubLen = 8 + prologueLen + 5;
    const jmpBackRel = (target + prologueLen) - (stub + stubLen);
    writeBytes(stub, [
        0x48, 0xFF, 0x04, 0x25, ...dword(counterAddr),   // inc qword [counter]
        ...prologue,
        0xE9, ...dword(jmpBackRel),
    ]);
    // o salto E9 (5 bytes) tem rel32 relativo ao FIM dele (target+5); os NOPs
    // so' preenchem ate prologueLen (o stub salta de volta p/ target+prologueLen)
    const detourRel = stub - (target + 5);
    const detourBytes = [0xE9, ...dword(detourRel)];
    while (detourBytes.length < prologueLen) detourBytes.push(0x90);
    writeBytes(target, detourBytes);
    funcCounterByName[name] = counterAddr;
    os.debugPrint('[ataport-trace] ' + name + ' instrumentado @ 0x' +
                  target.toString(16));
}

function instrumentAtapiCommandProcessor(atapiBase) {
    if (!recordPage) recordPage = GuestMemory.guestAllocPage();
    funcCounterBase = recordPage + 0x800;
    ATAPI_FUNCS.forEach(([rva, name], i) =>
        instrumentAtapiFunction(atapiBase, rva, name, i));
}

// chamado pelo resolver modulo-a-modulo (main.js): se a funcao e' de porta do
// ataport, devolve o stub (que registra a porta); senao, 0 (endereco real)
function hookAddressFor(dllName, functionName, realAddress) {
    if (!/^ataport\.sys$/i.test(dllName)) return 0;
    const index = HOOKED_FUNCTIONS.indexOf(functionName);
    if (index < 0) return 0;
    if (!stubPage) {
        stubPage = GuestMemory.guestAllocPage();
        recordPage = GuestMemory.guestAllocPage();
        GuestMemory.writeGuest64(recordPage, 0);   // ringHead = 0
    }
    const stubAddress = stubPage + index * STUB_SIZE;
    buildStub(stubAddress, realAddress, index);
    os.debugPrint('[ataport-trace] hook ' + functionName + ' -> real 0x' +
                  realAddress.toString(16));
    return stubAddress;
}

// despeja a sequencia de chamadas (arg rcx + arg rdx) que o atapi fez no scan
function dumpResults() {
    // contadores por funcao do atapi (HwFindAdapter/HwStartIo/...)
    for (const name of Object.keys(funcCounterByName))
        os.debugPrint('[ataport-trace] atapi!' + name + ' chamado ' +
                      GuestMemory.readGuest64(funcCounterByName[name]) + 'x');
    if (!recordPage) { os.debugPrint('[ataport-trace] sem hooks'); return; }
    const head = GuestMemory.readGuest64(recordPage);
    const ring1 = recordPage + 8;
    const ring2 = ring1 + RING_ENTRIES * 8;
    os.debugPrint('[ataport-trace] total de chamadas hook: ' + head);
    const count = Math.min(head, RING_ENTRIES);
    const parts = [];
    for (let i = 0; i < count; i++) {
        const rcx = GuestMemory.readGuest64(ring1 + i * 8);
        const rdx = GuestMemory.readGuest64(ring2 + i * 8);
        parts.push('rcx=0x' + rcx.toString(16) + ',rdx=0x' + rdx.toString(16));
    }
    os.debugPrint('[ataport-trace] fluxo: ' + parts.join(' | '));
}

module.exports = { hookAddressFor, dumpResults,
                   instrumentAtapiCommandProcessor };
