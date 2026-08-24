/*
 * primitives_irq.c - primitivas de interrupcao para o JS.
 *
 * O JS constroi a IDT inteira na memoria fisica e chama os.loadIdt().
 * os.getIrqStubTable() devolve a base dos trampolins asm (irqstubs.asm).
 */
#include "jsos.h"

extern const uint8_t irq_stub_table[];

static JSValue prim_loadIdt(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    uint32_t addr, size;
    struct __attribute__((packed)) { uint16_t limit; uint64_t base; } idtr;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    JS_ToUint32(ctx, &size, argv[1]);
    idtr.limit = (uint16_t)(size - 1);
    idtr.base  = addr;
    __asm__ volatile("lidt %0" :: "m"(idtr));
    __asm__ volatile("sti");
    return JS_UNDEFINED;
}

static JSValue prim_getIrqStubTable(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)(uintptr_t)irq_stub_table);
}

/* ---- despacho imediato de ISR nativa (drivers Windows) -------------------
 * Chamado pelo stub asm de IRQ (irqstubs.asm) com o vetor. Se o vetor tem
 * uma cadeia KINTERRUPT nativa (dirql != 0 na tabela compartilhada) e o IRQL
 * atual e' menor que o DIRQL do vetor, despacha AGORA (como o HAL do NT
 * preemptando) — senao fica pendente p/ o dispatchPending do idle loop.
 *
 * Mapa compartilhado com o JS:
 *   0x81528: u32 currentIrql (publicado por ntos/ke/irql.js)
 *   0x81600: u32 dirql[256]  (publicado por ntos/ke/interrupt-object.js) ---- */

#include "quickjs_host.h"

extern JSContext *js_host_ctx(void);
extern void jsos_dump_exception(JSContext *ctx);

#define JSOS_CURRENT_IRQL_ADDR  0x81528u
#define JSOS_IRQ_DIRQL_TABLE    0x81600u
#define JSOS_SHARED_FRAME_ADDR  0x81530u
#define JSOS_TSC_HZ_ADDR        0x81534u
#define JSOS_TSC_AT_BOOT_ADDR   0x81538u
#define JSOS_BOOT_NT100NS_ADDR  0x81540u

/* atualizacao preemptiva do KUSER_SHARED_DATA: roda a cada IRQ do timer
 * (0x40), DENTRO do stub — o SystemTime/TickCount avancam mesmo durante
 * spins nativos de drivers (o timeout do atapi le esse campo; o nosso idle
 * loop cooperativo nao roda durante o spin, congelando o relogio) */
static void jsos_update_shared_times(uint32_t vector) {
    uint32_t frame, tscHz, lo, hi;
    uint64_t tscAtBoot, bootNt100ns, now, systemTime100ns, tickCountMs;
    if (vector != 0x40) return;
    frame = *(volatile uint32_t *)(uintptr_t)JSOS_SHARED_FRAME_ADDR;
    tscHz = *(volatile uint32_t *)(uintptr_t)JSOS_TSC_HZ_ADDR;
    if (!frame || !tscHz) return;
    lo = *(volatile uint32_t *)(uintptr_t)JSOS_TSC_AT_BOOT_ADDR;
    hi = *(volatile uint32_t *)(uintptr_t)(JSOS_TSC_AT_BOOT_ADDR + 4);
    tscAtBoot = (uint64_t)lo + ((uint64_t)hi << 32);
    lo = *(volatile uint32_t *)(uintptr_t)JSOS_BOOT_NT100NS_ADDR;
    hi = *(volatile uint32_t *)(uintptr_t)(JSOS_BOOT_NT100NS_ADDR + 4);
    bootNt100ns = (uint64_t)lo + ((uint64_t)hi << 32);
    __asm__ volatile("rdtsc" : "=a"(lo), "=d"(hi));
    now = (uint64_t)lo + ((uint64_t)hi << 32);
    systemTime100ns = bootNt100ns + (now - tscAtBoot) * 10000000ULL / tscHz;
    tickCountMs = (now - tscAtBoot) * 1000ULL / tscHz;
    /* SystemTime (+0x14) e TickCount (+0x320) do KUSER_SHARED_DATA */
    *(volatile uint32_t *)(uintptr_t)(frame + 0x14) = (uint32_t)systemTime100ns;
    *(volatile uint32_t *)(uintptr_t)(frame + 0x18) = (uint32_t)(systemTime100ns >> 32);
    *(volatile uint32_t *)(uintptr_t)(frame + 0x320) = (uint32_t)tickCountMs;
    *(volatile uint32_t *)(uintptr_t)(frame + 0x324) = (uint32_t)(tickCountMs >> 32);
}

void jsos_irq_native_dispatch(uint32_t vector) {
    uint32_t currentIrql, dirql;
    JSContext *ctx;
    JSValue global, fn, arg, ret;

    jsos_update_shared_times(vector);

    currentIrql = *(volatile uint32_t *)(uintptr_t)JSOS_CURRENT_IRQL_ADDR;
    dirql = *(volatile uint32_t *)(uintptr_t)(JSOS_IRQ_DIRQL_TABLE + vector * 4u);
    if (!dirql || currentIrql >= dirql) return;   /* fica pendente */

    ctx = js_host_ctx();
    if (!ctx) return;
    global = JS_GetGlobalObject(ctx);
    fn = JS_GetPropertyStr(ctx, global, "__jsosIrqNativeDispatch");
    if (JS_IsFunction(ctx, fn)) {
        arg = JS_NewUint32(ctx, vector);
        ret = JS_Call(ctx, fn, global, 1, (JSValueConst *)&arg);
        if (JS_IsException(ret)) jsos_dump_exception(ctx);
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, arg);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
}

/* ---- os.readMsr/msr / os.writeMsr: acesso a MSRs (APIC base etc.) ---- */

static JSValue prim_readMsr(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    uint32_t msr, lo, hi;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &msr, argv[0]);
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(msr));
    return JS_NewFloat64(ctx, (double)lo + (double)hi * 4294967296.0);
}

static JSValue prim_writeMsr(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    uint32_t msr;
    double val;
    uint64_t v64;
    uint32_t lo, hi;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &msr, argv[0]);
    JS_ToFloat64(ctx, &val, argv[1]);
    v64 = (uint64_t)val;
    lo = (uint32_t)(v64 & 0xFFFFFFFF);
    hi = (uint32_t)(v64 >> 32);
    __asm__ volatile("wrmsr" :: "c"(msr), "a"(lo), "d"(hi));
    return JS_UNDEFINED;
}

/* ---- os.cpuid(leaf) -> [eax,ebx,ecx,edx] (deteccao de plataforma) ---- */

static JSValue prim_cpuid(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    uint32_t leaf, a, b, c, d;
    JSValue arr;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &leaf, argv[0]);
    __asm__ volatile("cpuid" : "=a"(a), "=b"(b), "=c"(c), "=d"(d) : "a"(leaf));
    arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewFloat64(ctx, (double)a));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewFloat64(ctx, (double)b));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewFloat64(ctx, (double)c));
    JS_SetPropertyUint32(ctx, arr, 3, JS_NewFloat64(ctx, (double)d));
    return arr;
}

/* ---- os.lapicRead/lapicWrite: LAPIC MMIO (0xFEE00000+reg) ----
 * Com kernel-irqchip=off o QEMU emula o LAPIC em userland e o emulador do
 * WHPX precisa DECODIFICAR a instrucao que acessa o GPA. O decoder falha em
 * formas exoticas (ex: movsxd com [rax]) — por isso aqui vai asm explicito
 * com o mov mais simples possivel (8B/89 /r), que o WHPX decodifica. */

#define JSOS_LAPIC_PHYS 0xFEE00000u

static JSValue prim_lapicRead(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    uint32_t reg, value;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &reg, argv[0]);
    __asm__ volatile("movl %1, %0"
                     : "=r"(value)
                     : "m"(*(volatile uint32_t *)(uintptr_t)(JSOS_LAPIC_PHYS + reg))
                     : "memory");
    return JS_NewUint32(ctx, value);
}

static JSValue prim_lapicWrite(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    uint32_t reg, value;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &reg, argv[0]);
    JS_ToUint32(ctx, &value, argv[1]);
    __asm__ volatile("movl %1, %0"
                     : "=m"(*(volatile uint32_t *)(uintptr_t)(JSOS_LAPIC_PHYS + reg))
                     : "r"(value)
                     : "memory");
    return JS_UNDEFINED;
}

/* ---- os.rdtsc(): Time Stamp Counter (relogio de alta resolucao) ---- */

static JSValue prim_rdtsc(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    uint32_t lo, hi;
    (void)this_val; (void)argc; (void)argv;
    __asm__ volatile("rdtsc" : "=a"(lo), "=d"(hi));
    return JS_NewFloat64(ctx, (double)lo + (double)hi * 4294967296.0);
}

/* ---- os.armDataWriteWatchpoint(addr) / os.disarmDataWatchpoint():
   watchpoint de HARDWARE nos registradores de debug (DR0/DR7): a CPU gera
   #DB (vetor 1) logo apos QUALQUER instrucao que escreva nos 8 bytes a
   partir de addr — o dump da excecao mostra o RIP do escritor. Cobre
   escritas de drivers, do nosso C e de stubs asm (o watch por software no
   dispatch JS so enxerga fronteiras de chamada de API). ---- */
static JSValue prim_armDataWriteWatchpoint(JSContext *ctx,
                                           JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
    uint32_t addr, mode;
    uint64_t dr7;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    mode = 1;                                   /* padrao: so escrita */
    if (argc > 1) JS_ToUint32(ctx, &mode, argv[1]);
    __asm__ volatile("mov %0, %%dr0" :: "r"((uint64_t)addr));
    dr7 = 0x1                                   /* L0: watchpoint 0 habilitado */
        | ((uint64_t)(mode & 3) << 16)          /* RW0: 01=escrita 11=leitura+escrita */
        | (0x2ULL << 18);                       /* LEN0 = 10: janela de 8 bytes */
    __asm__ volatile("mov %0, %%dr7" :: "r"(dr7) : "memory");
    return JS_UNDEFINED;
}

static JSValue prim_disarmDataWatchpoint(JSContext *ctx,
                                         JSValueConst this_val,
                                         int argc, JSValueConst *argv) {
    uint64_t dr7;
    (void)this_val; (void)argc; (void)argv;
    __asm__ volatile("mov %%dr7, %0" : "=r"(dr7));
    dr7 &= ~(uint64_t)0x1;                 /* desliga L0 */
    __asm__ volatile("mov %0, %%dr7" :: "r"(dr7) : "memory");
    return JS_UNDEFINED;
}

const JSCFunctionListEntry jsos_irq_funcs[] = {
    JS_CFUNC_DEF("loadIdt", 2, prim_loadIdt),
    JS_CFUNC_DEF("getIrqStubTable", 0, prim_getIrqStubTable),
    JS_CFUNC_DEF("readMsr", 1, prim_readMsr),
    JS_CFUNC_DEF("writeMsr", 2, prim_writeMsr),
    JS_CFUNC_DEF("cpuid", 1, prim_cpuid),
    JS_CFUNC_DEF("lapicRead", 1, prim_lapicRead),
    JS_CFUNC_DEF("lapicWrite", 2, prim_lapicWrite),
    JS_CFUNC_DEF("rdtsc", 0, prim_rdtsc),
    JS_CFUNC_DEF("armDataWriteWatchpoint", 1, prim_armDataWriteWatchpoint),
    JS_CFUNC_DEF("disarmDataWatchpoint", 0, prim_disarmDataWatchpoint),
};
const int jsos_irq_funcs_count = 10;
