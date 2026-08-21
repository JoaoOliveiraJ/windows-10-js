/* drivers.h - suporte de hardware do kernel jsOS (o resto dos drivers e JS) */
#ifndef JSOS_DRIVERS_H
#define JSOS_DRIVERS_H

#include <stddef.h>
#include <stdint.h>

/* kmalloc.c - heap K&R; E820 lido de 0x4FF0/0x5000 (gravado pelo stage2) */
void     kmalloc_init(void);
void    *kmalloc(size_t size);
void     kfree(void *ptr);
void     kmalloc_info(size_t *total, size_t *used);
uint64_t kmalloc_ram_top(void);

/* rtc.c - relogio CMOS (usado pelo libc p/ Date do JS) */
void rtc_read(int *year, int *month, int *day, int *hour, int *min, int *sec);

#endif
