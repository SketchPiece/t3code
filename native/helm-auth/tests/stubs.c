#include <security/pam_appl.h>
#include <security/pam_modules.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
int pam_get_user(pam_handle_t *h, const char **u, const char *p) { (void)h; (void)p; *u = getenv("USER"); return PAM_SUCCESS; }
int pam_get_item(const pam_handle_t *h, int i, const void **v) { (void)h; (void)i; *v = "sudo"; return PAM_SUCCESS; }
int pam_prompt(const pam_handle_t *h, int s, char **r, const char *f, ...) { (void)h; (void)s; (void)r; va_list a; va_start(a, f); printf("[pam] "); vprintf(f, a); printf("\n"); va_end(a); return PAM_SUCCESS; }
int pam_sm_authenticate(pam_handle_t *, int, int, const char **);
int main(void) { int r = pam_sm_authenticate(NULL, 0, 0, NULL); printf("result=%d (%s)\n", r, r == PAM_SUCCESS ? "SUCCESS" : r == PAM_IGNORE ? "IGNORE" : "FAIL"); return 0; }
