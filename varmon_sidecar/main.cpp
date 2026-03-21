/**
 * Consumidor SHM (mismo layout que web_monitor/shm_reader.py y libvarmonitor shm_publisher).
 * Grabación TSV alineada con _write_record_header_stream / _write_record_row_stream.
 * Sin dependencia de libvarmonitor.
 */
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
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
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <semaphore.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

constexpr uint32_t kMagic = 0x4D524156u;
constexpr size_t kNameMaxLen = 128u;
constexpr size_t kEntrySize = kNameMaxLen + 1 + 8;
constexpr size_t kHeaderSize = 32u;

std::atomic<bool> g_stop{false};

void on_signal(int) { g_stop.store(true); }

void print_usage(const char* argv0) {
    std::fprintf(stderr,
        "Grabación:\n  %s --shm-name NAME --sem-name /NAME --output PATH --names-file PATH "
        "[--max-vars N] [--status-file PATH] [--alarms-file PATH] [--alarm-exit-file PATH]\n"
        "Monitor de alarmas (TSV burst, SHM solo polling; no usa el semáforo):\n"
        "  %s --alarm-monitor --shm-name NAME --sem-name /NAME --names-file PATH --alarms-file PATH "
        "--alarm-events-file PATH --alarm-output-dir DIR [--max-vars N]\n",
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

bool parse_snapshot(const uint8_t* base, size_t map_size, uint32_t max_vars, double& timestamp_out,
                    std::unordered_map<std::string, Entry>& out_map) {
    out_map.clear();
    if (map_size < kHeaderSize) return false;
    uint32_t magic = 0;
    std::memcpy(&magic, base, 4);
    if (magic != kMagic) return false;
    uint64_t seq = 0;
    uint32_t count = 0;
    std::memcpy(&seq, base + 8, 8);
    std::memcpy(&count, base + 16, 4);
    (void)seq;
    std::memcpy(&timestamp_out, base + 24, 8);
    if (count > max_vars) count = max_vars;
    const uint8_t* ent = base + kHeaderSize;
    for (uint32_t i = 0; i < count; ++i) {
        if (static_cast<size_t>(ent - base) + kEntrySize > map_size) break;
        char namebuf[kNameMaxLen + 1];
        std::memcpy(namebuf, ent, kNameMaxLen);
        namebuf[kNameMaxLen] = '\0';
        std::string name(namebuf);
        const size_t z = name.find('\0');
        if (z != std::string::npos) name.resize(z);
        while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.pop_back();
        uint8_t type_byte = ent[kNameMaxLen];
        double val = 0.0;
        std::memcpy(&val, ent + kNameMaxLen + 1, 8);
        ent += kEntrySize;
        if (name.empty()) continue;
        out_map[name] = Entry{type_byte, val};
    }
    return true;
}

std::string value_to_tsv_cell(uint8_t type_byte, double raw) {
    if (type_byte == 2) { /* Bool */
        return (raw != 0.0) ? "True" : "False";
    }
    if (type_byte == 1) { /* Int32 */
        return std::to_string(static_cast<int32_t>(raw));
    }
    /* Double y otros: cercano a str() de Python para floats */
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", raw);
    std::string s(buf);
    if (s == "-0") s = "0";
    return s;
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

void sem_trywait_all(sem_t* sem) {
    while (sem_trywait(sem) == 0) {
    }
}

constexpr double kAlarmRingSec = 2.2;
constexpr double kAlarmPostSec = 1.0;
constexpr std::size_t kMaxAlarmTsvRows = 8000;

using SnapMap = std::unordered_map<std::string, Entry>;

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
    for (const auto& kv : by_t) {
        double t_rel = (kv.first > t0) ? (kv.first - t0) : 0.0;
        std::ostringstream row;
        row.setf(std::ios::fixed);
        row << std::setprecision(6) << t_rel;
        for (const auto& name : col_names) {
            row << '\t';
            auto it = kv.second.find(name);
            if (it != kv.second.end()) {
                row << value_to_tsv_cell(it->second.type_byte, it->second.value);
            }
        }
        row << '\n';
        std::string line = row.str();
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

int run_alarm_monitor_main(const std::string& shm_name, const std::vector<std::string>& col_names,
                           const std::vector<AlarmRule>& alarm_rules, const std::string& events_path,
                           const std::string& output_dir, uint32_t max_vars) {
    if (col_names.empty() || alarm_rules.empty()) return 1;
    std::string shm_path = "/dev/shm/" + shm_name;
    int fd = open(shm_path.c_str(), O_RDONLY);
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
    if (map_size < kHeaderSize) {
        std::fprintf(stderr, "SHM demasiado pequeño\n");
        close(fd);
        return 1;
    }
    void* p = mmap(nullptr, map_size, PROT_READ, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) {
        std::fprintf(stderr, "mmap: %s\n", std::strerror(errno));
        close(fd);
        return 1;
    }
    close(fd);

    struct sigaction sa {};
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

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

    while (!g_stop.load()) {
        usleep(2000);
        if (g_stop.load()) break;
        if (map_size < kHeaderSize) continue;
        const auto* base = static_cast<const uint8_t*>(p);
        uint32_t magic = 0;
        std::memcpy(&magic, base, 4);
        if (magic != kMagic) continue;
        uint64_t cur_seq = 0;
        std::memcpy(&cur_seq, base + 8, 8);
        if (have_seq && cur_seq == last_seq) continue;
        last_seq = cur_seq;
        have_seq = true;

        double ts = 0.0;
        if (!parse_snapshot(base, map_size, max_vars, ts, snap)) continue;

        trim_ring(ts);
        ring.push_back({ts, snap});

        if (phase == AmPhase::PostCollect) {
            post_rows.push_back({ts, snap});
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
            continue;
        }

        auto prev_before = prev_alarm;
        const int64_t now_ms = static_cast<int64_t>(std::llround(ts * 1000.0));
        std::string an;
        std::string ar;
        double av = 0.0;
        bool fired =
            evaluate_alarms_step(alarm_rules, snap, now_ms, prev_alarm, pending_alarm, an, ar, av);

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
    }

    munmap(p, map_size);
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
        return run_alarm_monitor_main(shm_name, col_names_am, alarm_rules_am, alarm_events_path, alarm_output_dir,
                                      max_vars);
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
    int fd = open(shm_path.c_str(), O_RDONLY);
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
    if (map_size < kHeaderSize) {
        std::fprintf(stderr, "SHM demasiado pequeño\n");
        close(fd);
        return 1;
    }
    void* p = mmap(nullptr, map_size, PROT_READ, MAP_SHARED, fd, 0);
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
    double t0 = -1.0;
    uint64_t rows = 0;
    uint64_t last_status_rows = 0;
    uint64_t last_seq = 0;
    bool have_seq = false;
    std::unordered_map<std::string, bool> prev_alarm;
    std::unordered_map<std::string, int64_t> pending_alarm;

    auto write_status = [&]() {
        if (status_path.empty()) return;
        FILE* sf = std::fopen(status_path.c_str(), "w");
        if (!sf) return;
        std::fprintf(sf, "%llu\n", static_cast<unsigned long long>(rows));
        std::fclose(sf);
    };

    while (!g_stop.load()) {
        uint64_t cur_seq = 0;
        if (sem) {
            bool got = sem_timedwait_secs(sem, 1.0);
            if (g_stop.load()) break;
            if (!got) continue;
            sem_trywait_all(sem);
        } else {
            usleep(5000);
            if (g_stop.load()) break;
            /* Polling: no parsear 2048 entradas si seq no cambió (como shm_reader.peek_shm_seq). */
            if (map_size < kHeaderSize) continue;
            const auto* base = static_cast<const uint8_t*>(p);
            uint32_t magic = 0;
            std::memcpy(&magic, base, 4);
            if (magic != kMagic) continue;
            std::memcpy(&cur_seq, base + 8, 8);
            if (have_seq && cur_seq == last_seq) continue;
        }

        double ts = 0.0;
        if (!parse_snapshot(static_cast<const uint8_t*>(p), map_size, max_vars, ts, snap)) continue;
        if (!sem) {
            last_seq = cur_seq;
            have_seq = true;
        }

        if (t0 < 0.0) t0 = ts;
        double t_rel = (rows == 0) ? 0.0 : (ts > t0 ? ts - t0 : 0.0);

        std::ostringstream row;
        row.setf(std::ios::fixed);
        row << std::setprecision(6) << t_rel;
        for (const auto& name : col_names) {
            row << '\t';
            auto it = snap.find(name);
            if (it == snap.end()) {
                continue;
            }
            row << value_to_tsv_cell(it->second.type_byte, it->second.value);
        }
        row << '\n';
        std::string line = row.str();
        if (std::fwrite(line.data(), 1, line.size(), out) != line.size()) {
            std::fprintf(stderr, "escritura fila falló\n");
            break;
        }
        ++rows;
        if (!alarm_rules.empty()) {
            const int64_t now_ms = static_cast<int64_t>(std::llround(ts * 1000.0));
            std::string an;
            std::string ar;
            double av = 0.0;
            if (evaluate_alarms_step(alarm_rules, snap, now_ms, prev_alarm, pending_alarm, an, ar, av)) {
                write_alarm_exit_json(alarm_exit_path, an, ar, av);
                last_status_rows = rows;
                write_status();
                break;
            }
        }
        if (status_path.empty()) {
            /* ok */
        } else if (rows - last_status_rows >= 64 || rows == 1) {
            last_status_rows = rows;
            write_status();
        }
    }

    std::fflush(out);
    std::fclose(out);
    write_status();
    munmap(p, map_size);
    if (sem) sem_close(sem);
    return 0;
}
