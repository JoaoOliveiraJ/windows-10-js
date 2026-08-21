/*
 * host.c - camada hospedeira bare metal do jsOS.
 *
 * Propositalmente minima: serial (debug), I/O de porta, peek/poke de
 * memoria fisica, heap (para o engine JS), RTC cru e o bundle JS embutido.
 * TODO o resto do sistema (drivers, console, shell, syscalls...) e JS.
 */
#include "host.h"
#include "drivers.h"
#include <string.h>

/* ---- I/O de porta ---- */

void host_outb(uint16_t port, uint8_t val) {
    __asm__ volatile("outb %0, %1" :: "a"(val), "Nd"(port));
}

uint8_t host_inb(uint16_t port) {
    uint8_t v;
    __asm__ volatile("inb %1, %0" : "=a"(v) : "Nd"(port));
    return v;
}

uint16_t host_inw(uint16_t port) {
    uint16_t v;
    __asm__ volatile("inw %1, %0" : "=a"(v) : "Nd"(port));
    return v;
}

/* ---- serial COM1 (debug) ---- */

#define COM1 ((uint16_t)0x3F8)

static void serial_init(void) {
    host_outb(COM1 + 1, 0x00);
    host_outb(COM1 + 3, 0x80);
    host_outb(COM1 + 0, 0x03);
    host_outb(COM1 + 1, 0x00);
    host_outb(COM1 + 3, 0x03);
    host_outb(COM1 + 2, 0xC7);
    host_outb(COM1 + 4, 0x0B);
}

static void serial_putc(char c) {
    while ((host_inb(COM1 + 5) & 0x20) == 0) { }
    host_outb(COM1, (uint8_t)c);
}

void host_serial_write(const char *s, size_t len) {
    size_t i;
    for (i = 0; i < len; i++) {
        if (s[i] == '\n') serial_putc('\r');
        serial_putc(s[i]);
    }
}

void host_serial_puts(const char *s) {
    while (*s) {
        if (*s == '\n') serial_putc('\r');
        serial_putc(*s++);
    }
}

/* ---- tela: delegada ao driver VGA em JS; aqui so o buffer bruto ---- */

void host_screen_puts(const char *s) {
    /* usado so antes do kernel JS subir (boot/panico): vai p/ serial */
    host_serial_puts(s);
}

void host_log(const char *s) {
    host_serial_puts(s);
}

/* ---- heap (motor + primitivas JS) ---- */

void host_pool_alloc(void **out, size_t size) {
    void *p = kmalloc(size);
    if (!p) host_panic("heap esgotado");
    *out = p;
}

void host_pool_free(void *ptr) {
    kfree(ptr);
}

void host_heap_info(size_t *total, size_t *used) {
    kmalloc_info(total, used);
}

uint64_t host_ram_size(void) {
    return kmalloc_ram_top();
}

/* ---- tempo ---- */

void host_get_time(int *year, int *month, int *day,
                   int *hour, int *min, int *sec) {
    rtc_read(year, month, day, hour, min, sec);
}

/* ---- bundle JS embutido (gerado pelo build) ---- */

typedef struct {
    const char *name;
    const char *data;
    uint32_t size;
} jsbundle_file_t;

extern const jsbundle_file_t jsbundle_files[];
extern const uint32_t jsbundle_count;

int host_read_file(const char *name, const char **out_buf, size_t *out_size) {
    uint32_t i;
    for (i = 0; i < jsbundle_count; i++) {
        if (strcmp(jsbundle_files[i].name, name) == 0) {
            *out_buf = jsbundle_files[i].data;
            *out_size = jsbundle_files[i].size;
            return 0;
        }
    }
    return -1;
}

void host_halt(void) {
    __asm__ volatile("cli");
    for (;;) __asm__ volatile("hlt");
}

void host_panic(const char *msg) {
    host_serial_puts("\n*** PANIC: ");
    host_serial_puts(msg);
    host_serial_puts(" ***\n");
    host_halt();
}

static uint64_t guest_arena_base;

void host_init(void) {
    serial_init();
    kmalloc_init();
    /* arena de 16MB para o heap dos drivers convidados (dentro do heap do
     * kernel, que comeca em 32MB): sub-alocada pelo free-list em JS */
    guest_arena_base = (uint64_t)(uintptr_t)kmalloc(16u << 20);
    if (!guest_arena_base) host_panic("arena de convidado falhou");
}

/* ---- arena do heap de convidado (drivers) ---- */

uint64_t host_guest_arena(void) {
    return guest_arena_base;
}
