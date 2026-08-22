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
    // DRIVER_EXTENSION (wdm.h)
    DRIVER_EXTENSION: {
        DRIVER_OBJECT: 0x00,
        ADD_DEVICE: 0x08,        // PDRIVER_ADD_DEVICE
        COUNT: 0x10,
        SERVICE_KEY_NAME: 0x18,  // UNICODE_STRING
        SIZE: 0x40,
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
        CANCEL: 0x44,
        CANCEL_ROUTINE: 0x68,    // PDRIVER_CANCEL (device, irp)
        USER_IOSB: 0x48,         // Tail antes? nao: campo direto (wdm.h x64)
        USER_EVENT: 0x50,
        USER_BUFFER: 0x70,
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
        IOCTL_IN_LENGTH: 0x10,   // InputBufferLength (POINTER_ALIGNMENT: 8-align)
        IOCTL_CODE: 0x18,        // IoControlCode (idem) — medido no wdm.h x64
        IOCTL_TYPE3_BUFFER: 0x20,
        POWER_SYSTEM_CONTEXT: 0x08,  // Parameters.Power.SystemContext
        POWER_TYPE: 0x10,            // Parameters.Power.Type (POINTER_ALIGNMENT)
        POWER_STATE: 0x18,           // Parameters.Power.State (POWER_STATE)
        POWER_SHUTDOWN_TYPE: 0x20,   // Parameters.Power.ShutdownType
        PNP_ALLOCATED_RESOURCES: 0x08,           // StartDevice.AllocatedResources
        PNP_ALLOCATED_RESOURCES_TRANSLATED: 0x10,
        DEVICE_OBJECT: 0x28,
        FILE_OBJECT: 0x30,
        COMPLETION_ROUTINE: 0x38,    // IoSetCompletionRoutine (macro no WDK)
        CONTEXT: 0x40,               // contexto da completion routine
        FLAGS: 2,
        CONTROL: 3,                  // SL_INVOKE_* bits
        SIZE: 0x48,
    },
    // bits do campo Control da IO_STACK_LOCATION (wdm.h)
    SL_INVOKE_ON_CANCEL: 0x20,
    SL_INVOKE_ON_SUCCESS: 0x40,
    SL_INVOKE_ON_ERROR: 0x80,
    // NTSTATUS usados no modelo de conclusao (wdm.h/ntstatus.h)
    STATUS: {
        SUCCESS: 0,
        PENDING: 0x103,
        MORE_PROCESSING_REQUIRED: 0xC0000467 - 0x100000000,  // i32 sinal
        INVALID_PARAMETER: 0xC000000D - 0x100000000,
        NOT_SUPPORTED: 0xC00000BB - 0x100000000,
    },
    // FILE_OBJECT (wdm.h x64)
    FILE_OBJECT: {
        TYPE: 0,                 // IO_TYPE_FILE = 5
        SIZE: 2,
        DEVICE_OBJECT: 0x08,
        STRUCT_SIZE: 0xB8,
    },
    // IO_STATUS_BLOCK (wdm.h)
    IO_STATUS_BLOCK: { STATUS: 0, INFORMATION: 8, SIZE: 0x10 },
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
    // DISPATCHER_HEADER (wdm.h x64) — base de KEVENT/KMUTEX/KTIMER
    DISPATCHER_HEADER: {
        TYPE: 0,
        SIGNAL_STATE: 4,         // i32
        WAIT_LIST_HEAD: 8,
        SIZE: 0x18,
        TYPE_EVENT_NOTIFICATION: 0,
        TYPE_EVENT_SYNCHRONIZATION: 1,
        TYPE_MUTANT: 2,
        MUTEX_OWNER: 0x18,       // KMUTEX: OwnerThread (nosso slot)
    },
    // KEVENT (wdm.h x64) / KMUTEX
    KEVENT: { SIZE: 0x18 },
    KMUTEX: { SIZE: 0x38 },
    // FAST_MUTEX (wdm.h x64, sizeof 0x38 — layout oficial)
    FAST_MUTEX: {
        COUNT: 0x00,             // LONG: 1 = livre, 0 = com dono
        OWNER: 0x08,             // PVOID thread dona (handle, no nosso caso)
        CONTENTION: 0x10,        // ULONG: vezes que houve contencao real
        EVENT: 0x18,             // KEVENT embutido (espera em contencao)
        OLD_IRQL: 0x30,          // ULONG (APC_LEVEL no acquire)
        SIZE: 0x38,
    },
    // KDPC (wdm.h x64, sizeof 0x40 — layout oficial)
    KDPC: {
        TYPE: 0x00,              // DpcObject = 19 (0x13)
        IMPORTANCE: 0x04,
        DPC_LIST_ENTRY: 0x10,    // SingleListEntry (ligacao na fila do NT)
        ROUTINE: 0x18,           // DeferredRoutine
        CONTEXT: 0x20,           // DeferredContext
        SYSARG1: 0x28,           // SystemArgument1
        SYSARG2: 0x30,           // SystemArgument2
        DPC_DATA: 0x38,          // nao-nulo enquanto enfileirado (como o NT)
        SIZE: 0x40,
        TYPE_DPC: 0x13,
        IMPORTANCE_MEDIUM: 1,
    },
    // KTIMER (wdm.h x64): DISPATCHER_HEADER(0x18) + DueTime + lista + Dpc
    KTIMER: {
        TYPE: 0,                 // TimerNotificationObject=8 / Sync=9
        SIGNAL_STATE: 4,         // dispatcher header SignalState (i32)
        DUE_TIME: 0x18,
        TIMER_LIST_ENTRY: 0x20,
        DPC: 0x30,
        PERIOD: 0x38,
        SIZE: 0x40,
        TIMER_NOTIFICATION: 8,
        TIMER_SYNCHRONIZATION: 9,
    },
    // IO_WORKITEM (interno do NT; ReactOS documenta: WORK_QUEUE_ITEM =
    // LIST_ENTRY + Function, depois Context/DeviceObject/Type)
    IO_WORKITEM: {
        LIST_FLINK: 0x00,
        LIST_BLINK: 0x08,
        FUNCTION: 0x10,          // WORK_QUEUE_ITEM.Function (a routine)
        CONTEXT: 0x18,
        DEVICE_OBJECT: 0x20,
        TYPE: 0x28,              // CriticalWorkQueue=0 Delayed=1 HyperCritical=2
        QUEUED: 0x2C,            // ligacao interna da fila do jsOS
        SIZE: 0x30,
    },
    // KEY_VALUE_PARTIAL_INFORMATION (wdm.h)
    KEY_VALUE_PARTIAL: { TITLE_INDEX: 0, TYPE: 4, DATA_LENGTH: 8, DATA: 12 },
    // MDL (wdm.h x64; o array de PFNs comeca em 0x30)
    MDL: {
        NEXT: 0x00,
        SIZE: 0x08,
        MDL_FLAGS: 0x0A,
        PROCESS: 0x10,
        MAPPED_SYSTEM_VA: 0x18,
        START_VA: 0x20,
        BYTE_COUNT: 0x28,
        BYTE_OFFSET: 0x2C,
        PFN_ARRAY: 0x30,
        FLAG_MAPPED_TO_SYSTEM_VA: 0x0001,
        FLAG_PAGES_LOCKED: 0x0002,
        FLAG_SOURCE_NONPAGED: 0x0004,
    },
    // PAGED_LOOKASIDE_LIST (objeto do kernel; campos internos do jsOS)
    LOOKASIDE_LIST: {
        DEPTH: 0x10,             // u16 max de blocos cacheados
        BLOCK_SIZE: 0x18,        // u32
        TAG: 0x1C,               // u32
        ALLOC_COUNT: 0x20,       // u32
        FREE_COUNT: 0x24,        // u32
        FREE_HEAD: 0x28,         // u32 (cadeia: next no 1o dword do bloco)
        SIZE: 0x80,              // sizeof real no NT x64
    },
    // EPROCESS/KPROCESS/KTHREAD — offsets CONFIRMADOS por disassembly do
    // ntoskrnl.exe do Windows 10 22H2 desta maquina (RE real):
    //   IoGetCurrentProcess: mov rax,gs:[0x188] (Prcb.CurrentThread);
    //                        mov rax,[rax+0xB8] (KTHREAD.ApcState.Process)
    //   PsGetProcessId:      mov rax,[rcx+0x440] (EPROCESS.UniqueProcessId)
    //   PsGetCurrentProcessId:  [thread+0x478] (KTHREAD.Cid.UniqueProcess)
    //   PsGetCurrentThreadId:   [thread+0x480] (KTHREAD.Cid.UniqueThread)
    //   KeGetCurrentIrql:    mov rax,cr8 (IRQL mora no TPR/CR8 no NT)
    KTHREAD: {
        APC_STATE: 0x98,         // KAPC_STATE embutido
        APC_STATE_PROCESS: 0xB8, // ApcState.Process (0x98 + 0x20) — RE
        CID: 0x478,              // CLIENT_ID
        CID_UNIQUE_PROCESS: 0x478,
        CID_UNIQUE_THREAD: 0x480,
        SIZE: 0x4C0,
    },
    EPROCESS: {
        // KPROCESS embutido comeca em 0x00 (DISPATCHER_HEADER etc.)
        DIRECTORY_TABLE_BASE: 0x28,   // KPROCESS.DTB (CR3 do processo)
        UNIQUE_PROCESS_ID: 0x440,     // RE confirmado
        ACTIVE_PROCESS_LINKS: 0x448,  // RE confirmado (LIST_ENTRY global)
        CREATE_TIME: 0x458,
        TOKEN: 0x4B8,                 // RE confirmado
        PEB: 0x550,                   // RE (lista de offsets publica)
        IMAGE_FILE_NAME: 0x5A8,       // RE (15 bytes)
        ACTIVE_THREADS: 0x5F0,        // Win10 x64 (comunidade/RE)
        EXIT_TIME: 0x608,
        SIZE: 0xA00,
        TYPE_PROCESS: 3,              // KOBJECTS ProcessObject
    },
};
