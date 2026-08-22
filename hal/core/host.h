/*
 * host.h - API da camada hospedeira do jsOS (bare metal x86-64).
 *
 * Unico lugar que fala direto com o hardware. O libc shim e o QuickJS
 * usam apenas estas funcoes.
 */
#ifndef JSOS_HOST_H
#define JSOS_HOST_H

#include <stddef.h>
#include <stdint.h>

/* chamado uma vez no kernel_main (serial + VGA + heap) */
void host_init(void);

/* saida de debug pela serial COM1 */
void host_serial_write(const char *s, size_t len);
void host_serial_puts(const char *s);

/* saida na tela (VGA texto 80x25) */
void host_screen_puts(const char *s);

/* ambos (serial + tela) */
void host_log(const char *s);

/* heap do kernel (K&R sobre a RAM detectada via E820) */
void  host_pool_alloc(void **out, size_t size);
void  host_pool_free(void *ptr);
void  host_heap_info(size_t *total, size_t *used);

/* I/O de porta */
void     host_outb(uint16_t port, uint8_t val);
uint8_t  host_inb(uint16_t port);
uint16_t host_inw(uint16_t port);
void     host_outl(uint16_t port, uint32_t val);
uint32_t host_inl(uint16_t port);

/* teclado: -1 se vazio (scancode traduzido p/ ASCII; setas = 0x100+) */
int host_getkey(void);

/* tempo via RTC CMOS */
void host_get_time(int *year, int *month, int *day,
                   int *hour, int *min, int *sec);

/* le arquivo do bundle JS embutido. Retorna 0 se achou. */
int  host_read_file(const char *name, const char **out_buf, size_t *out_size);

/* RAM total detectada via E820 (bytes) */
uint64_t host_ram_size(void);

/* arena de 16MB para o heap dos drivers convidados (base fisica) */
uint64_t host_guest_arena(void);

/* panico: mensagem + halt */
void host_panic(const char *msg) __attribute__((noreturn));

/* halt eterno */
void host_halt(void) __attribute__((noreturn));

#endif
