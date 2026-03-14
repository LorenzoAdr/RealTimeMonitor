#include "var_monitor.hpp"

#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <thread>
#include <sstream>
#include <iostream>
#include <fstream>
#include <vector>
#include <chrono>
#include <iomanip>
#include <limits.h>

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

static uint16_t g_tcp_port = 9100;
static size_t g_history_capacity = 100;
static std::string g_config_path;
static std::chrono::steady_clock::time_point g_server_start_time;

void set_tcp_port(uint16_t port) { g_tcp_port = port; }
uint16_t get_tcp_port() { return g_tcp_port; }
size_t get_history_capacity() { return g_history_capacity; }

void set_config_path(const std::string& path) { g_config_path = path; }

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
                  << "  Usando valores por defecto (tcp_port=" << g_tcp_port << ")\n"
                  << "  Para cambiar la ruta:\n"
                  << "    - Variable de entorno: VARMON_CONFIG=/ruta/a/varmon.conf\n"
                  << "    - En codigo: varmon::set_config_path(\"/ruta/a/varmon.conf\")\n";
        return false;
    }

    std::string line;
    while (std::getline(file, line)) {
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;

        auto eq = line.find('=');
        if (eq == std::string::npos) continue;

        std::string key = trim(line.substr(0, eq));
        std::string val = trim(line.substr(eq + 1));

        if (key == "tcp_port") {
            int port = std::stoi(val);
            if (port > 0 && port <= 65535) g_tcp_port = static_cast<uint16_t>(port);
        } else if (key == "history_capacity") {
            int cap = std::stoi(val);
            if (cap > 0) g_history_capacity = static_cast<size_t>(cap);
        }
    }

    std::cout << "[VarMonitor] Config cargada desde " << path
              << " (tcp_port_base=" << g_tcp_port
              << ", history_capacity=" << g_history_capacity << ")\n";
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

static const char* type_str(VarType t) {
    switch (t) {
        case VarType::Double: return "double";
        case VarType::Int32:  return "int32";
        case VarType::Bool:   return "bool";
        case VarType::String: return "string";
        case VarType::Array:  return "array";
    }
    return "unknown";
}

static void write_var_json(std::ostringstream& ss, const VarMonitor::VarSnapshot& v) {
    ss << "{\"name\":\"" << json_escape(v.name) << "\""
       << ",\"type\":\"" << type_str(v.type) << "\"";

    switch (v.type) {
        case VarType::Double:
            ss << ",\"value\":" << std::get<double>(v.value);
            break;
        case VarType::Int32:
            ss << ",\"value\":" << std::get<int32_t>(v.value);
            break;
        case VarType::Bool:
            ss << ",\"value\":" << (std::get<bool>(v.value) ? "true" : "false");
            break;
        case VarType::String:
            ss << ",\"value\":\"" << json_escape(std::get<std::string>(v.value)) << "\"";
            break;
        case VarType::Array: {
            auto& arr = std::get<std::vector<double>>(v.value);
            ss << ",\"value\":[";
            for (size_t i = 0; i < arr.size(); i++) {
                if (i > 0) ss << ",";
                ss << arr[i];
            }
            ss << "],\"size\":" << arr.size();
            break;
        }
    }

    double ts = std::chrono::duration<double>(v.time.time_since_epoch()).count();
    ss << ",\"timestamp\":" << std::fixed << std::setprecision(6) << ts << "}";
}

static void handle_client(int client_fd, std::atomic<bool>& running) {
    auto* mon = get_global_instance();
    if (!mon) { ::close(client_fd); return; }

    mon->client_connected();

    int flag = 1;
    setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

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
        else if (cmd == "get_history") {
            std::string name = json_get_string(request, "name");
            auto hist = mon->get_history(name);
            if (!hist) {
                response = "{\"type\":\"history\",\"data\":null}";
            } else {
                std::ostringstream ss;
                ss << std::fixed << std::setprecision(6);
                ss << "{\"type\":\"history\",\"data\":{\"name\":\"" << json_escape(hist->name) << "\""
                   << ",\"values\":[";
                for (size_t i = 0; i < hist->values.size(); i++) {
                    if (i > 0) ss << ",";
                    ss << hist->values[i];
                }
                ss << "],\"timestamps\":[";
                for (size_t i = 0; i < hist->timestamps.size(); i++) {
                    if (i > 0) ss << ",";
                    ss << std::chrono::duration<double>(hist->timestamps[i].time_since_epoch()).count();
                }
                ss << "]}}";
                response = ss.str();
            }
        }
        else if (cmd == "get_histories") {
            auto names_pos = request.find("\"names\"");
            std::vector<std::string> names;
            if (names_pos != std::string::npos) {
                auto arr_start = request.find('[', names_pos);
                auto arr_end = request.find(']', arr_start);
                if (arr_start != std::string::npos && arr_end != std::string::npos) {
                    std::string arr = request.substr(arr_start + 1, arr_end - arr_start - 1);
                    size_t p = 0;
                    while (p < arr.size()) {
                        auto q1 = arr.find('"', p);
                        if (q1 == std::string::npos) break;
                        auto q2 = arr.find('"', q1 + 1);
                        if (q2 == std::string::npos) break;
                        names.push_back(arr.substr(q1 + 1, q2 - q1 - 1));
                        p = q2 + 1;
                    }
                }
            }
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(6);
            ss << "{\"type\":\"histories\",\"data\":[";
            bool first = true;
            for (const auto& name : names) {
                auto hist = mon->get_history(name);
                if (!hist) continue;
                if (!first) ss << ",";
                first = false;
                ss << "{\"name\":\"" << json_escape(hist->name) << "\",\"values\":[";
                for (size_t i = 0; i < hist->values.size(); i++) {
                    if (i > 0) ss << ",";
                    ss << hist->values[i];
                }
                ss << "],\"timestamps\":[";
                for (size_t i = 0; i < hist->timestamps.size(); i++) {
                    if (i > 0) ss << ",";
                    ss << std::chrono::duration<double>(hist->timestamps[i].time_since_epoch()).count();
                }
                ss << "]}";
            }
            ss << "]}";
            response = ss.str();
        }
        else if (cmd == "get_histories_since") {
            uint64_t since_seq = static_cast<uint64_t>(json_get_number(request, "since_seq"));
            auto names_pos = request.find("\"names\"");
            std::vector<std::string> names;
            if (names_pos != std::string::npos) {
                auto arr_start = request.find('[', names_pos);
                auto arr_end = request.find(']', arr_start);
                if (arr_start != std::string::npos && arr_end != std::string::npos) {
                    std::string arr = request.substr(arr_start + 1, arr_end - arr_start - 1);
                    size_t p = 0;
                    while (p < arr.size()) {
                        auto q1 = arr.find('"', p);
                        if (q1 == std::string::npos) break;
                        auto q2 = arr.find('"', q1 + 1);
                        if (q2 == std::string::npos) break;
                        names.push_back(arr.substr(q1 + 1, q2 - q1 - 1));
                        p = q2 + 1;
                    }
                }
            }
            uint64_t current_seq = mon->get_seq();
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(6);
            ss << "{\"type\":\"histories\",\"seq\":" << current_seq << ",\"data\":[";
            bool first = true;
            for (const auto& name : names) {
                auto hist = mon->get_history_since(name, since_seq);
                if (!hist || hist->values.empty()) continue;
                if (!first) ss << ",";
                first = false;
                ss << "{\"name\":\"" << json_escape(hist->name) << "\",\"values\":[";
                for (size_t i = 0; i < hist->values.size(); i++) {
                    if (i > 0) ss << ",";
                    ss << hist->values[i];
                }
                ss << "],\"timestamps\":[";
                for (size_t i = 0; i < hist->timestamps.size(); i++) {
                    if (i > 0) ss << ",";
                    ss << std::chrono::duration<double>(hist->timestamps[i].time_since_epoch()).count();
                }
                ss << "]}";
            }
            ss << "]}";
            response = ss.str();
        }
        else if (cmd == "unregister_var") {
            std::string name = json_get_string(request, "name");
            bool ok = mon->unregister_var(name);
            response = ok ? "{\"type\":\"unregister_result\",\"ok\":true}"
                          : "{\"type\":\"unregister_result\",\"ok\":false}";
        }
        else {
            response = "{\"type\":\"error\",\"message\":\"unknown command\"}";
        }

        if (!send_message(client_fd, response)) break;
    }

    mon->client_disconnected();
    ::close(client_fd);
}

void VarMonitor::tcp_server_loop() {
    int server_fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        std::cerr << "[VarMonitor] Error creando socket TCP\n";
        return;
    }

    int opt = 1;
    ::setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    // Intentar bind en un rango de puertos consecutivos empezando en g_tcp_port.
    uint16_t base_port = g_tcp_port;
    const uint16_t max_offset = 10;
    bool bound = false;

    for (uint16_t offset = 0; offset <= max_offset; ++offset) {
        uint16_t port = static_cast<uint16_t>(base_port + offset);
        struct sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(port);

        if (::bind(server_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) == 0) {
            g_tcp_port = port;
            bound = true;
            break;
        }
    }

    if (!bound) {
        std::cerr << "[VarMonitor] Error en bind: no hay puertos libres en rango ["
                  << base_port << "," << (base_port + max_offset) << "]\n";
        ::close(server_fd);
        return;
    }

    if (::listen(server_fd, 8) < 0) {
        std::cerr << "[VarMonitor] Error en listen\n";
        ::close(server_fd);
        return;
    }

    std::cout << "[VarMonitor] Servidor TCP escuchando en puerto " << g_tcp_port << "\n";
    g_server_start_time = std::chrono::steady_clock::now();

    while (running_.load()) {
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(server_fd, &rfds);
        struct timeval tv{1, 0};
        int ret = ::select(server_fd + 1, &rfds, nullptr, nullptr, &tv);
        if (ret <= 0) continue;

        struct sockaddr_in client_addr{};
        socklen_t client_len = sizeof(client_addr);
        int client_fd = ::accept(server_fd, reinterpret_cast<struct sockaddr*>(&client_addr), &client_len);
        if (client_fd < 0) continue;

        std::thread(handle_client, client_fd, std::ref(running_)).detach();
    }

    ::close(server_fd);
}

} // namespace varmon
