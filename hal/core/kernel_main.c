/*
 * kernel_main.c - entrada 64-bit do jsOS (saltada pelo stage2 em 0x100000).
 *
 * Minimo proposital: zera o BSS, sobe o host (serial+heap), inicializa o
 * engine QuickJS e entrega o controle ao kernel JavaScript (main.js).
 * Todo o resto do sistema e JS.
 */
#include "host.h"
#include "../qjs/quickjs_host.h"

extern char __bss_start[], __bss_end[];

__attribute__((section(".text.boot"), used))
void kernel_main(void) {
    char *p;
    for (p = __bss_start; p < __bss_end; p++)
        *p = 0;

    host_init();

    host_serial_puts("[jsOS] kernel 64-bit vivo (BIOS real mode -> long mode)\n");
    host_serial_puts("HELLO_KERNEL_OK\n");

    js_host_init();

    /* kernel JavaScript: system32/init/main.js do bundle embutido */
    {
        const char *code;
        size_t size;
        if (host_read_file("system32/init/main.js", &code, &size) != 0)
            host_panic("system32/init/main.js nao encontrado no bundle");
        if (!js_host_run(code, "system32/init/main.js"))
            host_panic("excecao no kernel JS");
    }

    host_halt();
}
