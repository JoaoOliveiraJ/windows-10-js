/* pthread.c - stubs no-op (single-thread) */
#include <pthread.h>

int pthread_mutex_init(pthread_mutex_t *m, const void *attr) { (void)attr; if (m) *m = 0; return 0; }
int pthread_mutex_lock(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_unlock(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_cond_init(pthread_cond_t *c, const void *attr) { (void)attr; if (c) *c = 0; return 0; }
int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
int pthread_cond_signal(pthread_cond_t *c) { (void)c; return 0; }
int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { (void)c; (void)m; return 0; }
int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m, const void *ts) { (void)c; (void)m; (void)ts; return 0; }
