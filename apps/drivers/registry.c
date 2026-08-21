/*
 * registry.c - driver demo do grupo "Registry Zw*" do jsOS.
 * Cria \Registry\Machine\Software\jsOS, grava valor Magic="jsOS!", fecha,
 * reabre, le de volta e confere. \Device\Registry devolve "registry-ok".
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
typedef struct {
    ULONG Length;
    ULONG64 RootDirectory;
    ULONG64 ObjectName;   /* UNICODE_STRING* */
    ULONG Attributes;
    ULONG64 SecurityDescriptor;
    ULONG64 SecurityQOS;
} JSOS_OBJECT_ATTRIBUTES;

#define IRP_MJ_READ 3
#define STATUS_SUCCESS 0

__declspec(dllimport) NTSTATUS DbgPrint(const char *message);
__declspec(dllimport) NTSTATUS IoCreateDevice(ULONG64 driverObject, ULONG extensionSize,
                                              UNICODE_STRING *name, ULONG type,
                                              ULONG characteristics, ULONG exclusive,
                                              ULONG64 *outDevice);
__declspec(dllimport) void RtlInitUnicodeString(UNICODE_STRING *out, const wchar_t *str);
__declspec(dllimport) NTSTATUS ZwCreateKey(ULONG64 *outHandle, ULONG access,
                                           JSOS_OBJECT_ATTRIBUTES *attrs);
__declspec(dllimport) NTSTATUS ZwOpenKey(ULONG64 *outHandle, ULONG access,
                                         JSOS_OBJECT_ATTRIBUTES *attrs);
__declspec(dllimport) NTSTATUS ZwSetValueKey(ULONG64 handle, UNICODE_STRING *valueName,
                                             ULONG titleIndex, ULONG type,
                                             ULONG64 data, ULONG dataSize);
__declspec(dllimport) NTSTATUS ZwQueryValueKey(ULONG64 handle, UNICODE_STRING *valueName,
                                               ULONG infoClass, ULONG64 outBuffer,
                                               ULONG bufferSize, ULONG64 outLength);
__declspec(dllimport) NTSTATUS ZwClose(ULONG64 handle);

static int allPassed = 0;

static NTSTATUS registryRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "registry-ok" : "registry-fail";
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
    UNICODE_STRING deviceName, keyName, valueName;
    JSOS_OBJECT_ATTRIBUTES attrs;
    ULONG64 keyHandle = 0, readLength = 0, devicePtr = 0;
    unsigned char readBuffer[64];
    ULONG i;
    int ok = 1;
    const char expected[] = "jsOS!";
    (void)registryPath;

    DbgPrint("registry.sys: DriverEntry\r\n");

    RtlInitUnicodeString(&keyName, L"\\Registry\\Machine\\Software\\jsOS");
    attrs.Length = sizeof(attrs);
    attrs.RootDirectory = 0;
    attrs.ObjectName = (ULONG64)(ULONG64)&keyName;
    attrs.Attributes = 0;
    attrs.SecurityDescriptor = 0;
    attrs.SecurityQOS = 0;

    /* cria + grava + fecha */
    if (ZwCreateKey(&keyHandle, 0xF0000, &attrs) != STATUS_SUCCESS) ok = 0;
    if (ok && keyHandle) {
        RtlInitUnicodeString(&valueName, L"Magic");
        if (ZwSetValueKey(keyHandle, &valueName, 0, 1,
                          (ULONG64)(ULONG64)expected, sizeof(expected)) != STATUS_SUCCESS)
            ok = 0;
        if (ZwClose(keyHandle) != STATUS_SUCCESS) ok = 0;
        keyHandle = 0;
    }

    /* reabre + le + confere + fecha */
    if (ok) {
        if (ZwOpenKey(&keyHandle, 0x20019, &attrs) != STATUS_SUCCESS) ok = 0;
    }
    if (ok && keyHandle) {
        for (i = 0; i < sizeof(readBuffer); i++) readBuffer[i] = 0;
        if (ZwQueryValueKey(keyHandle, &valueName, 0, (ULONG64)(ULONG64)readBuffer,
                            sizeof(readBuffer), (ULONG64)(ULONG64)&readLength) != STATUS_SUCCESS)
            ok = 0;
        else {
            ULONG dataLength = *(ULONG *)(ULONG64)(readBuffer + 8);
            unsigned char *data = readBuffer + 12;
            if (dataLength != sizeof(expected)) ok = 0;
            else for (i = 0; i < dataLength; i++) if (data[i] != expected[i]) ok = 0;
        }
        if (ZwClose(keyHandle) != STATUS_SUCCESS) ok = 0;
    }
    allPassed = ok;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&registryRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\Registry");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "registry.sys: registry ok\r\n" : "registry.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
