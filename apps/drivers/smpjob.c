/*
 * smpjob.c - trabalho CPU-bound exportado para rodar nos APs (SMP).
 * SpinWork: LCG 32-bit deterministico (resultado prova a execucao).
 * ParallelSum: soma LCG de uma faixa (2 args, p/ paralelismo real).
 * Sem device: e um driver de servico carregado sob demanda pelo selftest.
 */
#include "jsos-driver.h"

__declspec(dllexport) ULONG SpinWork(ULONG iterations) {
    ULONG acc = 0x12345678, i;
    for (i = 0; i < iterations; i++) acc = acc * 1664525u + 1013904223u;
    return acc;
}

__declspec(dllexport) ULONG ParallelSum(ULONG seed, ULONG iterations) {
    ULONG acc = seed, sum = 0, i;
    for (i = 0; i < iterations; i++) {
        acc = acc * 1664525u + 1013904223u;
        sum += acc;
    }
    return sum;
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath) {
    (void)driverObject; (void)registryPath;
    DbgPrint("smpjob.sys: DriverEntry (exports SpinWork/ParallelSum p/ APs)\r\n");
    return STATUS_SUCCESS;
}
