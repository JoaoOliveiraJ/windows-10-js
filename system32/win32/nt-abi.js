// ===========================================================================
// jsOS - system32/win32/nt-abi.js: layouts REAIS das structs do kernel NT
// (x64), extraidos do WDK 10.0.26100 (km/wdm.h). Fonte unica de verdade da
// ABI convidado<->kernel; os drivers compilados com o ntddk.h real dependem
// destes offsets.
// ===========================================================================

module.exports = {
    // DRIVER_OBJECT (wdm.h): MajorFunction DEVE ser o ultimo campo (extensivel)
    DRIVER_OBJECT: {
        TYPE: 0,                 // IO_TYPE_DRIVER = 4
        SIZE: 2,
        DEVICE_OBJECT: 0x08,
        FLAGS: 0x10,
        DRIVER_START: 0x18,
        DRIVER_SIZE: 0x20,
        DRIVER_SECTION: 0x28,
        DRIVER_EXTENSION: 0x30,
        DRIVER_NAME: 0x38,       // UNICODE_STRING (16B)
        HARDWARE_DATABASE: 0x48,
        FAST_IO_DISPATCH: 0x50,
        DRIVER_INIT: 0x58,
        DRIVER_START_IO: 0x60,
        DRIVER_UNLOAD: 0x68,
        MAJOR_FUNCTION: 0x70,    // [29]
        STRUCT_SIZE: 0x70 + 29 * 8,
        IO_TYPE: 4,
    },
    // DEVICE_OBJECT (wdm.h x64, sizeof = 0x150)
    DEVICE_OBJECT: {
        TYPE: 0,                 // IO_TYPE_DEVICE = 3
        SIZE: 2,
        REFERENCE_COUNT: 4,
        DRIVER_OBJECT: 0x08,
        NEXT_DEVICE: 0x10,       // lista ligada na cabeca do driver (como o NT)
        ATTACHED_DEVICE: 0x18,   // topo da pilha de devices (IoAttachDevice)
        CURRENT_IRP: 0x20,
        TIMER: 0x28,
        FLAGS: 0x30,             // DO_BUFFERED_IO etc.
        CHARACTERISTICS: 0x34,   // FILE_REMOVABLE_MEDIA etc.
        VPB: 0x38,
        DEVICE_EXTENSION: 0x40,  // logo apos o DEVICE_OBJECT (IoCreateDevice)
        DEVICE_TYPE: 0x48,
        STACK_SIZE: 0x4C,
        STRUCT_SIZE: 0x150,
        IO_TYPE: 3,
    },
    // IRP (wdm.h) + IO_STACK_LOCATION
    IRP: {
        TYPE: 0,                 // IO_TYPE_IRP = 6
        SIZE_FIELD: 2,
        MDL_ADDRESS: 0x08,
        FLAGS: 0x10,
        SYSTEM_BUFFER: 0x18,     // AssociatedIrp.SystemBuffer
        IO_STATUS: 0x30,         // Status i32 @0x30 / Information u64 @0x38
        IO_STATUS_INFORMATION: 0x38,
        STACK_COUNT: 0x42,
        CURRENT_LOCATION: 0x43,
        CURRENT_STACK_LOCATION: 0xB8,   // Tail.Overlay.CurrentStackLocation
        STRUCT_SIZE: 0xD0,
        STACK_LOCATION_SIZE: 0x48,
        IO_TYPE: 6,
    },
    IO_STACK_LOCATION: {
        MAJOR: 0,
        MINOR: 1,
        READ_LENGTH: 0x08,       // Parameters.Read.Length (Write idem)
        READ_OFFSET: 0x10,       // Parameters.Read.ByteOffset
        IOCTL_OUT_LENGTH: 0x08,  // DeviceIoControl.OutputBufferLength
        IOCTL_IN_LENGTH: 0x0C,
        IOCTL_CODE: 0x10,
        POWER_SYSTEM_CONTEXT: 0x08,  // Parameters.Power.SystemContext
        POWER_TYPE: 0x10,            // Parameters.Power.Type (POINTER_ALIGNMENT)
        POWER_STATE: 0x18,           // Parameters.Power.State (POWER_STATE)
        POWER_SHUTDOWN_TYPE: 0x20,   // Parameters.Power.ShutdownType
        DEVICE_OBJECT: 0x28,
        FILE_OBJECT: 0x30,
        SIZE: 0x48,
    },
    // POWER_STATE_TYPE (wdm.h)
    POWER_STATE_TYPE: { SYSTEM_POWER_STATE: 0, DEVICE_POWER_STATE: 1 },
    // DEVICE_POWER_STATE (wdm.h)
    DEVICE_POWER_STATE: { UNSPECIFIED: 0, D0: 1, D1: 2, D2: 3, D3: 4 },
    // OBJECT_ATTRIBUTES (wdm.h)
    OBJECT_ATTRIBUTES: {
        LENGTH: 0,
        ROOT_DIRECTORY: 0x08,
        OBJECT_NAME: 0x10,       // UNICODE_STRING*
        ATTRIBUTES: 0x18,
        SIZE: 0x30,
    },
    // UNICODE_STRING / ANSI_STRING (wdm.h)
    UNICODE_STRING: { LENGTH: 0, MAXIMUM_LENGTH: 2, BUFFER: 8, SIZE: 0x10 },
    // KDPC (nossa ABI simplificada; o KDPC real tem filas internas do NT)
    KDPC: { ROUTINE: 0, CONTEXT: 8, QUEUED: 16, SIZE: 24 },
    // IO_WORKITEM (nossa ABI simplificada)
    IO_WORKITEM: { DEVICE_OBJECT: 0, ROUTINE: 8, CONTEXT: 16, QUEUED: 24, SIZE: 32 },
    // KEY_VALUE_PARTIAL_INFORMATION (wdm.h)
    KEY_VALUE_PARTIAL: { TITLE_INDEX: 0, TYPE: 4, DATA_LENGTH: 8, DATA: 12 },
};
