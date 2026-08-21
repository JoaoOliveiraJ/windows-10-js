/*
 * engine.c - hospeda o engine QuickJS e registra o objeto global `os`.
 *
 * O C so oferece primitivas brutas (ver jsos.h); TODO o resto do sistema -
 * drivers, console, shell, syscalls, VFS, escalonador - e JavaScript.
 */
#include "jsos.h"
#include <string.h>
#include <stdio.h>

static JSRuntime *g_rt;
static JSContext *g_ctx;

/* ---- registro do objeto global os.* ---- */

void js_host_init(void) {
    JSValue os, global;
    g_rt = JS_NewRuntime();
    if (!g_rt) host_panic("JS_NewRuntime falhou");
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx) host_panic("JS_NewContext falhou");
    global = JS_GetGlobalObject(g_ctx);
    os = JS_NewObject(g_ctx);
    JS_SetPropertyFunctionList(g_ctx, os, jsos_ports_funcs, jsos_ports_funcs_count);
    JS_SetPropertyFunctionList(g_ctx, os, jsos_memory_funcs, jsos_memory_funcs_count);
    JS_SetPropertyFunctionList(g_ctx, os, jsos_system_funcs, jsos_system_funcs_count);
    JS_SetPropertyFunctionList(g_ctx, os, jsos_irq_funcs, jsos_irq_funcs_count);
    JS_SetPropertyStr(g_ctx, global, "os", os);
    JS_FreeValue(g_ctx, global);
}

/* imprime excecao JS pendente (mensagem + stack) */
void jsos_dump_exception(JSContext *ctx) {
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
        jsos_dump_exception(g_ctx);
        JS_FreeValue(g_ctx, r);
        return 0;
    }
    JS_FreeValue(g_ctx, r);
    return 1;
}

JSContext *js_host_ctx(void) {
    return g_ctx;
}

/* ---- js_win32_dispatch: chamado pelo trampolim asm; despacha p/ JS ----
 * ids 0-31: kernel32 (Win32.handle); ids 32-63: ntoskrnl (Ntoskrnl.handle) */

uint64_t js_win32_dispatch(uint64_t id, uint64_t a1, uint64_t a2,
                           uint64_t a3, uint64_t a4) {
    JSValue global, table, handle, args[5], ret;
    const char *tableName;
    int64_t r = 0;
    int i;
    uint64_t raw[5] = { id, a1, a2, a3, a4 };

    if (!g_ctx) return 0;
    if (id >= 32) {
        tableName = "Ntoskrnl";
        raw[0] = id - 32;
    } else {
        tableName = "Win32";
    }
    global = JS_GetGlobalObject(g_ctx);
    table = JS_GetPropertyStr(g_ctx, global, tableName);
    if (!JS_IsObject(table)) { JS_FreeValue(g_ctx, table); JS_FreeValue(g_ctx, global); return 0; }
    handle = JS_GetPropertyStr(g_ctx, table, "handle");
    for (i = 0; i < 5; i++)
        args[i] = JS_NewFloat64(g_ctx, (double)raw[i]);
    ret = JS_Call(g_ctx, handle, table, 5, (JSValueConst *)args);
    if (JS_IsException(ret)) {
        jsos_dump_exception(g_ctx);
    } else {
        JS_ToInt64(g_ctx, &r, ret);
    }
    JS_FreeValue(g_ctx, ret);
    for (i = 0; i < 5; i++) JS_FreeValue(g_ctx, args[i]);
    JS_FreeValue(g_ctx, handle);
    JS_FreeValue(g_ctx, table);
    JS_FreeValue(g_ctx, global);
    return (uint64_t)r;
}
