/*
 * ketime.c - KeQuerySystemTime / KeQueryTickCount.
 * \Device\KeTime devolve "ke-time-ok" se os relogios sao sensiveis.
 */
#include "jsos-driver.h"

static int allPassed;

static NTSTATUS ketimeRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    return JsosReadWithMessage(deviceObject, irp, allPassed ? "ke-time-ok" : "ke-time-fail");
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    LARGE_INTEGER systemTime;
    ULONG64 ticksFirst, ticksSecond;
    (void)registryPath;
    DbgPrint("ketime.sys: DriverEntry\r\n");

    KeQuerySystemTime(&systemTime);
    KeQueryTickCount((PULONG64)&ticksFirst);
    KeQueryTickCount((PULONG64)&ticksSecond);

    allPassed = (systemTime.QuadPart > 130000000000000000ULL) &&
                (ticksSecond >= ticksFirst);

    driverObject->MajorFunction[IRP_MJ_READ] = ketimeRead;
    return JsosCreateDevice(driverObject, L"\\Device\\KeTime");
}
