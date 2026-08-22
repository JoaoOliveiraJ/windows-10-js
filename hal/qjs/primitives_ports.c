/*
 * primitives_ports.c - primitivas de I/O de porta para o JS.
 * os.readPort8 / os.writePort8 / os.readPort16
 */
#include "jsos.h"

static JSValue prim_writePort8(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    uint32_t port, val;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    JS_ToUint32(ctx, &val, argv[1]);
    host_outb((uint16_t)port, (uint8_t)val);
    return JS_UNDEFINED;
}

static JSValue prim_readPort8(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    uint32_t port;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    return JS_NewUint32(ctx, host_inb((uint16_t)port));
}

static JSValue prim_readPort16(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    uint32_t port;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    return JS_NewUint32(ctx, host_inw((uint16_t)port));
}

static JSValue prim_writePort16(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    uint32_t port, val;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    JS_ToUint32(ctx, &val, argv[1]);
    host_outw((uint16_t)port, (uint16_t)val);
    return JS_UNDEFINED;
}

static JSValue prim_writePort32(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    uint32_t port, val;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    JS_ToUint32(ctx, &val, argv[1]);
    host_outl((uint16_t)port, (uint32_t)val);
    return JS_UNDEFINED;
}

static JSValue prim_readPort32(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    uint32_t port;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    return JS_NewUint32(ctx, host_inl((uint16_t)port));
}

const JSCFunctionListEntry jsos_ports_funcs[] = {
    JS_CFUNC_DEF("writePort8", 2, prim_writePort8),
    JS_CFUNC_DEF("readPort8", 1, prim_readPort8),
    JS_CFUNC_DEF("readPort16", 1, prim_readPort16),
    JS_CFUNC_DEF("writePort16", 2, prim_writePort16),
    JS_CFUNC_DEF("writePort32", 2, prim_writePort32),
    JS_CFUNC_DEF("readPort32", 1, prim_readPort32),
};
const int jsos_ports_funcs_count = 6;
