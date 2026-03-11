#include "var_monitor.hpp"
#include <iostream>
#include <algorithm>
#include <mutex>

namespace varmon {

static VarMonitor* g_instance = nullptr;

VarMonitor* get_global_instance() { return g_instance; }
void set_global_instance(VarMonitor* instance) { g_instance = instance; }

VarMonitor::VarMonitor(size_t history_capacity)
    : history_capacity_(history_capacity) {}

VarMonitor::~VarMonitor() {
    stop();
    if (g_instance == this) g_instance = nullptr;
}

void VarMonitor::register_var(const std::string& name, double* ptr) {
    register_var(name, VarType::Double,
        [ptr]() -> VarValue { return *ptr; },
        [ptr](const VarValue& v) { *ptr = std::get<double>(v); });
}

void VarMonitor::register_var(const std::string& name, int32_t* ptr) {
    register_var(name, VarType::Int32,
        [ptr]() -> VarValue { return *ptr; },
        [ptr](const VarValue& v) { *ptr = std::get<int32_t>(v); });
}

void VarMonitor::register_var(const std::string& name, bool* ptr) {
    register_var(name, VarType::Bool,
        [ptr]() -> VarValue { return *ptr; },
        [ptr](const VarValue& v) { *ptr = std::get<bool>(v); });
}

void VarMonitor::register_var(const std::string& name, std::string* ptr) {
    register_var(name, VarType::String,
        [ptr]() -> VarValue { return *ptr; },
        [ptr](const VarValue& v) { *ptr = std::get<std::string>(v); });
}

void VarMonitor::register_var(const std::string& name, VarType type,
                               Getter getter, Setter setter) {
    std::unique_lock lock(mutex_);
    VarEntry entry;
    entry.name = name;
    entry.type = type;
    entry.getter = std::move(getter);
    entry.setter = std::move(setter);
    if (type != VarType::Array) {
        entry.history.resize(history_capacity_);
    }
    vars_[name] = std::move(entry);
}

void VarMonitor::register_array(const std::string& name, double* ptr, size_t count) {
    register_var(name, VarType::Array,
        [ptr, count]() -> VarValue {
            return std::vector<double>(ptr, ptr + count);
        });
    std::unique_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it != vars_.end()) {
        it->second.array_elem_setter = [ptr, count](size_t idx, double val) -> bool {
            if (idx >= count) return false;
            ptr[idx] = val;
            return true;
        };
    }
}

void VarMonitor::register_array(const std::string& name,
                                 std::vector<double>& vec, std::mutex& mtx) {
    register_var(name, VarType::Array,
        [&vec, &mtx]() -> VarValue {
            std::lock_guard<std::mutex> lock(mtx);
            return vec;
        });
    std::unique_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it != vars_.end()) {
        it->second.array_elem_setter = [&vec, &mtx](size_t idx, double val) -> bool {
            std::lock_guard<std::mutex> lk(mtx);
            if (idx >= vec.size()) return false;
            vec[idx] = val;
            return true;
        };
    }
}

void VarMonitor::register_array(const std::string& name, ArrayGetter getter) {
    auto g = std::move(getter);
    register_var(name, VarType::Array,
        [g = std::move(g)]() -> VarValue { return g(); });
}

bool VarMonitor::unregister_var(const std::string& name) {
    std::unique_lock lock(mutex_);
    return vars_.erase(name) > 0;
}

void VarMonitor::unregister_all() {
    std::unique_lock lock(mutex_);
    vars_.clear();
}

bool VarMonitor::start(int sample_interval_ms) {
    if (running_.exchange(true)) return false;
    sample_interval_ms_ = sample_interval_ms;
    set_global_instance(this);

    load_config();

    size_t cfg_cap = get_history_capacity();
    if (cfg_cap != history_capacity_) {
        std::unique_lock lock(mutex_);
        history_capacity_ = cfg_cap;
        for (auto& [name, entry] : vars_) {
            if (entry.type != VarType::Array) {
                entry.history.resize(history_capacity_);
                entry.history_write_idx = 0;
                entry.history_full = false;
            }
        }
    }

    sample_thread_ = std::thread(&VarMonitor::sample_loop, this);
    rpc_thread_ = std::thread(&VarMonitor::tcp_server_loop, this);

    std::cout << "[VarMonitor] Servidor TCP iniciado (puerto " << get_tcp_port() << ")\n";
    return true;
}

void VarMonitor::stop() {
    if (!running_.exchange(false)) return;
    if (sample_thread_.joinable()) sample_thread_.join();
    if (rpc_thread_.joinable()) rpc_thread_.detach();
    std::cout << "[VarMonitor] Detenido\n";
}

std::vector<VarMonitor::VarSnapshot> VarMonitor::list_vars() {
    std::shared_lock lock(mutex_);
    std::vector<VarSnapshot> result;
    result.reserve(vars_.size());
    for (auto& [name, entry] : vars_) {
        VarSnapshot snap;
        snap.name = name;
        snap.type = entry.type;
        snap.value = entry.getter();
        snap.time = std::chrono::system_clock::now();
        result.push_back(std::move(snap));
    }
    return result;
}

std::vector<std::string> VarMonitor::list_var_names() {
    std::shared_lock lock(mutex_);
    std::vector<std::string> result;
    result.reserve(vars_.size());
    for (auto& [name, entry] : vars_) {
        result.push_back(name);
    }
    return result;
}

std::optional<VarMonitor::VarSnapshot> VarMonitor::get_var(const std::string& name) {
    std::shared_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it == vars_.end()) return std::nullopt;
    VarSnapshot snap;
    snap.name = name;
    snap.type = it->second.type;
    snap.value = it->second.getter();
    snap.time = std::chrono::system_clock::now();
    return snap;
}

bool VarMonitor::set_var(const std::string& name, const VarValue& value) {
    std::shared_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it == vars_.end() || !it->second.setter) return false;
    it->second.setter(value);
    return true;
}

bool VarMonitor::set_array_element(const std::string& name, size_t index, double value) {
    std::shared_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it == vars_.end() || it->second.type != VarType::Array) return false;
    if (!it->second.array_elem_setter) return false;
    return it->second.array_elem_setter(index, value);
}

std::optional<VarMonitor::HistoryData> VarMonitor::get_history(const std::string& name) {
    std::shared_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it == vars_.end()) return std::nullopt;
    if (it->second.type == VarType::Array) return std::nullopt;

    auto& entry = it->second;
    HistoryData hd;
    hd.name = name;

    size_t count = entry.history_full ? history_capacity_ : entry.history_write_idx;
    hd.values.reserve(count);
    hd.timestamps.reserve(count);
    hd.seqs.reserve(count);

    size_t start = entry.history_full ? entry.history_write_idx : 0;
    for (size_t i = 0; i < count; ++i) {
        size_t idx = (start + i) % history_capacity_;
        hd.values.push_back(entry.history[idx].value);
        hd.timestamps.push_back(entry.history[idx].time);
        hd.seqs.push_back(entry.history[idx].seq);
    }
    return hd;
}

std::optional<VarMonitor::HistoryData> VarMonitor::get_history_since(
        const std::string& name, uint64_t since_seq) {
    std::shared_lock lock(mutex_);
    auto it = vars_.find(name);
    if (it == vars_.end()) return std::nullopt;
    if (it->second.type == VarType::Array) return std::nullopt;

    auto& entry = it->second;
    HistoryData hd;
    hd.name = name;

    size_t count = entry.history_full ? history_capacity_ : entry.history_write_idx;
    size_t start = entry.history_full ? entry.history_write_idx : 0;
    for (size_t i = 0; i < count; ++i) {
        size_t idx = (start + i) % history_capacity_;
        if (entry.history[idx].seq > since_seq) {
            hd.values.push_back(entry.history[idx].value);
            hd.timestamps.push_back(entry.history[idx].time);
            hd.seqs.push_back(entry.history[idx].seq);
        }
    }
    return hd;
}

void VarMonitor::client_connected() {
    client_count_.fetch_add(1);
}

void VarMonitor::client_disconnected() {
    client_count_.fetch_sub(1);
}

void VarMonitor::sample_loop() {
    while (running_.load()) {
        if (client_count_.load() > 0) {
            std::unique_lock lock(mutex_);
            auto now = std::chrono::system_clock::now();
            uint64_t seq = ++seq_num_;
            for (auto& [name, entry] : vars_) {
                if (entry.type == VarType::Array) continue;
                double val = 0.0;
                auto v = entry.getter();
                switch (entry.type) {
                    case VarType::Double: val = std::get<double>(v); break;
                    case VarType::Int32:  val = static_cast<double>(std::get<int32_t>(v)); break;
                    case VarType::Bool:   val = std::get<bool>(v) ? 1.0 : 0.0; break;
                    case VarType::String: val = 0.0; break;
                    case VarType::Array:  break;
                }
                entry.history[entry.history_write_idx] = {val, now, seq};
                entry.history_write_idx = (entry.history_write_idx + 1) % history_capacity_;
                if (entry.history_write_idx == 0) entry.history_full = true;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(sample_interval_ms_));
    }
}

} // namespace varmon
