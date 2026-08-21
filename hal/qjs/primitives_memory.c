/*
 * primitives_memory.c - acesso a memoria fisica e info de memoria para o JS.
 * os.readPhysical8/16/32, os.writePhysical8/16/32, os.getRamSize, os.getHeapInfo
 */
#include "jsos.h"

static JSValue prim_writePhysical(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int width) {
    uint32_t addr, val;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    JS_ToUint32(ctx, &val, argv[1]);
    if (width == 8)       *(volatile uint8_t *)(uintptr_t)addr = (uint8_t)val;
    else if (width == 16) *(volatile uint16_t *)(uintptr_t)addr = (uint16_t)val;
    else                  *(volatile uint32_t *)(uintptr_t)addr = val;
    return JS_UNDEFINED;
}

static JSValue prim_readPhysical(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv, int width) {
    uint32_t addr;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    if (width == 8)       return JS_NewUint32(ctx, *(volatile uint8_t *)(uintptr_t)addr);
    else if (width == 16) return JS_NewUint32(ctx, *(volatile uint16_t *)(uintptr_t)addr);
    else                  return JS_NewUint32(ctx, *(volatile uint32_t *)(uintptr_t)addr);
}

static JSValue prim_writePhysical8(JSContext *c, JSValueConst t, int n, JSValueConst *a)  { return prim_writePhysical(c, t, n, a, 8); }
static JSValue prim_writePhysical16(JSContext *c, JSValueConst t, int n, JSValueConst *a) { return prim_writePhysical(c, t, n, a, 16); }
static JSValue prim_writePhysical32(JSContext *c, JSValueConst t, int n, JSValueConst *a) { return prim_writePhysical(c, t, n, a, 32); }
static JSValue prim_readPhysical8(JSContext *c, JSValueConst t, int n, JSValueConst *a)   { return prim_readPhysical(c, t, n, a, 8); }
static JSValue prim_readPhysical16(JSContext *c, JSValueConst t, int n, JSValueConst *a)  { return prim_readPhysical(c, t, n, a, 16); }
static JSValue prim_readPhysical32(JSContext *c, JSValueConst t, int n, JSValueConst *a)  { return prim_readPhysical(c, t, n, a, 32); }

static JSValue prim_getRamSize(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)host_ram_size());
}

static JSValue prim_getHeapInfo(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    size_t total, used;
    JSValue obj;
    (void)this_val; (void)argc; (void)argv;
    host_heap_info(&total, &used);
    obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "total", JS_NewFloat64(ctx, (double)total));
    JS_SetPropertyStr(ctx, obj, "used", JS_NewFloat64(ctx, (double)used));
    return obj;
}

const JSCFunctionListEntry jsos_memory_funcs[] = {
    JS_CFUNC_DEF("writePhysical8", 2, prim_writePhysical8),
    JS_CFUNC_DEF("writePhysical16", 2, prim_writePhysical16),
    JS_CFUNC_DEF("writePhysical32", 2, prim_writePhysical32),
    JS_CFUNC_DEF("readPhysical8", 1, prim_readPhysical8),
    JS_CFUNC_DEF("readPhysical16", 1, prim_readPhysical16),
    JS_CFUNC_DEF("readPhysical32", 1, prim_readPhysical32),
    JS_CFUNC_DEF("getRamSize", 0, prim_getRamSize),
    JS_CFUNC_DEF("getHeapInfo", 0, prim_getHeapInfo),
};
const int jsos_memory_funcs_count = 8;
