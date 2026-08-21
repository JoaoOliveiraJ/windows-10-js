/* assert.c - falha de assert vai para a serial e trava */
#include "../core/host.h"

void __assert_fail(const char *expr, const char *file, int line, const char *func) {
    char buf[16];
    int i = 0;
    unsigned int v = (unsigned int)line;
    char tmp[16];
    int n = 0;
    host_serial_puts("ASSERT ");
    host_serial_puts(expr);
    host_serial_puts(" @ ");
    host_serial_puts(file);
    host_serial_puts(":");
    if (!v) tmp[n++] = '0';
    while (v) { tmp[n++] = (char)('0' + v % 10); v /= 10; }
    while (n) buf[i++] = tmp[--n];
    buf[i] = 0;
    host_serial_puts(buf);
    host_serial_puts(" (");
    host_serial_puts(func);
    host_serial_puts(")");
    host_panic("assert falhou");
}
