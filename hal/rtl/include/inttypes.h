/* inttypes.h - libc shim do jsOS */
#ifndef JSOS_INTTYPES_H
#define JSOS_INTTYPES_H

#include <stdint.h>

#define PRId8  "d"
#define PRId16 "d"
#define PRId32 "d"
#define PRId64 "lld"
#define PRIi8  "i"
#define PRIi16 "i"
#define PRIi32 "i"
#define PRIi64 "lli"
#define PRIu8  "u"
#define PRIu16 "u"
#define PRIu32 "u"
#define PRIu64 "llu"
#define PRIx8  "x"
#define PRIx16 "x"
#define PRIx32 "x"
#define PRIx64 "llx"
#define PRIX64 "llX"
#define PRIdPTR "lld"
#define PRIuPTR "llu"

#endif
