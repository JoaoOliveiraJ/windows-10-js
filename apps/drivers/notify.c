/*
 * notify.c - PsSetCreateProcessNotifyRoutine (notificacao real de criacao/
 * saida de processo), IoGetDeviceProperty (HardwareID do PDO PCI) e
 * IoGetRelatedDeviceObject (topo da pilha via FileObject).
 * \Device\Notify READ devolve "notify-ok".
 * Bits: 1=create notify 2=exit notify 4=device property 8=related device
 */
#include "jsos-driver.h"

static ULONG allPassed;
static ULONG lastCreatedPid;
static ULONG lastExitedPid;

/* PCREATE_PROCESS_NOTIFY_ROUTINE: (parent, pid, created) */
static VOID processNotifyRoutine(HANDLE parentId, HANDLE processId,
                                 BOOLEAN created) {
    (void)parentId;
    if (created) lastCreatedPid = (ULONG)(ULONG_PTR)processId;
    else lastExitedPid = (ULONG)(ULONG_PTR)processId;
}

static NTSTATUS notifyRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    /* ok = resolve(1)+property(4)+related(8) + create/exit (pid > 4) */
    int ok = (allPassed & 0xD) == 0xD && lastCreatedPid > 4 &&
             lastExitedPid > 4;
    return JsosReadWithMessage(deviceObject, irp, ok ? "notify-ok"
                                                     : "notify-fail");
}

static void testDeviceProperty(void) {
    UNICODE_STRING pdoName;
    PFILE_OBJECT pdoFile = NULL;
    PDEVICE_OBJECT vgaPdo = NULL, topDevice;
    WCHAR idBuffer[64];
    ULONG resultLength = 0;
    NTSTATUS status;

    RtlInitUnicodeString(&pdoName, L"\\Device\\PDO4");   /* VGA PCI */
    status = IoGetDeviceObjectPointer(&pdoName, FILE_READ_DATA,
                                      &pdoFile, &vgaPdo);
    if (!NT_SUCCESS(status) || !vgaPdo) return;
    allPassed |= 1;   /* resolveu o PDO4 */

    /* IoGetRelatedDeviceObject: o topo da pilha (FDO do pcidemo) */
    topDevice = IoGetRelatedDeviceObject(pdoFile);
    if (topDevice && topDevice == vgaPdo) allPassed |= 8;

    /* HardwareID real do barramento (anda ate o PDO pela cadeia de attach) */
    status = IoGetDeviceProperty(vgaPdo, DevicePropertyHardwareID,
                                 sizeof(idBuffer), idBuffer, &resultLength);
    if (NT_SUCCESS(status) && resultLength > 10 &&
        idBuffer[0] == L'P' && idBuffer[1] == L'C' && idBuffer[2] == L'I')
        allPassed |= 4;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("notify.sys: DriverEntry\r\n");
    allPassed = 0;
    lastCreatedPid = 0;
    lastExitedPid = 0;
    if (NT_SUCCESS(PsSetCreateProcessNotifyRoutine(processNotifyRoutine,
                                                   FALSE)))
        DbgPrint("notify.sys: notify routine registrada\r\n");
    testDeviceProperty();
    driverObject->MajorFunction[IRP_MJ_READ] = notifyRead;
    return JsosCreateDevice(driverObject, L"\\Device\\Notify");
}
