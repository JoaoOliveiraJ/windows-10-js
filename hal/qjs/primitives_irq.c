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

const JSCFunctionListEntry jsos_irq_funcs[] = {
    JS_CFUNC_DEF("loadIdt", 2, prim_loadIdt),
    JS_CFUNC_DEF("getIrqStubTable", 0, prim_getIrqStubTable),
    JS_CFUNC_DEF("readMsr", 1, prim_readMsr),
    JS_CFUNC_DEF("writeMsr", 2, prim_writeMsr),
    JS_CFUNC_DEF("cpuid", 1, prim_cpuid),
    JS_CFUNC_DEF("lapicRead", 1, prim_lapicRead),
    JS_CFUNC_DEF("lapicWrite", 2, prim_lapicWrite),
    JS_CFUNC_DEF("rdtsc", 0, prim_rdtsc),
};
const int jsos_irq_funcs_count = 8;
