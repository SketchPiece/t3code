// pam_helm: approve sudo with Face ID on a paired iPhone or iPad.
//
// The module asks Helm (the desktop app, over a Unix socket in the invoking
// user's home) to get a signature from the phone. The phone signs a fresh
// nonce with a Secure Enclave key that needs Face ID. The module checks the
// signature against public keys in a root-owned file, so a process that
// fakes the socket cannot approve anything.
//
// /etc/pam.d/sudo_local:
//   auth       sufficient     /usr/local/lib/pam/pam_helm.so.2
//
// Any failure (no Helm, no phone, timeout, denial, bad signature) returns
// PAM_IGNORE / PAM_AUTH_ERR so sudo falls through to Touch ID or the password.

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pwd.h>
#include <security/pam_appl.h>
#include <security/pam_modules.h>
#include <security/openpam.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#ifndef KEYS_PATH
#define KEYS_PATH "/etc/helm/sudo-approvers"
#endif
#ifndef KEYS_OWNER
#define KEYS_OWNER 0
#endif
#ifndef SOCKET_NAME
#define SOCKET_NAME ".helm/sudo.sock"
#endif
#define DEFAULT_TIMEOUT 45
#define MAX_REPLY 8192

static const char b64chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char *b64_encode(const unsigned char *in, size_t len) {
  size_t out_len = 4 * ((len + 2) / 3);
  char *out = malloc(out_len + 1);
  if (!out) return NULL;
  size_t i = 0, j = 0;
  while (i < len) {
    uint32_t a = i < len ? in[i++] : 0;
    uint32_t b = i < len ? in[i++] : 0;
    uint32_t c = i < len ? in[i++] : 0;
    uint32_t t = (a << 16) | (b << 8) | c;
    out[j++] = b64chars[(t >> 18) & 63];
    out[j++] = b64chars[(t >> 12) & 63];
    out[j++] = b64chars[(t >> 6) & 63];
    out[j++] = b64chars[t & 63];
  }
  size_t mod = len % 3;
  if (mod > 0) out[out_len - 1] = '=';
  if (mod == 1) out[out_len - 2] = '=';
  out[out_len] = 0;
  return out;
}

static int b64_value(char c) {
  const char *p = strchr(b64chars, c);
  return (c && p) ? (int)(p - b64chars) : -1;
}

static unsigned char *b64_decode(const char *in, size_t *out_len) {
  size_t len = strlen(in);
  unsigned char *out = malloc(len * 3 / 4 + 3);
  if (!out) return NULL;
  uint32_t acc = 0;
  int bits = 0;
  size_t j = 0;
  for (size_t i = 0; i < len; i++) {
    if (in[i] == '=') break;
    int v = b64_value(in[i]);
    if (v < 0) { free(out); return NULL; }
    acc = (acc << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (unsigned char)((acc >> bits) & 0xFF);
    }
  }
  *out_len = j;
  return out;
}

// JSON string escaping for the request; the module only ever writes strings.
static void json_append_string(char *buf, size_t cap, const char *s) {
  size_t n = strlen(buf);
  if (n + 2 >= cap) return;
  buf[n++] = '"';
  for (; *s && n + 7 < cap; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { buf[n++] = '\\'; buf[n++] = (char)c; }
    else if (c < 0x20) n += (size_t)snprintf(buf + n, cap - n, "\\u%04x", c);
    else buf[n++] = (char)c;
  }
  buf[n++] = '"';
  buf[n] = 0;
}

// Finds "key":"value" in a flat JSON object written by Helm. Values are base64
// or short words, so no escapes are expected.
static int json_get_string(const char *json, const char *key, char *out, size_t cap) {
  char pattern[64];
  snprintf(pattern, sizeof pattern, "\"%s\"", key);
  const char *p = strstr(json, pattern);
  if (!p) return 0;
  p += strlen(pattern);
  while (*p == ' ' || *p == ':') p++;
  if (*p != '"') return 0;
  p++;
  size_t n = 0;
  while (*p && *p != '"' && n + 1 < cap) out[n++] = *p++;
  if (*p != '"') return 0;
  out[n] = 0;
  return 1;
}

// The command sudo was asked to run: this module runs inside the sudo process,
// so its own argv is "sudo …".
static void own_command_line(char *out, size_t cap) {
  out[0] = 0;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, getpid()};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size == 0) return;
  char *buf = malloc(size);
  if (!buf) return;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0) { free(buf); return; }
  int argc;
  memcpy(&argc, buf, sizeof argc);
  char *p = buf + sizeof argc;
  char *end = buf + size;
  while (p < end && *p) p++;  // executable path
  while (p < end && !*p) p++;  // padding
  size_t n = 0;
  for (int i = 0; i < argc && p < end; i++) {
    size_t len = strnlen(p, (size_t)(end - p));
    if (n && n + 1 < cap) out[n++] = ' ';
    size_t copy = len < cap - n - 1 ? len : cap - n - 1;
    memcpy(out + n, p, copy);
    n += copy;
    p += len + 1;
  }
  out[n] = 0;
  free(buf);
}

static int read_line(int fd, char *buf, size_t cap, int timeout_s) {
  size_t n = 0;
  time_t deadline = time(NULL) + timeout_s;
  while (n + 1 < cap) {
    int left = (int)(deadline - time(NULL));
    if (left <= 0) return 0;
    struct pollfd pfd = {fd, POLLIN, 0};
    int r = poll(&pfd, 1, left * 1000);
    if (r < 0 && errno == EINTR) return 0;  // Ctrl-C: stop waiting
    if (r <= 0) return 0;
    ssize_t got = read(fd, buf + n, cap - n - 1);
    if (got <= 0) return 0;
    n += (size_t)got;
    buf[n] = 0;
    if (memchr(buf, '\n', n)) return 1;
  }
  return 0;
}

static int connect_helm(uid_t uid) {
  struct passwd *pw = getpwuid(uid);
  if (!pw || !pw->pw_dir) return -1;
  struct sockaddr_un addr = {0};
  addr.sun_family = AF_UNIX;
  if (snprintf(addr.sun_path, sizeof addr.sun_path, "%s/%s", pw->pw_dir, SOCKET_NAME) >=
      (int)sizeof addr.sun_path)
    return -1;
  // Only talk to a socket the invoking user owns. (The signature check is what
  // actually protects root; this just avoids leaking the command to others.)
  struct stat st;
  if (lstat(addr.sun_path, &st) != 0 || !S_ISSOCK(st.st_mode) || st.st_uid != uid) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) { close(fd); return -1; }
  return fd;
}

static int verify(const char *message, const unsigned char *sig, size_t sig_len) {
  FILE *f = fopen(KEYS_PATH, "r");
  if (!f) return 0;
  struct stat st;
  // The key list decides who can become root, so it must be root's alone.
  if (fstat(fileno(f), &st) != 0 || st.st_uid != KEYS_OWNER || (st.st_mode & 022)) { fclose(f); return 0; }
  int ok = 0;
  char line[1024];
  CFDataRef msg = CFDataCreate(NULL, (const UInt8 *)message, (CFIndex)strlen(message));
  CFDataRef sigData = CFDataCreate(NULL, sig, (CFIndex)sig_len);
  while (!ok && fgets(line, sizeof line, f)) {
    char *s = line;
    while (*s == ' ' || *s == '\t') s++;
    if (*s == '#' || *s == '\n' || !*s) continue;
    char *e = s;
    while (*e && *e != ' ' && *e != '\t' && *e != '\n') e++;
    *e = 0;
    size_t key_len;
    unsigned char *key_bytes = b64_decode(s, &key_len);
    if (!key_bytes) continue;
    CFDataRef keyData = CFDataCreate(NULL, key_bytes, (CFIndex)key_len);
    free(key_bytes);
    const void *keys[] = {kSecAttrKeyType, kSecAttrKeyClass};
    const void *vals[] = {kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClassPublic};
    CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, vals, 2, &kCFTypeDictionaryKeyCallBacks,
                                               &kCFTypeDictionaryValueCallBacks);
    SecKeyRef key = SecKeyCreateWithData(keyData, attrs, NULL);
    if (key) {
      ok = SecKeyVerifySignature(key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256, msg, sigData, NULL);
      CFRelease(key);
    }
    CFRelease(attrs);
    CFRelease(keyData);
  }
  CFRelease(msg);
  CFRelease(sigData);
  fclose(f);
  return ok;
}

static void info(pam_handle_t *pamh, const char *text) {
  pam_prompt(pamh, PAM_TEXT_INFO, NULL, "%s", text);
}

PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc, const char **argv) {
  (void)flags;
  int timeout = DEFAULT_TIMEOUT;
  for (int i = 0; i < argc; i++)
    if (strncmp(argv[i], "timeout=", 8) == 0) timeout = atoi(argv[i] + 8);
  if (timeout <= 0) timeout = DEFAULT_TIMEOUT;

  if (access(KEYS_PATH, R_OK) != 0) return PAM_IGNORE;

  const char *user = NULL;
  if (pam_get_user(pamh, &user, NULL) != PAM_SUCCESS || !user) return PAM_IGNORE;

  uid_t uid = getuid();  // the invoking user; sudo is setuid root
  int fd = connect_helm(uid);
  if (fd < 0) return PAM_IGNORE;

  unsigned char nonce[32];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof nonce, nonce) != errSecSuccess) {
    close(fd);
    return PAM_IGNORE;
  }
  char *nonce64 = b64_encode(nonce, sizeof nonce);
  char command[1024], host[256] = "";
  own_command_line(command, sizeof command);
  gethostname(host, sizeof host);
  const char *service = NULL;
  pam_get_item(pamh, PAM_SERVICE, (const void **)&service);

  char request[4096] = "{\"type\":\"sudo\",\"nonce\":";
  json_append_string(request, sizeof request, nonce64);
  strlcat(request, ",\"user\":", sizeof request);
  json_append_string(request, sizeof request, user);
  strlcat(request, ",\"service\":", sizeof request);
  json_append_string(request, sizeof request, service ? service : "");
  strlcat(request, ",\"command\":", sizeof request);
  json_append_string(request, sizeof request, command);
  strlcat(request, ",\"host\":", sizeof request);
  json_append_string(request, sizeof request, host);
  char tail[64];
  snprintf(tail, sizeof tail, ",\"timeout\":%d}\n", timeout);
  strlcat(request, tail, sizeof request);

  int result = PAM_IGNORE;
  if (write(fd, request, strlen(request)) == (ssize_t)strlen(request)) {
    info(pamh, "Confirm with Face ID on your phone (Helm)…");
    char reply[MAX_REPLY];
    if (read_line(fd, reply, sizeof reply, timeout)) {
      char status[32] = "", sig64[1024] = "";
      json_get_string(reply, "status", status, sizeof status);
      if (strcmp(status, "approved") == 0 && json_get_string(reply, "signature", sig64, sizeof sig64)) {
        // What the phone signed: the nonce ties it to this sudo call, the
        // rest is what the person saw on the phone.
        char message[2048];
        snprintf(message, sizeof message, "helm-sudo-v1\n%s\n%s\n%s\n%s", nonce64, user, host, command);
        size_t sig_len;
        unsigned char *sig = b64_decode(sig64, &sig_len);
        if (sig && verify(message, sig, sig_len)) result = PAM_SUCCESS;
        else { info(pamh, "Helm: the phone's signature didn't check out."); result = PAM_AUTH_ERR; }
        free(sig);
      } else if (strcmp(status, "denied") == 0) {
        info(pamh, "Helm: declined on the phone.");
        result = PAM_AUTH_ERR;
      }
    } else {
      info(pamh, "Helm: no answer from the phone.");
    }
  }
  free(nonce64);
  close(fd);
  return result;
}

PAM_EXTERN int pam_sm_setcred(pam_handle_t *pamh, int flags, int argc, const char **argv) {
  (void)pamh; (void)flags; (void)argc; (void)argv;
  return PAM_SUCCESS;
}

PAM_EXTERN int pam_sm_acct_mgmt(pam_handle_t *pamh, int flags, int argc, const char **argv) {
  (void)pamh; (void)flags; (void)argc; (void)argv;
  return PAM_IGNORE;
}
