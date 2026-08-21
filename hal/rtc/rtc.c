/* rtc.c - relogio de tempo real via CMOS (portas 0x70/0x71) */
#include "../core/drivers.h"
#include "../core/host.h"

static uint8_t cmos_read(uint8_t reg) {
    host_outb(0x70, reg);
    return host_inb(0x71);
}

static int bcd(uint8_t v) {
    return (v & 0x0F) + (v >> 4) * 10;
}

void rtc_read(int *year, int *month, int *day, int *hour, int *min, int *sec) {
    uint8_t regb = cmos_read(0x0B);
    int is_bcd = !(regb & 0x04);
    uint8_t s = cmos_read(0x00), mi = cmos_read(0x02), h = cmos_read(0x04);
    uint8_t d = cmos_read(0x07), mo = cmos_read(0x08), y = cmos_read(0x09);
    if (is_bcd) {
        s = (uint8_t)bcd(s); mi = (uint8_t)bcd(mi); h = (uint8_t)bcd(h);
        d = (uint8_t)bcd(d); mo = (uint8_t)bcd(mo); y = (uint8_t)bcd(y);
    }
    *year = 2000 + y;
    *month = mo;
    *day = d;
    *hour = h;
    *min = mi;
    *sec = s;
}
