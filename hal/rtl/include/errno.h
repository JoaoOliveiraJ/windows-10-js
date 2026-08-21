/* errno.h - libc shim do jsOS */
#ifndef JSOS_ERRNO_H
#define JSOS_ERRNO_H

extern int errno;

#define EPERM  1
#define ENOENT 2
#define EIO    5
#define ENOMEM 12
#define EINVAL 22
#define EDOM   33
#define ERANGE 34
#define ETIMEDOUT 110

#endif
