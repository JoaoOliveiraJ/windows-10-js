/* fenv.h - stub: SSE em round-to-nearest permanente */
#ifndef JSOS_FENV_H
#define JSOS_FENV_H

#define FE_TONEAREST    0
#define FE_DOWNWARD     1
#define FE_UPWARD       2
#define FE_TOWARDZERO   3

int fegetround(void);
int fesetround(int round);

#endif
