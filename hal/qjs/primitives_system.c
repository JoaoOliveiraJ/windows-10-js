/*
 * primitives_system.c - primitivas de sistema para o JS:
 * serial (debugPrint/serialWrite), bundle embutido (readBundleText/Bytes,
 * listBundleFiles), execucao nativa (execMachineCode, getWin32ThunkTable),
 * halt.
 */
#include "jsos.h"

/* trampolins Win32 (hal/win32/win32thunk.asm) */
extern const uint8_t win32_stubs[];
extern const uint64_t win32_stub_max;

/* bundle embutido */
extern const jsbundle_file_t jsbundle_files[];
extern const uint32_t jsbundle_count;

/* ---- os.debugPrint(...): serial com newline (canal de debug do kernel) ---- */

static JSValue prim_debugPrint(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    int i;
    (void)this_val;
    for (i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (s) {
            if (i) host_serial_puts(" ");
            host_serial_puts(s);
            JS_FreeCString(ctx, s);
        }
    }
    host_serial_puts("\n");
    return JS_UNDEFINED;
}

/* ---- os.serialWrite(s): serial crua, sem newline ---- */

static JSValue prim_serialWrite(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    const char *s;
    size_t len;
    (void)this_val; (void)argc;
    s = JS_ToCStringLen(ctx, &len, argv[0]);
    if (s) {
        host_serial_write(s, len);
        JS_FreeCString(ctx, s);
    }
    return JS_UNDEFINED;
}

/* ---- os.readBundleText(nome) / os.readBundleBytes(nome) ---- */

static JSValue prim_readBundleText(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    const char *name, *data;
    size_t size;
    (void)this_val; (void)argc;
    name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    if (host_read_file(name, &data, &size) != 0) {
        JS_FreeCString(ctx, name);
        return JS_NULL;
    }
    JS_FreeCString(ctx, name);
    return JS_NewStringLen(ctx, data, size);
}

static JSValue prim_readBundleBytes(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    const char *name, *data;
    size_t size;
    (void)this_val; (void)argc;
    name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    if (host_read_file(name, &data, &size) != 0) {
        JS_FreeCString(ctx, name);
        return JS_NULL;
    }
    JS_FreeCString(ctx, name);
    return JS_NewArrayBufferCopy(ctx, (const uint8_t *)data, size);
}

/* ---- os.listBundleFiles() ---- */

static JSValue prim_listBundleFiles(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    JSValue arr;
    uint32_t i;
    (void)this_val; (void)argc; (void)argv;
    arr = JS_NewArray(ctx);
    for (i = 0; i < jsbundle_count; i++)
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, jsbundle_files[i].name));
    return arr;
}

/* ---- os.execMachineCode(addr): chama codigo nativo (entry de PE) ---- */

static JSValue prim_execMachineCode(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    uint32_t addr;
    void (*entry)(void);
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    entry = (void (*)(void))(uintptr_t)addr;
    entry();
    return JS_UNDEFINED;
}

/* ---- os.execMsAbi(addr, a1..a4): codigo nativo na ABI MS (.sys) ----
 * Retorna o rax do convidado. Implementado em hal/win32/win32thunk.asm. */

extern uint64_t exec_msabi(uint64_t addr, uint64_t a1, uint64_t a2,
                           uint64_t a3, uint64_t a4);

static JSValue prim_execMsAbi(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    double addr, a1, a2, a3, a4;
    uint64_t r;
    (void)this_val;
    JS_ToFloat64(ctx, &addr, argv[0]);
    JS_ToFloat64(ctx, &a1, argv[1]);
    JS_ToFloat64(ctx, &a2, argv[2]);
    JS_ToFloat64(ctx, &a3, argv[3]);
    JS_ToFloat64(ctx, &a4, argv[4]);
    r = exec_msabi((uint64_t)addr, (uint64_t)a1, (uint64_t)a2,
                   (uint64_t)a3, (uint64_t)a4);
    return JS_NewFloat64(ctx, (double)r);
}

/* ---- os.getWin32ThunkTable(): endereco da tabela de trampolins ---- */

static JSValue prim_getWin32ThunkTable(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)(uintptr_t)win32_stubs);
}

/* ---- os.getWin32ThunkCount(): n. de stubs (valida ids no PE loader) ---- */

static JSValue prim_getWin32ThunkCount(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)win32_stub_max);
}

/* ---- os.getGuestArenaBase(): base da arena do heap de convidado ---- */

static JSValue prim_getGuestArenaBase(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)host_guest_arena());
}

/* ---- os.halt() ---- */

static JSValue prim_halt(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    host_serial_puts("os.halt() chamado pelo JS\n");
    host_halt();
}

const JSCFunctionListEntry jsos_system_funcs[] = {
    JS_CFUNC_DEF("debugPrint", 1, prim_debugPrint),
    JS_CFUNC_DEF("serialWrite", 1, prim_serialWrite),
    JS_CFUNC_DEF("readBundleText", 1, prim_readBundleText),
    JS_CFUNC_DEF("readBundleBytes", 1, prim_readBundleBytes),
    JS_CFUNC_DEF("listBundleFiles", 0, prim_listBundleFiles),
    JS_CFUNC_DEF("execMachineCode", 1, prim_execMachineCode),
    JS_CFUNC_DEF("execMsAbi", 5, prim_execMsAbi),
    JS_CFUNC_DEF("getWin32ThunkTable", 0, prim_getWin32ThunkTable),
    JS_CFUNC_DEF("getWin32ThunkCount", 0, prim_getWin32ThunkCount),
    JS_CFUNC_DEF("getGuestArenaBase", 0, prim_getGuestArenaBase),
    JS_CFUNC_DEF("halt", 0, prim_halt),
};
const int jsos_system_funcs_count = 11;
