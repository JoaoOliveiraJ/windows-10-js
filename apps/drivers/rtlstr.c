/*
 * rtlstr.c - Rtl unicode strings: RtlInit/Compare/Copy/Equal.
 * \Device\RtlStr devolve "rtl-str-ok" se todas baterem.
 */
#include "jsos-driver.h"

static int allPassed;
static wchar_t copyStorage[64];

static NTSTATUS rtlstrRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "rtl-str-ok" : "rtl-str-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    UNICODE_STRING first, second, copy;
    (void)registryPath;
    DbgPrint("rtlstr.sys: DriverEntry\r\n");

    RtlInitUnicodeString(&first, L"Windows");
    RtlInitUnicodeString(&second, L"windows");
    copy.Length = 0;
    copy.MaximumLength = sizeof(copyStorage);
    copy.Buffer = copyStorage;

    allPassed =
        RtlEqualUnicodeString(&first, &second, TRUE) &&
        !RtlEqualUnicodeString(&first, &second, FALSE) &&
        RtlCompareUnicodeString(&first, &second, TRUE) == 0;

    RtlCopyUnicodeString(&copy, &first);
    if (!RtlEqualUnicodeString(&copy, &first, FALSE)) allPassed = 0;

    driverObject->MajorFunction[IRP_MJ_READ] = rtlstrRead;
    return JsosCreateDevice(driverObject, L"\\Device\\RtlStr");
}
