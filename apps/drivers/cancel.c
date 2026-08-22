/*
 * cancel.c - cancelamento de IRP real (IoSetCancelRoutine/IoCancelIrp com o
 * campo Cancel e a PDRIVER_CANCEL rodando), ZwOpenFile e
 * ZwQueryInformationFile/ZwSetInformationFile. \Device\Cancel READ devolve
 * "cancel-ok".
 * Bits: 1=cancelamento 2=ZwOpenFile 4=QueryInfo 8=SetInfo(delete)
 */
#include "jsos-driver.h"

static ULONG allPassed;
static ULONG cancelRoutineRan;

static VOID testCancelRoutine(PDEVICE_OBJECT deviceObject, PIRP irp) {
    (void)deviceObject;
    cancelRoutineRan = 1;
    if (!irp->Cancel) allPassed &= ~1;   /* Cancel tem que estar marcado */
    irp->IoStatus.Status = STATUS_CANCELLED;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
}

static NTSTATUS cancelRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    char detail[20];
    detail[0]='c';detail[1]='a';detail[2]='n';detail[3]='c';detail[4]='e';
    detail[5]='l';detail[6]='-';detail[7]='f';detail[8]='a';detail[9]='i';
    detail[10]='l';detail[11]=':';
    detail[12]="0123456789abcdef"[allPassed & 0xF];
    detail[13]=0;
    return JsosReadWithMessage(deviceObject, irp,
                               allPassed == 0xF ? "cancel-ok" : detail);
}

static void testIrpCancellation(PDEVICE_OBJECT ownDevice) {
    PIRP irp = IoAllocateIrp(ownDevice->StackSize, FALSE);
    PIO_STACK_LOCATION stack;
    PDRIVER_CANCEL previous;
    if (!irp) return;
    /* o IRP alocado vem posicionado acima do topo; o slot do device fica
     * em CurrentStackLocation - 1 (IoGetNextIrpStackLocation) */
    stack = IoGetNextIrpStackLocation(irp);
    stack->DeviceObject = ownDevice;
    irp->Tail.Overlay.CurrentStackLocation = stack;
    irp->CurrentLocation = (CHAR)ownDevice->StackSize;
    previous = IoSetCancelRoutine(irp, testCancelRoutine);
    IoCancelIrp(irp);
    if (previous == NULL && cancelRoutineRan &&
        irp->IoStatus.Status == STATUS_CANCELLED)
        allPassed |= 1;
    IoFreeIrp(irp);
}

static void testZwFileInfo(void) {
    OBJECT_ATTRIBUTES attributes;
    UNICODE_STRING path;
    IO_STATUS_BLOCK ioStatus;
    HANDLE handle = NULL;
    FILE_STANDARD_INFORMATION standardInfo;
    union { UCHAR bytes[8]; FILE_DISPOSITION_INFORMATION dispose; } setInfo;

    /* ZwOpenFile no NTFS real */
    RtlInitUnicodeString(&path, L"\\DosDevices\\D:\\HELLO.TXT");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (NT_SUCCESS(ZwOpenFile(&handle, GENERIC_READ, &attributes, &ioStatus,
                              FILE_SHARE_READ, 0))) {
        allPassed |= 2;
        if (NT_SUCCESS(ZwQueryInformationFile(handle, &ioStatus,
                                              &standardInfo,
                                              sizeof(standardInfo),
                                              FileStandardInformation)) &&
            standardInfo.EndOfFile.QuadPart > 0)
            allPassed |= 4;
        ZwClose(handle);
    }

    /* SetInformationFile(delete) num arquivo do ramfs criado p/ isso */
    RtlInitUnicodeString(&path, L"\\DosDevices\\C:\\DELME.TMP");
    InitializeObjectAttributes(&attributes, &path, OBJ_CASE_INSENSITIVE,
                               NULL, NULL);
    if (NT_SUCCESS(ZwCreateFile(&handle, GENERIC_WRITE | DELETE, &attributes,
                                &ioStatus, NULL, FILE_ATTRIBUTE_NORMAL, 0,
                                FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE,
                                NULL, 0))) {
        setInfo.dispose.DeleteFile = TRUE;
        if (NT_SUCCESS(ZwSetInformationFile(handle, &ioStatus, &setInfo, 1,
                                            FileDispositionInformation)))
            allPassed |= 8;
        ZwClose(handle);
    }
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    NTSTATUS status;
    (void)registryPath;
    DbgPrint("cancel.sys: DriverEntry\r\n");
    allPassed = 0;
    cancelRoutineRan = 0;

    status = JsosCreateDevice(driverObject, L"\\Device\\Cancel");
    if (!NT_SUCCESS(status)) return status;
    testIrpCancellation(driverObject->DeviceObject);
    testZwFileInfo();

    driverObject->MajorFunction[IRP_MJ_READ] = cancelRead;
    return STATUS_SUCCESS;
}
