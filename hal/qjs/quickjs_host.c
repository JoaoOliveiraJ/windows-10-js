/*
 * quickjs_host.c - hospeda o engine QuickJS e expoe as primitivas `os.*`.
 *
 * A filosofia: o C oferece so primitivas brutas (porta de I/O, peek/poke de
 * memoria fisica, heap, arquivo embutido). TODO o resto do sistema -
 * drivers, console, shell, syscalls, VFS, escalonador - e JavaScript.
 */
#include "quickjs.h"
#include "../core/host.h"
#include <string.h>
#include <stdio.h>

/* bundle embutido (gerado em build/generated/jsbundle.c) */
typedef struct { const char *name; const char *data; uint32_t size; } jsbundle_file_t;
extern const jsbundle_file_t jsbundle_files[];
extern const uint32_t jsbundle_count;

/* trampolins Win32 (hal/win32/win32thunk.asm) */
extern const uint8_t win32_stubs[];

static JSRuntime *g_rt;
static JSContext *g_ctx;

static void dump_exception(JSContext *ctx);

/* ---- helpers ---- */

static void out_str(const char *s) {
    host_serial_puts(s);
}

/* ---- os.print(...): canal principal (serial; a tela VGA e JS) ---- */

static JSValue js_os_print(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    int i;
    (void)this_val;
    for (i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (s) {
            if (i) out_str(" ");
            out_str(s);
            JS_FreeCString(ctx, s);
        }
    }
    out_str("\n");
    return JS_UNDEFINED;
}

/* ---- os.outb(port, value) / os.inb(port) ---- */

static JSValue js_os_outb(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    uint32_t port, val;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    JS_ToUint32(ctx, &val, argv[1]);
    host_outb((uint16_t)port, (uint8_t)val);
    return JS_UNDEFINED;
}

static JSValue js_os_inb(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    uint32_t port;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &port, argv[0]);
    return JS_NewUint32(ctx, host_inb((uint16_t)port));
}

/* ---- os.poke8/16/32(addr, v) / os.peek8/16/32(addr): memoria fisica ---- */

static JSValue js_os_poke(JSContext *ctx, JSValueConst this_val,
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

static JSValue js_os_peek(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv, int width) {
    uint32_t addr;
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    if (width == 8)       return JS_NewUint32(ctx, *(volatile uint8_t *)(uintptr_t)addr);
    else if (width == 16) return JS_NewUint32(ctx, *(volatile uint16_t *)(uintptr_t)addr);
    else                  return JS_NewUint32(ctx, *(volatile uint32_t *)(uintptr_t)addr);
}

static JSValue js_os_poke8(JSContext *c, JSValueConst t, int n, JSValueConst *a)  { return js_os_poke(c, t, n, a, 8); }
static JSValue js_os_poke16(JSContext *c, JSValueConst t, int n, JSValueConst *a) { return js_os_poke(c, t, n, a, 16); }
static JSValue js_os_poke32(JSContext *c, JSValueConst t, int n, JSValueConst *a) { return js_os_poke(c, t, n, a, 32); }
static JSValue js_os_peek8(JSContext *c, JSValueConst t, int n, JSValueConst *a)  { return js_os_peek(c, t, n, a, 8); }
static JSValue js_os_peek16(JSContext *c, JSValueConst t, int n, JSValueConst *a) { return js_os_peek(c, t, n, a, 16); }
static JSValue js_os_peek32(JSContext *c, JSValueConst t, int n, JSValueConst *a) { return js_os_peek(c, t, n, a, 32); }

/* ---- os.readFile(nome): arquivo do bundle embutido ---- */

static JSValue js_os_readFile(JSContext *ctx, JSValueConst this_val,
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

/* ---- os.ramSize() / os.heapInfo() ---- */

static JSValue js_os_ramSize(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)host_ram_size());
}

static JSValue js_os_heapInfo(JSContext *ctx, JSValueConst this_val,
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

/* ---- os.listBundle(): nomes dos arquivos embutidos ---- */

static JSValue js_os_listBundle(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    JSValue arr;
    uint32_t i;
    (void)this_val; (void)argc; (void)argv;
    arr = JS_NewArray(ctx);
    for (i = 0; i < jsbundle_count; i++)
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, jsbundle_files[i].name));
    return arr;
}

/* ---- os.readFileBytes(nome): binario como ArrayBuffer (para .exe) ---- */

static JSValue js_os_readFileBytes(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    const char *name, *data;
    size_t size;
    JSValue ab;
    (void)this_val; (void)argc;
    name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;
    if (host_read_file(name, &data, &size) != 0) {
        JS_FreeCString(ctx, name);
        return JS_NULL;
    }
    JS_FreeCString(ctx, name);
    ab = JS_NewArrayBufferCopy(ctx, (const uint8_t *)data, size);
    return ab;
}

/* ---- os.write(s): serial crua, sem newline (saida de programas) ---- */

static JSValue js_os_write(JSContext *ctx, JSValueConst this_val,
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

/* ---- os.execAt(addr): chama codigo nativo (entry de .exe PE) ---- */

static JSValue js_os_execAt(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    uint32_t addr;
    void (*entry)(void);
    (void)this_val; (void)argc;
    JS_ToUint32(ctx, &addr, argv[0]);
    entry = (void (*)(void))(uintptr_t)addr;
    entry();
    return JS_UNDEFINED;
}

/* ---- os.win32ThunkBase(): endereco da tabela de trampolins ---- */

static JSValue js_os_win32ThunkBase(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)(uintptr_t)win32_stubs);
}

/* ---- js_win32_dispatch: chamado pelo trampolim asm; despacha p/ JS ---- */

uint64_t js_win32_dispatch(uint64_t id, uint64_t a1, uint64_t a2,
                           uint64_t a3, uint64_t a4) {
    JSValue global, win32, handle, args[5], ret;
    int64_t r = 0;
    int i;
    uint64_t raw[5] = { id, a1, a2, a3, a4 };

    if (!g_ctx) return 0;
    global = JS_GetGlobalObject(g_ctx);
    win32 = JS_GetPropertyStr(g_ctx, global, "Win32");
    if (!JS_IsObject(win32)) { JS_FreeValue(g_ctx, win32); JS_FreeValue(g_ctx, global); return 0; }
    handle = JS_GetPropertyStr(g_ctx, win32, "handle");
    for (i = 0; i < 5; i++)
        args[i] = JS_NewFloat64(g_ctx, (double)raw[i]);
    ret = JS_Call(g_ctx, handle, win32, 5, (JSValueConst *)args);
    if (JS_IsException(ret)) {
        dump_exception(g_ctx);
    } else {
        JS_ToInt64(g_ctx, &r, ret);
    }
    JS_FreeValue(g_ctx, ret);
    for (i = 0; i < 5; i++) JS_FreeValue(g_ctx, args[i]);
    JS_FreeValue(g_ctx, handle);
    JS_FreeValue(g_ctx, win32);
    JS_FreeValue(g_ctx, global);
    return (uint64_t)r;
}

/* ---- os.halt() ---- */

static JSValue js_os_halt(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    host_serial_puts("os.halt() chamado pelo JS\n");
    host_halt();
}

/* ---- registro ---- */

static const JSCFunctionListEntry os_funcs[] = {
    JS_CFUNC_DEF("print", 1, js_os_print),
    JS_CFUNC_DEF("outb", 2, js_os_outb),
    JS_CFUNC_DEF("inb", 1, js_os_inb),
    JS_CFUNC_DEF("poke8", 2, js_os_poke8),
    JS_CFUNC_DEF("poke16", 2, js_os_poke16),
    JS_CFUNC_DEF("poke32", 2, js_os_poke32),
    JS_CFUNC_DEF("peek8", 1, js_os_peek8),
    JS_CFUNC_DEF("peek16", 1, js_os_peek16),
    JS_CFUNC_DEF("peek32", 1, js_os_peek32),
    JS_CFUNC_DEF("readFile", 1, js_os_readFile),
    JS_CFUNC_DEF("readFileBytes", 1, js_os_readFileBytes),
    JS_CFUNC_DEF("write", 1, js_os_write),
    JS_CFUNC_DEF("execAt", 1, js_os_execAt),
    JS_CFUNC_DEF("win32ThunkBase", 0, js_os_win32ThunkBase),
    JS_CFUNC_DEF("listBundle", 0, js_os_listBundle),
    JS_CFUNC_DEF("ramSize", 0, js_os_ramSize),
    JS_CFUNC_DEF("heapInfo", 0, js_os_heapInfo),
    JS_CFUNC_DEF("halt", 0, js_os_halt),
};

void js_host_init(void) {
    JSValue os, global;
    g_rt = JS_NewRuntime();
    if (!g_rt) host_panic("JS_NewRuntime falhou");
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx) host_panic("JS_NewContext falhou");
    global = JS_GetGlobalObject(g_ctx);
    os = JS_NewObject(g_ctx);
    JS_SetPropertyFunctionList(g_ctx, os, os_funcs,
                               sizeof(os_funcs) / sizeof(os_funcs[0]));
    JS_SetPropertyStr(g_ctx, global, "os", os);
    JS_FreeValue(g_ctx, global);
}

/* imprime excecao JS pendente (mensagem + stack) */
static void dump_exception(JSContext *ctx) {
    JSValue ex = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, ex);
    host_serial_puts("EXCECAO JS: ");
    host_serial_puts(msg ? msg : "(?)");
    host_serial_puts("\n");
    if (msg) JS_FreeCString(ctx, msg);
    if (JS_IsObject(ex)) {
        JSValue st = JS_GetPropertyStr(ctx, ex, "stack");
        const char *s = JS_ToCString(ctx, st);
        if (s) { host_serial_puts(s); host_serial_puts("\n"); JS_FreeCString(ctx, s); }
        JS_FreeValue(ctx, st);
    }
    JS_FreeValue(ctx, ex);
}

/* executa codigo JS; retorna 1 se ok */
int js_host_run(const char *code, const char *filename) {
    JSValue r = JS_Eval(g_ctx, code, strlen(code), filename, JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        dump_exception(g_ctx);
        JS_FreeValue(g_ctx, r);
        return 0;
    }
    JS_FreeValue(g_ctx, r);
    return 1;
}

JSContext *js_host_ctx(void) {
    return g_ctx;
}
