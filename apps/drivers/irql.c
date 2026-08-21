/*
 * irql.c - driver demo do grupo "IRQL + spinlock" do jsOS.
 * Testa KeGetCurrentIrql / KeRaiseIrql / KeLowerIrql / KeInitializeSpinLock /
 * KeAcquireSpinLockRaiseToDpc / KeReleaseSpinLock. \Device\Irql devolve
 * "irql-ok" se o ciclo subiu para DISPATCH e voltou a PASSIVE.
 */

typedef unsigned long long ULONG64;
typedef unsigned int ULONG;
typedef unsigned short USHORT;
typedef long NTSTATUS;
typedef USHORT wchar_t;
typedef unsigned char UCHAR;

typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } UNICODE_STRING;
typedef struct { ULONG64 DispatchTable; ULONG64 UnloadRoutine; } JSOS_DRIVER_OBJECT;
typedef struct {
    ULONG MajorFunction;
    ULONG Status;
    ULONG64 Buffer;
    ULONG64 BufferLength;
    ULONG64 ResultLength;
} JSOS_IRP;

#define IRP_MJ_READ 3
#define STATUS_SUCCESS 0
#define PASSIVE_LEVEL 0
#define DISPATCH_LEVEL 2

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) ULONG KeGetCurrentIrql(void);
__declspec(dllimport) void KeRaiseIrql(ULONG newIrql, ULONG *outOldIrql);
__declspec(dllimport) void KeLowerIrql(ULONG newIrql);
__declspec(dllimport) void KeInitializeSpinLock(ULONG *lock);
__declspec(dllimport) void KeAcquireSpinLockRaiseToDpc(ULONG *lock, ULONG *outOldIrql);
__declspec(dllimport) void KeReleaseSpinLock(ULONG *lock, ULONG oldIrql);

static ULONG testLock;
static int allPassed = 0;

static NTSTATUS irqlRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "irql-ok" : "irql-fail";
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
    ULONG oldIrql = 0xFFFFFFFF;
    int ok = 1;
    (void)registryPath;

    DbgPrint("irql.sys: DriverEntry\r\n");

    KeInitializeSpinLock(&testLock);
    if (testLock != 0) ok = 0;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) ok = 0;

    KeAcquireSpinLockRaiseToDpc(&testLock, &oldIrql);
    if (oldIrql != PASSIVE_LEVEL) ok = 0;         /* gravou o IRQL antigo */
    if (KeGetCurrentIrql() != DISPATCH_LEVEL) ok = 0;   /* subiu p/ DISPATCH */
    if (testLock != 1) ok = 0;                    /* lock adquirido */

    KeReleaseSpinLock(&testLock, oldIrql);
    if (testLock != 0) ok = 0;                    /* lock liberado */
    if (KeGetCurrentIrql() != PASSIVE_LEVEL) ok = 0;    /* voltou a PASSIVE */

    allPassed = ok;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&irqlRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\Irql");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "irql.sys: IRQL+spinlock ok\r\n" : "irql.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
