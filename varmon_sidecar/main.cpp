/**
 * Consumidor SHM (mismo layout que web_monitor/shm_reader.py y libvarmonitor shm_publisher).
 * Grabación TSV alineada con _write_record_header_stream / _write_record_row_stream.
 * Sin dependencia de libvarmonitor.
 */
#include <atomic>
#include <charconv>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <functional>
#include <limits>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <semaphore.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

constexpr uint32_t kMagic = 0x4D524156u;
constexpr uint32_t kVersionV1 = 1u;
constexpr uint32_t kVersionV2 = 2u;
constexpr size_t kNameMaxLen = 128u;
constexpr size_t kEntrySizeV1 = kNameMaxLen + 1 + 8;
constexpr size_t kHeaderV1Size = 32u;
constexpr size_t kHeaderV2Size = 64u;
constexpr size_t kTableRowV2 = 176u;
constexpr size_t kRowModeOff = 128u;
constexpr size_t kRowTypeOff = 129u;
constexpr size_t kRowValueOff = 136u;
constexpr size_t kRowMirrorOff = 168u;
constexpr uint8_t kModeExportRing = 2u;
constexpr size_t kRowRingRelOff = 144u;
constexpr size_t kRowRingCapOff = 148u;
constexpr size_t kRowWriteIdxOff = 152u;
constexpr size_t kRowReadIdxOff = 160u;
constexpr size_t kRingSlotBytes = 16u;
constexpr size_t kHeaderRingArenaOff = 44u;

/* Depuración temporal: trazas [sidecar_trace] en stderr. Poner a 0 y recompilar para silenciar. */
#ifndef VARMON_SIDECAR_WAKE_TRACE
#define VARMON_SIDECAR_WAKE_TRACE 1
#endif

std::atomic<bool> g_stop{false};
static bool g_ring_trace_env_cached = false;
static bool g_ring_trace_enabled = false;

static bool ring_trace_enabled() {
    if (!g_ring_trace_env_cached) {
        g_ring_trace_env_cached = true;
        const char* v = std::getenv("VARMON_SIDECAR_RING_TRACE");
        g_ring_trace_enabled =
            (v != nullptr && v[0] != '\0' && std::strcmp(v, "0") != 0 && std::strcmp(v, "false") != 0 &&
             std::strcmp(v, "FALSE") != 0);
    }
    return g_ring_trace_enabled;
}

/** NDJSON append para que Python muestre en el visor de log retrasos SHM “reales” (grabación / alarmas sidecar). */
class ShmHealthEmitter {
public:
    explicit ShmHealthEmitter(std::string path) : path_(std::move(path)) {}

    void emit_seq_gap(uint64_t skipped, uint64_t from_seq, uint64_t to_seq) {
        if (path_.empty() || skipped == 0) return;
        const auto now = std::chrono::steady_clock::now();
        if (seq_gap_inited_ && (now - last_seq_gap_) < std::chrono::milliseconds(2000)) return;
        seq_gap_inited_ = true;
        last_seq_gap_ = now;
        char buf[288];
        std::snprintf(buf, sizeof(buf),
                      "{\"source\":\"varmon_sidecar\",\"kind\":\"seq_gap\",\"skipped\":%llu,\"from_seq\":%llu,\"to_"
                      "seq\":%llu}\n",
                      static_cast<unsigned long long>(skipped), static_cast<unsigned long long>(from_seq),
                      static_cast<unsigned long long>(to_seq));
        append_line(buf);
    }

    void emit_ring_loss() {
        if (path_.empty()) return;
        const auto now = std::chrono::steady_clock::now();
        if (ring_inited_ && (now - last_ring_) < std::chrono::milliseconds(2000)) return;
        ring_inited_ = true;
        last_ring_ = now;
        append_line("{\"source\":\"varmon_sidecar\",\"kind\":\"ring_loss\",\"detail\":\"v2 ring buffer overflow\"}\n");
    }

private:
    void append_line(const char* s) {
        FILE* f = std::fopen(path_.c_str(), "a");
        if (!f) return;
        std::fputs(s, f);
        std::fclose(f);
    }
    std::string path_;
    std::chrono::steady_clock::time_point last_seq_gap_{};
    std::chrono::steady_clock::time_point last_ring_{};
    bool seq_gap_inited_ = false;
    bool ring_inited_ = false;
};

/** Desglose de tiempos por ciclo de grabación (μs de reloj monótono); se vuelca a JSON para /api/perf. */
constexpr size_t kSidecarPerfPhases = 24;
static const char* kSidecarPerfIds[kSidecarPerfPhases] = {
    "sidecar.sem_wait",
    "sidecar.preflight",
    "sidecar.ring_extract",
    "sidecar.ring_format",
    "sidecar.ring_fwrite",
    "sidecar.ring_alarms",
    "sidecar.parse_snapshot",
    "sidecar.snap_format",
    "sidecar.snap_fwrite",
    "sidecar.snap_alarms_status",
    /* Desglose fino (sumar con fases 2–9 según camino) para cuadrar con traza wake→done */
    "sidecar.post_wake_overhead",
    "sidecar.preflight_read_shm_seq",
    "sidecar.preflight_seq_gap_emit",
    "sidecar.preflight_ring_overflow",
    "sidecar.snap_ostream_stream", /* tiempo: snprintf time_s + reserve (histórico: ostringstream) */
    "sidecar.snap_row_str",        /* columnas TSV + \\n */
    "sidecar.perf_json_flush",
    /* Reloj de pared maestro del ciclo: mismo instante que traza [sidecar_trace] wake → fin fwrite de la fila. */
    "sidecar.cycle_wall_wake_to_fwrite_done",
    "sidecar.parse_header_meta",
    "sidecar.parse_body_rows",
    "sidecar.ring_col_resolve_scan",
    "sidecar.ring_replay_build_rows",
    "sidecar.gap_preflight_to_ring_extract",
    "sidecar.gap_ring_extract_to_parse",
};

struct SidecarPerf {
    std::string path;
    /** Escribir JSON de perf cada N ciclos con datos (reduce fopen/fwrite en caliente). */
    unsigned flush_every_n = 4;
    unsigned flush_counter = 0;

    struct P {
        double last = 0;
        double ema = 0;
        double n = 0;
    } p[kSidecarPerfPhases];

    explicit SidecarPerf(std::string path_in) : path(std::move(path_in)) {}

    /** Si flush_every_n > 1, solo vuelca a disco cuando toca; devuelve si escribió. */
    bool flush_throttled(double sum_to_fwrite_us, double post_fwrite_work_us, double cycle_wall_wake_to_fwrite_us) {
        if (path.empty()) return false;
        if (flush_every_n <= 1u) {
            flush(sum_to_fwrite_us, post_fwrite_work_us, cycle_wall_wake_to_fwrite_us);
            return true;
        }
        if (++flush_counter >= flush_every_n) {
            flush_counter = 0;
            flush(sum_to_fwrite_us, post_fwrite_work_us, cycle_wall_wake_to_fwrite_us);
            return true;
        }
        return false;
    }

    static uint64_t micros(std::chrono::steady_clock::time_point a, std::chrono::steady_clock::time_point b) {
        return static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(b - a).count());
    }

    void record(size_t i, uint64_t us) {
        if (i >= kSidecarPerfPhases || path.empty()) return;
        P& x = p[i];
        x.last = static_cast<double>(us);
        x.ema = x.ema * 0.85 + x.last * 0.15;
        x.n += 1.0;
    }

    /**
     * post_fwrite_work_us: alarmas + write_status tras la fila (no incluye el coste de escribir este JSON).
     * cycle_wall_wake_to_fwrite_us: tiempo de pared que encuadra todo el trabajo hasta la fila (fase 17); debe
     *   cuadrar ~con sum_to_fwrite_us + huecos de scheduling no medidos en subfases.
     * sum_to_fwrite_us: suma explícita 10+11+12+13+22+2+23+6+14+15+8 en camino snapshot (sin 9 ni 16).
     */
    void flush(double sum_to_fwrite_us, double post_fwrite_work_us, double cycle_wall_wake_to_fwrite_us) const {
        if (path.empty()) return;
        std::FILE* f = std::fopen(path.c_str(), "w");
        if (!f) return;
        std::fprintf(f, "{\"phases\":[");
        for (size_t i = 0; i < kSidecarPerfPhases; ++i) {
            if (i) std::fprintf(f, ",");
            const P& x = p[i];
            std::fprintf(f, "{\"id\":\"%s\",\"last_us\":%.3f,\"ema_us\":%.3f,\"samples\":%.0f}", kSidecarPerfIds[i],
                         x.last, x.ema, x.n);
        }
        std::fprintf(f,
                     "],\"sum_to_fwrite_us\":%.3f,\"post_fwrite_work_us\":%.3f,\"cycle_wall_wake_to_fwrite_us\":%.3f}\n",
                     sum_to_fwrite_us, post_fwrite_work_us, cycle_wall_wake_to_fwrite_us);
        std::fflush(f);
        std::fclose(f);
    }
};

static bool read_shm_seq(const uint8_t* base, size_t map_size, uint64_t& seq_out) {
    if (map_size < 16) return false;
    uint32_t magic = 0;
    std::memcpy(&magic, base, 4);
    if (magic != kMagic) return false;
    std::memcpy(&seq_out, base + 8, 8);
    return true;
}

static bool v2_any_ring_overflow(const uint8_t* base, size_t map_size, uint32_t max_vars) {
    if (map_size < kHeaderV2Size) return false;
    uint32_t version = 0;
    std::memcpy(&version, base + 4, 4);
    if (version < kVersionV2) return false;
    uint32_t count = 0;
    std::memcpy(&count, base + 16, 4);
    if (count > max_vars) count = max_vars;
    uint32_t table_off = 0;
    uint32_t stride = 0;
    std::memcpy(&table_off, base + 32, 4);
    std::memcpy(&stride, base + 36, 4);
    if (stride < kTableRowV2) stride = static_cast<uint32_t>(kTableRowV2);
    for (uint32_t i = 0; i < count; ++i) {
        const size_t off = static_cast<size_t>(table_off) + static_cast<size_t>(i) * stride;
        if (off + kTableRowV2 > map_size) break;
        const uint8_t* row = base + off;
        if (row[kRowModeOff] != kModeExportRing) continue;
        uint32_t cap = 0;
        std::memcpy(&cap, row + kRowRingCapOff, 4);
        if (cap == 0) continue;
        uint64_t w = 0;
        uint64_t r = 0;
        std::memcpy(&w, row + kRowWriteIdxOff, 8);
        std::memcpy(&r, row + kRowReadIdxOff, 8);
        const uint64_t pending = w - r;
        if (pending > cap) return true;
    }
    return false;
}

void on_signal(int) { g_stop.store(true); }

void print_usage(const char* argv0) {
    std::fprintf(stderr,
        "Grabación:\n  %s --shm-name NAME --sem-name /NAME-sc (sem sidecar de server_info; no el de Python) "
        "--output PATH --names-file PATH "
        "[--max-vars N] [--status-file PATH] [--alarms-file PATH] [--alarm-exit-file PATH] "
        "[--shm-health-file PATH] [--perf-file PATH]\n"
        "Entorno: VARMON_SIDECAR_PERF_FLUSH_EVERY=N (1–512) reduce fopen del JSON de --perf-file (defecto 4).\n"
        "Monitor de alarmas (TSV burst; sem sidecar como arriba, fallback polling si falla sem_open):\n"
        "  %s --alarm-monitor --shm-name NAME --sem-name /NAME-sc --names-file PATH --alarms-file PATH "
        "--alarm-events-file PATH --alarm-output-dir DIR [--max-vars N] [--shm-health-file PATH]\n",
        argv0,
        argv0);
}

bool read_names_file(const std::string& path, std::vector<std::string>& out) {
    std::ifstream f(path);
    if (!f) return false;
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!line.empty()) out.push_back(line);
    }
    return !out.empty();
}

struct Entry {
    uint8_t type_byte = 0;
    double value = 0.0;
};

static void trim_inplace(std::string& s) {
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
    if (i > 0) s.erase(0, i);
}

static std::vector<std::string> split_tab(const std::string& line) {
    std::vector<std::string> p;
    size_t a = 0;
    for (;;) {
        size_t b = line.find('\t', a);
        if (b == std::string::npos) {
            p.push_back(line.substr(a));
            break;
        }
        p.push_back(line.substr(a, b - a));
        a = b + 1;
    }
    for (auto& s : p) trim_inplace(s);
    return p;
}

static bool parse_opt_double(const std::string& s, double& out, bool& has) {
    if (s.empty()) {
        has = false;
        return true;
    }
    char* end = nullptr;
    out = std::strtod(s.c_str(), &end);
    if (end == s.c_str()) {
        has = false;
        return false;
    }
    has = true;
    return true;
}

static bool parse_opt_int(const std::string& s, int& out) {
    if (s.empty()) {
        out = 0;
        return true;
    }
    char* end = nullptr;
    long v = std::strtol(s.c_str(), &end, 10);
    if (end == s.c_str()) {
        out = 0;
        return false;
    }
    out = static_cast<int>(v);
    return true;
}

/** Misma semántica que web_monitor/app.py _evaluate_alarms (TSV escrito por Python). */
struct AlarmRule {
    std::string name;
    bool has_lo = false;
    bool has_hi = false;
    double lo = 0;
    double hi = 0;
    double hys = 0;
    int delay_ms = 0;
};

bool read_alarms_file(const std::string& path, std::vector<AlarmRule>& out) {
    std::ifstream f(path);
    if (!f) return false;
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        trim_inplace(line);
        if (line.empty() || line[0] == '#') continue;
        std::vector<std::string> p = split_tab(line);
        if (p.empty() || p[0].empty()) continue;
        while (p.size() < 5) p.push_back("");
        AlarmRule r;
        r.name = p[0];
        if (!parse_opt_double(p[1], r.lo, r.has_lo)) continue;
        if (!parse_opt_double(p[2], r.hi, r.has_hi)) continue;
        bool has_hys = false;
        if (!parse_opt_double(p[3], r.hys, has_hys)) continue;
        if (!has_hys) r.hys = 0.0;
        r.hys = std::max(0.0, r.hys);
        if (!parse_opt_int(p[4], r.delay_ms)) continue;
        if (r.delay_ms < 0) r.delay_ms = 0;
        out.push_back(std::move(r));
    }
    return !out.empty();
}

static double entry_numeric_for_alarm(const Entry& e) {
    if (e.type_byte == 1) return static_cast<double>(static_cast<int32_t>(e.value));
    if (e.type_byte == 2) return e.value != 0.0 ? 1.0 : 0.0;
    return e.value;
}

static std::string json_escape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        if (c == '\\' || c == '"') {
            o += '\\';
            o += static_cast<char>(c);
        } else if (c < 0x20u) {
            o += ' ';
        } else {
            o += static_cast<char>(c);
        }
    }
    return o;
}

static void write_alarm_exit_json(const std::string& path, const std::string& name, const std::string& reason,
                                  double value) {
    if (path.empty()) return;
    FILE* af = std::fopen(path.c_str(), "w");
    if (!af) return;
    std::string en = json_escape(name);
    std::string er = json_escape(reason);
    std::fprintf(af, "{\"name\":\"%s\",\"reason\":\"%s\",\"value\":%.17g}\n", en.c_str(), er.c_str(), value);
    std::fclose(af);
}

/**
 * Una pasada por las reglas (orden del fichero). Actualiza prev_state / pending_since_ms.
 * Si hay disparo (transición a alarma confirmada), rellena out_* y devuelve true.
 */
bool evaluate_alarms_step(const std::vector<AlarmRule>& rules, const std::unordered_map<std::string, Entry>& snap,
                          int64_t now_ms, std::unordered_map<std::string, bool>& prev_state,
                          std::unordered_map<std::string, int64_t>& pending_since_ms, std::string& out_name,
                          std::string& out_reason, double& out_value) {
    for (const auto& rule : rules) {
        auto it = snap.find(rule.name);
        if (it == snap.end()) continue;
        double val = entry_numeric_for_alarm(it->second);
        const double hi = rule.has_hi ? rule.hi : 0.0;
        const double lo = rule.has_lo ? rule.lo : 0.0;
        const double hys = rule.hys;
        const int delay_ms = rule.delay_ms;
        bool was = false;
        auto ps = prev_state.find(rule.name);
        if (ps != prev_state.end()) was = ps->second;

        bool alarming = false;
        const bool over_hi = rule.has_hi && val > hi;
        const bool under_lo = rule.has_lo && val < lo;
        if (was) {
            const bool clear_hi = !rule.has_hi || val <= (hi - hys);
            const bool clear_lo = !rule.has_lo || val >= (lo + hys);
            if (clear_hi && clear_lo) {
                alarming = false;
            } else {
                alarming = (rule.has_hi && val > (hi - hys)) || (rule.has_lo && val < (lo + hys));
            }
        } else {
            alarming = over_hi || under_lo;
        }

        if (!alarming) {
            pending_since_ms.erase(rule.name);
            prev_state[rule.name] = false;
        } else {
            auto pe = pending_since_ms.find(rule.name);
            if (pe == pending_since_ms.end()) pending_since_ms[rule.name] = now_ms;
            int64_t since = pending_since_ms[rule.name];
            const bool confirmed = (now_ms - since >= delay_ms);
            prev_state[rule.name] = confirmed;
            if (confirmed && !was) {
                std::ostringstream rs;
                rs.setf(std::ios::fixed);
                if (rule.has_hi && val > hi) {
                    rs << rule.name << " = " << std::setprecision(4) << val << " > Hi:" << hi;
                } else if (rule.has_lo && val < lo) {
                    rs << rule.name << " = " << std::setprecision(4) << val << " < Lo:" << lo;
                } else {
                    rs << rule.name << " en alarma (" << std::setprecision(4) << val << ")";
                }
                out_name = rule.name;
                out_reason = rs.str();
                out_value = val;
                return true;
            }
        }
    }
    return false;
}

/** Nombre de fila v1/v2 desde bytes de nombre en la tabla (trim espacios finales). */
static void row_name_into_string(const uint8_t* ent, std::string& name) {
    char namebuf[kNameMaxLen + 1];
    std::memcpy(namebuf, ent, kNameMaxLen);
    namebuf[kNameMaxLen] = '\0';
    name.assign(namebuf);
    const size_t z = name.find('\0');
    if (z != std::string::npos) name.resize(z);
    while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.pop_back();
}

/**
 * Lee cabecera SHM y filas v1/v2. Si only_keys != nullptr, solo rellena out_map para esos nombres (p. ej. columnas
 * del TSV): sigue siendo O(count) en lectura de mmap pero evita miles de inserciones en el mapa cuando count ≫ k.
 */
bool parse_snapshot(const uint8_t* base, size_t map_size, uint32_t max_vars, double& timestamp_out,
                    std::unordered_map<std::string, Entry>& out_map, const std::unordered_set<std::string>* only_keys,
                    SidecarPerf* perf_detail = nullptr) {
    using pclock = std::chrono::steady_clock;
    const auto t_parse_enter = pclock::now();
    auto mark_header_done = [&](pclock::time_point t_header_end) {
        if (perf_detail)
            perf_detail->record(18, SidecarPerf::micros(t_parse_enter, t_header_end));
    };
    auto mark_body_done = [&](pclock::time_point t_body_start, pclock::time_point t_body_end) {
        if (perf_detail) perf_detail->record(19, SidecarPerf::micros(t_body_start, t_body_end));
    };

    out_map.clear();
    if (map_size < kHeaderV1Size) return false;
    uint32_t magic = 0;
    std::memcpy(&magic, base, 4);
    if (magic != kMagic) return false;
    uint32_t version = 0;
    std::memcpy(&version, base + 4, 4);
    uint64_t seq = 0;
    uint32_t count = 0;
    std::memcpy(&seq, base + 8, 8);
    std::memcpy(&count, base + 16, 4);
    (void)seq;
    std::memcpy(&timestamp_out, base + 24, 8);
    if (count > max_vars) count = max_vars;
    if (only_keys != nullptr && !only_keys->empty()) {
        out_map.reserve(only_keys->size());
    } else if (count > 0) {
        out_map.reserve(static_cast<size_t>(count));
    }

    if (version == kVersionV1) {
        mark_header_done(pclock::now());
        const auto t_body_a = pclock::now();
        const uint8_t* ent = base + kHeaderV1Size;
        std::string name;
        name.reserve(kNameMaxLen);
        for (uint32_t i = 0; i < count; ++i) {
            if (static_cast<size_t>(ent - base) + kEntrySizeV1 > map_size) break;
            row_name_into_string(ent, name);
            uint8_t type_byte = ent[kNameMaxLen];
            double val = 0.0;
            std::memcpy(&val, ent + kNameMaxLen + 1, 8);
            ent += kEntrySizeV1;
            if (name.empty()) continue;
            if (only_keys != nullptr && !only_keys->count(name)) continue;
            out_map[name] = Entry{type_byte, val};
        }
        mark_body_done(t_body_a, pclock::now());
        return true;
    }

    if (version >= kVersionV2) {
        if (map_size < kHeaderV2Size) return false;
        uint32_t table_off = 0;
        uint32_t stride = 0;
        std::memcpy(&table_off, base + 32, 4);
        std::memcpy(&stride, base + 36, 4);
        if (stride < kTableRowV2) stride = static_cast<uint32_t>(kTableRowV2);
        mark_header_done(pclock::now());
        const auto t_body_a = pclock::now();
        std::string name;
        name.reserve(kNameMaxLen);
        for (uint32_t i = 0; i < count; ++i) {
            const size_t off = static_cast<size_t>(table_off) + static_cast<size_t>(i) * stride;
            if (off + kTableRowV2 > map_size) break;
            const uint8_t* ent = base + off;
            row_name_into_string(ent, name);
            const uint8_t mode = ent[kRowModeOff];
            uint8_t type_byte = ent[kRowTypeOff];
            double val = 0.0;
            double mirror = 0.0;
            std::memcpy(&val, ent + kRowValueOff, 8);
            std::memcpy(&mirror, ent + kRowMirrorOff, 8);
            const double use = (mode == kModeExportRing) ? mirror : val;
            if (name.empty()) continue;
            if (only_keys != nullptr && !only_keys->count(name)) continue;
            out_map[name] = Entry{type_byte, use};
        }
        mark_body_done(t_body_a, pclock::now());
        return true;
    }

    return false;
}

/** Añade representación TSV de una celda sin string temporal por valor (to_chars solo enteros; ver nota). */
static void append_tsv_cell(std::string& out, uint8_t type_byte, double raw) {
    if (type_byte == 2) { /* Bool */
        out += (raw != 0.0) ? "True" : "False";
        return;
    }
    if (type_byte == 1) { /* Int32 */
        char ibuf[16];
        const auto r = std::to_chars(ibuf, ibuf + sizeof(ibuf), static_cast<int32_t>(raw));
        if (r.ec == std::errc{}) out.append(ibuf, static_cast<size_t>(r.ptr - ibuf));
        return;
    }
    /*
     * No usar std::to_chars para double: en libstdc++ la sobrecarga float existe solo desde GCC 11;
     * fuera (p. ej. GCC 9 en muchas distros) falla la resolución de sobrecarga en tiempo de compilación.
     */
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", raw);
    if (std::strcmp(buf, "-0") == 0) {
        out += '0';
    } else {
        out.append(buf);
    }
}

bool sem_timedwait_secs(sem_t* sem, double timeout_sec) {
    if (timeout_sec < 0) timeout_sec = 0;
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return sem_wait(sem) == 0;
    long add_ns = static_cast<long>((timeout_sec - std::floor(timeout_sec)) * 1e9);
    ts.tv_sec += static_cast<time_t>(timeout_sec) + (ts.tv_nsec + add_ns) / 1000000000L;
    ts.tv_nsec = (ts.tv_nsec + add_ns) % 1000000000L;
    if (sem_timedwait(sem, &ts) == 0) return true;
    return false;
}

constexpr double kAlarmRingSec = 2.2;
constexpr double kAlarmPostSec = 1.0;
constexpr std::size_t kMaxAlarmTsvRows = 8000;

using SnapMap = std::unordered_map<std::string, Entry>;

/** Fila grabación: time_s fijo + columnas; sin ostringstream ni std::string por celda. */
static void append_recording_tsv_line(std::string& line, double t_rel, const std::vector<std::string>& col_names,
                                      const SnapMap& snap) {
    line.clear();
    line.reserve(col_names.size() * 24u + 48u);
    char tbuf[32];
    const int tn = std::snprintf(tbuf, sizeof(tbuf), "%.6f", t_rel);
    if (tn > 0) line.append(tbuf, static_cast<size_t>(tn));
    for (const auto& name : col_names) {
        line.push_back('\t');
        const auto it = snap.find(name);
        if (it != snap.end()) append_tsv_cell(line, it->second.type_byte, it->second.value);
    }
    line.push_back('\n');
}

static void append_recording_tsv_line_from_cols(std::string& line, double t_rel, const std::vector<std::string>& col_names,
                                                const std::vector<Entry>& entries, const std::vector<char>& col_present) {
    line.clear();
    line.reserve(col_names.size() * 24u + 48u);
    char tbuf[32];
    const int tn = std::snprintf(tbuf, sizeof(tbuf), "%.6f", t_rel);
    if (tn > 0) line.append(tbuf, static_cast<size_t>(tn));
    for (size_t i = 0; i < col_names.size(); ++i) {
        line.push_back('\t');
        if (static_cast<size_t>(i) < col_present.size() && col_present[i])
            append_tsv_cell(line, entries[i].type_byte, entries[i].value);
    }
    line.push_back('\n');
}

static void snap_map_from_column_entries(SnapMap& snap, const std::vector<std::string>& col_names,
                                         const std::vector<Entry>& entries, const std::vector<char>& col_present) {
    snap.clear();
    snap.reserve(col_names.size());
    for (size_t i = 0; i < col_names.size(); ++i) {
        if (static_cast<size_t>(i) < col_present.size() && col_present[i])
            snap.emplace(col_names[i], entries[i]);
    }
}

static constexpr size_t kRecordingBadOff = static_cast<size_t>(-1);

/** Metadatos SHM + mapa nombre→offset de fila; evita O(N) por ciclo en grabación. */
struct RecordingLayoutCache {
    bool valid = false;
    uint32_t magic_store = 0;
    uint32_t version = 0;
    uint32_t count = 0;
    uint32_t table_off = 0;
    uint32_t stride = 0;
    size_t map_size_at_build = 0;
    std::unordered_map<std::string, size_t> name_to_row_off;
    std::vector<size_t> rec_row_off;
};

static void recording_layout_invalidate(RecordingLayoutCache& c) {
    c.valid = false;
    c.name_to_row_off.clear();
    c.rec_row_off.clear();
}

static bool recording_shm_header_matches_cache(const RecordingLayoutCache& c, const uint8_t* base, size_t map_size) {
    if (!c.valid || map_size != c.map_size_at_build || map_size < kHeaderV1Size) return false;
    uint32_t m = 0;
    uint32_t v = 0;
    uint32_t cnt = 0;
    std::memcpy(&m, base, 4);
    std::memcpy(&v, base + 4, 4);
    std::memcpy(&cnt, base + 16, 4);
    if (m != c.magic_store || v != c.version || cnt != c.count) return false;
    if (v >= kVersionV2) {
        if (map_size < kHeaderV2Size) return false;
        uint32_t to = 0;
        uint32_t st = 0;
        std::memcpy(&to, base + 32, 4);
        std::memcpy(&st, base + 36, 4);
        return to == c.table_off && st == c.stride;
    }
    return c.table_off == kHeaderV1Size && c.stride == static_cast<uint32_t>(kEntrySizeV1);
}

static bool recording_layout_verify_names(const uint8_t* base, const std::vector<std::string>& col_names,
                                          const RecordingLayoutCache& c) {
    std::string tmp;
    tmp.reserve(kNameMaxLen);
    for (size_t j = 0; j < col_names.size(); ++j) {
        const size_t off = c.rec_row_off[j];
        if (off == kRecordingBadOff) continue;
        row_name_into_string(base + off, tmp);
        if (tmp != col_names[j]) return false;
    }
    return true;
}

static bool recording_layout_rebuild(const uint8_t* base, size_t map_size, uint32_t max_vars,
                                     const std::vector<std::string>& col_names, RecordingLayoutCache& c) {
    recording_layout_invalidate(c);
    if (map_size < kHeaderV1Size) return false;
    uint32_t magic = 0;
    std::memcpy(&magic, base, 4);
    if (magic != kMagic) return false;
    uint32_t version = 0;
    std::memcpy(&version, base + 4, 4);
    uint32_t count = 0;
    std::memcpy(&count, base + 16, 4);
    if (count > max_vars) count = max_vars;
    c.magic_store = magic;
    c.version = version;
    c.count = count;
    c.map_size_at_build = map_size;
    c.name_to_row_off.clear();
    c.name_to_row_off.reserve(static_cast<size_t>(count) + 8u);
    c.rec_row_off.assign(col_names.size(), kRecordingBadOff);
    std::string rname;
    rname.reserve(kNameMaxLen);

    if (version == kVersionV1) {
        c.table_off = static_cast<uint32_t>(kHeaderV1Size);
        c.stride = static_cast<uint32_t>(kEntrySizeV1);
        const uint8_t* ent = base + kHeaderV1Size;
        for (uint32_t i = 0; i < count; ++i) {
            if (static_cast<size_t>(ent - base) + kEntrySizeV1 > map_size) break;
            row_name_into_string(ent, rname);
            if (!rname.empty()) c.name_to_row_off.emplace(rname, static_cast<size_t>(ent - base));
            ent += kEntrySizeV1;
        }
    } else if (version >= kVersionV2) {
        if (map_size < kHeaderV2Size) return false;
        std::memcpy(&c.table_off, base + 32, 4);
        std::memcpy(&c.stride, base + 36, 4);
        if (c.stride < kTableRowV2) c.stride = static_cast<uint32_t>(kTableRowV2);
        for (uint32_t i = 0; i < count; ++i) {
            const size_t off = static_cast<size_t>(c.table_off) + static_cast<size_t>(i) * c.stride;
            if (off + kTableRowV2 > map_size) break;
            row_name_into_string(base + off, rname);
            if (!rname.empty()) c.name_to_row_off.emplace(rname, off);
        }
    } else {
        return false;
    }

    for (size_t j = 0; j < col_names.size(); ++j) {
        const auto it = c.name_to_row_off.find(col_names[j]);
        if (it != c.name_to_row_off.end()) c.rec_row_off[j] = it->second;
    }
    c.valid = true;
    return true;
}

/**
 * Lee timestamp + solo columnas grabadas (O(k)). Rellena fases perf 18/19/6 como parse_snapshot acotado.
 */
static bool read_recording_snapshot_columns(const uint8_t* base, size_t map_size, const RecordingLayoutCache& c,
                                            const std::vector<std::string>& col_names, double& ts_out,
                                            std::vector<Entry>& entries_out, std::vector<char>& col_present_out,
                                            SidecarPerf* perf_detail) {
    using pclock = std::chrono::steady_clock;
    const auto t_parse_enter = pclock::now();
    entries_out.resize(col_names.size());
    col_present_out.assign(col_names.size(), 0);
    uint32_t magic = 0;
    std::memcpy(&magic, base, 4);
    if (magic != kMagic) return false;
    std::memcpy(&ts_out, base + 24, 8);
    const auto t_after_header = pclock::now();
    if (perf_detail)
        perf_detail->record(18, SidecarPerf::micros(t_parse_enter, t_after_header));
    const auto t_body_a = pclock::now();

    if (c.version == kVersionV1) {
        for (size_t j = 0; j < col_names.size(); ++j) {
            const size_t off = c.rec_row_off[j];
            if (off == kRecordingBadOff || off + kEntrySizeV1 > map_size) continue;
            const uint8_t* ent = base + off;
            uint8_t type_byte = ent[kNameMaxLen];
            double val = 0.0;
            std::memcpy(&val, ent + kNameMaxLen + 1, 8);
            entries_out[j] = Entry{type_byte, val};
            col_present_out[j] = 1;
        }
    } else {
        for (size_t j = 0; j < col_names.size(); ++j) {
            const size_t off = c.rec_row_off[j];
            if (off == kRecordingBadOff || off + kTableRowV2 > map_size) continue;
            const uint8_t* ent = base + off;
            const uint8_t mode = ent[kRowModeOff];
            uint8_t type_byte = ent[kRowTypeOff];
            double val = 0.0;
            double mirror = 0.0;
            std::memcpy(&val, ent + kRowValueOff, 8);
            std::memcpy(&mirror, ent + kRowMirrorOff, 8);
            const double use = (mode == kModeExportRing) ? mirror : val;
            entries_out[j] = Entry{type_byte, use};
            col_present_out[j] = 1;
        }
    }

    const auto t_body_b = pclock::now();
    if (perf_detail) perf_detail->record(19, SidecarPerf::micros(t_body_a, t_body_b));
    return true;
}

struct RingColInfo {
    size_t row_off{};
    uint32_t cap{};
    uint32_t rel{};
    uint64_t r{};
    uint64_t w{};
    uint8_t type_byte{};
};

static bool read_ring_slot_at(const uint8_t* arena, size_t arena_size, uint32_t rel, uint32_t cap, uint64_t logical_k,
                              double& ts_out, double& val_out) {
    if (cap == 0) return false;
    if (static_cast<size_t>(rel) + static_cast<size_t>(cap) * kRingSlotBytes > arena_size) return false;
    const uint64_t slot = logical_k % cap;
    const size_t off = static_cast<size_t>(rel) + static_cast<size_t>(slot) * kRingSlotBytes;
    if (off + kRingSlotBytes > arena_size) return false;
    std::memcpy(&ts_out, arena + off, 8);
    std::memcpy(&val_out, arena + off + 8, 8);
    return true;
}

/**
 * Núcleo replay anillo v2: con mapa nombre→offset precargado (grabación) la fase 20 es O(k); con líneas TSV no hay
 * SnapMap por muestra. out_snap XOR out_lines debe estar activo.
 */
static int v2_ring_replay_extract_impl(uint8_t* base, size_t map_size, uint32_t max_vars,
                                       const std::vector<std::string>& col_names,
                                       std::vector<std::pair<double, SnapMap>>* out_snap,
                                       std::vector<std::pair<double, std::string>>* out_lines,
                                       std::vector<std::vector<Entry>>* out_entries_per_row,
                                       const std::function<double(double)>* row_time_fn, SidecarPerf* perf_detail,
                                       std::unordered_map<std::string, size_t>* shared_name_to_off, bool shared_map_ready) {
    using rclock = std::chrono::steady_clock;
    if (out_snap) out_snap->clear();
    if (out_lines) out_lines->clear();
    if (out_entries_per_row) out_entries_per_row->clear();
    if (map_size < kHeaderV2Size || col_names.empty()) return 0;
    if (static_cast<bool>(out_lines) != static_cast<bool>(row_time_fn)) return 0;
    if (out_snap && out_lines) return 0;
    if (!out_snap && !out_lines) return 0;

    uint32_t magic = 0;
    std::memcpy(&magic, base, 4);
    if (magic != kMagic) return 0;
    uint32_t version = 0;
    std::memcpy(&version, base + 4, 4);
    if (version < kVersionV2) return 0;
    uint32_t count = 0;
    std::memcpy(&count, base + 16, 4);
    if (count > max_vars) count = max_vars;
    uint32_t table_off = 0;
    uint32_t stride = 0;
    std::memcpy(&table_off, base + 32, 4);
    std::memcpy(&stride, base + 36, 4);
    if (stride < kTableRowV2) stride = static_cast<uint32_t>(kTableRowV2);
    uint32_t ring_arena_off = 0;
    std::memcpy(&ring_arena_off, base + kHeaderRingArenaOff, 4);
    if (static_cast<size_t>(ring_arena_off) >= map_size) return 0;
    const uint8_t* arena = base + ring_arena_off;
    const size_t arena_size = map_size - static_cast<size_t>(ring_arena_off);

    std::vector<RingColInfo> cols;
    cols.reserve(col_names.size());

    std::unordered_map<std::string, size_t> local_name_map;
    std::unordered_map<std::string, size_t>* name_lookup = nullptr;

    const auto t_resolve0 = rclock::now();
    if (shared_map_ready && shared_name_to_off != nullptr && !shared_name_to_off->empty()) {
        name_lookup = shared_name_to_off;
    } else {
        name_lookup = &local_name_map;
        local_name_map.reserve(static_cast<size_t>(count) + 8u);
        std::string rname;
        rname.reserve(kNameMaxLen);
        for (uint32_t i = 0; i < count; ++i) {
            const size_t off = static_cast<size_t>(table_off) + static_cast<size_t>(i) * stride;
            if (off + kTableRowV2 > map_size) break;
            row_name_into_string(base + off, rname);
            if (!rname.empty()) local_name_map.emplace(rname, off);
        }
        if (shared_name_to_off != nullptr) *shared_name_to_off = local_name_map;
    }

    for (const std::string& want : col_names) {
        const auto it = name_lookup->find(want);
        if (it == name_lookup->end()) return 0;
        const size_t off = it->second;
        const uint8_t* ent = base + off;
        const uint8_t mode = ent[kRowModeOff];
        if (mode != kModeExportRing) return 0;
        RingColInfo c{};
        c.row_off = off;
        std::memcpy(&c.rel, ent + kRowRingRelOff, 4);
        std::memcpy(&c.cap, ent + kRowRingCapOff, 4);
        std::memcpy(&c.r, ent + kRowReadIdxOff, 8);
        std::memcpy(&c.w, ent + kRowWriteIdxOff, 8);
        c.type_byte = ent[kRowTypeOff];
        if (c.cap == 0) return 0;
        cols.push_back(c);
    }
    const auto t_resolve1 = rclock::now();
    if (perf_detail) perf_detail->record(20, SidecarPerf::micros(t_resolve0, t_resolve1));

    const uint64_t r0 = cols[0].r;
    const uint64_t w0 = cols[0].w;
    if (w0 < r0) return 0;
    const uint64_t pending = w0 - r0;
    if (pending == 0) return 0;
    if (ring_trace_enabled()) {
        std::fprintf(stderr,
                     "[ring_trace] replay_probe pending=%llu r0=%llu w0=%llu cols=%zu cap0=%u map_ready=%d\n",
                     static_cast<unsigned long long>(pending), static_cast<unsigned long long>(r0),
                     static_cast<unsigned long long>(w0), cols.size(), static_cast<unsigned>(cols[0].cap),
                     shared_map_ready ? 1 : 0);
        std::fflush(stderr);
    }
    for (const RingColInfo& c : cols) {
        if (c.r != r0 || c.w != w0) return 0;
        if (c.w - c.r > c.cap) return 0;
    }

    const auto t_build0 = rclock::now();
    if (out_snap) {
        out_snap->reserve(static_cast<size_t>(pending));
        for (uint64_t k = r0; k < w0; ++k) {
            double ts0 = 0;
            double scratch = 0;
            if (!read_ring_slot_at(arena, arena_size, cols[0].rel, cols[0].cap, k, ts0, scratch)) return 0;
            SnapMap snap;
            snap.reserve(cols.size());
            for (size_t ci = 0; ci < cols.size(); ++ci) {
                const RingColInfo& c = cols[ci];
                double ts = 0;
                double val = 0;
                if (!read_ring_slot_at(arena, arena_size, c.rel, c.cap, k, ts, val)) return 0;
                if (std::memcmp(&ts, &ts0, sizeof(double)) != 0) return 0;
                snap.emplace(col_names[ci], Entry{c.type_byte, val});
            }
            out_snap->push_back({ts0, std::move(snap)});
        }
    } else {
        out_lines->reserve(static_cast<size_t>(pending));
        if (out_entries_per_row) out_entries_per_row->reserve(static_cast<size_t>(pending));
        for (uint64_t k = r0; k < w0; ++k) {
            double ts0 = 0;
            double scratch = 0;
            if (!read_ring_slot_at(arena, arena_size, cols[0].rel, cols[0].cap, k, ts0, scratch)) return 0;
            const double t_rel = (*row_time_fn)(ts0);
            std::string line;
            line.reserve(col_names.size() * 24u + 48u);
            char tbuf[32];
            const int tn = std::snprintf(tbuf, sizeof(tbuf), "%.6f", t_rel);
            if (tn > 0) line.append(tbuf, static_cast<size_t>(tn));
            std::vector<Entry> row_entries;
            if (out_entries_per_row) row_entries.resize(col_names.size());
            for (size_t ci = 0; ci < cols.size(); ++ci) {
                line.push_back('\t');
                const RingColInfo& c = cols[ci];
                double ts = 0;
                double val = 0;
                if (!read_ring_slot_at(arena, arena_size, c.rel, c.cap, k, ts, val)) return 0;
                if (std::memcmp(&ts, &ts0, sizeof(double)) != 0) return 0;
                append_tsv_cell(line, c.type_byte, val);
                if (out_entries_per_row) row_entries[ci] = Entry{c.type_byte, val};
            }
            line.push_back('\n');
            out_lines->emplace_back(ts0, std::move(line));
            if (out_entries_per_row) out_entries_per_row->push_back(std::move(row_entries));
        }
    }

    for (const RingColInfo& c : cols) {
        uint8_t* row = base + c.row_off;
        std::memcpy(row + kRowReadIdxOff, &w0, 8);
    }
    const auto t_build1 = rclock::now();
    if (perf_detail) perf_detail->record(21, SidecarPerf::micros(t_build0, t_build1));
    if (ring_trace_enabled()) {
        double ts_first = 0.0;
        double ts_last = 0.0;
        if (out_snap && !out_snap->empty()) {
            ts_first = out_snap->front().first;
            ts_last = out_snap->back().first;
        } else if (out_lines && !out_lines->empty()) {
            ts_first = out_lines->front().first;
            ts_last = out_lines->back().first;
        }
        std::fprintf(stderr,
                     "[ring_trace] replay_emit rows=%llu ts_first=%.9f ts_last=%.9f span_ms=%.3f\n",
                     static_cast<unsigned long long>(pending), ts_first, ts_last,
                     (ts_last >= ts_first ? (ts_last - ts_first) * 1000.0 : -1.0));
        std::fflush(stderr);
    }

    if (out_snap) return static_cast<int>(out_snap->size());
    return static_cast<int>(out_lines->size());
}

/**
 * Replay anillo → SnapMap por muestra (monitor de alarmas / compat).
 */
static int v2_ring_replay_extract(uint8_t* base, size_t map_size, uint32_t max_vars,
                                  const std::vector<std::string>& col_names,
                                  std::vector<std::pair<double, SnapMap>>& out_ordered,
                                  SidecarPerf* perf_detail = nullptr) {
    return v2_ring_replay_extract_impl(base, map_size, max_vars, col_names, &out_ordered, nullptr, nullptr, nullptr,
                                       perf_detail, nullptr, false);
}

/** Replay anillo → líneas TSV completas; out_entries_per_row opcional para alarmas (misma orden que col_names). */
static int v2_ring_replay_extract_lines(uint8_t* base, size_t map_size, uint32_t max_vars,
                                        const std::vector<std::string>& col_names,
                                        std::vector<std::pair<double, std::string>>& out_lines,
                                        std::vector<std::vector<Entry>>* out_entries_per_row,
                                        const std::function<double(double)>& row_time_fn, SidecarPerf* perf_detail,
                                        std::unordered_map<std::string, size_t>* shared_name_to_off,
                                        bool shared_map_ready) {
    return v2_ring_replay_extract_impl(base, map_size, max_vars, col_names, nullptr, &out_lines, out_entries_per_row,
                                       &row_time_fn, perf_detail, shared_name_to_off, shared_map_ready);
}

bool append_event_line(const std::string& path, const std::string& line) {
    if (path.empty()) return false;
    std::FILE* f = std::fopen(path.c_str(), "a");
    if (!f) return false;
    std::fwrite(line.data(), 1, line.size(), f);
    std::fputc('\n', f);
    std::fflush(f);
    std::fclose(f);
    return true;
}

std::string triggered_event_json(const std::string& name, const std::string& reason, double value) {
    std::ostringstream o;
    o << std::setprecision(17);
    o << "{\"kind\":\"triggered\",\"triggered\":[{\"name\":\"" << json_escape(name) << "\",\"reason\":\""
      << json_escape(reason) << "\",\"value\":" << value << "}]}";
    return o.str();
}

std::string cleared_event_json(const std::vector<std::string>& names) {
    std::ostringstream o;
    o << "{\"kind\":\"cleared\",\"names\":[";
    for (size_t i = 0; i < names.size(); ++i) {
        if (i > 0) o << ',';
        o << '"' << json_escape(names[i]) << '"';
    }
    o << "]}";
    return o.str();
}

std::string ready_event_json(const std::string& path, const std::string& filename) {
    std::ostringstream o;
    o << "{\"kind\":\"ready\",\"path\":\"" << json_escape(path) << "\",\"filename\":\"" << json_escape(filename)
      << "\"}";
    return o.str();
}

bool write_alarm_tsv_from_merged(const std::string& fullpath, const std::vector<std::string>& col_names,
                                 const std::map<double, SnapMap>& by_t) {
    if (by_t.empty()) return false;
    std::FILE* out = std::fopen(fullpath.c_str(), "w");
    if (!out) return false;
    setvbuf(out, nullptr, _IOFBF, 1024 * 1024);
    std::ostringstream hdr;
    hdr << "time_s";
    for (const auto& n : col_names) hdr << '\t' << n;
    hdr << '\n';
    std::string hdr_line = hdr.str();
    if (std::fwrite(hdr_line.data(), 1, hdr_line.size(), out) != hdr_line.size()) {
        std::fclose(out);
        return false;
    }
    const double t0 = by_t.begin()->first;
    std::string line;
    for (const auto& kv : by_t) {
        const double t_rel = (kv.first > t0) ? (kv.first - t0) : 0.0;
        append_recording_tsv_line(line, t_rel, col_names, kv.second);
        if (std::fwrite(line.data(), 1, line.size(), out) != line.size()) {
            std::fclose(out);
            return false;
        }
    }
    std::fflush(out);
#if defined(_POSIX_SYNCHRONIZED_IO) && _POSIX_SYNCHRONIZED_IO > 0
    int fd = fileno(out);
    if (fd >= 0) fsync(fd);
#endif
    std::fclose(out);
    return true;
}

int run_alarm_monitor_main(const std::string& shm_name, const std::string& sem_name,
                           const std::vector<std::string>& col_names,
                           const std::vector<AlarmRule>& alarm_rules, const std::string& events_path,
                           const std::string& output_dir, uint32_t max_vars,
                           const std::string& shm_health_path) {
    if (col_names.empty() || alarm_rules.empty()) return 1;
    std::string shm_path = "/dev/shm/" + shm_name;
    int fd = open(shm_path.c_str(), O_RDWR);
    if (fd < 0) {
        std::fprintf(stderr, "open %s: %s\n", shm_path.c_str(), std::strerror(errno));
        return 1;
    }
    struct stat st {};
    if (fstat(fd, &st) != 0) {
        std::fprintf(stderr, "fstat: %s\n", std::strerror(errno));
        close(fd);
        return 1;
    }
    size_t map_size = static_cast<size_t>(st.st_size);
    if (map_size < kHeaderV1Size) {
        std::fprintf(stderr, "SHM demasiado pequeño\n");
        close(fd);
        return 1;
    }
    void* p = mmap(nullptr, map_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        std::fprintf(stderr, "mmap: %s\n", std::strerror(errno));
        close(fd);
        return 1;
    }
    close(fd);

    sem_t* sem = sem_open(sem_name.c_str(), O_RDWR);
    if (sem == SEM_FAILED) {
        std::fprintf(stderr, "alarm-monitor sem_open %s: %s (modo polling)\n", sem_name.c_str(),
                     std::strerror(errno));
        sem = nullptr;
    }

    struct sigaction sa {};
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    ShmHealthEmitter health(shm_health_path);
    std::deque<std::pair<double, SnapMap>> ring;
    std::unordered_map<std::string, bool> prev_alarm;
    std::unordered_map<std::string, int64_t> pending_alarm;
    SnapMap snap;
    uint64_t last_seq = 0;
    bool have_seq = false;

    enum class AmPhase { Idle, PostCollect };
    AmPhase phase = AmPhase::Idle;
    std::vector<std::pair<double, SnapMap>> pre_rows;
    std::vector<std::pair<double, SnapMap>> post_rows;
    std::chrono::steady_clock::time_point post_deadline{};

    auto trim_ring = [&](double ts_now) {
        while (!ring.empty() && ring.front().first < ts_now - kAlarmRingSec) {
            ring.pop_front();
        }
        while (ring.size() > kMaxAlarmTsvRows) {
            ring.pop_front();
        }
    };

    auto feed_sample = [&](double ts, const SnapMap& S) {
        trim_ring(ts);
        ring.push_back({ts, S});

        if (phase == AmPhase::PostCollect) {
            post_rows.push_back({ts, S});
            if (std::chrono::steady_clock::now() >= post_deadline) {
                std::map<double, SnapMap> by_t;
                for (const auto& pr : pre_rows) by_t[pr.first] = pr.second;
                for (const auto& pr : post_rows) by_t[pr.first] = pr.second;
                while (by_t.size() > kMaxAlarmTsvRows) {
                    by_t.erase(by_t.begin());
                }
                char fnbuf[128];
                std::time_t tt = std::time(nullptr);
                struct tm tm_l {};
                localtime_r(&tt, &tm_l);
                std::strftime(fnbuf, sizeof(fnbuf), "alarm_%Y%m%d_%H%M%S.tsv", &tm_l);
                std::string fn = fnbuf;
                std::string fullpath = output_dir;
                if (!fullpath.empty() && fullpath.back() != '/') fullpath += '/';
                fullpath += fn;
                if (!by_t.empty() && write_alarm_tsv_from_merged(fullpath, col_names, by_t)) {
                    append_event_line(events_path, ready_event_json(fullpath, fn));
                }
                phase = AmPhase::Idle;
                pre_rows.clear();
                post_rows.clear();
            }
            return;
        }

        auto prev_before = prev_alarm;
        const int64_t now_ms = static_cast<int64_t>(std::llround(ts * 1000.0));
        std::string an;
        std::string ar;
        double av = 0.0;
        bool fired =
            evaluate_alarms_step(alarm_rules, S, now_ms, prev_alarm, pending_alarm, an, ar, av);

        std::vector<std::string> cleared_names;
        for (const auto& rule : alarm_rules) {
            bool was = false;
            auto itb = prev_before.find(rule.name);
            if (itb != prev_before.end()) was = itb->second;
            bool now_c = false;
            auto itn = prev_alarm.find(rule.name);
            if (itn != prev_alarm.end()) now_c = itn->second;
            if (was && !now_c) cleared_names.push_back(rule.name);
        }
        if (!cleared_names.empty()) {
            append_event_line(events_path, cleared_event_json(cleared_names));
        }

        if (fired) {
            append_event_line(events_path, triggered_event_json(an, ar, av));
            pre_rows.clear();
            pre_rows.insert(pre_rows.end(), ring.begin(), ring.end());
            post_rows.clear();
            post_deadline = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(static_cast<int>(kAlarmPostSec * 1000.0));
            phase = AmPhase::PostCollect;
        }
    };

    while (!g_stop.load()) {
        const auto* base = static_cast<const uint8_t*>(p);
        if (sem) {
            bool got = sem_timedwait_secs(sem, 1.0);
            if (g_stop.load()) break;
            if (!got) continue;
            /* Un sem_post = un ciclo de evaluación; no consumir posts acumulados de golpe. */
        } else {
            usleep(5000);
            if (g_stop.load()) break;
            if (map_size < kHeaderV1Size) continue;
            uint32_t magic_poll = 0;
            std::memcpy(&magic_poll, base, 4);
            if (magic_poll != kMagic) continue;
            uint64_t cur_seq_poll = 0;
            std::memcpy(&cur_seq_poll, base + 8, 8);
            if (have_seq && cur_seq_poll == last_seq) continue;
        }
        if (map_size < kHeaderV1Size) continue;
        uint32_t magic = 0;
        std::memcpy(&magic, base, 4);
        if (magic != kMagic) continue;
        uint64_t cur_seq = 0;
        std::memcpy(&cur_seq, base + 8, 8);
        if (have_seq && cur_seq == last_seq) continue;
        const uint64_t prev_seq = last_seq;
        if (have_seq && cur_seq > prev_seq + 1) {
            health.emit_seq_gap(cur_seq - prev_seq - 1, prev_seq, cur_seq);
        }
        if (v2_any_ring_overflow(base, map_size, max_vars)) health.emit_ring_loss();

        uint8_t* mbase = static_cast<uint8_t*>(p);
        std::vector<std::pair<double, SnapMap>> replay_batch;
        if (v2_ring_replay_extract(mbase, map_size, max_vars, col_names, replay_batch, nullptr) > 0) {
            for (const auto& pr : replay_batch) {
                feed_sample(pr.first, pr.second);
            }
            last_seq = cur_seq;
            have_seq = true;
            continue;
        }

        double ts = 0.0;
        if (!parse_snapshot(base, map_size, max_vars, ts, snap, nullptr, nullptr)) continue;
        last_seq = cur_seq;
        have_seq = true;

        feed_sample(ts, snap);
    }

    munmap(p, map_size);
    if (sem) sem_close(sem);
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    std::string shm_name;
    std::string sem_name;
    std::string output_path;
    std::string names_path;
    std::string status_path;
    std::string alarms_path;
    std::string alarm_exit_path;
    std::string alarm_events_path;
    std::string alarm_output_dir;
    std::string shm_health_path;
    std::string sidecar_perf_path;
    bool alarm_monitor = false;
    uint32_t max_vars = 2048;

    for (int i = 1; i < argc; ++i) {
        std::string_view a = argv[i];
        auto need = [&](const char* what) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "Falta valor para %s\n", what);
                return nullptr;
            }
            return argv[++i];
        };
        if (a == "--alarm-monitor") {
            alarm_monitor = true;
        } else if (a == "--alarm-events-file") {
            const char* v = need("--alarm-events-file");
            if (!v) return 2;
            alarm_events_path = v;
        } else if (a == "--alarm-output-dir") {
            const char* v = need("--alarm-output-dir");
            if (!v) return 2;
            alarm_output_dir = v;
        } else if (a == "--shm-name") {
            const char* v = need("--shm-name");
            if (!v) return 2;
            shm_name = v;
        } else if (a == "--sem-name") {
            const char* v = need("--sem-name");
            if (!v) return 2;
            sem_name = v;
        } else if (a == "--output") {
            const char* v = need("--output");
            if (!v) return 2;
            output_path = v;
        } else if (a == "--names-file") {
            const char* v = need("--names-file");
            if (!v) return 2;
            names_path = v;
        } else if (a == "--status-file") {
            const char* v = need("--status-file");
            if (!v) return 2;
            status_path = v;
        } else if (a == "--alarms-file") {
            const char* v = need("--alarms-file");
            if (!v) return 2;
            alarms_path = v;
        } else if (a == "--alarm-exit-file") {
            const char* v = need("--alarm-exit-file");
            if (!v) return 2;
            alarm_exit_path = v;
        } else if (a == "--shm-health-file") {
            const char* v = need("--shm-health-file");
            if (!v) return 2;
            shm_health_path = v;
        } else if (a == "--perf-file") {
            const char* v = need("--perf-file");
            if (!v) return 2;
            sidecar_perf_path = v;
        } else if (a == "--max-vars") {
            const char* v = need("--max-vars");
            if (!v) return 2;
            max_vars = static_cast<uint32_t>(std::strtoul(v, nullptr, 10));
            if (max_vars < 1) max_vars = 2048;
        } else if (a == "-h" || a == "--help") {
            print_usage(argv[0]);
            return 0;
        } else {
            std::fprintf(stderr, "Argumento desconocido: %s\n", argv[i]);
            print_usage(argv[0]);
            return 2;
        }
    }

    if (alarm_monitor) {
        if (shm_name.empty() || sem_name.empty() || names_path.empty() || alarms_path.empty() ||
            alarm_events_path.empty() || alarm_output_dir.empty()) {
            print_usage(argv[0]);
            return 2;
        }
        std::vector<std::string> col_names_am;
        if (!read_names_file(names_path, col_names_am)) {
            std::fprintf(stderr, "No se pudo leer --names-file o está vacío\n");
            return 1;
        }
        std::vector<AlarmRule> alarm_rules_am;
        if (!read_alarms_file(alarms_path, alarm_rules_am)) {
            std::fprintf(stderr, "Alarm monitor: --alarms-file vacío o ilegible\n");
            return 1;
        }
        return run_alarm_monitor_main(shm_name, sem_name, col_names_am, alarm_rules_am, alarm_events_path,
                                      alarm_output_dir, max_vars, shm_health_path);
    }

    if (shm_name.empty() || sem_name.empty() || output_path.empty() || names_path.empty()) {
        print_usage(argv[0]);
        return 2;
    }

    std::vector<std::string> col_names;
    if (!read_names_file(names_path, col_names)) {
        std::fprintf(stderr, "No se pudo leer --names-file o está vacío\n");
        return 1;
    }

    std::vector<AlarmRule> alarm_rules;
    if (!alarms_path.empty()) {
        if (!read_alarms_file(alarms_path, alarm_rules)) {
            std::fprintf(stderr, "Aviso: --alarms-file vacío o ilegible; grabación sin parada por alarma\n");
        }
    }
    if (alarm_exit_path.empty() && !alarm_rules.empty()) alarm_exit_path = output_path + ".alarm_exit";

    std::string shm_path = "/dev/shm/" + shm_name;
    int fd = open(shm_path.c_str(), O_RDWR);
    if (fd < 0) {
        std::fprintf(stderr, "open %s: %s\n", shm_path.c_str(), std::strerror(errno));
        return 1;
    }
    struct stat st {};
    if (fstat(fd, &st) != 0) {
        std::fprintf(stderr, "fstat: %s\n", std::strerror(errno));
        close(fd);
        return 1;
    }
    size_t map_size = static_cast<size_t>(st.st_size);
    if (map_size < kHeaderV1Size) {
        std::fprintf(stderr, "SHM demasiado pequeño\n");
        close(fd);
        return 1;
    }
    void* p = mmap(nullptr, map_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        std::fprintf(stderr, "mmap: %s\n", std::strerror(errno));
        close(fd);
        return 1;
    }
    close(fd);

    sem_t* sem = sem_open(sem_name.c_str(), O_RDWR);
    if (sem == SEM_FAILED) {
        std::fprintf(stderr, "sem_open %s: %s (modo polling)\n", sem_name.c_str(), std::strerror(errno));
        sem = nullptr;
    }

    struct sigaction sa {};
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    FILE* out = std::fopen(output_path.c_str(), "w");
    if (!out) {
        std::fprintf(stderr, "fopen output: %s\n", std::strerror(errno));
        munmap(p, map_size);
        if (sem) sem_close(sem);
        return 1;
    }
    setvbuf(out, nullptr, _IOFBF, 1024 * 1024);

    /* Cabecera TSV: time_s + columnas (solo escalares desde SHM) */
    std::ostringstream hdr;
    hdr << "time_s";
    for (const auto& n : col_names) hdr << '\t' << n;
    hdr << '\n';
    std::string hdr_line = hdr.str();
    if (std::fwrite(hdr_line.data(), 1, hdr_line.size(), out) != hdr_line.size()) {
        std::fprintf(stderr, "escritura cabecera falló\n");
        std::fclose(out);
        munmap(p, map_size);
        if (sem) sem_close(sem);
        return 1;
    }

    std::unordered_map<std::string, Entry> snap;
    RecordingLayoutCache layout_cache;
    std::vector<Entry> column_entries;
    std::vector<char> col_present;
    /** Origen de `time_s`: primer timestamp de muestra (cabecera +24 o ranura anillo), mismo reloj que el C++. */
    double t_epoch = std::numeric_limits<double>::quiet_NaN();
    /** Evita saltos hacia atrás en time_s si el reloj del sistema retrocede (p. ej. NTP) o hay discontinuidad. */
    double last_t_rel_written = -1.0;
    uint64_t rows = 0;
    uint64_t last_status_rows = 0;
    uint64_t last_seq = 0;
    bool have_seq = false;
    std::unordered_map<std::string, bool> prev_alarm;
    std::unordered_map<std::string, int64_t> pending_alarm;
    ShmHealthEmitter health(shm_health_path);
    std::unordered_set<std::string> rec_column_set;
    rec_column_set.reserve(col_names.size() * 2 + 8);
    for (const auto& cn : col_names) {
        if (!cn.empty()) rec_column_set.insert(cn);
    }

    auto write_status = [&]() {
        if (status_path.empty()) return;
        FILE* sf = std::fopen(status_path.c_str(), "w");
        if (!sf) return;
        std::fprintf(sf, "%llu\n", static_cast<unsigned long long>(rows));
        std::fclose(sf);
    };

    std::unique_ptr<SidecarPerf> sc_perf;
    if (!sidecar_perf_path.empty()) {
        sc_perf = std::make_unique<SidecarPerf>(sidecar_perf_path);
        const char* fe = std::getenv("VARMON_SIDECAR_PERF_FLUSH_EVERY");
        if (fe != nullptr && fe[0] != '\0') {
            unsigned long v = std::strtoul(fe, nullptr, 10);
            if (v >= 1ul && v <= 512ul) sc_perf->flush_every_n = static_cast<unsigned>(v);
        }
    }

#if VARMON_SIDECAR_WAKE_TRACE
    using trace_steady = std::chrono::steady_clock;
    trace_steady::time_point trace_prev_wake{};
    trace_steady::time_point trace_prev_done{};
    trace_steady::time_point trace_this_wake{};
    bool trace_have_prev_wake = false;
    bool trace_have_prev_done = false;
#endif

    while (!g_stop.load()) {
        const auto* base = static_cast<const uint8_t*>(p);
        using sc_clock = std::chrono::steady_clock;
        if (sem) {
            auto t_sem_a = sc_clock::now();
            bool got = sem_timedwait_secs(sem, 1.0);
            auto t_sem_b = sc_clock::now();
            if (sc_perf) sc_perf->record(0, SidecarPerf::micros(t_sem_a, t_sem_b));
            if (g_stop.load()) break;
            if (!got) continue;
            /* Un sem_post del C++ = un snapshot: no drenar posts extra (evita N ciclos → 1 fila TSV). */
        } else {
            usleep(5000);
            if (g_stop.load()) break;
            /* Polling: no parsear 2048 entradas si seq no cambió (como shm_reader.peek_shm_seq). */
            if (map_size < kHeaderV1Size) continue;
            uint32_t magic = 0;
            std::memcpy(&magic, base, 4);
            if (magic != kMagic) continue;
            uint64_t cur_seq_poll = 0;
            std::memcpy(&cur_seq_poll, base + 8, 8);
            if (have_seq && cur_seq_poll == last_seq) continue;
        }

        const sc_clock::time_point t_cycle_anchor = sc_clock::now();
#if VARMON_SIDECAR_WAKE_TRACE
        trace_this_wake = t_cycle_anchor;
        {
            const double w = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                                 .count();
            double d_wake_ms = -1.0;
            if (trace_have_prev_wake) {
                d_wake_ms =
                    std::chrono::duration<double, std::milli>(trace_this_wake - trace_prev_wake).count();
            }
            std::fprintf(stderr, "[sidecar_trace] wake  wall_s=%.6f delta_prev_wake_ms=%.3f\n", w, d_wake_ms);
            std::fflush(stderr);
            trace_prev_wake = trace_this_wake;
            trace_have_prev_wake = true;
        }
#endif
        const sc_clock::time_point t_after_post_wake = sc_clock::now();
        if (sc_perf) sc_perf->record(10, SidecarPerf::micros(t_cycle_anchor, t_after_post_wake));

        const sc_clock::time_point t_rs0 = sc_clock::now();
        uint64_t cur_seq = 0;
        if (!read_shm_seq(base, map_size, cur_seq)) continue;
        if (ring_trace_enabled()) {
            std::fprintf(stderr, "[ring_trace] wake_seq cur=%llu last=%llu have_seq=%d\n",
                         static_cast<unsigned long long>(cur_seq), static_cast<unsigned long long>(last_seq),
                         have_seq ? 1 : 0);
            std::fflush(stderr);
        }
        if (have_seq && cur_seq == last_seq) continue;
        const sc_clock::time_point t_rs1 = sc_clock::now();
        const uint64_t prev_seq = last_seq;
        const sc_clock::time_point t_sg0 = sc_clock::now();
        if (have_seq && cur_seq > prev_seq + 1) {
            health.emit_seq_gap(cur_seq - prev_seq - 1, prev_seq, cur_seq);
        }
        const sc_clock::time_point t_sg1 = sc_clock::now();
        const sc_clock::time_point t_ov0 = sc_clock::now();
        if (v2_any_ring_overflow(base, map_size, max_vars)) health.emit_ring_loss();
        const sc_clock::time_point t_ov1 = sc_clock::now();
        if (sc_perf) {
            sc_perf->record(11, SidecarPerf::micros(t_rs0, t_rs1));
            sc_perf->record(12, SidecarPerf::micros(t_sg0, t_sg1));
            sc_perf->record(13, SidecarPerf::micros(t_ov0, t_ov1));
            sc_perf->record(1, SidecarPerf::micros(t_rs0, t_ov1));
        }

        auto row_time_s = [&](double ts_sample) -> double {
            if (!std::isfinite(ts_sample)) return 0.0;
            if (!std::isfinite(t_epoch)) {
                t_epoch = ts_sample;
                last_t_rel_written = 0.0;
                return 0.0;
            }
            double x = ts_sample - t_epoch;
            if (!std::isfinite(x) || x < 0.0) x = 0.0;
            if (last_t_rel_written >= 0.0 && x < last_t_rel_written) {
                x = last_t_rel_written + 1e-6;
            }
            last_t_rel_written = x;
            return x;
        };
        const std::function<double(double)> row_time_fn = [&](double ts_sample) { return row_time_s(ts_sample); };

        if (!recording_shm_header_matches_cache(layout_cache, base, map_size) ||
            !recording_layout_verify_names(base, col_names, layout_cache)) {
            if (!recording_layout_rebuild(base, map_size, max_vars, col_names, layout_cache)) {
                recording_layout_invalidate(layout_cache);
            }
        }

        uint8_t* mbase = static_cast<uint8_t*>(p);
        std::vector<std::pair<double, std::string>> replay_lines;
        std::vector<std::vector<Entry>> replay_entries;
        const sc_clock::time_point t_re0 = sc_clock::now();
        if (sc_perf) sc_perf->record(22, SidecarPerf::micros(t_ov1, t_re0));
        std::unordered_map<std::string, size_t>* ring_name_map =
            layout_cache.valid ? &layout_cache.name_to_row_off : nullptr;
        const int replay_n = v2_ring_replay_extract_lines(
            mbase, map_size, max_vars, col_names, replay_lines,
            alarm_rules.empty() ? nullptr : &replay_entries, row_time_fn, sc_perf.get(), ring_name_map,
            layout_cache.valid);
        if (ring_trace_enabled()) {
            std::fprintf(stderr, "[ring_trace] replay_n=%d cur_seq=%llu\n", replay_n,
                         static_cast<unsigned long long>(cur_seq));
            std::fflush(stderr);
        }
        const sc_clock::time_point t_re1 = sc_clock::now();
        if (sc_perf) sc_perf->record(2, SidecarPerf::micros(t_re0, t_re1));
        if (replay_n > 0) {
            last_seq = cur_seq;
            have_seq = true;
            uint64_t acc_fmt = 0;
            uint64_t acc_fw = 0;
            uint64_t acc_al = 0;
            bool recording_break = false;
            sc_clock::time_point t_last_fwrite_ring = t_cycle_anchor;
            for (int ri = 0; ri < replay_n; ++ri) {
                const double ts = replay_lines[static_cast<size_t>(ri)].first;
                const std::string& line = replay_lines[static_cast<size_t>(ri)].second;

                auto t2a = sc_clock::now();
                if (std::fwrite(line.data(), 1, line.size(), out) != line.size()) {
                    std::fprintf(stderr, "escritura fila falló\n");
                    acc_fw += SidecarPerf::micros(t2a, sc_clock::now());
                    recording_break = true;
                    break;
                }
                auto t2b = sc_clock::now();
                acc_fw += SidecarPerf::micros(t2a, t2b);
                t_last_fwrite_ring = t2b;
                ++rows;
#if VARMON_SIDECAR_WAKE_TRACE
                {
                    const auto now_d = trace_steady::now();
                    const double w = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                                         .count();
                    double d_done_ms = -1.0;
                    if (trace_have_prev_done) {
                        d_done_ms =
                            std::chrono::duration<double, std::milli>(now_d - trace_prev_done).count();
                    }
                    const double since_wake_ms =
                        std::chrono::duration<double, std::milli>(now_d - trace_this_wake).count();
                    std::fprintf(stderr,
                                 "[sidecar_trace] done  wall_s=%.6f delta_prev_done_ms=%.3f since_wake_ms=%.3f "
                                 "rows=%llu ring_replay=1\n",
                                 w, d_done_ms, since_wake_ms, static_cast<unsigned long long>(rows));
                    std::fflush(stderr);
                    trace_prev_done = now_d;
                    trace_have_prev_done = true;
                }
#endif

                auto t3a = sc_clock::now();
                if (!alarm_rules.empty()) {
                    const int64_t now_ms = static_cast<int64_t>(std::llround(ts * 1000.0));
                    std::string an;
                    std::string ar;
                    double av = 0.0;
                    snap.clear();
                    snap.reserve(col_names.size());
                    {
                        const std::vector<Entry>& row_e = replay_entries[static_cast<size_t>(ri)];
                        for (size_t ci = 0; ci < col_names.size() && ci < row_e.size(); ++ci)
                            snap.emplace(col_names[ci], row_e[ci]);
                    }
                    if (evaluate_alarms_step(alarm_rules, snap, now_ms, prev_alarm, pending_alarm, an, ar, av)) {
                        write_alarm_exit_json(alarm_exit_path, an, ar, av);
                        last_status_rows = rows;
                        write_status();
                        recording_break = true;
                    }
                }
                if (!recording_break && !status_path.empty() && (rows - last_status_rows >= 64 || rows == 1)) {
                    last_status_rows = rows;
                    write_status();
                }
                auto t3b = sc_clock::now();
                acc_al += SidecarPerf::micros(t3a, t3b);
                if (recording_break) break;
            }
            if (sc_perf) {
                sc_perf->record(3, acc_fmt);
                sc_perf->record(4, acc_fw);
                sc_perf->record(5, acc_al);
                const uint64_t us10r = SidecarPerf::micros(t_cycle_anchor, t_after_post_wake);
                const uint64_t us11r = SidecarPerf::micros(t_rs0, t_rs1);
                const uint64_t us12r = SidecarPerf::micros(t_sg0, t_sg1);
                const uint64_t us13r = SidecarPerf::micros(t_ov0, t_ov1);
                const uint64_t us22r = SidecarPerf::micros(t_ov1, t_re0);
                const uint64_t us2r = SidecarPerf::micros(t_re0, t_re1);
                const double stf_ring =
                    static_cast<double>(us10r + us11r + us12r + us13r + us22r + us2r + acc_fmt + acc_fw);
                const uint64_t us17_ring = SidecarPerf::micros(t_cycle_anchor, t_last_fwrite_ring);
                sc_perf->record(17, us17_ring);
                const auto tf0_ring = sc_clock::now();
                sc_perf->flush_throttled(stf_ring, static_cast<double>(acc_al), static_cast<double>(us17_ring));
                const auto tf1_ring = sc_clock::now();
                sc_perf->record(16, SidecarPerf::micros(tf0_ring, tf1_ring));
            }
            if (recording_break) break;
            continue;
        }

        double ts = 0.0;
        const sc_clock::time_point t_ps0 = sc_clock::now();
        if (sc_perf) sc_perf->record(23, SidecarPerf::micros(t_re1, t_ps0));

        bool used_column_cache = false;
        if (layout_cache.valid) {
            used_column_cache =
                read_recording_snapshot_columns(base, map_size, layout_cache, col_names, ts, column_entries, col_present,
                                                sc_perf.get());
            if (!used_column_cache) recording_layout_invalidate(layout_cache);
        }
        if (!used_column_cache) {
            if (!parse_snapshot(base, map_size, max_vars, ts, snap, &rec_column_set, sc_perf.get())) {
                if (sc_perf) {
                    const auto tf0p = sc_clock::now();
                    sc_perf->flush(-1.0, -1.0, -1.0);
                    const auto tf1p = sc_clock::now();
                    sc_perf->record(16, SidecarPerf::micros(tf0p, tf1p));
                }
                continue;
            }
        }
        const sc_clock::time_point t_ps1 = sc_clock::now();
        if (sc_perf) sc_perf->record(6, SidecarPerf::micros(t_ps0, t_ps1));
        last_seq = cur_seq;
        have_seq = true;

        const double t_rel = row_time_s(ts);
        const sc_clock::time_point t_sf0 = sc_clock::now();
        std::string line;
        sc_clock::time_point t_sf_mid = t_sf0;
        sc_clock::time_point t_sf1 = t_sf0;
        if (used_column_cache) {
            append_recording_tsv_line_from_cols(line, t_rel, col_names, column_entries, col_present);
            t_sf_mid = sc_clock::now();
            t_sf1 = t_sf_mid;
        } else {
            line.reserve(col_names.size() * 24u + 48u);
            char tbuf[32];
            const int ttn = std::snprintf(tbuf, sizeof(tbuf), "%.6f", t_rel);
            if (ttn > 0) line.append(tbuf, static_cast<size_t>(ttn));
            t_sf_mid = sc_clock::now();
            for (const auto& name : col_names) {
                line.push_back('\t');
                const auto it = snap.find(name);
                if (it != snap.end()) append_tsv_cell(line, it->second.type_byte, it->second.value);
            }
            line.push_back('\n');
            t_sf1 = sc_clock::now();
        }
        if (sc_perf) {
            sc_perf->record(14, SidecarPerf::micros(t_sf0, t_sf_mid));
            sc_perf->record(15, SidecarPerf::micros(t_sf_mid, t_sf1));
            sc_perf->record(7, SidecarPerf::micros(t_sf0, t_sf1));
        }
        const sc_clock::time_point t_w0 = sc_clock::now();
        if (std::fwrite(line.data(), 1, line.size(), out) != line.size()) {
            std::fprintf(stderr, "escritura fila falló\n");
            if (sc_perf) {
                sc_perf->record(8, SidecarPerf::micros(t_w0, sc_clock::now()));
                const auto tf0e = sc_clock::now();
                sc_perf->flush(-1.0, -1.0, -1.0);
                const auto tf1e = sc_clock::now();
                sc_perf->record(16, SidecarPerf::micros(tf0e, tf1e));
            }
            break;
        }
        const sc_clock::time_point t_w1 = sc_clock::now();
        if (sc_perf) sc_perf->record(8, SidecarPerf::micros(t_w0, t_w1));
        if (sc_perf) sc_perf->record(17, SidecarPerf::micros(t_cycle_anchor, t_w1));
        ++rows;
#if VARMON_SIDECAR_WAKE_TRACE
        {
            const auto now_d = trace_steady::now();
            const double w = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
                                 .count();
            double d_done_ms = -1.0;
            if (trace_have_prev_done) {
                d_done_ms = std::chrono::duration<double, std::milli>(now_d - trace_prev_done).count();
            }
            const double since_wake_ms =
                std::chrono::duration<double, std::milli>(now_d - trace_this_wake).count();
            std::fprintf(stderr,
                         "[sidecar_trace] done  wall_s=%.6f delta_prev_done_ms=%.3f since_wake_ms=%.3f rows=%llu "
                         "ring_replay=0\n",
                         w, d_done_ms, since_wake_ms, static_cast<unsigned long long>(rows));
            std::fflush(stderr);
            trace_prev_done = now_d;
            trace_have_prev_done = true;
        }
#endif
        auto t_a0 = sc_clock::now();
        if (!alarm_rules.empty()) {
            const int64_t now_ms = static_cast<int64_t>(std::llround(ts * 1000.0));
            std::string an;
            std::string ar;
            double av = 0.0;
            if (used_column_cache) {
                snap.clear();
                snap_map_from_column_entries(snap, col_names, column_entries, col_present);
            }
            if (evaluate_alarms_step(alarm_rules, snap, now_ms, prev_alarm, pending_alarm, an, ar, av)) {
                write_alarm_exit_json(alarm_exit_path, an, ar, av);
                last_status_rows = rows;
                write_status();
                if (sc_perf) {
                    sc_perf->record(9, SidecarPerf::micros(t_a0, sc_clock::now()));
                    const auto tf0a = sc_clock::now();
                    sc_perf->flush(-1.0, -1.0, -1.0);
                    const auto tf1a = sc_clock::now();
                    sc_perf->record(16, SidecarPerf::micros(tf0a, tf1a));
                }
                break;
            }
        }
        if (status_path.empty()) {
            /* ok */
        } else if (rows - last_status_rows >= 64 || rows == 1) {
            last_status_rows = rows;
            write_status();
        }
        if (sc_perf) {
            const sc_clock::time_point t_before_flush_snap = sc_clock::now();
            const uint64_t us9snap = SidecarPerf::micros(t_a0, t_before_flush_snap);
            sc_perf->record(9, us9snap);
            const uint64_t us10s = SidecarPerf::micros(t_cycle_anchor, t_after_post_wake);
            const uint64_t us11s = SidecarPerf::micros(t_rs0, t_rs1);
            const uint64_t us12s = SidecarPerf::micros(t_sg0, t_sg1);
            const uint64_t us13s = SidecarPerf::micros(t_ov0, t_ov1);
            const uint64_t us22s = SidecarPerf::micros(t_ov1, t_re0);
            const uint64_t us2s = SidecarPerf::micros(t_re0, t_re1);
            const uint64_t us23s = SidecarPerf::micros(t_re1, t_ps0);
            const uint64_t us6s = SidecarPerf::micros(t_ps0, t_ps1);
            const uint64_t us14s = SidecarPerf::micros(t_sf0, t_sf_mid);
            const uint64_t us15s = SidecarPerf::micros(t_sf_mid, t_sf1);
            const uint64_t us8s = SidecarPerf::micros(t_w0, t_w1);
            const uint64_t us17snap = SidecarPerf::micros(t_cycle_anchor, t_w1);
            const double sum_tf =
                static_cast<double>(us10s + us11s + us12s + us13s + us22s + us2s + us23s + us6s + us14s + us15s +
                                    us8s);
            const auto tf0snap = sc_clock::now();
            sc_perf->flush_throttled(sum_tf, static_cast<double>(us9snap), static_cast<double>(us17snap));
            const auto tf1snap = sc_clock::now();
            sc_perf->record(16, SidecarPerf::micros(tf0snap, tf1snap));
        }
    }

    std::fflush(out);
    std::fclose(out);
    write_status();
    munmap(p, map_size);
    if (sem) sem_close(sem);
    return 0;
}
