/* fenv.c - stub: SSE fica sempre em round-to-nearest */
#include <fenv.h>

int fegetround(void) { return FE_TONEAREST; }
int fesetround(int round) { (void)round; return 0; }
