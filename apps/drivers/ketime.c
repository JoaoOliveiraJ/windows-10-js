/*
 * ketime.c - driver demo do grupo "Ke tempo" do jsOS.
 * Usa KeQuerySystemTime / KeQueryTickCount; o \Device\KeTime devolve
 * "ke-time-ok" se os relogios responderam valores sensiveis.
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
__declspec(dllimport) void KeQuerySystemTime(ULONG64 *outTime);
__declspec(dllimport) void KeQueryTickCount(ULONG64 *outTicks);

static int allPassed = 0;

static NTSTATUS timeRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "ke-time-ok" : "ke-time-fail";
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
    ULONG64 systemTime = 0, ticksFirst = 0, ticksSecond = 0;
    UNICODE_STRING deviceName;
    ULONG64 devicePtr = 0;
    (void)registryPath;

    DbgPrint("ketime.sys: DriverEntry\r\n");

    KeQuerySystemTime(&systemTime);
    KeQueryTickCount(&ticksFirst);
    KeQueryTickCount(&ticksSecond);

    /* tempo de sistema plausivel (ano 2024+) e tick monotonico */
    allPassed = (systemTime > 130000000000000000ULL) &&
                (ticksSecond >= ticksFirst);

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&timeRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\KeTime");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "ketime.sys: relogios ok\r\n" : "ketime.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
