/* time.c - relogio do jsOS: epoch calculado do RTC CMOS (via host) */
#include <time.h>
#include <sys/time.h>
#include "../core/host.h"

/* Howard Hinnant, days_from_civil - dias desde 1970-01-01 */
static long long days_from_civil(int y, unsigned m, unsigned d) {
    int era;
    unsigned yoe, doy, doe;
    y -= m <= 2;
    era = (y >= 0 ? y : y - 399) / 400;
    yoe = (unsigned)(y - era * 400);
    doy = (153 * (m + (m > 2 ? (unsigned)-3 : 9)) + 2) / 5 + d - 1;
    doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return (long long)era * 146097 + (long long)doe - 719468;
}

time_t time(time_t *t) {
    int y, mo, d, h, mi, s;
    time_t v;
    host_get_time(&y, &mo, &d, &h, &mi, &s);
    v = (time_t)(days_from_civil(y, (unsigned)mo, (unsigned)d) * 86400LL
               + h * 3600 + mi * 60 + s);
    if (t) *t = v;
    return v;
}

int gettimeofday(struct timeval *tv, void *tz) {
    (void)tz;
    if (tv) {
        tv->tv_sec = time(0);
        tv->tv_usec = 0;
    }
    return 0;
}

int clock_gettime(int clk, struct timespec *ts) {
    (void)clk;
    if (ts) {
        ts->tv_sec = time(0);
        ts->tv_nsec = 0;
    }
    return 0;
}

double difftime(time_t a, time_t b) {
    return (double)(a - b);
}

/* Howard Hinnant, civil_from_days */
static void civil_from_days(long long z, int *y, unsigned *m, unsigned *d) {
    long long era;
    unsigned doe, yoe, doy, mp;
    z += 719468;
    era = (z >= 0 ? z : z - 146096) / 146097;
    doe = (unsigned)(z - era * 146097);
    yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    *y = (int)(yoe + era * 400);
    doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    mp = (5 * doy + 2) / 153;
    *d = doy - (153 * mp + 2) / 5 + 1;
    *m = mp + (mp < 10 ? 3 : (unsigned)-9);
    *y += *m <= 2;
}

/* kernel em UTC: localtime_r = gmtime_r */
struct tm *gmtime_r(const time_t *tp, struct tm *r) {
    long long days, rem;
    int y;
    unsigned mo, dd;
    time_t t = *tp;
    days = t / 86400;
    rem = t % 86400;
    if (rem < 0) { rem += 86400; days--; }
    civil_from_days(days, &y, &mo, &dd);
    r->tm_year = y - 1900;
    r->tm_mon = (int)mo - 1;
    r->tm_mday = (int)dd;
    r->tm_hour = (int)(rem / 3600);
    r->tm_min = (int)((rem / 60) % 60);
    r->tm_sec = (int)(rem % 60);
    r->tm_wday = (int)((days + 4) % 7 < 0 ? (days + 4) % 7 + 7 : (days + 4) % 7);
    r->tm_yday = 0;
    r->tm_isdst = 0;
    r->tm_gmtoff = 0;
    return r;
}

struct tm *localtime_r(const time_t *tp, struct tm *r) {
    return gmtime_r(tp, r);
}

struct tm *gmtime(const time_t *tp) {
    static struct tm tmbuf;
    return gmtime_r(tp, &tmbuf);
}
