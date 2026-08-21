/*
 * stdio.c - libc shim do jsOS: printf vai para a serial.
 * vsnprintf suporta %c %s %d %i %u %x %X %o %p %f %g com width/precision
 * basicos e modificadores l/ll/z.
 */
#include <stdio.h>
#include <string.h>
#include "../core/host.h"

FILE *stdout;
FILE *stderr;
FILE *stdin;

typedef struct {
    char *buf;
    size_t size;
    size_t pos;
} outctx_t;

static void emit(outctx_t *o, char c) {
    if (o->buf) {
        if (o->pos + 1 < o->size || o->size == 0) {
            if (o->size != 0) o->buf[o->pos] = c;
        }
        o->pos++;
    }
}

static void emit_str(outctx_t *o, const char *s) {
    while (*s) emit(o, *s++);
}

static void emit_ull(outctx_t *o, unsigned long long v, int base,
                     int upper, int neg, int width, char pad) {
    char tmp[32];
    int i = 0, len;
    if (v == 0) tmp[i++] = '0';
    while (v) {
        int d = (int)(v % (unsigned)base);
        tmp[i++] = (char)(d < 10 ? '0' + d : (upper ? 'A' : 'a') + d - 10);
        v /= (unsigned)base;
    }
    len = i + neg;
    while (len < width) { emit(o, pad); len++; }
    if (neg) emit(o, '-');
    while (i) emit(o, tmp[--i]);
}

static void emit_double(outctx_t *o, double x, int precision) {
    unsigned long long ip, fp;
    int i;
    if (x < 0) { emit(o, '-'); x = -x; }
    ip = (unsigned long long)x;
    emit_ull(o, ip, 10, 0, 0, 0, ' ');
    emit(o, '.');
    x -= (double)ip;
    for (i = 0; i < precision; i++) x *= 10.0;
    fp = (unsigned long long)(x + 0.5);
    {
        char tmp[32];
        int n = 0;
        if (fp == 0) tmp[n++] = '0';
        while (fp) { tmp[n++] = (char)('0' + fp % 10); fp /= 10; }
        while (n < precision) tmp[n++] = '0';
        while (n) emit(o, tmp[--n]);
    }
}

int vsnprintf(char *buf, size_t size, const char *fmt, va_list ap) {
    outctx_t o = { buf, size, 0 };
    while (*fmt) {
        char c = *fmt++;
        if (c != '%') { emit(&o, c); continue; }
        {
            int width = 0, precision = 6, has_prec = 0;
            char pad = ' ';
            int lcount = 0, zflag = 0;
            c = *fmt++;
            if (c == '%') { emit(&o, '%'); continue; }
            if (c == '0') { pad = '0'; c = *fmt++; }
            while (c >= '0' && c <= '9') { width = width * 10 + (c - '0'); c = *fmt++; }
            if (c == '.') {
                has_prec = 1; precision = 0; c = *fmt++;
                while (c >= '0' && c <= '9') { precision = precision * 10 + (c - '0'); c = *fmt++; }
            }
            while (c == 'l') { lcount++; c = *fmt++; }
            if (c == 'z') { zflag = 1; c = *fmt++; }
            (void)has_prec; (void)zflag;
            switch (c) {
            case 'd': case 'i': {
                long long v = lcount >= 2 ? va_arg(ap, long long)
                            : lcount == 1 ? va_arg(ap, long) : va_arg(ap, int);
                emit_ull(&o, v < 0 ? (unsigned long long)(~v + 1) : (unsigned long long)v,
                         10, 0, v < 0, width, pad);
                break;
            }
            case 'u': case 'x': case 'X': case 'o': {
                unsigned long long v = lcount >= 2 ? va_arg(ap, unsigned long long)
                                     : lcount == 1 ? va_arg(ap, unsigned long)
                                     : va_arg(ap, unsigned int);
                int base = c == 'u' ? 10 : c == 'o' ? 8 : 16;
                emit_ull(&o, v, base, c == 'X', 0, width, pad);
                break;
            }
            case 'p': {
                unsigned long long v = (unsigned long long)(uintptr_t)va_arg(ap, void *);
                emit_str(&o, "0x");
                emit_ull(&o, v, 16, 0, 0, width, pad);
                break;
            }
            case 'c':
                emit(&o, (char)va_arg(ap, int));
                break;
            case 's': {
                const char *s = va_arg(ap, const char *);
                emit_str(&o, s ? s : "(null)");
                break;
            }
            case 'f': case 'g': case 'e':
                emit_double(&o, va_arg(ap, double), precision);
                break;
            default:
                emit(&o, '%');
                emit(&o, c);
                break;
            }
        }
    }
    if (buf && size) {
        buf[o.pos < size ? o.pos : size - 1] = 0;
    }
    return (int)o.pos;
}

int snprintf(char *buf, size_t size, const char *fmt, ...) {
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vsnprintf(buf, size, fmt, ap);
    va_end(ap);
    return r;
}

int sprintf(char *buf, const char *fmt, ...) {
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vsnprintf(buf, (size_t)1 << 30, fmt, ap); /* sem limite: uso interno */
    va_end(ap);
    return r;
}

int vprintf(const char *fmt, va_list ap) {
    char buf[1024];
    int r = vsnprintf(buf, sizeof(buf), fmt, ap);
    host_serial_write(buf, (size_t)strlen(buf));
    return r;
}

int printf(const char *fmt, ...) {
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vprintf(fmt, ap);
    va_end(ap);
    return r;
}

int puts(const char *s) {
    host_serial_puts(s);
    host_serial_puts("\n");
    return 0;
}

int putchar(int c) {
    char ch = (char)c;
    host_serial_write(&ch, 1);
    return c;
}

int fputs(const char *s, FILE *f) { (void)f; host_serial_puts(s); return 0; }
int fputc(int c, FILE *f) { (void)f; return putchar(c); }
int fflush(FILE *f) { (void)f; return 0; }
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *f) {
    (void)f;
    host_serial_write(ptr, size * nmemb);
    return nmemb;
}

int vfprintf(FILE *f, const char *fmt, va_list ap) {
    (void)f;
    return vprintf(fmt, ap);
}

int fprintf(FILE *f, const char *fmt, ...) {
    va_list ap;
    int r;
    va_start(ap, fmt);
    r = vfprintf(f, fmt, ap);
    va_end(ap);
    return r;
}
