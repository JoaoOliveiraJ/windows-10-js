/*
 * echo.c - driver de demonstracao do jsOS no formato .sys do Windows
 * (PE nativo, DriverEntry, dispatch de IRP). Compilado no build com
 * zig cc -target x86_64-windows-gnu -subsystem native.
 *
 * Cria \Device\Echo (+ link \DosDevices\Echo). IRP_MJ_WRITE guarda o texto,
 * IRP_MJ_READ devolve o ultimo texto escrito.
 */

typedef unsigned long long ULONG64;
typedef unsigned int ULONG;
typedef unsigned short USHORT;
typedef long NTSTATUS;
typedef USHORT wchar_t;   /* sem headers libc: WCHAR = UTF-16 */

/* structs do convidado (ABI documentada em system32/win32/ntoskrnl.js) */
typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } UNICODE_STRING;
typedef struct { ULONG64 DispatchTable; ULONG64 DeviceList; } JSOS_DRIVER_OBJECT;
typedef struct { ULONG64 DriverObject; ULONG64 Reserved; } JSOS_DEVICE_OBJECT;
typedef struct {
    ULONG MajorFunction;
    ULONG Status;
    ULONG64 Buffer;
    ULONG64 BufferLength;
    ULONG64 ResultLength;
} JSOS_IRP;

#define IRP_MJ_READ  3
#define IRP_MJ_WRITE 4
#define STATUS_SUCCESS 0

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) NTSTATUS IoCreateSymbolicLink(UNICODE_STRING *link, UNICODE_STRING *target);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);

/* ultimo texto escrito (persistente na imagem do driver) */
static char lastText[256];
static ULONG lastLength;

static NTSTATUS echoRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    char *buffer = (char *)(ULONG64)irp->Buffer;
    ULONG n = irp->BufferLength < lastLength ? irp->BufferLength : lastLength;
    ULONG i;
    (void)devicePtr;
    for (i = 0; i < n; i++) buffer[i] = lastText[i];
    irp->ResultLength = n;
    irp->Status = STATUS_SUCCESS;
    return STATUS_SUCCESS;
}

static NTSTATUS echoWrite(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    char *buffer = (char *)(ULONG64)irp->Buffer;
    ULONG n = irp->BufferLength > 255 ? 255 : irp->BufferLength;
    ULONG i;
    (void)devicePtr;
    for (i = 0; i < n; i++) lastText[i] = buffer[i];
    lastLength = n;
    irp->ResultLength = n;
    irp->Status = STATUS_SUCCESS;
    return STATUS_SUCCESS;
}

NTSTATUS DriverEntry(ULONG64 driverObjectPtr, ULONG64 registryPath) {
    JSOS_DRIVER_OBJECT *driverObject = (JSOS_DRIVER_OBJECT *)(ULONG64)driverObjectPtr;
    ULONG64 *dispatch = (ULONG64 *)(ULONG64)driverObject->DispatchTable;
    UNICODE_STRING deviceName, linkName;
    ULONG64 devicePtr = 0;
    (void)registryPath;

    DbgPrint("echo.sys: DriverEntry rodando nativo no jsOS\r\n");

    dispatch[IRP_MJ_READ]  = (ULONG64)(ULONG64)&echoRead;
    dispatch[IRP_MJ_WRITE] = (ULONG64)(ULONG64)&echoWrite;

    RtlInitUnicodeString(&deviceName, L"\\Device\\Echo");
    RtlInitUnicodeString(&linkName, L"\\DosDevices\\Echo");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);
    IoCreateSymbolicLink(&linkName, &deviceName);

    DbgPrint("echo.sys: \\Device\\Echo criado\r\n");
    return STATUS_SUCCESS;
}
