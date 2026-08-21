/* assert.h - libc shim do jsOS: falha vai para a serial e trava */
#ifndef JSOS_ASSERT_H
#define JSOS_ASSERT_H

void __assert_fail(const char *expr, const char *file, int line, const char *func);

#ifdef NDEBUG
#define assert(x) ((void)0)
#else
#define assert(x) ((x) ? (void)0 : __assert_fail(#x, __FILE__, __LINE__, __func__))
#endif

#endif
