#include "var_monitor.hpp"
#include "shm_publisher.hpp"
#include <iostream>
#include <algorithm>
#include <mutex>

namespace varmon {

static VarMonitor* g_instance = nullptr;

VarMonitor* get_global_instance() { return g_instance; }
void set_global_instance(VarMonitor* instance) { g_instance = instance; }

VarMonitor::VarMonitor() = default;

VarMonitor::~VarMonitor() {
    stop();
    if (g_instance == this) g_instance = nullptr;
}

void VarMonitor::register_var(const std::string& name, double* ptr) {
    register_var(name, VarType::Double,
        [ptr]() -> VarValue { return *ptr; },
        [ptr](const VarValue& v) { *ptr = std::get<double>(v); });
}

void VarMonitor::register_var(const std::string& name, float* ptr) {
    register_var(name, VarType::Double,
        [ptr]() -> VarValue { return static_cast<double>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<float>(std::get<double>(v)); });
}

void VarMonitor::register_var(const std::string& name, int32_t* ptr) {
    register_var(name, VarType::Int32,
        [ptr]() -> VarValue { return *ptr; },
        [ptr](const VarValue& v) { *ptr = std::get<int32_t>(v); });
}

void VarMonitor::register_var(const std::string& name, int64_t* ptr) {
    register_var(name, VarType::Double,
        [ptr]() -> VarValue { return static_cast<double>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<int64_t>(std::get<double>(v)); });
}

void VarMonitor::register_var(const std::string& name, uint32_t* ptr) {
    register_var(name, VarType::Double,
        [ptr]() -> VarValue { return static_cast<double>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<uint32_t>(std::get<double>(v)); });
}

void VarMonitor::register_var(const std::string& name, uint64_t* ptr) {
    register_var(name, VarType::Double,
        [ptr]() -> VarValue { return static_cast<double>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<uint64_t>(std::get<double>(v)); });
}

void VarMonitor::register_var(const std::string& name, int16_t* ptr) {
    register_var(name, VarType::Int32,
        [ptr]() -> VarValue { return static_cast<int32_t>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<int16_t>(std::get<int32_t>(v)); });
}

void VarMonitor::register_var(const std::string& name, uint16_t* ptr) {
    register_var(name, VarType::Int32,
        [ptr]() -> VarValue { return static_cast<int32_t>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<uint16_t>(std::get<int32_t>(v)); });
}

void VarMonitor::register_var(const std::string& name, int8_t* ptr) {
    register_var(name, VarType::Int32,
        [ptr]() -> VarValue { return static_cast<int32_t>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<int8_t>(std::get<int32_t>(v)); });
}

void VarMonitor::register_var(const std::string& name, uint8_t* ptr) {
    register_var(name, VarType::Int32,
        [ptr]() -> VarValue { return static_cast<int32_t>(*ptr); },
        [ptr](const VarValue& v) { *ptr = static_cast<uint8_t>(std::get<int32_t>(v)); });
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

void VarMonitor::register_char_array(const std::string& name, char* buf, size_t len) {
    register_var(name, VarType::String,
        [buf, len]() -> VarValue {
            size_t actual = strnlen(buf, len);
            return std::string(buf, actual);
        },
        [buf, len](const VarValue& v) {
            const std::string& s = std::get<std::string>(v);
            size_t n = std::min(len - 1, s.size());
            std::memcpy(buf, s.data(), n);
            buf[n] = '\0';
        });
}

void VarMonitor::register_var(const std::string& name, VarType type,
                               Getter getter, Setter setter) {
    std::unique_lock lock(mutex_);
    // Si la variable ya existe, ignoramos registros duplicados para
    // evitar reinicializar el historial continuamente.
    auto it_existing = vars_.find(name);
    if (it_existing != vars_.end()) {
        return;
    }

    VarEntry entry;
    entry.name = name;
    entry.type = type;
    entry.getter = std::move(getter);
    entry.setter = std::move(setter);
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

    unsigned max_vars = get_config_uint("shm_max_vars", 2048);
    shm_publisher::init(static_cast<size_t>(max_vars));

    sample_thread_ = std::thread(&VarMonitor::sample_loop, this);
    rpc_thread_ = std::thread(&VarMonitor::uds_server_loop, this);

    std::cout << "[VarMonitor] Servidor UDS iniciado\n";
    return true;
}

void VarMonitor::stop() {
    if (!running_.exchange(false)) return;
    shm_publisher::shutdown();
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

void VarMonitor::client_connected() {
    client_count_.fetch_add(1);
}

void VarMonitor::client_disconnected() {
    client_count_.fetch_sub(1);
}

void VarMonitor::sample_loop() {
    while (running_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(sample_interval_ms_));
    }
}

void VarMonitor::write_shm_snapshot() {
    shm_publisher::write_snapshot(this);
}

} // namespace varmon
