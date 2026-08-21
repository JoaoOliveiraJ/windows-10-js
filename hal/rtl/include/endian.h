/* endian.h - x86-64 e sempre little-endian (usado pelo libm.h do musl) */
#ifndef JSOS_ENDIAN_H
#define JSOS_ENDIAN_H

#define __LITTLE_ENDIAN 1234
#define __BIG_ENDIAN    4321
#define __BYTE_ORDER    __LITTLE_ENDIAN

#define LITTLE_ENDIAN __LITTLE_ENDIAN
#define BIG_ENDIAN    __BIG_ENDIAN
#define BYTE_ORDER    __BYTE_ORDER

#endif
