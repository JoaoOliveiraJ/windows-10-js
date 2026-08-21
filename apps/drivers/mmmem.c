/*
 * mmmem.c - driver demo do grupo "Mm memoria" do jsOS.
 * Usa MmAllocateNonCachedMemory / MmFreeNonCachedMemory; o \Device\MmMem
 * devolve "mm-mem-ok" se a memoria alocada gravou/leu um padrao correto.
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

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) ULONG64 MmAllocateNonCachedMemory(ULONG size);
__declspec(dllimport) void MmFreeNonCachedMemory(ULONG64 pointer, ULONG size);

static int allPassed = 0;

static NTSTATUS memoryRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "mm-mem-ok" : "mm-mem-fail";
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

    DbgPrint("mmmem.sys: DriverEntry\r\n");

    /* aloca 8KB, grava padrao 0x5A, confere a leitura, libera */
    block = MmAllocateNonCachedMemory(8192);
    if (block) {
        unsigned char *bytes = (unsigned char *)(ULONG64)block;
        for (i = 0; i < 8192; i++) bytes[i] = 0x5A;
        for (i = 0; i < 8192; i++) if (bytes[i] != 0x5A) { ok = 0; break; }
        MmFreeNonCachedMemory(block, 8192);
    } else {
        ok = 0;
    }
    allPassed = ok;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&memoryRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\MmMem");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "mmmem.sys: memoria ok\r\n" : "mmmem.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
