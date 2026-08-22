/*
 * jsos-driver.h - base comum dos drivers demo do jsOS, com o WDK real.
 * Cada driver registra READ/WRITE/PNP pelo MajorFunction[] e cria
 * \Device\X + \DosDevices\X. O kernel jsOS entrega IRPs reais
 * (layout oficial do ntddk.h).
 */
#ifndef JSOS_DRIVER_H
#define JSOS_DRIVER_H

#include <ntddk.h>

/* READ de teste: copia `message` no SystemBuffer (METHOD_BUFFERED) e completa */
static NTSTATUS JsosReadWithMessage(PDEVICE_OBJECT deviceObject, PIRP irp,
                                    const char *message) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    ULONG length = 0, i;
    ULONG n;
    (void)deviceObject;
    while (message[length]) length++;
    n = stack->Parameters.Read.Length < length ? stack->Parameters.Read.Length
                                               : length;
    for (i = 0; i < n; i++)
        ((char *)irp->AssociatedIrp.SystemBuffer)[i] = message[i];
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = n;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

/* WRITE de teste: guarda o ultimo texto em `storage` (max 255) */
static NTSTATUS JsosWriteToStorage(PDEVICE_OBJECT deviceObject, PIRP irp,
                                   char *storage, ULONG *storageLength) {
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    ULONG n = stack->Parameters.Write.Length > 255 ? 255
                                                   : stack->Parameters.Write.Length;
    ULONG i;
    (void)deviceObject;
    for (i = 0; i < n; i++)
        storage[i] = ((char *)irp->AssociatedIrp.SystemBuffer)[i];
    *storageLength = n;
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = n;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

/* cria \Device\<name> + link \DosDevices\<name> */
static NTSTATUS JsosCreateDevice(PDRIVER_OBJECT driverObject, const wchar_t *name) {
    UNICODE_STRING deviceName, linkName;
    PDEVICE_OBJECT deviceObject = NULL;
    NTSTATUS status;
    RtlInitUnicodeString(&deviceName, name);
    status = IoCreateDevice(driverObject, 0, &deviceName, FILE_DEVICE_UNKNOWN,
                            0, FALSE, &deviceObject);
    if (!NT_SUCCESS(status)) return status;
    {
        wchar_t linkPath[64] = L"\\DosDevices\\";
        UNICODE_STRING linkUnicode;
        ULONG i = 0;
        const wchar_t *shortName = name + 8;   /* pula "\Device\" */
        while (linkPath[i]) i++;
        while (*shortName && i < 62) linkPath[i++] = *shortName++;
        linkPath[i] = 0;
        RtlInitUnicodeString(&linkUnicode, linkPath);
        IoCreateSymbolicLink(&linkUnicode, &deviceName);
    }
    return STATUS_SUCCESS;
}

#endif
