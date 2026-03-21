#include "shm_publisher.hpp"
#include "var_monitor.hpp"
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <semaphore.h>
#include <unistd.h>
#include <pwd.h>
#include <cerrno>
#include <dirent.h>
#include <atomic>
#include <csignal>
#include <mutex>
#include <unordered_set>
#include <type_traits>
#include <variant>

namespace varmon {
namespace shm_publisher {

static constexpr uint32_t MAGIC = 0x4D524156u; /* "VARM" little-endian */
static constexpr uint32_t VERSION = 1u;
static constexpr size_t NAME_MAX_LEN = 128u;
static constexpr size_t ENTRY_SIZE = NAME_MAX_LEN + 1 + 8; /* name + type + value (double) */
static constexpr size_t HEADER_SIZE = 4 + 4 + 8 + 4 + 4 + 8;   /* magic, version, seq, count, padding, timestamp (32 bytes) */
static constexpr size_t DEFAULT_MAX_VARS = 2048u;
static constexpr size_t MIN_MAX_VARS = 64u;
static constexpr size_t MAX_MAX_VARS = 32768u;

static size_t g_max_vars = DEFAULT_MAX_VARS;
static size_t g_segment_size = 0;  /* fijado en init() */

static int g_shm_fd = -1;
static void* g_shm_ptr = nullptr;
static sem_t* g_sem = nullptr;
static std::string g_shm_name;
static std::string g_sem_name;
static bool g_active = false;

static std::mutex g_subscription_mutex;
static std::unordered_set<std::string> g_subscription;  /* vacío = todas */

static std::string get_username() {
    const char* user = getenv("USER");
    if (user && user[0]) return user;
    struct passwd* pw = getpwuid(geteuid());
    if (pw && pw->pw_name) return pw->pw_name;
    return "unknown";
}

void cleanup_stale_shm_for_user() {
#ifdef __linux__
    std::string user = get_username();
    std::string prefix = "varmon-" + user + "-";
    DIR* dir = opendir("/dev/shm");
    if (!dir) return;
    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr) {
        std::string name = ent->d_name;
        if (name.size() <= prefix.size() || name.compare(0, prefix.size(), prefix) != 0)
            continue;
        std::string pid_str = name.substr(prefix.size());
        if (pid_str.empty()) continue;
        pid_t pid = 0;
        try {
            pid = static_cast<pid_t>(std::stoul(pid_str));
        } catch (...) {
            continue;
        }
        if (pid <= 0) continue;
        if (kill(pid, 0) == 0)
            continue; /* process exists */
        if (errno != ESRCH)
            continue; /* other error */
        std::string full = "/" + name;
        if (shm_unlink(full.c_str()) == 0)
            std::cout << "[VarMonitor] Limpieza SHM zombie: " << name << "\n";
        sem_unlink(("/" + name).c_str());
    }
    closedir(dir);
#else
    (void)0;
#endif
}

bool init(size_t max_vars) {
    if (g_active) return true;
    if (max_vars == 0) max_vars = DEFAULT_MAX_VARS;
    if (max_vars < MIN_MAX_VARS) max_vars = MIN_MAX_VARS;
    if (max_vars > MAX_MAX_VARS) max_vars = MAX_MAX_VARS;
    g_max_vars = max_vars;
    g_segment_size = HEADER_SIZE + g_max_vars * ENTRY_SIZE;

    cleanup_stale_shm_for_user();
    std::string user = get_username();
    pid_t pid = getpid();
    std::ostringstream oss;
    oss << "varmon-" << user << "-" << pid;
    g_shm_name = oss.str();
    g_sem_name = "/" + g_shm_name;

    int fd = shm_open(("/" + g_shm_name).c_str(), O_CREAT | O_RDWR | O_EXCL, 0666);
    if (fd < 0) {
        std::cerr << "[VarMonitor] shm_open failed: " << strerror(errno) << "\n";
        return false;
    }
    if (ftruncate(fd, static_cast<off_t>(g_segment_size)) != 0) {
        close(fd);
        shm_unlink(("/" + g_shm_name).c_str());
        return false;
    }
    void* ptr = mmap(nullptr, g_segment_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) {
        close(fd);
        shm_unlink(("/" + g_shm_name).c_str());
        return false;
    }
    g_shm_fd = fd;
    g_shm_ptr = ptr;

    sem_t* sem = sem_open(g_sem_name.c_str(), O_CREAT | O_EXCL, 0666, 0);
    if (sem == SEM_FAILED) {
        munmap(g_shm_ptr, g_segment_size);
        close(g_shm_fd);
        shm_unlink(("/" + g_shm_name).c_str());
        g_shm_ptr = nullptr;
        g_shm_fd = -1;
        std::cerr << "[VarMonitor] sem_open failed: " << strerror(errno) << "\n";
        return false;
    }
    g_sem = sem;

    /* Header inicial */
    char* h = static_cast<char*>(g_shm_ptr);
    memcpy(h, &MAGIC, 4);
    memcpy(h + 4, &VERSION, 4);
    uint64_t zero64 = 0;
    uint32_t zero32 = 0;
    memcpy(h + 8, &zero64, 8);
    memcpy(h + 16, &zero32, 4);
    double ts = 0.0;
    memcpy(h + 24, &ts, 8);

    g_active = true;
    std::cout << "[VarMonitor] SHM listo: /dev/shm/" << g_shm_name << " sem " << g_sem_name
              << " (" << g_max_vars << " vars, " << (g_segment_size / 1024) << " KiB)\n";
    return true;
}

void shutdown() {
    if (!g_active) return;
    g_active = false;
    if (g_sem) {
        sem_close(g_sem);
        sem_unlink(g_sem_name.c_str());
        g_sem = nullptr;
    }
    if (g_shm_ptr && g_segment_size > 0) {
        munmap(g_shm_ptr, g_segment_size);
        g_shm_ptr = nullptr;
        g_segment_size = 0;
    }
    if (g_shm_fd >= 0) {
        close(g_shm_fd);
        g_shm_fd = -1;
    }
    if (!g_shm_name.empty()) {
        shm_unlink(("/" + g_shm_name).c_str());
        g_shm_name.clear();
    }
    g_sem_name.clear();
}

/** Convierte a double según el tipo activo del variant (no usar s.type: puede desincronizarse y provocar std::bad_variant_access). */
static double scalar_to_double(const VarMonitor::VarSnapshot& s) {
    return std::visit([](const auto& arg) -> double {
        using T = std::decay_t<decltype(arg)>;
        if constexpr (std::is_same_v<T, double>) {
            return static_cast<double>(arg);
        } else if constexpr (std::is_same_v<T, int32_t>) {
            return static_cast<double>(arg);
        } else if constexpr (std::is_same_v<T, bool>) {
            return arg ? 1.0 : 0.0;
        } else {
            return 0.0;
        }
    }, s.value);
}

void write_snapshot(VarMonitor* mon) {
    if (!g_active || !g_shm_ptr || !mon || !g_sem) return;
    uint32_t count = 0;
    uint64_t seq = 0;
    double timestamp = std::chrono::duration<double>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    std::unordered_set<std::string> sub;
    {
        std::lock_guard<std::mutex> lock(g_subscription_mutex);
        sub = g_subscription;
    }

    char* h = static_cast<char*>(g_shm_ptr);
    memcpy(&seq, h + 8, 8);
    seq++;
    memcpy(h + 8, &seq, 8);

    if (sub.empty()) {
        /* Sin suscripción: no volcar variables; solo cabecera (count=0) y sem_post.
         * La lista de variables disponibles se obtiene por UDS (list_names/list_vars). */
        memcpy(h + 16, &count, 4);
        memcpy(h + 24, &timestamp, 8);
        sem_post(g_sem);
        return;
    }

    /* Iterar solo la suscripción (get_var por nombre), no list_vars() completo.
     * Con 20k vars registradas y 2k monitorizadas, coste O(2k) en lugar de O(20k). */
    if (sub.size() > g_max_vars) {
        static std::atomic<bool> warned{false};
        if (!warned.exchange(true)) {
            std::cerr << "[VarMonitor] AVISO: suscripcion tiene " << sub.size()
                      << " variables pero shm_max_vars=" << g_max_vars
                      << ". Solo se escriben las primeras " << g_max_vars
                      << "; el resto mostraran \"--\" hasta aumentar shm_max_vars en varmon.conf\n";
        }
    }
    char* ent = h + HEADER_SIZE;
    for (const auto& name : sub) {
        if (count >= g_max_vars) break;
        auto opt = mon->get_var(name);
        if (!opt) continue;
        if (opt->type == VarType::Array || opt->type == VarType::String) continue;
        size_t name_len = std::min(opt->name.size(), NAME_MAX_LEN);
        memset(ent, 0, ENTRY_SIZE);
        memcpy(ent, opt->name.c_str(), name_len);
        uint8_t type_byte = static_cast<uint8_t>(static_cast<int>(opt->type));
        ent[NAME_MAX_LEN] = type_byte;
        double val = scalar_to_double(*opt);
        memcpy(ent + NAME_MAX_LEN + 1, &val, 8);
        ent += ENTRY_SIZE;
        count++;
    }
    memcpy(h + 16, &count, 4);
    memcpy(h + 24, &timestamp, 8);

    sem_post(g_sem);
}

void set_subscription(const std::vector<std::string>& names) {
    std::lock_guard<std::mutex> lock(g_subscription_mutex);
    g_subscription.clear();
    for (const auto& n : names) g_subscription.insert(n);
}

std::string get_shm_name() { return g_shm_name; }
std::string get_sem_name() { return g_sem_name; }
bool is_active() { return g_active; }

} // namespace shm_publisher
} // namespace varmon
