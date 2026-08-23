// ===========================================================================
// jsOS - system32/drivers/bus/motherboard.js: bus driver dos dispositivos
// FIXOS da placa-mae (o que o ACPI enumeraria no PC: PNP0303 = controlador
// de teclado PS/2 8042, PNP0F13 = mouse PS/2).
//
// Cria os PDOs com os recursos de hardware REAIS (portas 0x60/0x64, IRQ1/
// IRQ12) e responde as queries PnP que o driver funcional (i8042prt.sys)
// desce para o PDO — o papel do acpi.sys aqui.
// ===========================================================================

const ObjectManager = require('ntos/ob/object-manager');
const IoManager = require('ntos/io/io-manager');
const GuestMemory = require('win32/guest-memory');
const NtAbi = require('win32/nt-abi');

const IRP = NtAbi.IRP;
const SL = NtAbi.IO_STACK_LOCATION;

// dispositivos fixos desta maquina (QEMU pc i440fx: 8042 sempre presente)
const MOTHERBOARD_DEVICES = [
    {
        name: 'I8042Kbd',
        instanceId: '00',
        deviceId: 'PNP0303',           // controlador de teclado PS/2
        hardwareIds: ['PNP0303'],
        resources: [
            { type: NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR.TYPE_PORT,
              start: 0x60, length: 1 },                    // data do 8042
            { type: NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR.TYPE_PORT,
              start: 0x64, length: 1 },                    // comando/status
            { type: NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR.TYPE_INTERRUPT,
              level: 1, vector: 0x21, affinity: 0xFF },    // IRQ1 (PIC)
        ],
    },
    {
        name: 'I8042Mou',
        instanceId: '01',
        deviceId: 'PNP0F13',           // mouse PS/2
        hardwareIds: ['PNP0F13'],
        resources: [
            { type: NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR.TYPE_PORT,
              start: 0x60, length: 1 },
            { type: NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR.TYPE_PORT,
              start: 0x64, length: 1 },
            { type: NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR.TYPE_INTERRUPT,
              level: 12, vector: 0x2C, affinity: 0xFF },   // IRQ12 (PIC slave)
        ],
    },
];

const createdPdos = [];   // { descriptor, node, resourceListPointer }

// CM_RESOURCE_LIST real (1 FULL descriptor, InterfaceType Isa) com os
// recursos do dispositivo — layout com alinhamento de 4 (medido no binario
// do i8042prt: stride 0x14, uniao em +4)
function buildResourceList(resources) {
    const RL = NtAbi.CM_RESOURCE_LIST;
    const FULL = NtAbi.CM_FULL_RESOURCE_DESCRIPTOR;
    const LIST = NtAbi.CM_PARTIAL_RESOURCE_LIST;
    const PART = NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR;
    const size = RL.FULL_DESCRIPTOR + FULL.PARTIAL_LIST + LIST.DESCRIPTORS +
                 PART.SIZE * resources.length;
    const address = GuestMemory.guestAllocBytes(size);
    GuestMemory.writeGuest32(address + RL.COUNT, 1);
    const full = address + RL.FULL_DESCRIPTOR;
    GuestMemory.writeGuest32(full + FULL.INTERFACE_TYPE, 1);   // Isa
    GuestMemory.writeGuest32(full + FULL.BUS_NUMBER, 0);
    const list = full + FULL.PARTIAL_LIST;
    GuestMemory.writeGuest16(list + LIST.VERSION, 1);
    GuestMemory.writeGuest16(list + LIST.REVISION, 1);
    GuestMemory.writeGuest32(list + LIST.COUNT, resources.length);
    let cursor = list + LIST.DESCRIPTORS;
    for (const resource of resources) {
        GuestMemory.writeGuest8(cursor + PART.TYPE, resource.type);
        GuestMemory.writeGuest8(cursor + PART.SHARE_DISPOSITION, 0);  // exclusive
        GuestMemory.writeGuest16(cursor + PART.FLAGS, 0);             // Latched
        if (resource.type === PART.TYPE_INTERRUPT) {
            GuestMemory.writeGuest32(cursor + PART.INTERRUPT_LEVEL,
                                     resource.level >>> 0);
            GuestMemory.writeGuest32(cursor + PART.INTERRUPT_VECTOR,
                                     resource.vector >>> 0);
            GuestMemory.writeGuest64(cursor + PART.INTERRUPT_AFFINITY,
                                     resource.affinity >>> 0);
        } else {
            GuestMemory.writeGuest64(cursor + PART.PORT_START, resource.start);
            GuestMemory.writeGuest32(cursor + PART.PORT_LENGTH,
                                     resource.length >>> 0);
        }
        cursor += PART.SIZE;
    }
    return address;
}

// string wide (pool zerado do convidado => ja termina em NUL)
function writeWideString(text) {
    const buffer = GuestMemory.guestAllocBytes((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++)
        GuestMemory.writeGuest16(buffer + i * 2, text.charCodeAt(i));
    return buffer;
}

// MULTI_SZ wide (duplo NUL no fim — o pool zerado garante os dois)
function writeMultiSz(strings) {
    let totalChars = 1;
    for (const text of strings) totalChars += text.length + 1;
    const buffer = GuestMemory.guestAllocBytes(totalChars * 2);
    let cursor = buffer;
    for (const text of strings) {
        for (let i = 0; i < text.length; i++)
            GuestMemory.writeGuest16(cursor, text.charCodeAt(i));
        cursor += 2 * (text.length + 1);
    }
    return buffer;
}

// DEVICE_CAPABILITIES (0x40 bytes, wdm.h x64): preenche o buffer fornecido
// pelo chamador (contrato do QUERY_CAPABILITIES) — 8042: D0 em tudo, sem wake
function fillDeviceCapabilities(address) {
    for (let i = 0; i < 0x40; i += 4) GuestMemory.writeGuest32(address + i, 0);
    GuestMemory.writeGuest16(address + 0, 0x40);      // Size
    GuestMemory.writeGuest16(address + 2, 1);         // Version
    GuestMemory.writeGuest32(address + 4, 0);         // sem DeviceD1/D2...
    GuestMemory.writeGuest32(address + 8, 0xFFFFFFFF);// Address: nao se aplica
    GuestMemory.writeGuest32(address + 0xC, 0xFFFFFFFF); // UINumber idem
    for (let i = 0; i < 7; i++)
        GuestMemory.writeGuest32(address + 0x10 + i * 4, 1);  // DeviceState=D0
    GuestMemory.writeGuest32(address + 0x2C, 0);      // SystemWake: unspecified
    GuestMemory.writeGuest32(address + 0x30, 0);      // DeviceWake: unspecified
}

// IO_RESOURCE_REQUIREMENTS_LIST (wdm.h, alinhamento 4 como o CM_* acima):
// 1 lista alternativa com 1 opcao por recurso — o que o 8042 precisa
function buildResourceRequirements(resources) {
    const PART = NtAbi.CM_PARTIAL_RESOURCE_DESCRIPTOR;
    // IO_RESOURCE_DESCRIPTOR = Option/Type/Share/Spare(4) + Flags/Spare2(4) +
    // uniao(0x10) = 0x18 por descritor; listas: header 0x20 + list 0x08
    const descriptorSize = 0x18;
    const size = 0x20 + 0x08 + descriptorSize * resources.length;
    const address = GuestMemory.guestAllocBytes(size);
    GuestMemory.writeGuest32(address + 0x00, size);        // ListSize
    GuestMemory.writeGuest32(address + 0x04, 1);           // InterfaceType Isa
    GuestMemory.writeGuest32(address + 0x08, 0);           // BusNumber
    GuestMemory.writeGuest32(address + 0x1C, 1);           // AlternativeLists
    const list = address + 0x20;
    GuestMemory.writeGuest16(list + 0, 1);                 // Version
    GuestMemory.writeGuest16(list + 2, 1);                 // Revision
    GuestMemory.writeGuest32(list + 4, resources.length);  // Count
    let cursor = list + 8;
    for (const resource of resources) {
        GuestMemory.writeGuest8(cursor + 0, 0);            // Option: required
        GuestMemory.writeGuest8(cursor + 1, resource.type);
        GuestMemory.writeGuest8(cursor + 2, 0);            // ShareDisposition
        GuestMemory.writeGuest16(cursor + 4, 0);           // Flags
        if (resource.type === PART.TYPE_INTERRUPT) {
            GuestMemory.writeGuest32(cursor + 8, resource.level >>> 0);
            GuestMemory.writeGuest32(cursor + 0xC, resource.vector >>> 0);
            GuestMemory.writeGuest32(cursor + 0x10, resource.affinity >>> 0);
        } else {
            GuestMemory.writeGuest64(cursor + 8, resource.start);
            GuestMemory.writeGuest32(cursor + 0x10, resource.length >>> 0);
        }
        cursor += descriptorSize;
    }
    return address;
}

// responde as queries PnP descidas ao PDO pelo driver funcional (estilo
// acpi.sys): QUERY_ID / QUERY_CAPABILITIES / QUERY_RESOURCES / START / REMOVE
function answerPnpIrp(devicePointer, irpPointer) {
    const entry = createdPdos.find(pdo =>
        pdo.node.data.nativeDevicePointer === devicePointer);
    if (!entry) return null;   // nao e' PDO nosso
    const stackPointer = GuestMemory.readGuest32(irpPointer +
                                                 IRP.CURRENT_STACK_LOCATION);
    const minor = os.readPhysical8(stackPointer + SL.MINOR);
    let information = 0;
    let status = 0;
    if (minor === IoManager.IRP_MN.START_DEVICE ||
        minor === IoManager.IRP_MN.REMOVE_DEVICE) {
        information = 0;
    } else if (minor === IoManager.IRP_MN.QUERY_ID) {
        const idType = GuestMemory.readGuest32(stackPointer + 0x08);
        if (idType === 0) information = writeWideString(entry.descriptor.deviceId);
        else if (idType === 1)
            information = writeMultiSz(entry.descriptor.hardwareIds);
        else if (idType === 2)
            information = writeMultiSz(['PNP0303']);
        else if (idType === 3)
            information = writeWideString(entry.descriptor.instanceId);
        else status = 0xC00000BB | 0;   // STATUS_NOT_SUPPORTED
    } else if (minor === IoManager.IRP_MN.QUERY_CAPABILITIES) {
        // o buffer DEVICE_CAPABILITIES vem pronto em Parameters (0x08) —
        // o bus PREENCHE ele (contrato real do PnP), nao devolve ponteiro
        const capsPointer = GuestMemory.readGuest32(stackPointer + 0x08);
        fillDeviceCapabilities(capsPointer);
        information = 0;
    } else if (minor === IoManager.IRP_MN.QUERY_RESOURCES) {
        information = entry.resourceListPointer;
    } else if (minor === IoManager.IRP_MN.QUERY_RESOURCE_REQUIREMENTS) {
        information = buildResourceRequirements(entry.descriptor.resources);
    } else if (minor === 0x0D) {   // FILTER_RESOURCE_REQUIREMENTS: sem alteracao
        information = 0;
    } else {
        // o bus driver SEMPRE completa (deixar pendente trava o forward+wait
        // do driver funcional) — NOT_SUPPORTED e' uma resposta completa
        status = 0xC00000BB | 0;
    }
    GuestMemory.writeGuest32(irpPointer + IRP.IO_STATUS, status >>> 0);
    GuestMemory.writeGuest64(irpPointer + IRP.IO_STATUS_INFORMATION,
                             information);
    IoManager.iofCompleteRequest(irpPointer);
    return status;
}

function enumerate() {
    for (const descriptor of MOTHERBOARD_DEVICES) {
        // PDO: DEVICE_OBJECT nativo SEM driver (quem responde e' o bus)
        const devicePointer = GuestMemory.guestAllocBytes(
            NtAbi.DEVICE_OBJECT.STRUCT_SIZE);
        GuestMemory.writeGuest16(devicePointer + NtAbi.DEVICE_OBJECT.TYPE,
                                 NtAbi.DEVICE_OBJECT.IO_TYPE);
        GuestMemory.writeGuest16(devicePointer + NtAbi.DEVICE_OBJECT.SIZE,
                                 NtAbi.DEVICE_OBJECT.STRUCT_SIZE);
        GuestMemory.writeGuest32(devicePointer + NtAbi.DEVICE_OBJECT.DRIVER_OBJECT,
                                 0);
        GuestMemory.writeGuest32(devicePointer + NtAbi.DEVICE_OBJECT.REFERENCE_COUNT,
                                 1);
        GuestMemory.writeGuest8(devicePointer + NtAbi.DEVICE_OBJECT.STACK_SIZE, 1);
        const resourceListPointer = buildResourceList(descriptor.resources);
        const node = ObjectManager.createObject('\\Device', descriptor.name,
            'Device', { nativeDevicePointer: devicePointer,
                        pdo: true, busDriver: 'motherboard',
                        hardwareIds: descriptor.hardwareIds,
                        resources: resourceListPointer });
        createdPdos.push({ descriptor, node, resourceListPointer });
        os.debugPrint('[mb] PDO \\Device\\' + descriptor.name + ' criado (' +
                      descriptor.deviceId + ', IRQ 0x' +
                      descriptor.resources.map(r => r.vector || r.start.toString(16))
                          .join('/') + ')');
    }
    IoManager.registerPdoNativeAnswerer(answerPnpIrp);
    return createdPdos;
}

module.exports = { enumerate, MOTHERBOARD_DEVICES };
