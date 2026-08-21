/* quickjs_host.h - interface do hospedeiro QuickJS */
#ifndef JSOS_QUICKJS_HOST_H
#define JSOS_QUICKJS_HOST_H

void js_host_init(void);
int  js_host_run(const char *code, const char *filename);

#endif
