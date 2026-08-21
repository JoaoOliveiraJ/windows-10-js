/* stdio.h - libc shim do jsOS: printf vai para a serial; sem arquivos */
#ifndef JSOS_STDIO_H
#define JSOS_STDIO_H

#include <stddef.h>
#include <stdarg.h>

typedef void FILE;
extern FILE *stdout;
extern FILE *stderr;
extern FILE *stdin;

#define EOF (-1)

int printf(const char *fmt, ...);
int vprintf(const char *fmt, va_list ap);
int snprintf(char *buf, size_t size, const char *fmt, ...);
int vsnprintf(char *buf, size_t size, const char *fmt, va_list ap);
int sprintf(char *buf, const char *fmt, ...);
int vsprintf(char *buf, const char *fmt, va_list ap);
int puts(const char *s);
int putchar(int c);
int fputs(const char *s, FILE *f);
int fputc(int c, FILE *f);
int fflush(FILE *f);
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *f);
int fprintf(FILE *f, const char *fmt, ...);
int vfprintf(FILE *f, const char *fmt, va_list ap);

#endif
