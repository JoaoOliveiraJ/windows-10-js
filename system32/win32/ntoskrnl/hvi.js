// ===========================================================================
// jsOS - system32/win32/ntoskrnl/hvi.js: exports Hvi* (a interface de
// hypervisor do kernel do NT) — leitura REAL das leaves CPUID de hypervisor.
// Sob WHPX/QEMU o bit de hypervisor esta ligado e o vendor e' "Microsoft Hv"
// (WHPX) ou "TCG"/"KVM" (QEMU puro) — respondemos o que o hardware diz.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

// os.cpuid(leaf) -> [eax, ebx, ecx, edx] (primitiva do hal, mesma do clock.js)
function cpuid(leaf) { return os.cpuid(leaf); }

// vendor da interface de hypervisor (CPUID.0x40000000 EBX/ECX/EDX, 12 chars)
function hypervisorVendor() {
    const leaf0 = cpuid(0x40000000);
    let text = '';
    for (const registerValue of [leaf0[1], leaf0[2], leaf0[3]])
        for (let byteIndex = 0; byteIndex < 4; byteIndex++)
            text += String.fromCharCode((registerValue >>> (byteIndex * 8)) & 0xFF);
    return text;
}

module.exports = {
    names: [
        'HviIsAnyHypervisorPresent',          // -> BOOLEAN (CPUID.1:ECX.31)
        'HviIsHypervisorMicrosoftCompatible', // -> BOOLEAN (vendor "Microsoft Hv")
        'HviGetHypervisorFeatures',           // (outFeaturesPtr)
    ],
    handlers: [
        // HviIsAnyHypervisorPresent() -> bit 31 de CPUID.1:ECX (hardware real)
        () => (cpuid(1)[2] & 0x80000000) ? 1 : 0,
        // HviIsHypervisorMicrosoftCompatible() -> vendor "Microsoft Hv"
        () => hypervisorVendor() === 'Microsoft Hv' ? 1 : 0,
        // HviGetHypervisorFeatures(outPtr): as feature flags da interface hv
        // (CPUID.0x40000003 EAX/EBX = features/privileges, 0x40000004 EAX =
        // recomendacoes de uso) — zeros quando a interface nao existe
        (featuresPointer) => {
            const maxLeaf = cpuid(0x40000000)[0] >>> 0;
            let featuresEax = 0, privilegesEbx = 0, recommendationsEax = 0;
            if (maxLeaf >= 0x40000003) {
                const leaf3 = cpuid(0x40000003);
                featuresEax = leaf3[0] >>> 0;
                privilegesEbx = leaf3[1] >>> 0;
            }
            if (maxLeaf >= 0x40000004)
                recommendationsEax = cpuid(0x40000004)[0] >>> 0;
            GuestMemory.writeGuest32(featuresPointer, featuresEax);
            GuestMemory.writeGuest32(featuresPointer + 4, privilegesEbx);
            GuestMemory.writeGuest32(featuresPointer + 8, recommendationsEax);
            return 0;
        },
    ],
};
