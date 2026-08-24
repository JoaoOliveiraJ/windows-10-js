// ===========================================================================
// jsOS - system32/ntos/io/device-resources.js: registro dos CM_RESOURCE_LIST
// entregues a cada PDO (native device pointer -> lista), para APIs que
// derivam configuracao do hardware do device — o IoConnectInterruptEx no
// modo LINE_BASED acha a IRQ do device AQUI (o que o NT resolve pelo
// devnode + arbitros de recurso).
// ===========================================================================

const GuestMemory = require('win32/guest-memory');

const resourcesByDevicePointer = new Map();   // pdoPtr -> cmResourceListPtr
// quantos descritores de interrupcao da lista ja foram consumidos por
// conexoes LINE_BASED nesse PDO (o ataport conecta um por canal IDE:
// primeiro IRQ14, depois IRQ15 — a ordem declarada pelo bus)
const consumedInterruptsByDevice = new Map();

function registerDeviceResources(devicePointer, resourceListPointer) {
    resourcesByDevicePointer.set(devicePointer >>> 0,
                                 resourceListPointer >>> 0);
}

function lookupResourceList(devicePointer) {
    return resourcesByDevicePointer.get(devicePointer >>> 0) || 0;
}

// layout do CM_PARTIAL_RESOURCE_DESCRIPTOR (wdm.h): Type u8 @0, Share u8 @1,
// Flags u16 @2; Interrupt { Level u32 @4, Vector u32 @8, Affinity u32 @12 }
const PARTIAL_DESCRIPTOR_SIZE = 20;
const CM_RESOURCE_TYPE_INTERRUPT = 2;

// consome o proximo descritor INTERRUPT da lista do PDO; devolve
// { level, vector, flags } ou null quando nao ha mais
function consumeNextInterrupt(devicePointer) {
    const resourceListPointer = lookupResourceList(devicePointer);
    if (!resourceListPointer) return null;
    const descriptorCount = GuestMemory.readGuest32(resourceListPointer + 16);
    const alreadyConsumed =
        consumedInterruptsByDevice.get(devicePointer >>> 0) || 0;
    let interruptIndex = 0;
    for (let index = 0; index < descriptorCount; index++) {
        const descriptor = resourceListPointer + 20 +
                           index * PARTIAL_DESCRIPTOR_SIZE;
        if (GuestMemory.readGuest8(descriptor) !== CM_RESOURCE_TYPE_INTERRUPT)
            continue;
        if (interruptIndex++ !== alreadyConsumed) continue;
        consumedInterruptsByDevice.set(devicePointer >>> 0, alreadyConsumed + 1);
        return {
            level: GuestMemory.readGuest32(descriptor + 4),
            vector: GuestMemory.readGuest32(descriptor + 8),
            flags: GuestMemory.readGuest16(descriptor + 2),
        };
    }
    return null;
}

module.exports = { registerDeviceResources, lookupResourceList,
                   consumeNextInterrupt };
