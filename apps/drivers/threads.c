/*
 * threads.c - driver demo do grupo "DPC + work items + threads de kernel".
 * No DriverEntry: enfileira uma DPC, enfileira um work item e cria uma
 * thread de kernel. Quando os tres rodarem, \Device\Threads devolve
 * "threads-ok".
 */

typedef unsigned long long ULONG64;
typedef unsigned int ULONG;
typedef unsigned short USHORT;
typedef long NTSTATUS;
typedef USHORT wchar_t;

typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } UNICODE_STRING;
typedef struct { ULONG64 DispatchTable; ULONG64 UnloadRoutine; } JSOS_DRIVER_OBJECT;
typedef struct {
    ULONG MajorFunction;
    ULONG Status;
    ULONG64 Buffer;
    ULONG64 BufferLength;
    ULONG64 ResultLength;
    ULONG MinorFunction;
} JSOS_IRP;
typedef struct { ULONG64 Routine; ULONG64 Context; ULONG64 Queued; } JSOS_KDPC;

#define IRP_MJ_READ 3
#define STATUS_SUCCESS 0

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) void KeInitializeDpc(ULONG64 dpc, ULONG64 routine, ULONG64 context);
__declspec(dllimport) ULONG KeInsertQueueDpc(ULONG64 dpc, ULONG64 sysArg1, ULONG64 sysArg2);
__declspec(dllimport) ULONG64 IoAllocateWorkItem(ULONG64 devicePtr);
__declspec(dllimport) void IoQueueWorkItem(ULONG64 item, ULONG64 routine, ULONG queueType,
                                           ULONG64 context);
__declspec(dllimport) void IoFreeWorkItem(ULONG64 item);
__declspec(dllimport) NTSTATUS PsCreateSystemThread(ULONG64 *outHandle, ULONG access,
                                                    ULONG64 objAttrs, ULONG64 processHandle,
                                                    ULONG64 clientId, ULONG64 startRoutine,
                                                    ULONG64 context);
__declspec(dllimport) NTSTATUS PsTerminateSystemThread(NTSTATUS status);

static int dpcRan, workItemRan, threadRan;
static JSOS_KDPC myDpc;
static ULONG64 myWorkItem;

static void myDpcRoutine(ULONG64 dpcPtr, ULONG64 context, ULONG64 sysArg1, ULONG64 sysArg2) {
    (void)dpcPtr; (void)context; (void)sysArg1; (void)sysArg2;
    dpcRan = 1;
    DbgPrint("threads.sys: DPC rodou (DISPATCH_LEVEL)\r\n");
}

static void myWorkRoutine(ULONG64 devicePtr, ULONG64 context) {
    (void)devicePtr; (void)context;
    workItemRan = 1;
    DbgPrint("threads.sys: work item rodou (PASSIVE)\r\n");
    IoFreeWorkItem(myWorkItem);
}

static void myThreadRoutine(ULONG64 context) {
    (void)context;
    threadRan = 1;
    DbgPrint("threads.sys: thread de kernel rodou\r\n");
    PsTerminateSystemThread(STATUS_SUCCESS);
}

static NTSTATUS threadsRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = (dpcRan && workItemRan && threadRan) ? "threads-ok"
                                                               : "threads-fail";
    char *buffer = (char *)(ULONG64)irp->Buffer;
    ULONG length = 0, i;
    (void)devicePtr;
    while (message[length]) length++;
    if (length > irp->BufferLength) length = irp->BufferLength;
    for (i = 0; i < length; i++) buffer[i] = message[i];
    irp->ResultLength = length;
    irp->Status = STATUS_SUCCESS;
    return STATUS_SUCCESS;
}

NTSTATUS DriverEntry(ULONG64 driverObjectPtr, ULONG64 registryPath) {
    JSOS_DRIVER_OBJECT *driverObject = (JSOS_DRIVER_OBJECT *)(ULONG64)driverObjectPtr;
    ULONG64 *dispatch = (ULONG64 *)(ULONG64)driverObject->DispatchTable;
    UNICODE_STRING deviceName;
    ULONG64 devicePtr = 0, threadHandle = 0;
    (void)registryPath;

    DbgPrint("threads.sys: DriverEntry\r\n");

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&threadsRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\Threads");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    /* DPC enfileirada (roda quando o kernel drenar a fila) */
    KeInitializeDpc((ULONG64)(ULONG64)&myDpc, (ULONG64)(ULONG64)&myDpcRoutine, 0);
    KeInsertQueueDpc((ULONG64)(ULONG64)&myDpc, 0, 0);

    /* work item enfileirado (roda na thread de trabalho do sistema) */
    myWorkItem = IoAllocateWorkItem(devicePtr);
    if (myWorkItem) IoQueueWorkItem(myWorkItem, (ULONG64)(ULONG64)&myWorkRoutine, 0, 0);

    /* thread de kernel (processo no escalonador cooperativo) */
    PsCreateSystemThread(&threadHandle, 0, 0, 0, 0,
                         (ULONG64)(ULONG64)&myThreadRoutine, 0);

    DbgPrint("threads.sys: DPC + work item + thread enfileirados\r\n");
    return STATUS_SUCCESS;
}
