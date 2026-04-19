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
#include <cstdlib>
#include <dirent.h>
#include <atomic>
#include <csignal>
#include <mutex>
#include <optional>
#include <unordered_set>
#include <vector>
#include <algorithm>
#include <type_traits>
#include <variant>
#include <cstdint>
#include <cmath>
#include <limits>

namespace varmon {
namespace shm_publisher {

static constexpr uint32_t MAGIC = 0x4D524156u; /* "VARM" little-endian */
static constexpr uint32_t VERSION_V2 = 2u;
static constexpr uint32_t VERSION_V3 = 3u;
/** 2 = snapshot/troceo v2; 3 = append por evento en anillo (misma tabla/arena que v2). */
static uint32_t g_layout_version = 2u;
static constexpr size_t NAME_MAX_LEN = 128u;
/* v2 */
static constexpr size_t HEADER_V2_SIZE = 64u;
/* Segundos entre esta publicación y la anterior (mismo reloj que timestamp en +24). Rellenado por C++; Python lo lee sin calcular Δt local. */
static constexpr size_t HEADER_PUBLISH_PERIOD_SEC_OFF = 52u;
static constexpr size_t TABLE_ROW_SIZE = 176u;
static constexpr size_t RING_SLOT_BYTES = 16u;

static constexpr uint8_t MODE_EXPORT_SNAPSHOT = 0u;
static constexpr uint8_t MODE_IMPORT_SNAPSHOT = 1u;
static constexpr uint8_t MODE_EXPORT_RING = 2u;

static constexpr size_t DEFAULT_MAX_VARS = 2048u;
static constexpr size_t MIN_MAX_VARS = 64u;
static constexpr size_t MAX_MAX_VARS = 32768u;
static constexpr unsigned DEFAULT_RING_DEPTH = 64u;
static constexpr unsigned MIN_RING_DEPTH = 2u;
static constexpr unsigned MAX_RING_DEPTH = 4096u;

/* Offsets inside a table row (v2) */
static constexpr size_t ROW_MODE_OFF = 128u;
static constexpr size_t ROW_TYPE_OFF = 129u;
/* Relleno v2 (antes no usado): último seq global SHM cuando esta fila se escribió por completo.
 * El lector Python reutiliza la entrada si el seq no cambió (troceo / skip_unchanged). */
static constexpr size_t ROW_PUB_SEQ_OFF = 130u;
static constexpr size_t ROW_VALUE_OFF = 136u;
static constexpr size_t ROW_RING_REL_OFF = 144u;
static constexpr size_t ROW_RING_CAP_OFF = 148u;
static constexpr size_t ROW_WRITE_IDX_OFF = 152u;
static constexpr size_t ROW_READ_IDX_OFF = 160u;
static constexpr size_t ROW_MIRROR_OFF = 168u;

static size_t g_max_vars = DEFAULT_MAX_VARS;
static size_t g_ring_depth = DEFAULT_RING_DEPTH;
static uint8_t g_default_export_mode = MODE_EXPORT_SNAPSHOT;
static size_t g_segment_size = 0;
static size_t g_ring_arena_offset = 0;

static int g_shm_fd = -1;
static void* g_shm_ptr = nullptr;
static sem_t* g_sem = nullptr;
static sem_t* g_sem_sidecar = nullptr;
static std::string g_shm_name;
static std::string g_sem_name;
static std::string g_sem_sidecar_name;
static bool g_active = false;

static std::mutex g_subscription_mutex;
static std::vector<std::string> g_subscription;

static std::vector<uint8_t> g_last_pub_valid;
static std::vector<uint8_t> g_last_pub_type;
static std::vector<double> g_last_pub_val;

static std::atomic<uint64_t> g_shm_publish_cycle{0};
static std::atomic<uint32_t> g_slice_n{1};
static std::atomic<uint32_t> g_slice_phase{0};
static std::atomic<uint32_t> g_slice_force_full{0};
static std::atomic<uint64_t> g_subscription_generation{0};

static std::atomic<bool> g_perf_collect{false};
static constexpr unsigned PERF_PHASES = 6;
static std::atomic<uint64_t> g_perf_us[PERF_PHASES];

/* Copia de suscripción solo cuando cambia (set_shm_subscription); evita clonar miles de std::string cada ciclo. */
static std::vector<std::string> g_snap_sub_cache;
static uint64_t g_snap_sub_cache_gen = std::numeric_limits<uint64_t>::max();

/* Buffers reutilizados en write_snapshot (menos malloc por ciclo RT). */
static std::vector<uint8_t> s_was_import_buf;
static std::vector<uint32_t> s_need_export_buf;
static std::vector<uint32_t> s_export_this_buf;
static std::vector<uint8_t> s_fetch_mask_buf;
static std::vector<uint32_t> s_row_to_batch_buf;
static std::vector<VarMonitor::ShmScalarExport> s_export_batch_buf;

static void resize_last_pub_row_cache() {
    g_last_pub_valid.assign(g_max_vars, 0);
    g_last_pub_type.assign(g_max_vars, 0);
    g_last_pub_val.assign(g_max_vars, 0.0);
}

static void invalidate_last_pub_row_cache() {
    std::fill(g_last_pub_valid.begin(), g_last_pub_valid.end(), 0);
}

/** Misma semántica que en var_monitor.cpp (solo depuración). */
static bool import_debug_env_enabled() {
    const char* v = std::getenv("VARMON_DEBUG_IMPORT");
    return v && v[0] != '\0' && !(v[0] == '0' && v[1] == '\0');
}

static bool import_debug_name_matches(const std::string& name) {
    const char* list = std::getenv("VARMON_DEBUG_IMPORT_NAMES");
    if (!list || !*list)
        return true;
    std::string s(list);
    size_t pos = 0;
    while (pos < s.size()) {
        size_t comma = s.find(',', pos);
        std::string token = (comma == std::string::npos) ? s.substr(pos) : s.substr(pos, comma - pos);
        while (!token.empty() && (token.front() == ' ' || token.front() == '\t'))
            token.erase(0, 1);
        while (!token.empty() && (token.back() == ' ' || token.back() == '\t'))
            token.pop_back();
        if (token == name)
            return true;
        if (comma == std::string::npos)
            break;
        pos = comma + 1;
    }
    return false;
}

static double var_value_to_double(const VarValue& v) {
    return std::visit(
        [](const auto& arg) -> double {
            using T = std::decay_t<decltype(arg)>;
            if constexpr (std::is_same_v<T, double>)
                return static_cast<double>(arg);
            else if constexpr (std::is_same_v<T, int32_t>)
                return static_cast<double>(arg);
            else if constexpr (std::is_same_v<T, bool>)
                return arg ? 1.0 : 0.0;
            else
                return std::numeric_limits<double>::quiet_NaN();
        },
        v);
}

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
            continue;
        if (errno != ESRCH)
            continue;
        std::string full = "/" + name;
        if (shm_unlink(full.c_str()) == 0)
            std::cout << "[VarMonitor] Limpieza SHM zombie: " << name << "\n";
        sem_unlink(("/" + name).c_str());
        sem_unlink(("/" + name + "-sc").c_str());
    }
    closedir(dir);
#else
    (void)0;
#endif
}

static void write_v2_header_tail(char* h, uint32_t ring_arena_off_u32) {
    uint32_t table_off = static_cast<uint32_t>(HEADER_V2_SIZE);
    uint32_t stride = static_cast<uint32_t>(TABLE_ROW_SIZE);
    uint32_t cap = static_cast<uint32_t>(g_max_vars);
    std::memcpy(h + 32, &table_off, 4);
    std::memcpy(h + 36, &stride, 4);
    std::memcpy(h + 40, &cap, 4);
    std::memcpy(h + 44, &ring_arena_off_u32, 4);
    uint16_t slot_b = static_cast<uint16_t>(RING_SLOT_BYTES);
    uint16_t depth = static_cast<uint16_t>(g_ring_depth > 0xffffu ? 0xffffu : g_ring_depth);
    std::memcpy(h + 48, &slot_b, 2);
    std::memcpy(h + 50, &depth, 2);
    std::memset(h + 52, 0, 12);
}

bool init(size_t max_vars) {
    if (g_active) return true;
    if (max_vars == 0) max_vars = DEFAULT_MAX_VARS;
    if (max_vars < MIN_MAX_VARS) max_vars = MIN_MAX_VARS;
    if (max_vars > MAX_MAX_VARS) max_vars = MAX_MAX_VARS;
    g_max_vars = max_vars;

    unsigned rd = get_config_uint("shm_ring_depth", DEFAULT_RING_DEPTH);
    if (rd < MIN_RING_DEPTH) rd = MIN_RING_DEPTH;
    if (rd > MAX_RING_DEPTH) rd = MAX_RING_DEPTH;
    g_ring_depth = rd;

    unsigned def_mode = get_config_uint("shm_default_export_mode", 0);
    if (def_mode == 2u)
        g_default_export_mode = MODE_EXPORT_RING;
    else
        g_default_export_mode = MODE_EXPORT_SNAPSHOT;

    g_layout_version = get_config_uint("shm_layout_version", 2);
    if (g_layout_version < 2u)
        g_layout_version = 2u;
    if (g_layout_version > 3u)
        g_layout_version = 3u;
    if (g_layout_version >= 3u)
        g_default_export_mode = MODE_EXPORT_RING;

    g_ring_arena_offset = HEADER_V2_SIZE + g_max_vars * TABLE_ROW_SIZE;
    const size_t ring_arena_size = g_max_vars * g_ring_depth * RING_SLOT_BYTES;
    if (g_ring_arena_offset > SIZE_MAX - ring_arena_size) {
        std::cerr << "[VarMonitor] SHM: tamaño de segmento desbordado\n";
        return false;
    }
    g_segment_size = g_ring_arena_offset + ring_arena_size;

    cleanup_stale_shm_for_user();
    std::string user = get_username();
    pid_t pid = getpid();
    std::ostringstream oss;
    oss << "varmon-" << user << "-" << pid;
    g_shm_name = oss.str();
    g_sem_name = "/" + g_shm_name;
    g_sem_sidecar_name = "/" + g_shm_name + "-sc";

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

    sem_t* sem_sc = sem_open(g_sem_sidecar_name.c_str(), O_CREAT | O_EXCL, 0666, 0);
    if (sem_sc == SEM_FAILED) {
        sem_close(g_sem);
        sem_unlink(g_sem_name.c_str());
        g_sem = nullptr;
        munmap(g_shm_ptr, g_segment_size);
        close(g_shm_fd);
        shm_unlink(("/" + g_shm_name).c_str());
        g_shm_ptr = nullptr;
        g_shm_fd = -1;
        std::cerr << "[VarMonitor] sem_open (sidecar) failed: " << strerror(errno) << "\n";
        return false;
    }
    g_sem_sidecar = sem_sc;

    std::memset(g_shm_ptr, 0, g_segment_size);

    char* h = static_cast<char*>(g_shm_ptr);
    const uint32_t file_ver = (g_layout_version >= 3u) ? VERSION_V3 : VERSION_V2;
    memcpy(h, &MAGIC, 4);
    memcpy(h + 4, &file_ver, 4);
    uint64_t zero64 = 0;
    uint32_t zero32 = 0;
    memcpy(h + 8, &zero64, 8);
    memcpy(h + 16, &zero32, 4);
    double ts = 0.0;
    memcpy(h + 24, &ts, 8);
    write_v2_header_tail(h, static_cast<uint32_t>(g_ring_arena_offset));

    resize_last_pub_row_cache();

    {
        unsigned sc = get_config_uint("shm_publish_slice_count", 1);
        if (sc < 1u) sc = 1u;
        g_slice_n.store(sc, std::memory_order_relaxed);
        g_slice_phase.store(0, std::memory_order_relaxed);
        g_slice_force_full.store(0, std::memory_order_relaxed);
    }

    g_active = true;
    std::cout << "[VarMonitor] SHM v" << (g_layout_version >= 3u ? 3 : 2) << " listo: /dev/shm/" << g_shm_name
              << " sem " << g_sem_name << " sidecar_sem " << g_sem_sidecar_name << " (" << g_max_vars
              << " vars, ring_depth=" << g_ring_depth << ", layout=" << g_layout_version << ", "
              << (g_segment_size / 1024) << " KiB)\n";
    return true;
}

void shutdown() {
    if (!g_active) return;
    g_active = false;
    if (g_sem_sidecar) {
        sem_close(g_sem_sidecar);
        sem_unlink(g_sem_sidecar_name.c_str());
        g_sem_sidecar = nullptr;
    }
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
    g_sem_sidecar_name.clear();
    g_last_pub_valid.clear();
    g_last_pub_type.clear();
    g_last_pub_val.clear();
    g_layout_version = 2u;
}

static std::string row_name_cstr(const char* row) {
    char namebuf[NAME_MAX_LEN + 1];
    std::memcpy(namebuf, row, NAME_MAX_LEN);
    namebuf[NAME_MAX_LEN] = '\0';
    std::string name(namebuf);
    const size_t z = name.find('\0');
    if (z != std::string::npos) name.resize(z);
    while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.pop_back();
    return name;
}

static void row_write_pub_seq(char* row, uint64_t seq) {
    uint32_t s = static_cast<uint32_t>(seq);
    std::memcpy(row + ROW_PUB_SEQ_OFF, &s, sizeof(s));
}

static bool shm_double_to_var_value(uint8_t type_byte, double val, VarValue& out) {
    switch (type_byte) {
        case 0:
            out = val;
            return true;
        case 1:
            out = static_cast<int32_t>(val);
            return true;
        case 2:
            out = (val != 0.0);
            return true;
        default:
            return false;
    }
}

static void ensure_ring_meta(char* row, size_t var_index) {
    uint32_t rel = 0;
    uint32_t cap = 0;
    std::memcpy(&rel, row + ROW_RING_REL_OFF, 4);
    std::memcpy(&cap, row + ROW_RING_CAP_OFF, 4);
    if (rel == 0 && cap == 0 && g_ring_depth > 0) {
        rel = static_cast<uint32_t>(var_index * g_ring_depth * RING_SLOT_BYTES);
        cap = static_cast<uint32_t>(g_ring_depth);
        std::memcpy(row + ROW_RING_REL_OFF, &rel, 4);
        std::memcpy(row + ROW_RING_CAP_OFF, &cap, 4);
    }
}

/** Un post para el lector Python y otro para varmon_sidecar (sin competir por el mismo contador). */
static void post_shm_readers() {
    if (g_sem) sem_post(g_sem);
    if (g_sem_sidecar) sem_post(g_sem_sidecar);
}

static void push_ring_sample(char* arena_base, char* row, double ts, double val) {
    uint32_t cap = 0;
    std::memcpy(&cap, row + ROW_RING_CAP_OFF, 4);
    if (cap == 0) return;
    uint32_t rel = 0;
    std::memcpy(&rel, row + ROW_RING_REL_OFF, 4);
    uint64_t w = 0;
    std::memcpy(&w, row + ROW_WRITE_IDX_OFF, 8);
    const size_t slot = static_cast<size_t>(w % cap);
    char* slot_ptr = arena_base + rel + slot * RING_SLOT_BYTES;
    std::memcpy(slot_ptr, &ts, 8);
    std::memcpy(slot_ptr + 8, &val, 8);
    w++;
    std::memcpy(row + ROW_WRITE_IDX_OFF, &w, 8);
    std::memcpy(row + ROW_MIRROR_OFF, &val, 8);
}

/** v3: escribe ts+valor en la ranura w%cap y recién entonces incrementa write_idx con release. */
static void push_ring_sample_event_atomic(char* arena_base, char* row, double ts, double val) {
    uint32_t cap = 0;
    std::memcpy(&cap, row + ROW_RING_CAP_OFF, 4);
    if (cap == 0)
        return;
    uint32_t rel = 0;
    std::memcpy(&rel, row + ROW_RING_REL_OFF, 4);
    std::atomic_ref<uint64_t> wref(*reinterpret_cast<uint64_t*>(row + ROW_WRITE_IDX_OFF));
    const uint64_t w = wref.load(std::memory_order_relaxed);
    const size_t slot = static_cast<size_t>(w % cap);
    char* slot_ptr = arena_base + rel + slot * RING_SLOT_BYTES;
    std::memcpy(slot_ptr, &ts, 8);
    std::memcpy(slot_ptr + 8, &val, 8);
    wref.fetch_add(1, std::memory_order_release);
    std::memcpy(row + ROW_MIRROR_OFF, &val, 8);
}

void write_snapshot(VarMonitor* mon) {
    if (!g_active || !g_shm_ptr || !mon || !g_sem) return;
    if (g_layout_version >= 3u) {
        /* v3: publicación por append_scalar_event; write_snapshot no hace barrido. */
        return;
    }

    const bool perf_on = g_perf_collect.load(std::memory_order_relaxed);
    auto perf_pt = std::chrono::steady_clock::now();
    auto perf_tick = [&](unsigned idx) {
        if (!perf_on || idx >= PERF_PHASES) return;
        const auto n = std::chrono::steady_clock::now();
        const uint64_t us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(n - perf_pt).count());
        g_perf_us[idx].store(us, std::memory_order_relaxed);
        perf_pt = n;
    };

    const uint64_t pub_c = ++g_shm_publish_cycle;
    const unsigned dirty_cfg = get_config_uint("shm_publish_dirty_mode", 1);
    const bool dirty_on = dirty_cfg != 0;
    unsigned refresh_n = get_config_uint("shm_publish_full_refresh_cycles", 1);
    if (refresh_n < 1)
        refresh_n = 1;
    const bool full_refresh =
        !dirty_on || pub_c == 1ull ||
        ((pub_c % static_cast<uint64_t>(refresh_n)) == 0ull);
    const unsigned skip_uc_cfg = get_config_uint("shm_publish_skip_unchanged", 1);
    const bool skip_unchanged = skip_uc_cfg != 0;

    double timestamp = std::chrono::duration<double>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    uint64_t sub_gen = 0;
    {
        std::lock_guard<std::mutex> lock(g_subscription_mutex);
        sub_gen = g_subscription_generation.load(std::memory_order_relaxed);
        if (sub_gen != g_snap_sub_cache_gen) {
            g_snap_sub_cache = g_subscription;
            g_snap_sub_cache_gen = sub_gen;
        }
    }
    const std::vector<std::string>& sub = g_snap_sub_cache;

    char* h = static_cast<char*>(g_shm_ptr);
    char* arena = h + g_ring_arena_offset;

    uint64_t seq_old = 0;
    std::memcpy(&seq_old, h + 8, 8);
    double old_ts = 0.0;
    std::memcpy(&old_ts, h + 24, 8);
    const uint64_t seq = seq_old + 1u;
    std::memcpy(h + 8, &seq, 8);
    std::memcpy(h + 24, &timestamp, 8);
    double pub_period_sec = 0.0;
    if (seq_old >= 1u) {
        pub_period_sec = timestamp - old_ts;
        if (!std::isfinite(pub_period_sec) || pub_period_sec <= 0.0 || pub_period_sec > 3600.0)
            pub_period_sec = 0.0;
    }
    std::memcpy(h + HEADER_PUBLISH_PERIOD_SEC_OFF, &pub_period_sec, 8);
    perf_tick(0);

    if (sub.empty()) {
        uint32_t count = 0;
        std::memcpy(h + 16, &count, 4);
        post_shm_readers();
        perf_tick(5);
        return;
    }

    if (sub.size() > g_max_vars) {
        static std::atomic<bool> warned{false};
        if (!warned.exchange(true)) {
            std::cerr << "[VarMonitor] AVISO: suscripcion tiene " << sub.size()
                      << " variables pero shm_max_vars=" << g_max_vars
                      << ". Solo se rellenan las primeras " << g_max_vars << " filas.\n";
        }
    }

    const uint32_t nrows = static_cast<uint32_t>(std::min(sub.size(), g_max_vars));
    std::memcpy(h + 16, &nrows, 4);

    s_was_import_buf.assign(static_cast<size_t>(nrows), 0u);
    auto& was_import = s_was_import_buf;
    std::vector<std::pair<std::string, VarValue>> import_items;
    import_items.reserve(nrows);
    s_need_export_buf.clear();
    s_need_export_buf.reserve(nrows);
    auto& need_export = s_need_export_buf;

    for (uint32_t i = 0; i < nrows; ++i) {
        const std::string& sub_name = sub[i];
        char* row = h + HEADER_V2_SIZE + static_cast<size_t>(i) * TABLE_ROW_SIZE;
        uint8_t mode = static_cast<uint8_t>(row[ROW_MODE_OFF]);

        if (mode == MODE_IMPORT_SNAPSHOT) {
            was_import[i] = 1;
            std::string rname = row_name_cstr(row);
            if (rname == sub_name) {
                uint8_t type_byte = static_cast<uint8_t>(row[ROW_TYPE_OFF]);
                double val = 0.0;
                std::memcpy(&val, row + ROW_VALUE_OFF, 8);
                VarValue vv;
                if (shm_double_to_var_value(type_byte, val, vv))
                    import_items.emplace_back(sub_name, std::move(vv));
            }
            continue;
        }

        if (mode == MODE_EXPORT_SNAPSHOT && g_default_export_mode == MODE_EXPORT_RING) {
            row[ROW_MODE_OFF] = MODE_EXPORT_RING;
            ensure_ring_meta(row, i);
            row_write_pub_seq(row, seq);
        }
        need_export.push_back(i);
    }
    perf_tick(1);

    mon->apply_shm_import_values(import_items);

    mon->shm_prepare_export_cache(sub, sub_gen);
    perf_tick(2);

    const uint32_t n_slice = std::max(1u, g_slice_n.load(std::memory_order_relaxed));
    const bool force_slice_full = g_slice_force_full.load(std::memory_order_relaxed) != 0;
    const bool slice_active = !force_slice_full && n_slice > 1u;
    uint32_t phase = g_slice_phase.load(std::memory_order_relaxed);
    if (slice_active)
        phase %= n_slice;

    s_export_this_buf.clear();
    s_export_this_buf.reserve(need_export.size());
    auto& export_this_cycle = s_export_this_buf;
    if (!slice_active) {
        export_this_cycle = need_export;
    } else {
        for (uint32_t idx : need_export) {
            if ((idx % n_slice) == phase)
                export_this_cycle.push_back(idx);
        }
    }

    const std::vector<uint8_t>* fetch_mask_ptr = nullptr;
    if (dirty_on) {
        s_fetch_mask_buf.resize(export_this_cycle.size());
        auto& fetch_mask = s_fetch_mask_buf;
        for (size_t k = 0; k < export_this_cycle.size(); ++k) {
            const std::string& nm = sub[export_this_cycle[k]];
            fetch_mask[k] = mon->shm_should_fetch_for_publish(nm, full_refresh) ? 1 : 0;
        }
        fetch_mask_ptr = &s_fetch_mask_buf;
    }

    mon->get_shm_scalar_exports(sub, export_this_cycle, s_export_batch_buf, fetch_mask_ptr);
    const std::vector<VarMonitor::ShmScalarExport>& export_batch = s_export_batch_buf;

    if (dirty_on && full_refresh) {
        if (!slice_active)
            mon->shm_clear_all_dirty();
        else
            mon->shm_clear_dirty_for_subscription_rows(sub, export_this_cycle);
    }
    perf_tick(3);

    s_row_to_batch_buf.assign(static_cast<size_t>(nrows), UINT32_MAX);
    auto& row_to_batch = s_row_to_batch_buf;
    for (size_t k = 0; k < export_this_cycle.size(); ++k)
        row_to_batch[export_this_cycle[k]] = static_cast<uint32_t>(k);

    for (uint32_t i = 0; i < nrows; ++i) {
        const std::string& sub_name = sub[i];
        char* row = h + HEADER_V2_SIZE + static_cast<size_t>(i) * TABLE_ROW_SIZE;

        if (was_import[i]) {
            row[ROW_MODE_OFF] = g_default_export_mode;
            if (g_default_export_mode == MODE_EXPORT_RING)
                ensure_ring_meta(row, i);
            row_write_pub_seq(row, seq);
            continue;
        }

        uint8_t mode = static_cast<uint8_t>(row[ROW_MODE_OFF]);

        const uint32_t bk = row_to_batch[i];
        if (bk == UINT32_MAX)
            continue;

        if (dirty_on && fetch_mask_ptr != nullptr) {
            if ((*fetch_mask_ptr)[bk] == 0)
                continue;
        }

        const VarMonitor::ShmScalarExport& ex = export_batch[bk];

        if (!ex.ok) {
            if (i < g_last_pub_valid.size())
                g_last_pub_valid[static_cast<size_t>(i)] = 0;
            const uint8_t keep_mode = mode;
            if (keep_mode == MODE_EXPORT_RING) {
                /* read_idx es propiedad del consumidor (sidecar); no tocarlo aquí. */
                std::memset(row, 0, NAME_MAX_LEN);
                size_t nl = std::min(sub_name.size(), NAME_MAX_LEN);
                std::memcpy(row, sub_name.c_str(), nl);
                row[ROW_MODE_OFF] = keep_mode;
                ensure_ring_meta(row, i);
            } else {
                std::memset(row, 0, TABLE_ROW_SIZE);
                size_t nl = std::min(sub_name.size(), NAME_MAX_LEN);
                std::memcpy(row, sub_name.c_str(), nl);
                row[ROW_MODE_OFF] = keep_mode;
            }
            row_write_pub_seq(row, seq);
            continue;
        }

        const uint8_t type_byte = static_cast<uint8_t>(static_cast<int>(ex.type));
        const double val = ex.as_double;
        if (skip_unchanged && i < g_last_pub_valid.size() &&
            g_last_pub_valid[static_cast<size_t>(i)] != 0 &&
            g_last_pub_type[static_cast<size_t>(i)] == type_byte &&
            g_last_pub_val[static_cast<size_t>(i)] == val) {
            continue;
        }

        const uint8_t export_mode = mode;
        size_t name_len = std::min(sub_name.size(), NAME_MAX_LEN);
        if (export_mode == MODE_EXPORT_RING) {
            /* Preservar índices/metadatos del anillo; en especial read_idx (solo sidecar). */
            std::memset(row, 0, NAME_MAX_LEN);
            std::memcpy(row, sub_name.c_str(), name_len);
            row[ROW_TYPE_OFF] = type_byte;
            std::memcpy(row + ROW_VALUE_OFF, &val, 8);
            row[ROW_MODE_OFF] = export_mode;
        } else {
            std::memset(row, 0, TABLE_ROW_SIZE);
            std::memcpy(row, sub_name.c_str(), name_len);
            row[ROW_TYPE_OFF] = type_byte;
            std::memcpy(row + ROW_VALUE_OFF, &val, 8);
            row[ROW_MODE_OFF] = export_mode;
        }

        if (i < g_last_pub_valid.size()) {
            g_last_pub_valid[static_cast<size_t>(i)] = 1;
            g_last_pub_type[static_cast<size_t>(i)] = type_byte;
            g_last_pub_val[static_cast<size_t>(i)] = val;
        }

        if (export_mode == MODE_EXPORT_RING) {
            ensure_ring_meta(row, i);
            push_ring_sample(arena, row, timestamp, val);
        } else {
            std::memcpy(row + ROW_MIRROR_OFF, &val, 8);
        }
        row_write_pub_seq(row, seq);
    }
    perf_tick(4);

    if (slice_active) {
        uint32_t ph = g_slice_phase.load(std::memory_order_relaxed) % n_slice;
        ph = (ph + 1u) % n_slice;
        g_slice_phase.store(ph, std::memory_order_relaxed);
    }

    if (import_debug_env_enabled() && mon && !import_items.empty()) {
        for (const auto& [name, vv] : import_items) {
            if (!import_debug_name_matches(name))
                continue;
            std::optional<VarMonitor::VarSnapshot> snap = mon->get_var(name);
            if (!snap.has_value())
                continue;
            const double g = var_value_to_double(snap->value);
            std::cerr << "[VarMonitor IMPORT end_shm_publish] pub_c=" << pub_c << " name=" << name << " getter=" << g
                      << "\n";
        }
    }

    post_shm_readers();
    perf_tick(5);
}

void set_shm_publish_slice(uint32_t count, bool force_full) {
    unsigned max_r = get_config_uint("update_ratio_max", 512);
    if (max_r < 1u) max_r = 1u;
    if (count < 1u) count = 1u;
    if (count > max_r) count = max_r;
    uint32_t prev = g_slice_n.exchange(count, std::memory_order_relaxed);
    if (prev != count)
        g_slice_phase.store(0, std::memory_order_relaxed);
    g_slice_force_full.store(force_full ? 1u : 0u, std::memory_order_relaxed);
}

void set_subscription(const std::vector<std::string>& names) {
    std::lock_guard<std::mutex> lock(g_subscription_mutex);
    g_subscription.clear();
    std::unordered_set<std::string> seen;
    g_subscription.reserve(names.size());
    for (const auto& n : names) {
        if (n.empty() || seen.count(n)) continue;
        seen.insert(n);
        g_subscription.push_back(n);
    }
    g_subscription_generation.fetch_add(1, std::memory_order_relaxed);
    invalidate_last_pub_row_cache();
    g_slice_phase.store(0, std::memory_order_relaxed);
    if (VarMonitor* m = get_global_instance())
        m->invalidate_shm_sub_cache();
}

std::string get_shm_name() { return g_shm_name; }
std::string get_sem_name() { return g_sem_name; }
std::string get_sem_sidecar_name() { return g_sem_sidecar_name; }
bool is_active() { return g_active; }

uint32_t get_shm_publish_slice_count() {
    return g_slice_n.load(std::memory_order_relaxed);
}

bool get_shm_publish_slice_force_full() {
    return g_slice_force_full.load(std::memory_order_relaxed) != 0;
}

uint64_t subscription_generation() {
    return g_subscription_generation.load(std::memory_order_relaxed);
}

void set_perf_collect(bool enable) {
    g_perf_collect.store(enable, std::memory_order_relaxed);
}

bool perf_collect_enabled() {
    return g_perf_collect.load(std::memory_order_relaxed);
}

void append_perf_json(std::ostringstream& ss) {
    if (!g_perf_collect.load(std::memory_order_relaxed)) return;
    static const char* ids[] = {
        "cpp.prep_headers_sub",
        "cpp.scan_rows",
        "cpp.apply_import_prepare",
        "cpp.export_fetch_dirty",
        "cpp.write_rows",
        "cpp.post_sem",
    };
    ss << ",\"shm_perf_us\":[";
    for (unsigned i = 0; i < PERF_PHASES; ++i) {
        if (i) ss << ",";
        ss << "{\"id\":\"" << ids[i] << "\",\"last_us\":" << g_perf_us[i].load(std::memory_order_relaxed) << "}";
    }
    ss << "]";
}

bool append_scalar_event(VarMonitor* mon, const std::string& name, double event_time_sec, double value_as_double,
                         uint8_t type_byte) {
    if (!g_active || !g_shm_ptr || name.empty())
        return false;
    if (g_layout_version < 3u)
        return false;
    if (mon) {
        if (!mon->get_var(name).has_value())
            return false;
    }

    uint32_t row_index = UINT32_MAX;
    std::lock_guard<std::mutex> lock(g_subscription_mutex);
    for (uint32_t i = 0; i < g_subscription.size(); ++i) {
        if (g_subscription[i] == name) {
            row_index = i;
            break;
        }
    }
    if (row_index == UINT32_MAX || static_cast<size_t>(row_index) >= g_max_vars)
        return false;

    char* h = static_cast<char*>(g_shm_ptr);
    char* arena = h + g_ring_arena_offset;
    const uint32_t nrows = static_cast<uint32_t>(std::min(g_subscription.size(), g_max_vars));
    std::memcpy(h + 16, &nrows, 4);

    char* row = h + HEADER_V2_SIZE + static_cast<size_t>(row_index) * TABLE_ROW_SIZE;
    std::memset(row, 0, NAME_MAX_LEN);
    const size_t nl = std::min(name.size(), NAME_MAX_LEN);
    std::memcpy(row, name.c_str(), nl);
    row[ROW_MODE_OFF] = MODE_EXPORT_RING;
    row[ROW_TYPE_OFF] = type_byte;
    std::memcpy(row + ROW_VALUE_OFF, &value_as_double, 8);
    ensure_ring_meta(row, row_index);

    push_ring_sample_event_atomic(arena, row, event_time_sec, value_as_double);

    const uint64_t seq =
        std::atomic_ref<uint64_t>(*reinterpret_cast<uint64_t*>(h + 8)).fetch_add(1, std::memory_order_relaxed) + 1;
    std::memcpy(h + 24, &event_time_sec, 8);
    row_write_pub_seq(row, seq);

    post_shm_readers();
    return true;
}

uint32_t layout_version() {
    return g_layout_version;
}

} // namespace shm_publisher
} // namespace varmon
