/*
 * rtlansi.c - Rtl ANSI<->Unicode com alocacao/free reais.
 * \Device\RtlAnsi devolve "rtl-ansi-ok".
 */
#include "jsos-driver.h"

static int allPassed;

static NTSTATUS rtlansiRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "rtl-ansi-ok" : "rtl-ansi-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    UNICODE_STRING unicode;
    ANSI_STRING ansiOriginal, ansiBack;
    int ok = 1;
    (void)registryPath;
    DbgPrint("rtlansi.sys: DriverEntry\r\n");

    RtlInitAnsiString(&ansiOriginal, "jsOS-NT");
    RtlZeroMemory(&unicode, sizeof(unicode));
    RtlAnsiStringToUnicodeString(&unicode, &ansiOriginal, TRUE);   /* aloca */
    if (unicode.Length != 14) ok = 0;                            /* 7 chars x 2 */
    if (unicode.Buffer && unicode.Buffer[0] != L'j') ok = 0;

    RtlZeroMemory(&ansiBack, sizeof(ansiBack));
    RtlUnicodeStringToAnsiString(&ansiBack, &unicode, TRUE);     /* aloca */
    if (!RtlEqualString(&ansiBack, &ansiOriginal, FALSE)) ok = 0;

    RtlFreeUnicodeString(&unicode);
    RtlFreeAnsiString(&ansiBack);
    if (unicode.Buffer != NULL || ansiBack.Buffer != NULL) ok = 0;

    allPassed = ok;

    driverObject->MajorFunction[IRP_MJ_READ] = rtlansiRead;
    return JsosCreateDevice(driverObject, L"\\Device\\RtlAnsi");
}
