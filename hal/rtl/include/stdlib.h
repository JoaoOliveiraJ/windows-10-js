/* stdlib.h - libc shim do jsOS (freestanding) */
#ifndef JSOS_STDLIB_H
#define JSOS_STDLIB_H

#include <stddef.h>

void *malloc(size_t size);
void *calloc(size_t nmemb, size_t size);
void *realloc(void *ptr, size_t size);
void  free(void *ptr);

void abort(void) __attribute__((noreturn));
void exit(int code) __attribute__((noreturn));
int  atoi(const char *s);
long atol(const char *s);
long strtol(const char *s, char **end, int base);
unsigned long strtoul(const char *s, char **end, int base);
long long strtoll(const char *s, char **end, int base);
unsigned long long strtoull(const char *s, char **end, int base);
double strtod(const char *s, char **end);
float strtof(const char *s, char **end);
long double strtold(const char *s, char **end);

void qsort(void *base, size_t nmemb, size_t size,
           int (*cmp)(const void *, const void *));
char *getenv(const char *name);
size_t malloc_usable_size(void *ptr);

int  abs(int x);
long labs(long x);
long long llabs(long long x);

#define alloca __builtin_alloca

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1

#endif
