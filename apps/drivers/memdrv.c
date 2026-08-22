/*
 * memdrv.c - lookaside lists (cache real sobre o pool), MDL com PFNs das
 * page tables, MmGetSystemRoutineAddress (resolucao dinamica + chamada) e
 * ExGetPreviousMode. \Device\MemDrv READ devolve "memdrv-ok".
 * Bits do diagnostico: 1=lookaside 2=mdl 4=resolucao 8=previousmode
 */
#include "jsos-driver.h"

static ULONG allPassed;

static NTSTATUS memdrvRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    char detail[20];
    detail[0]='m';detail[1]='e';detail[2]='m';detail[3]='d';detail[4]='r';
    detail[5]='v';detail[6]='-';detail[7]='f';detail[8]='a';detail[9]='i';
    detail[10]='l';detail[11]=':';
    detail[12]="0123456789abcdef"[allPassed & 0xF];
    detail[13]=0;
    return JsosReadWithMessage(deviceObject, irp,
                               allPassed == 0xF ? "memdrv-ok" : detail);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    PAGED_LOOKASIDE_LIST lookaside;
    PVOID blockA, blockB, blockC;
    PVOID poolBuffer;
    PMDL mdl;
    PVOID mappedVa;
    UNICODE_STRING routineName;
    KIRQL (*resolvedGetIrql)(void);
    (void)registryPath;
    DbgPrint("memdrv.sys: DriverEntry\r\n");
    allPassed = 0;

    /* lookaside: libera A e o proximo alloc TEM que reutilizar A (cache) */
    ExInitializePagedLookasideList(&lookaside, NULL, NULL, 0, 256, 'mDRV', 4);
    blockA = ExAllocateFromPagedLookasideList(&lookaside);
    blockB = ExAllocateFromPagedLookasideList(&lookaside);
    ExFreeToPagedLookasideList(&lookaside, blockA);
    blockC = ExAllocateFromPagedLookasideList(&lookaside);
    if (blockA && blockB && blockA != blockB && blockC == blockA)
        allPassed |= 1;
    ExFreeToPagedLookasideList(&lookaside, blockB);
    ExFreeToPagedLookasideList(&lookaside, blockC);
    ExDeletePagedLookasideList(&lookaside);

    /* MDL: struct real + MmGetSystemAddressForMdlSafe (identity) */
    poolBuffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, 0x400, 'mDRV');
    if (poolBuffer) {
        mdl = IoAllocateMdl(poolBuffer, 0x400, FALSE, FALSE, NULL);
        if (mdl && mdl->ByteCount == 0x400) {
            mappedVa = MmGetSystemAddressForMdlSafe(mdl, LowPagePriority);
            if (mappedVa == poolBuffer) {
                ((ULONG *)mappedVa)[0] = 0xC0FFEE;
                if (((ULONG *)poolBuffer)[0] == 0xC0FFEE) allPassed |= 2;
            }
        }
        if (mdl) IoFreeMdl(mdl);
        ExFreePool2(poolBuffer, 'mDRV', NULL, 0);
    }

    /* resolucao dinamica: endereco chamavel de KeGetCurrentIrql */
    RtlInitUnicodeString(&routineName, L"KeGetCurrentIrql");
    resolvedGetIrql = (KIRQL (*)(void))MmGetSystemRoutineAddress(&routineName);
    if (resolvedGetIrql && resolvedGetIrql() == PASSIVE_LEVEL) allPassed |= 4;

    if (ExGetPreviousMode() == KernelMode) allPassed |= 8;

    driverObject->MajorFunction[IRP_MJ_READ] = memdrvRead;
    return JsosCreateDevice(driverObject, L"\\Device\\MemDrv");
}
