// crash_handler.cpp — async-signal-safe native crash catcher for the embedded
// Node.js host spike (hostspike3).
//
// WHY: node::Start() and libnode load can SIGABRT/SIGSEGV natively. Those
// aborts are UNCATCHABLE from Java, and we cannot get an adb/USB logcat off the
// Sunmi T2s. So we install POSIX signal handlers that, on a fatal signal, write
// a small diagnostic text file to the app's files dir (path supplied from Java)
// and then re-raise the default handler so the process still dies normally.
// On next app launch the JS status card reads that file and shows the reason —
// the diagnosis we otherwise could not obtain.
//
// EVERYTHING in the signal handler is async-signal-safe: low-level open/write
// (NOT stdio/printf), no malloc, no FindClass. The backtrace uses
// _Unwind_Backtrace (Android bionic has no glibc backtrace()/backtrace_symbols)
// plus dladdr for best-effort symbolisation. If a frame can't be symbolised we
// write its raw address — still useful for offline addr2line.

#include <jni.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <string.h>
#include <time.h>
#include <unwind.h>
#include <dlfcn.h>
#include <stdint.h>
#include <errno.h>
#include <android/log.h>

#define CH_TAG "NODEHOST-CRASH"
#define CH_MAX_PATH 1024
#define CH_MAX_FRAMES 32

// File path to write the crash report to. Filled in (once) from Java before
// node starts. Plain char buffer so the handler touches no heap.
static char g_crash_file_path[CH_MAX_PATH] = {0};
static volatile sig_atomic_t g_handler_installed = 0;

// Saved previous dispositions so we can chain to the default after writing.
static struct sigaction g_old_sa[NSIG];

// ---- async-signal-safe helpers ----------------------------------------------

// write() the whole buffer, ignoring partial writes. No errno handling beyond
// retrying — must stay simple inside a signal handler.
static void ch_write(int fd, const char* buf, size_t len) {
    while (len > 0) {
        ssize_t n = write(fd, buf, len);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            return;
        }
        buf += n;
        len -= (size_t)n;
    }
}

static void ch_write_str(int fd, const char* s) {
    if (s) ch_write(fd, s, strlen(s));
}

// Write an unsigned 64-bit value as hex (0x...). Signal-safe, no sprintf.
static void ch_write_hex(int fd, uint64_t v) {
    char tmp[2 + 16 + 1];
    char* p = tmp + sizeof(tmp);
    *--p = '\0';
    if (v == 0) {
        *--p = '0';
    } else {
        while (v) {
            int d = (int)(v & 0xf);
            *--p = (char)(d < 10 ? ('0' + d) : ('a' + d - 10));
            v >>= 4;
        }
    }
    *--p = 'x';
    *--p = '0';
    ch_write_str(fd, p);
}

// Write a small unsigned int as decimal. Signal-safe.
static void ch_write_dec(int fd, unsigned long v) {
    char tmp[24];
    char* p = tmp + sizeof(tmp);
    *--p = '\0';
    if (v == 0) {
        *--p = '0';
    } else {
        while (v) {
            *--p = (char)('0' + (v % 10));
            v /= 10;
        }
    }
    ch_write_str(fd, p);
}

static const char* ch_signal_name(int sig) {
    switch (sig) {
        case SIGABRT: return "SIGABRT";
        case SIGSEGV: return "SIGSEGV";
        case SIGILL:  return "SIGILL";
        case SIGBUS:  return "SIGBUS";
        case SIGFPE:  return "SIGFPE";
        default:      return "UNKNOWN";
    }
}

#if defined(__aarch64__)
    #define CH_ABI "arm64-v8a"
#elif defined(__arm__)
    #define CH_ABI "armeabi-v7a"
#elif defined(__x86_64__)
    #define CH_ABI "x86_64"
#elif defined(__i386__)
    #define CH_ABI "x86"
#else
    #define CH_ABI "unknown"
#endif

// ---- backtrace via _Unwind_Backtrace -----------------------------------------

struct ch_bt_state {
    int fd;
    int count;
    int max;
};

static _Unwind_Reason_Code ch_unwind_cb(struct _Unwind_Context* ctx, void* arg) {
    struct ch_bt_state* st = (struct ch_bt_state*)arg;
    uintptr_t pc = _Unwind_GetIP(ctx);
    if (pc == 0) return _URC_NO_REASON;
    if (st->count >= st->max) return _URC_END_OF_STACK;

    ch_write_str(st->fd, "  #");
    ch_write_dec(st->fd, (unsigned long)st->count);
    ch_write_str(st->fd, "  pc ");
    ch_write_hex(st->fd, (uint64_t)pc);

    // Best-effort symbolisation. dladdr is NOT strictly async-signal-safe, but
    // in practice it only reads already-mapped link tables and is widely used in
    // Android crash handlers. We accept the small risk; if it faults we will
    // have already written the signal line + earlier frames.
    Dl_info info;
    memset(&info, 0, sizeof(info));
    if (dladdr((void*)pc, &info) && info.dli_fname) {
        ch_write_str(st->fd, "  ");
        ch_write_str(st->fd, info.dli_fname);
        if (info.dli_sname) {
            ch_write_str(st->fd, "  ");
            ch_write_str(st->fd, info.dli_sname);
            if (info.dli_saddr) {
                ch_write_str(st->fd, "+");
                ch_write_hex(st->fd, (uint64_t)((uintptr_t)pc - (uintptr_t)info.dli_saddr));
            }
        }
    }
    ch_write_str(st->fd, "\n");

    st->count++;
    return _URC_NO_REASON;
}

// ---- the handler -------------------------------------------------------------

static void ch_signal_handler(int sig, siginfo_t* info, void* ucontext) {
    (void)ucontext;

    if (g_crash_file_path[0] != '\0') {
        int fd = open(g_crash_file_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd >= 0) {
            ch_write_str(fd, "SiamEPOS embedded Node host — native crash\n");
            ch_write_str(fd, "signal: ");
            ch_write_str(fd, ch_signal_name(sig));
            ch_write_str(fd, " (");
            ch_write_dec(fd, (unsigned long)sig);
            ch_write_str(fd, ")\n");
            ch_write_str(fd, "abi: " CH_ABI "\n");

            // Fault address (meaningful for SIGSEGV/SIGBUS/SIGFPE/SIGILL).
            if (info) {
                ch_write_str(fd, "fault_addr: ");
                ch_write_hex(fd, (uint64_t)(uintptr_t)info->si_addr);
                ch_write_str(fd, "  code: ");
                ch_write_dec(fd, (unsigned long)info->si_code);
                ch_write_str(fd, "\n");
            }

            // Timestamp — time() is async-signal-safe; write epoch seconds.
            time_t now = time(NULL);
            ch_write_str(fd, "epoch: ");
            ch_write_dec(fd, (unsigned long)now);
            ch_write_str(fd, "\n");

            ch_write_str(fd, "backtrace:\n");
            struct ch_bt_state st = { fd, 0, CH_MAX_FRAMES };
            _Unwind_Backtrace(ch_unwind_cb, &st);
            if (st.count == 0) {
                ch_write_str(fd, "  (no frames unwound)\n");
            }
            ch_write_str(fd, "--- end ---\n");

            fsync(fd);
            close(fd);
        }
    }

    // Also drop a logcat line in case a USB log ever IS available.
    __android_log_write(ANDROID_LOG_FATAL, CH_TAG, ch_signal_name(sig));

    // Chain to the previous/default handler so the process still dies normally
    // and produces the usual tombstone.
    if (sig >= 0 && sig < NSIG) {
        struct sigaction* old = &g_old_sa[sig];
        if (old->sa_flags & SA_SIGINFO) {
            if (old->sa_sigaction) { old->sa_sigaction(sig, info, ucontext); return; }
        } else if (old->sa_handler != SIG_DFL && old->sa_handler != SIG_IGN) {
            old->sa_handler(sig);
            return;
        }
    }
    // Fall back to default disposition + re-raise.
    signal(sig, SIG_DFL);
    raise(sig);
}

static void ch_install_for(int sig) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = ch_signal_handler;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&sa.sa_mask);
    sigaction(sig, &sa, &g_old_sa[sig]);
}

// ---- JNI entry point ---------------------------------------------------------
// Called from Java (RNNodeJsMobileModule.installCrashHandler) RIGHT BEFORE node
// is started, passing the absolute path of the crash file to write.

extern "C"
JNIEXPORT void JNICALL
Java_com_janeasystems_rn_1nodejs_1mobile_RNNodeJsMobileModule_installCrashHandler(
        JNIEnv* env,
        jclass /* clazz */,
        jstring crashFilePath) {
    if (crashFilePath != nullptr) {
        const char* p = env->GetStringUTFChars(crashFilePath, 0);
        if (p) {
            strncpy(g_crash_file_path, p, CH_MAX_PATH - 1);
            g_crash_file_path[CH_MAX_PATH - 1] = '\0';
            env->ReleaseStringUTFChars(crashFilePath, p);
        }
    }

    if (g_handler_installed) return;
    g_handler_installed = 1;

    ch_install_for(SIGABRT);
    ch_install_for(SIGSEGV);
    ch_install_for(SIGILL);
    ch_install_for(SIGBUS);
    ch_install_for(SIGFPE);

    __android_log_write(ANDROID_LOG_INFO, CH_TAG, "native crash handler installed");
}
