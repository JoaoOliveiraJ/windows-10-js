/*
 * rtlansi.c - driver demo do grupo "Rtl ANSI<->Unicode" do jsOS.
 * Converte ANSI -> Unicode -> ANSI com alocacao real, confere conteudo,
 * libera. \Device\RtlAnsi devolve "rtl-ansi-ok" se tudo bater.
 */

typedef unsigned long long ULONG64;
typedef unsigned int ULONG;
typedef unsigned short USHORT;
typedef long NTSTATUS;
typedef USHORT wchar_t;

typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } UNICODE_STRING;
typedef struct { USHORT Length; USHORT MaximumLength; ULONG Pad; ULONG64 Buffer; } ANSI_STRING;
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
__declspec(dllimport) void RtlInitAnsiString(ANSI_STRING *out, const char *str);
__declspec(dllimport) NTSTATUS RtlAnsiStringToUnicodeString(UNICODE_STRING *uni,
                                                            ANSI_STRING *ansi, ULONG allocate);
__declspec(dllimport) NTSTATUS RtlUnicodeStringToAnsiString(ANSI_STRING *ansi,
                                                            UNICODE_STRING *uni, ULONG allocate);
__declspec(dllimport) void RtlFreeAnsiString(ANSI_STRING *str);
__declspec(dllimport) void RtlFreeUnicodeString(UNICODE_STRING *str);

static int allPassed = 0;

static int ansiEquals(ANSI_STRING *str, const char *expected) {
    char *buffer = (char *)(ULONG64)str->Buffer;
    ULONG i;
    if (str->Length == 0) return 0;
    for (i = 0; i < str->Length; i++)
        if (buffer[i] != expected[i]) return 0;
    return expected[str->Length] == 0;
}

static NTSTATUS ansiRead(ULONG64 devicePtr, ULONG64 irpPtr) {
    JSOS_IRP *irp = (JSOS_IRP *)(ULONG64)irpPtr;
    const char *message = allPassed ? "rtl-ansi-ok" : "rtl-ansi-fail";
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
    UNICODE_STRING deviceName, unicode;
    ANSI_STRING ansiOriginal, ansiBack;
    ULONG64 devicePtr = 0;
    int ok = 1;
    (void)registryPath;

    DbgPrint("rtlansi.sys: DriverEntry\r\n");

    RtlInitAnsiString(&ansiOriginal, "jsOS-NT");
    unicode.Buffer = 0; unicode.Length = 0; unicode.MaximumLength = 0;
    RtlAnsiStringToUnicodeString(&unicode, &ansiOriginal, 1);   /* aloca */
    {
        USHORT *ub = (USHORT *)(ULONG64)unicode.Buffer;
        DbgPrint(unicode.Length == 14 ? "rtlansi: uni ok\r\n" : "rtlansi: uni LEN err\r\n");
        if (unicode.Length == 14)
            DbgPrint(ub[0] == L'j' && ub[6] == L'T' ? "rtlansi: uni conteudo ok\r\n"
                                                   : "rtlansi: uni CONTEUDO err\r\n");
    }

    ansiBack.Buffer = 0; ansiBack.Length = 0; ansiBack.MaximumLength = 0;
    RtlUnicodeStringToAnsiString(&ansiBack, &unicode, 1);       /* aloca */
    DbgPrint(ansiEquals(&ansiBack, "jsOS-NT") ? "rtlansi: ansi back ok\r\n"
                                              : "rtlansi: ansi back ERR\r\n");

    RtlFreeUnicodeString(&unicode);
    RtlFreeAnsiString(&ansiBack);
    DbgPrint(unicode.Buffer == 0 && ansiBack.Buffer == 0 ?
             "rtlansi: frees zeraram ok\r\n" : "rtlansi: frees NAO zeraram\r\n");
    if (unicode.Buffer != 0 || ansiBack.Buffer != 0) ok = 0;    /* free zerou */

    allPassed = ok;

    dispatch[IRP_MJ_READ] = (ULONG64)(ULONG64)&ansiRead;
    RtlInitUnicodeString(&deviceName, L"\\Device\\RtlAnsi");
    IoCreateDevice(driverObjectPtr, 0, &deviceName, 0, 0, 0, &devicePtr);

    DbgPrint(allPassed ? "rtlansi.sys: conversoes ok\r\n" : "rtlansi.sys: FALHOU\r\n");
    return STATUS_SUCCESS;
}
