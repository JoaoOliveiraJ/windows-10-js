/* setjmp.h - stub: dtoa.c inclui mas nao usa */
#ifndef JSOS_SETJMP_H
#define JSOS_SETJMP_H

typedef unsigned long long jmp_buf[16];
int  setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val) __attribute__((noreturn));

#endif
