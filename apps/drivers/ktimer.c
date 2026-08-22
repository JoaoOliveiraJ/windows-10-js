/*
 * ktimer.c - KTIMER real: KeInitializeTimer/KeSetTimer/KeSetTimerEx/
 * KeCancelTimer/KeReadStateTimer/KeDelayExecutionThread + DPC no disparo.
 * \Device\KTimer devolve "ktimer-ok" se: timer simples sinalizou e rodou o
 * DPC, o periodico rearmou (>=3 disparos em 45ms c/ periodo 10ms) e o cancel
 * impediu o terceiro timer.
 */
#include "jsos-driver.h"

static KTIMER oneShotTimer;
static KDPC oneShotDpc;
static ULONG oneShotDpcRan;

static KTIMER periodicTimer;
static KDPC periodicDpc;
static ULONG periodicCount;

static KTIMER cancelledTimer;
static ULONG cancelWorked;

static VOID oneShotDpcRoutine(PKDPC dpc, PVOID context, PVOID arg1, PVOID arg2) {
    (void)dpc; (void)arg1; (void)arg2;
    *(ULONG *)context = 1;
}

static VOID periodicDpcRoutine(PKDPC dpc, PVOID context, PVOID arg1, PVOID arg2) {
    (void)dpc; (void)arg1; (void)arg2;
    (*(ULONG *)context)++;
}

static NTSTATUS ktimerRead(PDEVICE_OBJECT deviceObject, PIRP irp) {
    int ok = oneShotDpcRan == 1 && periodicCount >= 3 && cancelWorked == 1;
    /* diagnostico: "ktimer-fail:<oneShot>,<periodicos>,<cancel>" */
    char detail[20];
    detail[0]='k';detail[1]='t';detail[2]='i';detail[3]='m';detail[4]='e';
    detail[5]='r';detail[6]='-';detail[7]='f';detail[8]='a';detail[9]='i';
    detail[10]='l';detail[11]=':';
    detail[12]=(char)('0'+(oneShotDpcRan&7));
    detail[13]=',';
    detail[14]=(char)('0'+(periodicCount>9?9:periodicCount));
    detail[15]=',';
    detail[16]=(char)('0'+(cancelWorked&7));
    detail[17]=0;
    return JsosReadWithMessage(deviceObject, irp, ok ? "ktimer-ok" : detail);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    LARGE_INTEGER due20ms, delay45ms, dueFarFuture;
    (void)registryPath;
    DbgPrint("ktimer.sys: DriverEntry\r\n");

    due20ms.QuadPart = -(20 * 10000);        /* 20 ms relativo (100ns) */
    delay45ms.QuadPart = -(45 * 10000);
    dueFarFuture.QuadPart = -(60 * 1000 * 10000); /* 60 s relativo */

    /* timer simples: sinaliza + roda o DPC apos 20ms */
    KeInitializeTimer(&oneShotTimer);
    KeInitializeDpc(&oneShotDpc, oneShotDpcRoutine, &oneShotDpcRan);
    KeSetTimer(&oneShotTimer, due20ms, &oneShotDpc);

    /* periodico: 10ms; em 45ms deve disparar >= 3 vezes */
    KeInitializeTimer(&periodicTimer);
    KeInitializeDpc(&periodicDpc, periodicDpcRoutine, &periodicCount);
    KeSetTimerEx(&periodicTimer, due20ms, 10, &periodicDpc);

    /* timer que NUNCA deve disparar: cancelado em seguida */
    KeInitializeTimer(&cancelledTimer);
    KeSetTimer(&cancelledTimer, dueFarFuture, NULL);
    cancelWorked = KeCancelTimer(&cancelledTimer) &&
                   KeReadStateTimer(&cancelledTimer) == 0;

    /* espera real que processa timers e DPCs durante o atraso */
    KeDelayExecutionThread(KernelMode, FALSE, &delay45ms);
    KeCancelTimer(&periodicTimer);

    driverObject->MajorFunction[IRP_MJ_READ] = ktimerRead;
    return JsosCreateDevice(driverObject, L"\\Device\\KTimer");
}
