/*
 * rtlstr.c - driver demo do grupo "Rtl unicode strings" do jsOS.
 * Testa RtlInit/Compare/Copy/Equal no DriverEntry; o \Device\RtlStr
 * devolve "rtl-str-ok" se todas as operacoes passaram, senao "rtl-str-fail".
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
__declspec(dllimport) long RtlCompareUnicodeString(UNICODE_STRING *a, UNICODE_STRING *b,
                                                   ULONG caseInsensitive);
__declspec(dllimport) void RtlCopyUnicodeString(UNICODE_STRING *dest, UNICODE_STRING *src);
__declspec(dllimport) ULONG RtlEqualUnicodeString(UNICODE_STRING *a, UNICODE_STRING *b,
                                                  ULONG caseInsensitive);

static int allPassed = 0;

static NTSTATUS stringRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "rtl-str-ok" : "rtl-str-fail";
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
    UNICODE_STRING first, second, copy;
    UNICODE_STRING deviceName;
    ULONG64 devicePtr = 0;
    (void)registryPath;

    DbgPrint("rtlstr.sys: DriverEntry\r\n");

    RtlInitUnicodeString(&first, L"Windows");
    RtlInitUnicodeString(&second, L"windows");

    allPassed =
        RtlEqualUnicodeString(&first, &second, 1) &&          /* case-insensitive igual */
        !RtlEqualUnicodeString(&first, &second, 0) &&         /* case-sensitive difere */
        RtlCompareUnicodeString(&first, &second, 1) == 0;     /* compare igual */

    RtlCopyUnicodeString(&copy, &first);
    if (!RtlEqualUnicodeString(&copy, &first, 0)) allPassed = 0;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&stringRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\RtlStr");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "rtlstr.sys: testes ok\r\n" : "rtlstr.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
