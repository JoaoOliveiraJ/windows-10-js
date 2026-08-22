/*
 * primitives_mmu.c - primitivas de MMU para o JS (o JS edita as tabelas de
 * paginas diretamente via os.writePhysical32; estas duas so invalidam a TLB).
 */
#include "jsos.h"

/* ---- os.reloadCr3(): descarrega toda a TLB (apos split de pagina 2MB) ---- */
static JSValue prim_reloadCr3(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    __asm__ volatile("mov %%cr3, %%rax; mov %%rax, %%cr3" ::: "rax");
    return JS_UNDEFINED;
}

/* ---- os.invalidatePage(addr): invlpg de uma pagina (apos mexer numa PTE) ---- */
static JSValue prim_invalidatePage(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    uint32_t addr;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    __asm__ volatile("invlpg (%0)" :: "r"((uintptr_t)addr) : "memory");
    return JS_UNDEFINED;
}

const JSCFunctionListEntry jsos_mmu_funcs[] = {
    JS_CFUNC_DEF("reloadCr3", 0, prim_reloadCr3),
    JS_CFUNC_DEF("invalidatePage", 1, prim_invalidatePage),
};
const int jsos_mmu_funcs_count = 2;
