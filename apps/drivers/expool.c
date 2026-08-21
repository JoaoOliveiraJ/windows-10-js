/*
 * expool.c - driver demo do grupo "Ex pool" do jsOS.
 * Usa ExAllocatePoolWithTag / ExFreePool; o \Device\ExPool devolve
 * "ex-pool-ok" se a alocacao de pool gravou/leu corretamente.
 */

typedef unsigned long long ULONG64;
typedef unsigned int ULONG;
typedef unsigned short USHORT;
typedef long NTSTATUS;
typedef USHORT wchar_t;

typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } UNICODE_STRING;
typedef struct { ULONG64 DispatchTable; ULONG64 DeviceList; } JSOS_DRIVER_OBJECT;
typedef struct {
    ULONG MajorFunction;
    ULONG Status;
    ULONG64 Buffer;
    ULONG64 BufferLength;
    ULONG64 ResultLength;
} JSOS_IRP;

#define IRP_MJ_READ 3
#define STATUS_SUCCESS 0
#define JSOS_TAG 0x534F534A   /* 'JSOS' */

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) ULONG64 ExAllocatePoolWithTag(ULONG poolType, ULONG size, ULONG tag);
__declspec(dllimport) void ExFreePool(ULONG64 pointer);
__declspec(dllimport) void IoDeleteDevice(ULONG64 devicePtr);

static int allPassed = 0;

static NTSTATUS poolRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "ex-pool-ok" : "ex-pool-fail";
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
    ULONG64 devicePtr = 0;
    ULONG64 block;
    ULONG i;
    int ok = 1;
    (void)registryPath;

    DbgPrint("expool.sys: DriverEntry\r\n");

    /* pool com tag 'JSOS': grava padrao 0xA7, confere, libera */
    block = ExAllocatePoolWithTag(0, 4096, JSOS_TAG);
    if (block) {
        unsigned char *bytes = (unsigned char *)(ULONG64)block;
        for (i = 0; i < 4096; i++) bytes[i] = 0xA7;
        for (i = 0; i < 4096; i++) if (bytes[i] != 0xA7) { ok = 0; break; }
        ExFreePool(block);
    } else {
        ok = 0;
    }
    allPassed = ok;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&poolRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\ExPool");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    /* IoDeleteDevice real: cria um device descartavel e o remove */
    {
        UNICODE_STRING trashName;
        ULONG64 trashPtr = 0;
        RtlInitUnicodeString(&trashName, L"\\Device\\ExPoolTrash");
        IoCreateDevice(driverObjectPtr, 0, &trashName, 0, 0, 0, &trashPtr);
        if (trashPtr) IoDeleteDevice(trashPtr);
    }

    DbgPrint(allPassed ? "expool.sys: pool ok\r\n" : "expool.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
