/*
 * kmalloc.c - heap do kernel: lista livre first-fit (estilo K&R) sobre a RAM
 * detectada pelo E820. Heap comeca em 16MB (0x400000 fica livre para o
 * ImageBase de executaveis PE carregados pelo PE loader em JS).
 */
#include "../core/drivers.h"
#include <string.h>

#define HEAP_START  0x1000000ULL                /* 16MB */
#define RAM_CAP     0x40000000ULL               /* cap de 1GB */
#define E820_COUNT_ADDR  ((volatile uint16_t *)0x4FF0)
#define E820_TABLE_ADDR  ((const e820_entry_t *)0x5000)

typedef struct __attribute__((packed)) {
    uint64_t base;
    uint64_t length;
    uint32_t type;
    uint32_t acpi;
} e820_entry_t;

typedef struct block {
    size_t size;        /* bytes de dados (sem o header) */
    struct block *next; /* proximo bloco livre (valido se free) */
    int free;
    int _pad;
} block_t;

#define HDR_SIZE ((size_t)32) /* >= sizeof(block_t)=24, multiplo de 16 p/ alinhamento */

static block_t *free_list;
static size_t heap_total, heap_used;
static uint64_t ram_top;

static void detect_ram(void) {
    int count = *E820_COUNT_ADDR;
    const e820_entry_t *e = E820_TABLE_ADDR;
    int i;
    ram_top = 0;
    for (i = 0; i < count && i < 64; i++) {
        if (e[i].type == 1 && e[i].length) {
            uint64_t top = e[i].base + e[i].length;
            if (top > ram_top) ram_top = top;
        }
    }
    if (ram_top == 0 || ram_top > RAM_CAP) ram_top = RAM_CAP;
}

void kmalloc_init(void) {
    detect_ram();
    free_list = (block_t *)(uintptr_t)HEAP_START;
    free_list->size = (size_t)(ram_top - HEAP_START) - HDR_SIZE;
    free_list->next = 0;
    free_list->free = 1;
    heap_total = free_list->size;
    heap_used = 0;
}

void *kmalloc(size_t size) {
    block_t *b = free_list;
    size = (size + 15) & ~(size_t)15;
    while (b) {
        if (b->free && b->size >= size) {
            if (b->size >= size + HDR_SIZE + 16) {
                block_t *nb = (block_t *)((char *)b + HDR_SIZE + size);
                nb->size = b->size - size - HDR_SIZE;
                nb->next = b->next;
                nb->free = 1;
                nb->_pad = 0;
                b->size = size;
                b->next = nb;
            }
            b->free = 0;
            heap_used += b->size;
            return (char *)b + HDR_SIZE;
        }
        b = b->next;
    }
    return 0;
}

void kfree(void *ptr) {
    block_t *b;
    if (!ptr) return;
    b = (block_t *)((char *)ptr - HDR_SIZE);
    heap_used -= b->size;
    b->free = 1;
    /* coalescing simples: junta com o proximo se livre e contiguo */
    if (b->next && b->next->free &&
        (char *)b + HDR_SIZE + b->size == (char *)b->next) {
        b->size += HDR_SIZE + b->next->size;
        b->next = b->next->next;
    }
}

void kmalloc_info(size_t *total, size_t *used) {
    *total = heap_total;
    *used = heap_used;
}

uint64_t kmalloc_ram_top(void) {
    return ram_top;
}
