// ===========================================================================
// jsOS - system32/ntos/cm/hw-description.js: a arvore de descricao de
// hardware (\Registry\Machine\Hardware\Description) e a API legada
// IoQueryDeviceDescription — como o HAL do NT povoa e o ntoskrnl consulta.
//
// A arvore: \System\{Adaptador}\{Barramento}\{Controlador}\{N}\{Periferico}\{N}
// cada nivel com 3 valores (Identifier, Configuration Data, Component
// Information). IoQueryDeviceDescription anda a arvore casando
// Bus/Controller/PeripheralType e chama o CALLOUT do driver (11 args, ABI
// real do ntddk.h) com os KEY_VALUE_FULL_INFORMATION de cada nivel.
// ===========================================================================

const Registry = require('ntos/cm/registry');
const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

const HW_DESC = '\\Registry\\Machine\\Hardware\\Description\\System';

// CONFIGURATION_TYPE (ntddk.h) — os valores que o i8042prt consulta
const CONFIGURATION_TYPE = {
    OtherController: 22,
    OtherPeripheral: 32,
};
// nome da chave de cada tipo (como o HAL nomeia na arvore)
const CONTROLLER_TYPE_NAME = { 22: 'OtherController' };
const PERIPHERAL_TYPE_NAME = { 32: 'OtherPeripheral' };

// INTERFACE_TYPE (bus) -> nome do adaptador na arvore (como o NT)
const BUS_TYPE_ADAPTER = { 1: 'MultifunctionAdapter' };   // Isa

// ---- KEY_VALUE_FULL_INFORMATION (winreg.h) ------------------------------
// { u32 TitleIndex, u32 Type, u32 DataOffset, u32 DataLength, wchar Name[] }
// o dado binario vem DEPOIS do nome (alinhado), DataOffset aponta p/ ele
function buildKfvi(valueType, valueName, dataBytes) {
    const nameChars = valueName.length + 1;             // com o NUL
    const dataOffset = 0x10 + nameChars * 2;
    const aligned = (dataOffset + 3) & ~3;
    const buffer = GuestMemory.guestAllocBytes(aligned + dataBytes.length);
    GuestMemory.writeGuest32(buffer + 0, 0);                 // TitleIndex
    GuestMemory.writeGuest32(buffer + 4, valueType >>> 0);   // Type
    GuestMemory.writeGuest32(buffer + 8, aligned);           // DataOffset
    GuestMemory.writeGuest32(buffer + 0xC, dataBytes.length);// DataLength
    for (let i = 0; i < valueName.length; i++)
        GuestMemory.writeGuest16(buffer + 0x10 + i * 2, valueName.charCodeAt(i));
    for (let i = 0; i < dataBytes.length; i++)
        os.writePhysical8(buffer + aligned + i, dataBytes[i] & 0xFF);
    return buffer;
}

// array de 3 ponteiros (Identifier, ConfigurationData, ComponentInformation)
function buildInfoArray(identifierKfvi, configKfvi, componentKfvi) {
    const array = GuestMemory.guestAllocBytes(3 * 8);
    GuestMemory.writeGuest64(array, identifierKfvi);
    GuestMemory.writeGuest64(array + 8, configKfvi);
    GuestMemory.writeGuest64(array + 0x10, componentKfvi);
    return array;
}

// ---- leitura de um valor da arvore como (type, bytes) ---------------------
function readValueBytes(nodeHandle, valueName) {
    const entry = Registry.getValue(nodeHandle, valueName);
    if (!entry) return null;
    return { type: entry.type, bytes: entry.data };
}

// ---- semeamento da arvore (como o HAL faz no boot) ------------------------
function asciiBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
    bytes.push(0);
    return bytes;
}

function seedEntry(relativePath, identifier, configBytes, componentBytes) {
    const handle = Registry.openOrCreate(HW_DESC + relativePath);
    Registry.setValue(handle, 'Identifier', 1, asciiBytes(identifier));
    if (configBytes)
        Registry.setValue(handle, 'Configuration Data', 3, configBytes);
    Registry.setValue(handle, 'Component Information', 3,
                      componentBytes || [0, 0, 0, 0]);
    Registry.closeHandle(handle);
}

// 8042: o HAL do PC (i440fx) descreve o controlador PS/2 como
// OtherController/OtherPeripheral no barramento ISA (MultifunctionAdapter)
function seedHardwareDescription() {
    // CM_FULL_RESOURCE_DESCRIPTOR: Isa, bus 0, partial list c/ 3 recursos
    // (porta 0x60, porta 0x64, IRQ1) — layout de 4 bytes (stride 0x14)
    const FULL = [];
    const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
    const u16 = u32;
    const partial = (type, a, b, c) => {
        // Type u8, Share u8, Flags u16, uniao 16B em +4
        const d = [type, 0, 0, 0];
        if (type === 2) {          // Port: Start u64 + Length u32
            for (let i = 0; i < 8; i++) d.push((a >>> (8 * i)) & 0xFF);
            d.push(...u32(b));
        } else if (type === 3) {   // Interrupt: Level u32, Vector u32, Affinity u64
            d.push(...u32(a), ...u32(b));
            for (let i = 0; i < 8; i++) d.push((c >>> (8 * i)) & 0xFF);
        }
        while (d.length < 0x14) d.push(0);
        return d;
    };
    const descriptors = [
        ...partial(2, 0x60, 1, 0),
        ...partial(2, 0x64, 1, 0),
        ...partial(3, 1, 0x21, 0xFF),
    ];
    const configBytes = [
        ...u32(1),                 // CM_RESOURCE_LIST.Count = 1 FULL
        ...u32(1),                 // InterfaceType = Isa
        ...u32(0),                 // BusNumber = 0
        ...u16(1), ...u16(1),      // Version, Revision
        ...u32(3),                 // Count de partial descriptors
        ...descriptors,
    ];
    // MultifunctionAdapter (o barramento ISA)
    seedEntry('\\MultifunctionAdapter', 'ISA Bus', null);
    seedEntry('\\MultifunctionAdapter\\0', 'ISA Bus', null);
    seedEntry('\\MultifunctionAdapter\\0\\OtherController',
              '8042 Controller', null);
    seedEntry('\\MultifunctionAdapter\\0\\OtherController\\0',
              '8042 Controller', configBytes.slice());
    seedEntry('\\MultifunctionAdapter\\0\\OtherController\\0\\OtherPeripheral',
              '8042 Peripheral', null);
    seedEntry('\\MultifunctionAdapter\\0\\OtherController\\0\\OtherPeripheral\\0',
              'AT-Compatible 8042 Keyboard', configBytes.slice());
    os.debugPrint('[hwdesc] arvore de hardware descrita (8042 ISA) semeada');
}

// ---- a consulta (IoQueryDeviceDescription) --------------------------------

// monta o array KFVI de um nivel da arvore (Identifier/Config/Component)
function infoArrayOf(nodePath) {
    const nodeHandle = Registry.open(nodePath);
    if (!nodeHandle) return 0;
    const identifier = readValueBytes(nodeHandle, 'Identifier') ||
                       { type: 1, bytes: asciiBytes('Unknown') };
    const config = readValueBytes(nodeHandle, 'Configuration Data');
    const component = readValueBytes(nodeHandle, 'Component Information') ||
                      { type: 3, bytes: [0, 0, 0, 0] };
    const identifierKfvi = buildKfvi(identifier.type, 'Identifier', identifier.bytes);
    const configKfvi = config
        ? buildKfvi(config.type, 'Configuration Data', config.bytes)
        : buildKfvi(3, 'Configuration Data', []);
    const componentKfvi = buildKfvi(component.type, 'Component Information',
                                    component.bytes);
    const array = buildInfoArray(identifierKfvi, configKfvi, componentKfvi);
    Registry.closeHandle(nodeHandle);
    return array;
}

// escreve uma UNICODE_STRING no convidado; devolve o endereco da struct
function makeUnicodeString(text) {
    const textBuffer = GuestMemory.guestAllocBytes(text.length * 2 + 2);
    GuestStrings.writeGuestWideString(textBuffer, text);
    const structPointer = GuestMemory.guestAllocBytes(16);
    GuestMemory.writeGuest16(structPointer, text.length * 2);
    GuestMemory.writeGuest16(structPointer + 2, text.length * 2 + 2);
    GuestMemory.writeGuest64(structPointer + 8, textBuffer);
    return structPointer;
}

// IoQueryDeviceDescription(busTypePtr, busNumberPtr, controllerTypePtr,
//   controllerNumberPtr, peripheralTypePtr, peripheralNumberPtr,
//   calloutRoutine, contextPointer)
function queryDeviceDescription(busTypePointer, busNumberPointer,
                                controllerTypePointer, controllerNumberPointer,
                                peripheralTypePointer, peripheralNumberPointer,
                                calloutRoutine, contextPointer) {
    const readEnum = pointer => pointer ? GuestMemory.readGuest32(pointer) : null;
    const controllerType = readEnum(controllerTypePointer);
    const peripheralType = readEnum(peripheralTypePointer);
    const controllerName = CONTROLLER_TYPE_NAME[controllerType];
    const peripheralName = PERIPHERAL_TYPE_NAME[peripheralType];
    if (!controllerName || !peripheralName || !calloutRoutine)
        return 0xC0000034 | 0;   // STATUS_OBJECT_NAME_NOT_FOUND

    // anda a arvore: \System\{Adaptador}\{Bus}\{Controller}\{Ctrl}\{Perif}\{N}
    for (const adapterName of Object.values(BUS_TYPE_ADAPTER) ) {
        for (let busNumber = 0; busNumber < 4; busNumber++) {
            const controllerPath = HW_DESC + '\\' + adapterName + '\\' +
                                   busNumber + '\\' + controllerName;
            for (let controllerNumber = 0; controllerNumber < 4; controllerNumber++) {
                const peripheralPath = controllerPath + '\\' + controllerNumber +
                                       '\\' + peripheralName;
                for (let peripheralNumber = 0; peripheralNumber < 4; peripheralNumber++) {
                    const leafPath = peripheralPath + '\\' + peripheralNumber;
                    const leafHandle = Registry.open(leafPath);
                    if (!leafHandle) continue;
                    Registry.closeHandle(leafHandle);
                    // achou: monta os arrays e chama o callout (11 args da
                    // ABI do ntddk.h — os 7 ultimos passam pela PILHA)
                    const busInfo = infoArrayOf(HW_DESC + '\\' + adapterName);
                    const controllerInfo = infoArrayOf(
                        controllerPath + '\\' + controllerNumber);
                    const peripheralInfo = infoArrayOf(leafPath);
                    const pathString = makeUnicodeString(leafPath);
                    const busType = adapterName === 'MultifunctionAdapter' ? 1 : 0;
                    const argArray = GuestMemory.guestAllocBytes(11 * 8);
                    const args = [contextPointer, pathString, busType, busNumber,
                                  busInfo, controllerType, controllerNumber,
                                  controllerInfo, peripheralType, peripheralNumber,
                                  peripheralInfo];
                    for (let argIndex = 0; argIndex < args.length; argIndex++)
                        GuestMemory.writeGuest64(argArray + argIndex * 8,
                                                 args[argIndex]);
                    const result = os.execMsAbiN(calloutRoutine, argArray, 11);
                    if ((result | 0) === 0) return 0;   // STATUS_SUCCESS
                }
            }
        }
    }
    return 0xC0000034 | 0;   // nao achou
}

module.exports = { seedHardwareDescription, queryDeviceDescription,
                   CONFIGURATION_TYPE };
