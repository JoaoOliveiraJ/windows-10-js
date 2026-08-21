/*
 * pthread.h - stub: kernel single-thread. Atomics do QuickJS existem, mas
 * mutex/cond sao no-ops (Atomics.wait nao bloqueia de verdade).
 */
#ifndef JSOS_PTHREAD_H
#define JSOS_PTHREAD_H

typedef int pthread_mutex_t;
typedef int pthread_cond_t;

#define PTHREAD_MUTEX_INITIALIZER 0
#define PTHREAD_COND_INITIALIZER 0

int pthread_mutex_init(pthread_mutex_t *m, const void *attr);
int pthread_mutex_lock(pthread_mutex_t *m);
int pthread_mutex_unlock(pthread_mutex_t *m);
int pthread_mutex_destroy(pthread_mutex_t *m);
int pthread_cond_init(pthread_cond_t *c, const void *attr);
int pthread_cond_destroy(pthread_cond_t *c);
int pthread_cond_signal(pthread_cond_t *c);
int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m);
int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m, const void *ts);

#endif
