/*
 * listsync.c - listas interlocked (ExInterlockedInsertTailList/RemoveHeadList
 * com spinlock, InterlockedPush/PopEntryList), ERESOURCE variants e
 * driver object extensions. \Device\ListSync READ devolve "listsync-ok".
 */
#include "jsos-driver.h"

typedef struct {
    LIST_ENTRY link;
    ULONG value;
} MY_ENTRY;

static ULONG allPassed;

static NTSTATUS listsyncRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    char detail[20];
    detail[0]='l';detail[1]='i';detail[2]='s';detail[3]='t';detail[4]='f';
    detail[5]='a';detail[6]='i';detail[7]='l';detail[8]=':';
    detail[9]="0123456789abcdef"[allPassed & 0xF];
    detail[10]=0;
    return JsosReadWithMessage(deviceObject, irp,
                               allPassed == 0xF ? "listsync-ok" : detail);
}

static void testInterlockedLists(void) {
    LIST_ENTRY listHead;
    KSPIN_LOCK spinLock;
    static MY_ENTRY entryA, entryB, entryC;
    PLIST_ENTRY removed;
    int ok = 1;

    /* lista dupla sob spinlock: insere 10,20,30; remove na ordem (FIFO) */
    InitializeListHead(&listHead);
    KeInitializeSpinLock(&spinLock);
    entryA.value = 10; entryB.value = 20; entryC.value = 30;
    ExInterlockedInsertTailList(&listHead, &entryA.link, &spinLock);
    ExInterlockedInsertTailList(&listHead, &entryB.link, &spinLock);
    ExInterlockedInsertTailList(&listHead, &entryC.link, &spinLock);
    removed = ExInterlockedRemoveHeadList(&listHead, &spinLock);
    if (!removed || ((MY_ENTRY *)removed)->value != 10) ok = 0;
    removed = ExInterlockedRemoveHeadList(&listHead, &spinLock);
    if (!removed || ((MY_ENTRY *)removed)->value != 20) ok = 0;
    removed = ExInterlockedRemoveHeadList(&listHead, &spinLock);
    if (!removed || ((MY_ENTRY *)removed)->value != 30) ok = 0;
    if (ExInterlockedRemoveHeadList(&listHead, &spinLock) != NULL) ok = 0;

    if (ok) allPassed |= 1;
}

static void testResourceVariants(void) {
    static ERESOURCE resource;
    ExInitializeResourceLite(&resource);
    /* StarveExclusive: entra como leitor mesmo "furando a fila" */
    if (ExAcquireSharedStarveExclusive(&resource, TRUE))
        allPassed |= 2;
    /* WaitForExclusive: sem escritores na fila, entra como leitor */
    if (ExAcquireSharedWaitForExclusive(&resource, TRUE))
        allPassed |= 4;
    ExReleaseResourceLite(&resource);
    ExReleaseResourceLite(&resource);
    ExDeleteResourceLite(&resource);
}

static void testDriverExtension(PDRIVER_OBJECT driverObject) {
    static ULONG extensionTag = 'xTsL';
    PVOID extension = NULL;
    if (NT_SUCCESS(IoAllocateDriverObjectExtension(driverObject,
                                                   &extensionTag, 64,
                                                   &extension)) &&
        extension) {
        ((ULONG *)extension)[0] = 0xC0FFEE;
        if (IoGetDriverObjectExtension(driverObject, &extensionTag) ==
                extension &&
            ((ULONG *)IoGetDriverObjectExtension(driverObject,
                &extensionTag))[0] == 0xC0FFEE)
            allPassed |= 8;
    }
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)registryPath;
    DbgPrint("listsync.sys: DriverEntry\r\n");
    allPassed = 0;
    testInterlockedLists();
    testResourceVariants();
    testDriverExtension(driverObject);
    driverObject->MajorFunction[IRP_MJ_READ] = listsyncRead;
    return JsosCreateDevice(driverObject, L"\\Device\\ListSync");
}
