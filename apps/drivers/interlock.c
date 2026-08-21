/*
 * interlock.c - driver demo do grupo "Interlocked*" do jsOS.
 * Testa Increment/Decrement/Exchange/CompareExchange no DriverEntry;
 * \Device\Interlock devolve "interlock-ok" se todas bateram.
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
} JSOS_IRP;

#define IRP_MJ_READ 3
#define STATUS_SUCCESS 0

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) ULONG InterlockedIncrement(ULONG *target);
__declspec(dllimport) ULONG InterlockedDecrement(ULONG *target);
__declspec(dllimport) ULONG InterlockedExchange(ULONG *target, ULONG value);
__declspec(dllimport) ULONG InterlockedCompareExchange(ULONG *target, ULONG exchange,
                                                       ULONG comparand);

static ULONG counter;
static int allPassed = 0;

static NTSTATUS interlockRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "interlock-ok" : "interlock-fail";
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
    int ok = 1;
    (void)registryPath;

    DbgPrint("interlock.sys: DriverEntry\r\n");

    counter = 41;
    if (InterlockedIncrement(&counter) != 42) ok = 0;         /* 41 -> 42 */
    if (InterlockedDecrement(&counter) != 41) ok = 0;         /* 42 -> 41 */
    if (InterlockedExchange(&counter, 77) != 41) ok = 0;      /* velho 41 */
    if (counter != 77) ok = 0;
    /* compare-exchange: sucesso e falha */
    if (InterlockedCompareExchange(&counter, 99, 77) != 77) ok = 0;   /* casa: troca */
    if (counter != 99) ok = 0;
    if (InterlockedCompareExchange(&counter, 1, 77) != 99) ok = 0;    /* nao casa: nao troca */
    if (counter != 99) ok = 0;
    allPassed = ok;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&interlockRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\Interlock");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "interlock.sys: atomicas ok\r\n" : "interlock.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
