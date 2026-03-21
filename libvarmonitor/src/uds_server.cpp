#include "var_monitor.hpp"
#include "shm_publisher.hpp"

#include <sys/socket.h>
#include <sys/un.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <pwd.h>
#include <cstring>
#include <thread>
#include <sstream>
#include <iostream>
#include <fstream>
#include <vector>
#include <chrono>
#include <iomanip>
#include <limits.h>
#include <map>
#include <cstdlib>
#include <type_traits>
#include <variant>

namespace varmon {

#ifdef __linux__
static std::string get_executable_directory() {
    char buf[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n <= 0) return "";
    buf[n] = '\0';
    std::string path(buf);
    size_t last = path.rfind('/');
    if (last == std::string::npos) return "";
    return path.substr(0, last);
}

/** Read VmRSS from /proc/self/status (KB). Returns -1 if unavailable. */
static long get_self_rss_kb() {
    std::ifstream f("/proc/self/status");
    if (!f) return -1;
    std::string line;
    while (std::getline(f, line)) {
        if (line.compare(0, 6, "VmRSS:") != 0) continue;
        size_t i = 6;
        while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) ++i;
        if (i >= line.size()) return -1;
        try {
            return std::stol(line.substr(i));
        } catch (...) {
            return -1;
        }
    }
    return -1;
}

/** Read utime+stime (CPU jiffies) from /proc/self/stat. Returns -1 if unavailable. */
static long long get_self_cpu_jiffies() {
    std::ifstream f("/proc/self/stat");
    if (!f) return -1;
    std::string line;
    if (!std::getline(f, line)) return -1;
    size_t rparen = line.rfind(')');
    if (rparen == std::string::npos || rparen + 2 >= line.size()) return -1;
    std::istringstream iss(line.substr(rparen + 2));
    std::vector<std::string> tokens;
    for (std::string t; iss >> t; ) tokens.push_back(t);
    if (tokens.size() < 13) return -1;
    try {
        unsigned long utime = std::stoul(tokens[11]);
        unsigned long stime = std::stoul(tokens[12]);
        return static_cast<long long>(utime) + static_cast<long long>(stime);
    } catch (...) {
        return -1;
    }
}
#endif

static std::string g_config_path;
static std::chrono::steady_clock::time_point g_server_start_time;
static std::string g_uds_path;

static std::string get_username() {
    const char* u = std::getenv("USER");
    if (u && u[0]) return u;
    struct passwd* pw = getpwuid(geteuid());
    if (pw && pw->pw_name) return std::string(pw->pw_name);
    return "unknown";
}

void set_config_path(const std::string& path) { g_config_path = path; }

static std::map<std::string, std::string> g_config;

unsigned get_config_uint(const std::string& key, unsigned default_val) {
    auto it = g_config.find(key);
    if (it == g_config.end() || it->second.empty()) return default_val;
    try {
        unsigned long v = std::stoul(it->second);
        return static_cast<unsigned>(v);
    } catch (...) {
        return default_val;
    }
}

static std::string trim(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end - start + 1);
}

bool load_config() {
    std::string path;

    const char* env = std::getenv("VARMON_CONFIG");
    if (env && env[0]) {
        path = env;
    } else if (!g_config_path.empty()) {
        path = g_config_path;
    } else {
        path = "varmon.conf";
    }

    std::ifstream file(path);
#ifdef __linux__
    if (!file.is_open() && path == "varmon.conf") {
        std::string exe_dir = get_executable_directory();
        if (!exe_dir.empty()) {
            for (const std::string& candidate : { exe_dir + "/../../varmon.conf", exe_dir + "/../varmon.conf" }) {
                file.open(candidate);
                if (file.is_open()) { path = candidate; break; }
            }
        }
    }
#endif
    if (!file.is_open()) {
        std::cerr << "[VarMonitor] AVISO: No se encontro el archivo de configuracion.\n"
                  << "  Buscado en: " << path << "\n"
                  << "  Para cambiar la ruta: VARMON_CONFIG=/ruta/a/varmon.conf o set_config_path()\n";
        return false;
    }

    g_config.clear();
    std::string line;
    while (std::getline(file, line)) {
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string key = trim(line.substr(0, eq));
        std::string val = trim(line.substr(eq + 1));
        if (!key.empty()) g_config[key] = val;
    }

    std::cout << "[VarMonitor] Config cargada desde " << path << "\n";
    return true;
}

static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;      break;
        }
    }
    return out;
}

static std::string json_get_string(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos + 1);
    if (pos == std::string::npos) return "";
    auto end = pos + 1;
    while (end < json.size()) {
        if (json[end] == '"' && json[end - 1] != '\\') break;
        end++;
    }
    if (end >= json.size()) return "";
    return json.substr(pos + 1, end - pos - 1);
}

static double json_get_number(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return 0.0;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return 0.0;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    return std::strtod(json.c_str() + pos, nullptr);
}

static bool send_all(int fd, const char* data, size_t len) {
    while (len > 0) {
        ssize_t n = ::send(fd, data, len, MSG_NOSIGNAL);
        if (n <= 0) return false;
        data += n;
        len -= static_cast<size_t>(n);
    }
    return true;
}

static bool send_message(int fd, const std::string& json) {
    uint32_t net_len = htonl(static_cast<uint32_t>(json.size()));
    if (!send_all(fd, reinterpret_cast<const char*>(&net_len), 4)) return false;
    return send_all(fd, json.data(), json.size());
}

static bool recv_all(int fd, char* buf, size_t len) {
    while (len > 0) {
        ssize_t n = ::recv(fd, buf, len, 0);
        if (n <= 0) return false;
        buf += n;
        len -= static_cast<size_t>(n);
    }
    return true;
}

static bool recv_message(int fd, std::string& out) {
    uint32_t net_len;
    if (!recv_all(fd, reinterpret_cast<char*>(&net_len), 4)) return false;
    uint32_t len = ntohl(net_len);
    if (len > 10u * 1024u * 1024u) return false;
    out.resize(len);
    return recv_all(fd, out.data(), len);
}

/** Etiqueta JSON según el tipo activo del variant (no usar VarSnapshot::type: puede no coincidir y std::get lanzaba bad_variant_access). */
static const char* type_str_from_variant(const VarValue& val) {
    switch (val.index()) {
        case 0: return "double";
        case 1: return "int32";
        case 2: return "bool";
        case 3: return "string";
        case 4: return "array";
        default: return "unknown";
    }
}

static void write_var_json(std::ostringstream& ss, const VarMonitor::VarSnapshot& v) {
    ss << "{\"name\":\"" << json_escape(v.name) << "\""
       << ",\"type\":\"" << type_str_from_variant(v.value) << "\"";

    std::visit([&ss](const auto& arg) {
        using T = std::decay_t<decltype(arg)>;
        if constexpr (std::is_same_v<T, double>) {
            ss << ",\"value\":" << arg;
        } else if constexpr (std::is_same_v<T, int32_t>) {
            ss << ",\"value\":" << arg;
        } else if constexpr (std::is_same_v<T, bool>) {
            ss << ",\"value\":" << (arg ? "true" : "false");
        } else if constexpr (std::is_same_v<T, std::string>) {
            ss << ",\"value\":\"" << json_escape(arg) << "\"";
        } else if constexpr (std::is_same_v<T, std::vector<double>>) {
            ss << ",\"value\":[";
            for (size_t i = 0; i < arg.size(); i++) {
                if (i > 0) ss << ",";
                ss << arg[i];
            }
            ss << "],\"size\":" << arg.size();
        }
    }, v.value);

    double ts = std::chrono::duration<double>(v.time.time_since_epoch()).count();
    ss << ",\"timestamp\":" << std::fixed << std::setprecision(6) << ts << "}";
}

static void handle_client(int client_fd, std::atomic<bool>& running) {
    auto* mon = get_global_instance();
    if (!mon) { ::close(client_fd); return; }

    mon->client_connected();

    while (running.load()) {
        std::string request;
        if (!recv_message(client_fd, request)) break;

        std::string cmd = json_get_string(request, "cmd");
        std::string response;

        if (cmd == "server_info") {
            auto now = std::chrono::steady_clock::now();
            double sec = std::chrono::duration<double>(now - g_server_start_time).count();
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(3);
            ss << "{\"type\":\"server_info\",\"uptime_seconds\":" << sec;
            ss << ",\"sample_interval_ms\":" << mon->sample_interval_ms();
            if (varmon::shm_publisher::is_active()) {
                ss << ",\"shm_name\":\"" << json_escape(varmon::shm_publisher::get_shm_name()) << "\"";
                ss << ",\"sem_name\":\"" << json_escape(varmon::shm_publisher::get_sem_name()) << "\"";
            }
            if (!g_uds_path.empty()) {
                ss << ",\"uds_path\":\"" << json_escape(g_uds_path) << "\"";
            }
#ifdef __linux__
            long rss_kb = get_self_rss_kb();
            if (rss_kb >= 0) ss << ",\"memory_rss_kb\":" << rss_kb;
            long long cpu_jiffies = get_self_cpu_jiffies();
            if (cpu_jiffies >= 0) {
                static long long s_last_cpu_jiffies = -1;
                static std::chrono::steady_clock::time_point s_last_wall;
                long jiffies_per_sec = sysconf(_SC_CLK_TCK);
                if (jiffies_per_sec <= 0) jiffies_per_sec = 100;
                if (s_last_cpu_jiffies >= 0) {
                    double wall_sec = std::chrono::duration<double>(now - s_last_wall).count();
                    if (wall_sec >= 0.1) {
                        double cpu_sec = (cpu_jiffies - s_last_cpu_jiffies) / static_cast<double>(jiffies_per_sec);
                        double pct = (cpu_sec / wall_sec) * 100.0;
                        if (pct < 0.0) pct = 0.0;
                        if (pct > 100.0) pct = 100.0;
                        ss << ",\"cpu_percent\":" << std::fixed << std::setprecision(2) << pct;
                    }
                }
                s_last_cpu_jiffies = cpu_jiffies;
                s_last_wall = now;
            }
#endif
            ss << "}";
            response = ss.str();
        }
        else if (cmd == "list_names") {
            auto names = mon->list_var_names();
            std::ostringstream ss;
            ss << "{\"type\":\"names\",\"data\":[";
            for (size_t i = 0; i < names.size(); i++) {
                if (i > 0) ss << ",";
                ss << "\"" << json_escape(names[i]) << "\"";
            }
            ss << "]}";
            response = ss.str();
        }
        else if (cmd == "list_vars") {
            auto vars = mon->list_vars();
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(6);
            ss << "{\"type\":\"vars\",\"data\":[";
            for (size_t i = 0; i < vars.size(); i++) {
                if (i > 0) ss << ",";
                write_var_json(ss, vars[i]);
            }
            ss << "]}";
            response = ss.str();
        }
        else if (cmd == "get_var") {
            std::string name = json_get_string(request, "name");
            auto snap = mon->get_var(name);
            if (!snap) {
                response = "{\"type\":\"var\",\"data\":null}";
            } else {
                std::ostringstream ss;
                ss << std::fixed << std::setprecision(6);
                ss << "{\"type\":\"var\",\"data\":";
                write_var_json(ss, *snap);
                ss << "}";
                response = ss.str();
            }
        }
        else if (cmd == "set_var") {
            std::string name = json_get_string(request, "name");
            std::string vtype = json_get_string(request, "type");
            bool ok = false;
            if (vtype == "double") {
                ok = mon->set_var(name, VarValue(json_get_number(request, "value")));
            } else if (vtype == "int32") {
                ok = mon->set_var(name, VarValue(static_cast<int32_t>(json_get_number(request, "value"))));
            } else if (vtype == "bool") {
                ok = mon->set_var(name, VarValue(json_get_number(request, "value") != 0.0));
            }
            response = ok ? "{\"type\":\"set_result\",\"ok\":true}"
                          : "{\"type\":\"set_result\",\"ok\":false}";
        }
        else if (cmd == "set_array_element") {
            std::string name = json_get_string(request, "name");
            size_t index = static_cast<size_t>(json_get_number(request, "index"));
            double value = json_get_number(request, "value");
            bool ok = mon->set_array_element(name, index, value);
            response = ok ? "{\"type\":\"set_result\",\"ok\":true}"
                          : "{\"type\":\"set_result\",\"ok\":false}";
        }
        else if (cmd == "unregister_var") {
            std::string name = json_get_string(request, "name");
            bool ok = mon->unregister_var(name);
            response = ok ? "{\"type\":\"unregister_result\",\"ok\":true}"
                          : "{\"type\":\"unregister_result\",\"ok\":false}";
        }
        else if (cmd == "set_shm_subscription") {
            std::vector<std::string> names;
            std::string needle = "\"names\":[";
            auto pos = request.find(needle);
            if (pos != std::string::npos) {
                pos += needle.size();
                while (pos < request.size()) {
                    auto q = request.find('"', pos);
                    if (q == std::string::npos) break;
                    auto end = q + 1;
                    while (end < request.size()) {
                        if (request[end] == '"' && (end == 0 || request[end - 1] != '\\')) break;
                        end++;
                    }
                    if (end >= request.size()) break;
                    names.push_back(request.substr(q + 1, end - q - 1));
                    pos = end + 1;
                    if (pos < request.size() && request[pos] == ',') pos++;
                    if (pos < request.size() && request[pos] == ']') break;
                }
            }
            varmon::shm_publisher::set_subscription(names);
            response = "{\"type\":\"shm_subscription_result\",\"ok\":true}";
        }
        else {
            response = "{\"type\":\"error\",\"message\":\"unknown command\"}";
        }

        if (!send_message(client_fd, response)) break;
    }

    mon->client_disconnected();
    ::close(client_fd);
}

void VarMonitor::uds_server_loop() {
#ifdef __linux__
    int uds_fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (uds_fd < 0) {
        std::cerr << "[VarMonitor] Error creando socket UDS\n";
        return;
    }
    std::string user = get_username();
    std::ostringstream oss;
    oss << "/tmp/varmon-" << user << "-" << getpid() << ".sock";
    g_uds_path = oss.str();
    ::unlink(g_uds_path.c_str());
    struct sockaddr_un sun{};
    sun.sun_family = AF_UNIX;
    if (g_uds_path.size() >= sizeof(sun.sun_path)) {
        std::cerr << "[VarMonitor] Path UDS demasiado largo\n";
        ::close(uds_fd);
        return;
    }
    std::memcpy(sun.sun_path, g_uds_path.c_str(), g_uds_path.size() + 1);
    if (::bind(uds_fd, reinterpret_cast<struct sockaddr*>(&sun), sizeof(sun)) != 0 ||
        ::listen(uds_fd, 8) != 0) {
        std::cerr << "[VarMonitor] Error bind/listen UDS en " << g_uds_path << "\n";
        ::close(uds_fd);
        return;
    }
    std::cout << "[VarMonitor] UDS escuchando en " << g_uds_path << "\n";
    g_server_start_time = std::chrono::steady_clock::now();

    while (running_.load()) {
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(uds_fd, &rfds);
        struct timeval tv{1, 0};
        int ret = ::select(uds_fd + 1, &rfds, nullptr, nullptr, &tv);
        if (ret <= 0) continue;
        if (FD_ISSET(uds_fd, &rfds)) {
            int client_fd = ::accept(uds_fd, nullptr, nullptr);
            if (client_fd >= 0) {
                std::thread(handle_client, client_fd, std::ref(running_)).detach();
            }
        }
    }

    ::close(uds_fd);
    if (!g_uds_path.empty()) ::unlink(g_uds_path.c_str());
#else
    (void)0;
    std::cerr << "[VarMonitor] UDS solo soportado en Linux\n";
#endif
}

} // namespace varmon
