/* sys/time.h - libc shim do jsOS */
#ifndef JSOS_SYS_TIME_H
#define JSOS_SYS_TIME_H

#include <time.h>

struct timeval {
    time_t tv_sec;
    long   tv_usec;
};

int gettimeofday(struct timeval *tv, void *tz);

#endif
