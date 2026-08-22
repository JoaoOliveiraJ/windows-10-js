/*
 * fileio.c - IRP_MJ_CREATE/CLOSE com FILE_OBJECT + I/O de arquivo em modo
 * kernel: ZwCreateFile/ZwReadFile no NTFS real (D:\HELLO.TXT) e
 * ZwCreateFile/ZwWriteFile/ZwReadFile no ramfs (C:\KTMP.TST).
 * \Device\FileIo so atende READ com o device ABERTO (FileObject valido).
 * READ devolve "fileio-ok" se aberto E os Zw* passaram.
 */
#include "jsos-driver.h"

static ULONG openCount;
static ULONG closeCount;
static ULONG zwPassed;

static int textContains(const char *haystack, ULONG haystackLength,
                        const char *needle) {
    ULONG i, j, needleLength = 0;
    while (needle[needleLength]) needleLength++;
    if (needleLength > haystackLength) return 0;
    for (i = 0; i + needleLength <= haystackLength; i++) {
        for (j = 0; j < needleLength; j++)
            if (haystack[i + j] != needle[j]) break;
        if (j == needleLength) return 1;
    }
    return 0;
}

static NTSTATUS fileIoCreate(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    (void)deviceObject;
    if (!stack->FileObject) {   /* CREATE sem FILE_OBJECT: nao e NT */
        irp->IoStatus.Status = STATUS_INVALID_PARAMETER;
        IoCompleteRequest(irp, IO_NO_INCREMENT);
        return STATUS_INVALID_PARAMETER;
    }
    openCount++;
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = FILE_OPENED;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS fileIoClose(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    closeCount++;
    irp->IoStatus.Status = STATUS_SUCCESS;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS fileIoRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    int ok = stack->FileObject != NULL &&
             openCount == closeCount + 1 &&   /* aberto agora */
             zwPassed;
    return JsosReadWithMessage(deviceObject, irp, ok ? "fileio-ok"
                                                     : "fileio-fail");
}

/* Zw* de verdade: NTFS (leitura) + ramfs (escrita+leitura) */
static void testZwFileIo(void) {
    OBJECT_ATTRIBUTES attributes;
    UNICODE_STRING path;
    IO_STATUS_BLOCK ioStatus;
    HANDLE handle = NULL;
    LARGE_INTEGER offset;
    char buffer[64];
    NTSTATUS status;
    static const char payload[3] = { 'd', 'r', 'v' };

    /* NTFS real: le D:\HELLO.TXT e confere o conteudo */
    RtlInitUnicodeString(&path, L"\\DosDevices\\D:\\HELLO.TXT");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    offset.QuadPart = 0;
    status = ZwCreateFile(&handle, GENERIC_READ, &attributes, &ioStatus, NULL,
                          FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_OPEN,
                          FILE_NON_DIRECTORY_FILE, NULL, 0);
    if (!NT_SUCCESS(status)) { DbgPrint("fileio: ZwCreateFile D: falhou\r\n"); return; }
    status = ZwReadFile(handle, NULL, NULL, NULL, &ioStatus, buffer, 63,
                        &offset, NULL);
    if (!NT_SUCCESS(status) ||
        !textContains(buffer, ioStatus.Information, "jsOS")) {
        DbgPrint("fileio: ZwReadFile D: falhou\r\n");
        ZwClose(handle);
        return;
    }
    ZwClose(handle);

    /* ramfs: cria C:\KTMP.TST, escreve 'drv', le de volta e compara */
    RtlInitUnicodeString(&path, L"\\DosDevices\\C:\\KTMP.TST");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    status = ZwCreateFile(&handle, GENERIC_READ | GENERIC_WRITE, &attributes,
                          &ioStatus, NULL, FILE_ATTRIBUTE_NORMAL, 0,
                          FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE, NULL, 0);
    if (!NT_SUCCESS(status)) { DbgPrint("fileio: ZwCreateFile C: falhou\r\n"); return; }
    offset.QuadPart = 0;
    status = ZwWriteFile(handle, NULL, NULL, NULL, &ioStatus, (void *)payload, 3,
                         &offset, NULL);
    if (!NT_SUCCESS(status) || ioStatus.Information != 3) {
        DbgPrint("fileio: ZwWriteFile C: falhou\r\n");
        ZwClose(handle);
        return;
    }
    buffer[0] = buffer[1] = buffer[2] = 0;
    status = ZwReadFile(handle, NULL, NULL, NULL, &ioStatus, buffer, 3,
                        &offset, NULL);
    ZwClose(handle);
    if (!NT_SUCCESS(status) || ioStatus.Information != 3 ||
        buffer[0] != 'd' || buffer[1] != 'r' || buffer[2] != 'v') {
        DbgPrint("fileio: ZwReadFile C: falhou\r\n");
        return;
    }
    zwPassed = 1;
    DbgPrint("fileio.sys: Zw* NTFS+ramfs OK\r\n");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("fileio.sys: DriverEntry\r\n");
    testZwFileIo();
    driverObject->MajorFunction[IRP_MJ_CREATE] = fileIoCreate;
    driverObject->MajorFunction[IRP_MJ_CLOSE] = fileIoClose;
    driverObject->MajorFunction[IRP_MJ_READ] = fileIoRead;
    return JsosCreateDevice(driverObject, L"\\Device\\FileIo");
}
