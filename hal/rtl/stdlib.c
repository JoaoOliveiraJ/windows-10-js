/*
 * stdlib.c - libc shim do jsOS.
 * malloc usa o pool UEFI (AllocatePool) com cabecalho de 16 bytes
 * guardando o tamanho, para realloc/free funcionarem.
 */
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "../core/host.h"

typedef struct {
    uint64_t magic;
    uint64_t size;
} alloc_hdr_t;

#define ALLOC_MAGIC 0x4A534F534D454D31ULL /* "JSOSMEM1" */

void *malloc(size_t size) {
    void *raw;
    alloc_hdr_t *h;
    host_pool_alloc(&raw, size + sizeof(alloc_hdr_t));
    h = raw;
    h->magic = ALLOC_MAGIC;
    h->size = size;
    return (void *)(h + 1);
}

void free(void *ptr) {
    if (!ptr) return;
    host_pool_free((alloc_hdr_t *)ptr - 1);
}

size_t malloc_usable_size(void *ptr) {
    alloc_hdr_t *h;
    if (!ptr) return 0;
    h = (alloc_hdr_t *)ptr - 1;
    if (h->magic != ALLOC_MAGIC) return 0;
    return (size_t)h->size;
}

void *calloc(size_t nmemb, size_t size) {
    size_t total = nmemb * size;
    void *p = malloc(total);
    memset(p, 0, total);
    return p;
}

static void realloc_diag_hex(uint64_t v) {
    char buf[17];
    int i;
    for (i = 15; i >= 0; i--) { buf[i] = "0123456789abcdef"[v & 0xF]; v >>= 4; }
    host_serial_write(buf, 16);
}

void *realloc(void *ptr, size_t size) {
    alloc_hdr_t *h;
    void *np;
    size_t old;
    if (!ptr) return malloc(size);
    h = (alloc_hdr_t *)ptr - 1;
    /* magic invalido = ponteiro selvagem/double-free; size > 1GB e'
       impossivel com 4GB de RAM (cabecalho sobrescrito) — como o pool
       tagging do NT, falha alto com diagnostico em vez de corromper mais */
    if (h->magic != ALLOC_MAGIC || h->size > 1024u * 1024 * 1024) {
        /* cabecalho invalido: ponteiro selvagem ou heap corrompido */
        host_serial_puts("REALLOC CORROMPIDO ptr=0x");
        realloc_diag_hex((uint64_t)(uintptr_t)ptr);
        host_serial_puts(" magic=0x");
        realloc_diag_hex(h->magic);
        host_serial_puts(" size=0x");
        realloc_diag_hex(h->size);
        host_serial_puts(" novo=0x");
        realloc_diag_hex((uint64_t)size);
        host_serial_puts(" caller=0x");
        realloc_diag_hex((uint64_t)(uintptr_t)__builtin_return_address(0));
        host_serial_puts("\n");
        host_halt();
    }
    old = h->size;
    if (size <= old && size + 64 >= old) {
        h->size = size;
        return ptr;
    }
    np = malloc(size);
    memcpy(np, ptr, old < size ? old : size);
    free(ptr);
    return np;
}

void abort(void) {
    host_panic("abort()");
}

void exit(int code) {
    (void)code;
    host_panic("exit() chamado");
}

int abs(int x)            { return x < 0 ? -x : x; }
long labs(long x)         { return x < 0 ? -x : x; }
long long llabs(long long x) { return x < 0 ? -x : x; }

int atoi(const char *s) { return (int)strtol(s, 0, 10); }
long atol(const char *s) { return strtol(s, 0, 10); }

static int digit_val(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'z') return c - 'a' + 10;
    if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
    return -1;
}

unsigned long long strtoull(const char *s, char **end, int base) {
    unsigned long long v = 0;
    int neg = 0, any = 0, d;
    while (isspace((unsigned char)*s)) s++;
    if (*s == '+') s++;
    else if (*s == '-') { neg = 1; s++; }
    if ((base == 0 || base == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
        s += 2;
        if (base == 0) base = 16;
    } else if (base == 0) {
        base = (s[0] == '0') ? 8 : 10;
    }
    if (base == 8 && s[0] == '0') { s++; any = 1; }
    while ((d = digit_val((unsigned char)*s)) >= 0 && d < base) {
        v = v * (unsigned)base + (unsigned)d;
        s++;
        any = 1;
    }
    if (end) *end = (char *)(any ? s : s - (neg ? 1 : 0));
    return neg ? ~v + 1 : v;
}

long long strtoll(const char *s, char **end, int base) {
    return (long long)strtoull(s, end, base);
}

long strtol(const char *s, char **end, int base) {
    return (long)strtoull(s, end, base);
}

unsigned long strtoul(const char *s, char **end, int base) {
    return (unsigned long)strtoull(s, end, base);
}

/*
 * strtod simplificado: parse decimal + expoente. Precisao suficiente para o
 * uso interno; a conversao de numeros JS e feita pelo dtoa do QuickJS.
 */
double strtod(const char *s, char **end) {
    double v = 0.0, frac_scale = 1.0;
    int neg = 0, exp_neg = 0, exp_val = 0, any = 0, i;
    while (isspace((unsigned char)*s)) s++;
    if (*s == '+') s++;
    else if (*s == '-') { neg = 1; s++; }
    /* hex float: 0x1.fp3 */
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
        const char *p = s + 2;
        int hd;
        while ((hd = digit_val((unsigned char)*p)) >= 0 && hd < 16) {
            v = v * 16.0 + hd; p++; any = 1;
        }
        if (*p == '.') {
            p++;
            while ((hd = digit_val((unsigned char)*p)) >= 0 && hd < 16) {
                frac_scale /= 16.0; v += hd * frac_scale; p++; any = 1;
            }
        }
        if (any && (*p == 'p' || *p == 'P')) {
            p++;
            if (*p == '+') p++;
            else if (*p == '-') { exp_neg = 1; p++; }
            while (isdigit((unsigned char)*p)) { exp_val = exp_val * 10 + (*p - '0'); p++; }
        }
        for (i = 0; i < exp_val; i++) v = exp_neg ? v / 2.0 : v * 2.0;
        if (end) *end = (char *)(any ? p : s);
        return neg ? -v : v;
    }
    while (isdigit((unsigned char)*s)) { v = v * 10.0 + (*s - '0'); s++; any = 1; }
    if (*s == '.') {
        s++;
        while (isdigit((unsigned char)*s)) {
            frac_scale /= 10.0; v += (*s - '0') * frac_scale; s++; any = 1;
        }
    }
    if (any && (*s == 'e' || *s == 'E')) {
        s++;
        if (*s == '+') s++;
        else if (*s == '-') { exp_neg = 1; s++; }
        while (isdigit((unsigned char)*s)) { exp_val = exp_val * 10 + (*s - '0'); s++; }
    }
    for (i = 0; i < exp_val; i++) v = exp_neg ? v / 10.0 : v * 10.0;
    if (end) *end = (char *)s;
    return neg ? -v : v;
}

float strtof(const char *s, char **end)       { return (float)strtod(s, end); }
long double strtold(const char *s, char **end) { return (long double)strtod(s, end); }

char *getenv(const char *name) {
    (void)name;
    return 0;
}

/* insertion sort simples: suficiente para o uso interno */
void qsort(void *base, size_t nmemb, size_t size,
           int (*cmp)(const void *, const void *)) {
    unsigned char *b = base, *tmp;
    size_t i, j;
    if (nmemb < 2) return;
    tmp = malloc(size);
    for (i = 1; i < nmemb; i++) {
        memcpy(tmp, b + i * size, size);
        for (j = i; j > 0 && cmp(b + (j - 1) * size, tmp) > 0; j--)
            memcpy(b + j * size, b + (j - 1) * size, size);
        memcpy(b + j * size, tmp, size);
    }
    free(tmp);
}
