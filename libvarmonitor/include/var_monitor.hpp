#pragma once

#include <string>
#include <functional>
#include <unordered_map>
#include <vector>
#include <shared_mutex>
#include <atomic>
#include <thread>
#include <chrono>
#include <variant>
#include <optional>
#include <cstdint>
#include <cstring>
#include <mutex>

namespace varmon {

enum class VarType : int { Double = 0, Int32 = 1, Bool = 2, String = 3, Array = 4 };

using VarValue = std::variant<double, int32_t, bool, std::string, std::vector<double>>;
using Getter = std::function<VarValue()>;
using Setter = std::function<void(const VarValue&)>;
using ArrayGetter = std::function<std::vector<double>()>;
using ArrayElementSetter = std::function<bool(size_t index, double value)>;

struct TimestampedValue {
    double value;
    std::chrono::system_clock::time_point time;
};

struct VarEntry {
    std::string name;
    VarType type;
    Getter getter;
    Setter setter;
    ArrayElementSetter array_elem_setter;
    std::vector<TimestampedValue> history;
    size_t history_write_idx = 0;
    bool history_full = false;
};

class VarMonitor {
public:
    explicit VarMonitor(size_t history_capacity = 1000);
    ~VarMonitor();

    VarMonitor(const VarMonitor&) = delete;
    VarMonitor& operator=(const VarMonitor&) = delete;

    void register_var(const std::string& name, double* ptr);
    void register_var(const std::string& name, int32_t* ptr);
    void register_var(const std::string& name, bool* ptr);
    void register_var(const std::string& name, std::string* ptr);

    void register_var(const std::string& name, VarType type, Getter getter, Setter setter = nullptr);

    void register_array(const std::string& name, double* ptr, size_t count);
    void register_array(const std::string& name, std::vector<double>& vec, std::mutex& mtx);
    void register_array(const std::string& name, ArrayGetter getter);

    bool unregister_var(const std::string& name);
    void unregister_all();

    bool start(int sample_interval_ms = 100);
    void stop();
    bool is_running() const { return running_.load(); }

    struct VarSnapshot {
        std::string name;
        VarType type;
        VarValue value;
        std::chrono::system_clock::time_point time;
    };

    std::vector<VarSnapshot> list_vars();
    std::vector<std::string> list_var_names();
    std::optional<VarSnapshot> get_var(const std::string& name);
    bool set_var(const std::string& name, const VarValue& value);
    bool set_array_element(const std::string& name, size_t index, double value);

    struct HistoryData {
        std::string name;
        std::vector<double> values;
        std::vector<std::chrono::system_clock::time_point> timestamps;
    };

    std::optional<HistoryData> get_history(const std::string& name);

    void client_connected();
    void client_disconnected();
    int client_count() const { return client_count_.load(); }

private:
    void sample_loop();
    void tcp_server_loop();

    std::unordered_map<std::string, VarEntry> vars_;
    mutable std::shared_mutex mutex_;
    std::atomic<bool> running_{false};
    std::atomic<int> client_count_{0};
    std::thread sample_thread_;
    std::thread rpc_thread_;
    int sample_interval_ms_ = 100;
    size_t history_capacity_;
};

VarMonitor* get_global_instance();
void set_global_instance(VarMonitor* instance);

void set_tcp_port(uint16_t port);
uint16_t get_tcp_port();

void set_config_path(const std::string& path);
bool load_config();

} // namespace varmon
