/* string.c - implementacao do libc shim do jsOS */
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include "../core/host.h"

static void memcpy_guard_hex(uint64_t v) {
    char buf[17];
    int i;
    for (i = 15; i >= 0; i--) { buf[i] = "0123456789abcdef"[v & 0xF]; v >>= 4; }
    host_serial_write(buf, 16);
}

void *memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = dst;
    const unsigned char *s = src;
    size_t i;
    /* copia > 1GB e' impossivel com 4GB de RAM: ponteiro/tamanho corrompido
       a montante — diagnostico claro em vez de um #PF criptico no meio */
    if (n > 1024u * 1024 * 1024) {
        host_serial_puts("MEMCPY GIGANTE n=0x");
        memcpy_guard_hex((uint64_t)n);
        host_serial_puts(" dst=0x");
        memcpy_guard_hex((uint64_t)(uintptr_t)dst);
        host_serial_puts(" src=0x");
        memcpy_guard_hex((uint64_t)(uintptr_t)src);
        host_serial_puts(" caller=0x");
        memcpy_guard_hex((uint64_t)(uintptr_t)__builtin_return_address(0));
        host_serial_puts("\n");
        host_halt();
    }
    for (i = 0; i < n; i++) d[i] = s[i];
    return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
    unsigned char *d = dst;
    const unsigned char *s = src;
    if (d < s) {
        size_t i;
        for (i = 0; i < n; i++) d[i] = s[i];
    } else if (d > s) {
        while (n--) d[n] = s[n];
    }
    return dst;
}

void *memset(void *dst, int c, size_t n) {
    unsigned char *d = dst;
    size_t i;
    for (i = 0; i < n; i++) d[i] = (unsigned char)c;
    return dst;
}

int memcmp(const void *a, const void *b, size_t n) {
    const unsigned char *x = a, *y = b;
    size_t i;
    for (i = 0; i < n; i++)
        if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

void *memchr(const void *s, int c, size_t n) {
    const unsigned char *p = s;
    size_t i;
    for (i = 0; i < n; i++)
        if (p[i] == (unsigned char)c) return (void *)(p + i);
    return 0;
}

size_t strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return (size_t)(p - s);
}

size_t strnlen(const char *s, size_t maxlen) {
    size_t n = 0;
    while (n < maxlen && s[n]) n++;
    return n;
}

char *strcpy(char *dst, const char *src) {
    char *d = dst;
    while ((*d++ = *src++)) { }
    return dst;
}

char *strncpy(char *dst, const char *src, size_t n) {
    size_t i;
    for (i = 0; i < n && src[i]; i++) dst[i] = src[i];
    for (; i < n; i++) dst[i] = 0;
    return dst;
}

char *strcat(char *dst, const char *src) {
    strcpy(dst + strlen(dst), src);
    return dst;
}

char *strncat(char *dst, const char *src, size_t n) {
    char *d = dst + strlen(dst);
    size_t i;
    for (i = 0; i < n && src[i]; i++) d[i] = src[i];
    d[i] = 0;
    return dst;
}

int strcmp(const char *a, const char *b) {
    while (*a && *a == *b) { a++; b++; }
    return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n) {
    size_t i;
    for (i = 0; i < n; i++) {
        if (a[i] != b[i]) return (unsigned char)a[i] - (unsigned char)b[i];
        if (!a[i]) break;
    }
    return 0;
}

static int to_lower(int c) {
    return (c >= 'A' && c <= 'Z') ? c + 32 : c;
}

int strcasecmp(const char *a, const char *b) {
    while (*a && to_lower((unsigned char)*a) == to_lower((unsigned char)*b)) { a++; b++; }
    return to_lower((unsigned char)*a) - to_lower((unsigned char)*b);
}

int strncasecmp(const char *a, const char *b, size_t n) {
    size_t i;
    for (i = 0; i < n; i++) {
        int x = to_lower((unsigned char)a[i]), y = to_lower((unsigned char)b[i]);
        if (x != y) return x - y;
        if (!x) break;
    }
    return 0;
}

char *strchr(const char *s, int c) {
    while (*s) {
        if (*s == (char)c) return (char *)s;
        s++;
    }
    return (c == 0) ? (char *)s : 0;
}

char *strrchr(const char *s, int c) {
    const char *last = 0;
    do {
        if (*s == (char)c) last = s;
    } while (*s++);
    return (char *)last;
}

char *strstr(const char *hay, const char *needle) {
    size_t nl = strlen(needle);
    if (!nl) return (char *)hay;
    while (*hay) {
        if (*hay == *needle && strncmp(hay, needle, nl) == 0)
            return (char *)hay;
        hay++;
    }
    return 0;
}

size_t strspn(const char *s, const char *accept) {
    size_t n = 0;
    while (s[n] && strchr(accept, s[n])) n++;
    return n;
}

size_t strcspn(const char *s, const char *reject) {
    size_t n = 0;
    while (s[n] && !strchr(reject, s[n])) n++;
    return n;
}

char *strdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

char *strndup(const char *s, size_t n) {
    size_t len = strnlen(s, n);
    char *p = malloc(len + 1);
    if (p) { memcpy(p, s, len); p[len] = 0; }
    return p;
}
