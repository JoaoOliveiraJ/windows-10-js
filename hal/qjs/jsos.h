/*
 * jsos.h - contrato interno da camada C->JS do jsOS.
 *
 * As primitivas estao divididas por area (portas, memoria, sistema); cada
 * arquivo exporta uma tabela JSCFunctionListEntry que engine.c registra
 * no objeto global `os` do JavaScript.
 *
 * Convencao de nomes JS (sem abreviacoes):
 *   os.readPort8/16, os.writePort8        - I/O de porta
 *   os.readPhysical8/16/32, writePhysical8/16/32  - memoria fisica
 *   os.readBundleText/Bytes, os.listBundleFiles   - bundle embutido
 *   os.debugPrint, os.serialWrite                  - saida serial
 *   os.execMachineCode, os.getWin32ThunkTable      - codigo nativo / Win32
 *   os.getRamSize, os.getHeapInfo                  - memoria
 *   os.halt                                        - desliga
 */
#ifndef JSOS_JSOS_H
#define JSOS_JSOS_H

#include "quickjs.h"
#include "../core/host.h"

/* bundle embutido (gerado em build/generated/jsbundle.c) */
typedef struct { const char *name; const char *data; uint32_t size; } jsbundle_file_t;

/* tabelas de primitivas exportadas pelos arquivos primitives_*.c */
extern const JSCFunctionListEntry jsos_ports_funcs[];
extern const int jsos_ports_funcs_count;
extern const JSCFunctionListEntry jsos_memory_funcs[];
extern const int jsos_memory_funcs_count;
extern const JSCFunctionListEntry jsos_system_funcs[];
extern const int jsos_system_funcs_count;
extern const JSCFunctionListEntry jsos_irq_funcs[];
extern const int jsos_irq_funcs_count;
extern const JSCFunctionListEntry jsos_mmu_funcs[];
extern const int jsos_mmu_funcs_count;

/* engine.c */
JSContext *jsos_context(void);
void jsos_dump_exception(JSContext *ctx);

#endif
