/* time.h - libc shim do jsOS: relogio vem do UEFI GetTime */
#ifndef JSOS_TIME_H
#define JSOS_TIME_H

#include <stddef.h>

typedef long long time_t;
typedef long long clock_t;

#define CLOCKS_PER_SEC 1000000
#define CLOCK_REALTIME 0

struct timespec {
    time_t tv_sec;
    long   tv_nsec;
};

struct tm {
    int tm_sec, tm_min, tm_hour;
    int tm_mday, tm_mon, tm_year;
    int tm_wday, tm_yday, tm_isdst;
    long tm_gmtoff;         /* sempre 0: relogio do kernel em UTC */
};

time_t time(time_t *t);
int    clock_gettime(int clk, struct timespec *ts);
struct tm *gmtime_r(const time_t *t, struct tm *result);
struct tm *gmtime(const time_t *t);
struct tm *localtime_r(const time_t *t, struct tm *result);
double difftime(time_t a, time_t b);
time_t mktime(struct tm *tm);

#endif
