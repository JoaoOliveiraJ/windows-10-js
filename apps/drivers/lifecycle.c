/*
 * lifecycle.c - driver demo do grupo "ciclo de vida" do jsOS.
 * Registra DriverUnload (DRIVER_OBJECT+8 na nossa ABI) e no unload remove o
 * link simbolico com IoDeleteSymbolicLink. O selftest carrega, verifica,
 * descarrega e confere que tudo sumiu do namespace.
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

#define STATUS_SUCCESS 0

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) NTSTATUS IoCreateSymbolicLink(UNICODE_STRING *link, UNICODE_STRING *target);
__declspec(dllimport) NTSTATUS IoDeleteSymbolicLink(UNICODE_STRING *link);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);

static UNICODE_STRING linkName;   /* BSS: persiste entre Entry e Unload */

static void lifecycleUnload(ULONG64 driverObjectPtr) {
    (void)driverObjectPtr;
    DbgPrint("lifecycle.sys: DriverUnload rodando\r\n");
    IoDeleteSymbolicLink(&linkName);
}

NTSTATUS DriverEntry(ULONG64 driverObjectPtr, ULONG64 registryPath) {
    JSOS_DRIVER_OBJECT *driverObject = (JSOS_DRIVER_OBJECT *)(ULONG64)driverObjectPtr;
    UNICODE_STRING deviceName;
    ULONG64 devicePtr = 0;
    (void)registryPath;

    DbgPrint("lifecycle.sys: DriverEntry\r\n");

    RtlInitUnicodeString(&deviceName, L"\\Device\\LifeCycle");
    RtlInitUnicodeString(&linkName, L"\\DosDevices\\LifeCycle");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);
    IoCreateSymbolicLink(&linkName, &deviceName);

    /* registra a rotina de unload (nossa ABI: DRIVER_OBJECT+8) */
    driverObject->UnloadRoutine = (ULONG64)(ULONG64)&lifecycleUnload;

    DbgPrint("lifecycle.sys: \\Device\\LifeCycle + link criados\r\n");
    return STATUS_SUCCESS;
}
