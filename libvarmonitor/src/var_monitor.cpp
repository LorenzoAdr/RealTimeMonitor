#include "var_monitor.hpp"
#include "shm_publisher.hpp"
#include <iostream>
#include <algorithm>
#include <mutex>
#include <optional>
#include <string>
#include <variant>
#include <cstdint>
#include <cstdlib>
#include <limits>

namespace varmon {

namespace {

/** Convierte el valor entrante al alternative del std::variant que espera el setter de VarType (evita std::bad_variant_access). */
std::optional<VarValue> coerce_var_value_for_type(VarType target, const VarValue& v) {
    switch (target) {
        case VarType::Double:
            return std::visit(
                [](const auto& arg) -> std::optional<VarValue> {
                    using T = std::decay_t<decltype(arg)>;
                    if constexpr (std::is_same_v<T, double>)
                        return arg;
                    if constexpr (std::is_same_v<T, int32_t>)
                        return static_cast<double>(arg);
                    if constexpr (std::is_same_v<T, bool>)
                        return arg ? 1.0 : 0.0;
                    return std::nullopt;
                },
                v);
        case VarType::Int32:
            return std::visit(
                [](const auto& arg) -> std::optional<VarValue> {
                    using T = std::decay_t<decltype(arg)>;
                    if constexpr (std::is_same_v<T, double>)
                        return static_cast<int32_t>(arg);
                    if constexpr (std::is_same_v<T, int32_t>)
                        return arg;
                    if constexpr (std::is_same_v<T, bool>)
                        return static_cast<int32_t>(arg ? 1 : 0);
                    return std::nullopt;
                },
                v);
        case VarType::Bool:
            return std::visit(
                [](const auto& arg) -> std::optional<VarValue> {
                    using T = std::decay_t<decltype(arg)>;
                    if constexpr (std::is_same_v<T, bool>)
                        return arg;
                    if constexpr (std::is_same_v<T, double>)
                        return arg != 0.0;
                    if constexpr (std::is_same_v<T, int32_t>)
                        return arg != 0;
                    return std::nullopt;
                },
                v);
        case VarType::String:
            return std::visit(
                [](const auto& arg) -> std::optional<VarValue> {
                    using T = std::decay_t<decltype(arg)>;
                    if constexpr (std::is_same_v<T, std::string>)
                        return arg;
                    if constexpr (std::is_same_v<T, double>)
                        return std::to_string(arg);
                    if constexpr (std::is_same_v<T, int32_t>)
                        return std::to_string(arg);
                    if constexpr (std::is_same_v<T, bool>)
                        return std::string(arg ? "true" : "false");
                    return std::nullopt;
                },
                v);
        case VarType::Array:
        default:
            return std::nullopt;
    }
}

static double scalar_double_from_var_value(const VarValue& v) {
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
                return 0.0;
        },
        v);
}

/** `VARMON_DEBUG_IMPORT=1` y opcionalmente `VARMON_DEBUG_IMPORT_NAMES=a,b` (coincidencia exacta por nombre). */
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

} // namespace

static VarMonitor* g_instance = nullptr;

VarMonitor* get_global_instance() { return g_instance; }
void set_global_instance(VarMonitor* instance) { g_instance = instance; }

VarMonitor::VarMonitor() = default;

VarMonitor::~VarMonitor() {
    stop();
    if (g_instance == this) g_instance = nullptr;
}

void VarMonitor::register_var(const std::string& name, double* ptr) {
    {
        std::lock_guard<std::mutex> cg(sub_cache_mtx_);
        std::unique_lock<std::shared_mutex> lock(mutex_);
        if (name_to_id_.count(name) != 0)
            return;
        invalidate_sub_cache_rows_unlocked(name);
        VarEntry entry;
        entry.name = name;
        entry.type = VarType::Double;
        entry.getter = [ptr]() -> VarValue { return *ptr; };
        entry.setter = [ptr](const VarValue& v) { *ptr = std::get<double>(v); };
        entry.fast_double_ptr = ptr;
        uint32_t id;
        if (!free_slot_ids_.empty()) {
            id = free_slot_ids_.back();
            free_slot_ids_.pop_back();
        } else {
            id = static_cast<uint32_t>(var_slots_.size());
            var_slots_.emplace_back();
        }
        var_slots_[id].alive = true;
        var_slots_[id].entry = std::move(entry);
        name_to_id_[name] = id;
    }
    mark_dirty(name);
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
    {
        std::lock_guard<std::mutex> cg(sub_cache_mtx_);
        std::unique_lock<std::shared_mutex> lock(mutex_);
        if (name_to_id_.count(name) != 0)
            return;
        invalidate_sub_cache_rows_unlocked(name);
        VarEntry entry;
        entry.name = name;
        entry.type = type;
        entry.getter = std::move(getter);
        entry.setter = std::move(setter);
        uint32_t id;
        if (!free_slot_ids_.empty()) {
            id = free_slot_ids_.back();
            free_slot_ids_.pop_back();
        } else {
            id = static_cast<uint32_t>(var_slots_.size());
            var_slots_.emplace_back();
        }
        var_slots_[id].alive = true;
        var_slots_[id].entry = std::move(entry);
        name_to_id_[name] = id;
    }
    mark_dirty(name);
}

void VarMonitor::register_array(const std::string& name, double* ptr, size_t count) {
    register_var(name, VarType::Array,
        [ptr, count]() -> VarValue {
            return std::vector<double>(ptr, ptr + count);
        });
    std::lock_guard<std::mutex> cg(sub_cache_mtx_);
    std::unique_lock<std::shared_mutex> lock(mutex_);
    auto nit = name_to_id_.find(name);
    if (nit != name_to_id_.end()) {
        var_slots_[nit->second].entry.array_elem_setter =
            [ptr, count](size_t idx, double val) -> bool {
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
    std::lock_guard<std::mutex> cg(sub_cache_mtx_);
    std::unique_lock<std::shared_mutex> lock(mutex_);
    auto nit = name_to_id_.find(name);
    if (nit != name_to_id_.end()) {
        var_slots_[nit->second].entry.array_elem_setter =
            [&vec, &mtx](size_t idx, double val) -> bool {
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
    bool erased = false;
    {
        std::lock_guard<std::mutex> cg(sub_cache_mtx_);
        invalidate_sub_cache_rows_unlocked(name);
        std::unique_lock<std::shared_mutex> lock(mutex_);
        auto it = name_to_id_.find(name);
        if (it == name_to_id_.end())
            return false;
        const uint32_t id = it->second;
        name_to_id_.erase(it);
        var_slots_[id].alive = false;
        var_slots_[id].entry = VarEntry{};
        free_slot_ids_.push_back(id);
        erased = true;
    }
    if (erased) {
        std::lock_guard<std::mutex> dlk(dirty_mutex_);
        dirty_names_.erase(name);
    }
    return erased;
}

void VarMonitor::unregister_all() {
    {
        std::lock_guard<std::mutex> cg(sub_cache_mtx_);
        sub_cache_snapshot_.clear();
        sub_cache_ids_.clear();
        sub_cache_name_rows_.clear();
        std::unique_lock<std::shared_mutex> lock(mutex_);
        name_to_id_.clear();
        free_slot_ids_.clear();
        var_slots_.clear();
    }
    shm_clear_all_dirty();
}

void VarMonitor::set_sample_interval_ms(int ms) {
    if (ms < 1)
        ms = 1;
    else if (ms > 3'600'000)
        ms = 3'600'000;
    sample_interval_ms_.store(ms, std::memory_order_relaxed);
}

bool VarMonitor::start(int sample_interval_ms) {
    if (running_.exchange(true)) return false;
    set_sample_interval_ms(sample_interval_ms);
    set_global_instance(this);

    load_config();

    unsigned max_vars = get_config_uint("shm_max_vars", 2048);
    shm_publisher::init(static_cast<size_t>(max_vars));

    async_shm_publish_ = (get_config_uint("shm_async_publish", 0) != 0);
    if (async_shm_publish_) {
        shm_publish_thread_ = std::thread(&VarMonitor::shm_publish_loop, this);
        std::cout << "[VarMonitor] Publicacion SHM en hilo dedicado (shm_async_publish=1)\n";
    }

    sample_thread_ = std::thread(&VarMonitor::sample_loop, this);
    rpc_thread_ = std::thread(&VarMonitor::uds_server_loop, this);

    std::cout << "[VarMonitor] Servidor UDS iniciado\n";
    return true;
}

void VarMonitor::stop() {
    if (!running_.exchange(false)) return;
    shm_publish_cv_.notify_all();
    if (shm_publish_thread_.joinable())
        shm_publish_thread_.join();
    shm_publisher::shutdown();
    if (sample_thread_.joinable()) sample_thread_.join();
    if (rpc_thread_.joinable()) rpc_thread_.detach();
    std::cout << "[VarMonitor] Detenido\n";
}

std::vector<VarMonitor::VarSnapshot> VarMonitor::list_vars() {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    std::vector<VarSnapshot> result;
    for (const auto& slot : var_slots_) {
        if (!slot.alive)
            continue;
        VarSnapshot snap;
        snap.name = slot.entry.name;
        snap.type = slot.entry.type;
        snap.value = slot.entry.getter();
        snap.time = std::chrono::system_clock::now();
        result.push_back(std::move(snap));
    }
    return result;
}

std::vector<std::string> VarMonitor::list_var_names() {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    std::vector<std::string> result;
    for (const auto& slot : var_slots_) {
        if (!slot.alive)
            continue;
        result.push_back(slot.entry.name);
    }
    return result;
}

std::optional<VarMonitor::VarSnapshot> VarMonitor::get_var(const std::string& name) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = name_to_id_.find(name);
    if (it == name_to_id_.end())
        return std::nullopt;
    const uint32_t id = it->second;
    if (id >= var_slots_.size() || !var_slots_[id].alive)
        return std::nullopt;
    const VarEntry& ent = var_slots_[id].entry;
    VarSnapshot snap;
    snap.name = name;
    snap.type = ent.type;
    snap.value = ent.getter();
    snap.time = std::chrono::system_clock::now();
    return snap;
}

bool VarMonitor::set_var(const std::string& name, const VarValue& value) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = name_to_id_.find(name);
    if (it == name_to_id_.end())
        return false;
    const uint32_t id = it->second;
    if (!var_slots_[id].alive)
        return false;
    VarEntry& ent = var_slots_[id].entry;
    if (!ent.setter)
        return false;
    std::optional<VarValue> coerced = coerce_var_value_for_type(ent.type, value);
    if (!coerced)
        return false;
    ent.setter(*coerced);
    lock.unlock();
    mark_dirty(name);
    return true;
}

void VarMonitor::mark_dirty(const std::string& name) {
    std::lock_guard<std::mutex> lock(dirty_mutex_);
    dirty_names_.insert(name);
}

bool VarMonitor::shm_should_fetch_for_publish(const std::string& name, bool full_refresh) {
    if (full_refresh)
        return true;
    std::lock_guard<std::mutex> lock(dirty_mutex_);
    auto it = dirty_names_.find(name);
    if (it == dirty_names_.end())
        return false;
    dirty_names_.erase(it);
    return true;
}

void VarMonitor::shm_clear_all_dirty() {
    std::lock_guard<std::mutex> lock(dirty_mutex_);
    dirty_names_.clear();
}

void VarMonitor::shm_clear_dirty_for_subscription_rows(const std::vector<std::string>& sub_full,
                                                       const std::vector<uint32_t>& export_row_indices) {
    std::lock_guard<std::mutex> lock(dirty_mutex_);
    for (uint32_t row : export_row_indices) {
        if (row < sub_full.size())
            dirty_names_.erase(sub_full[row]);
    }
}

void VarMonitor::get_shm_scalar_exports(const std::vector<std::string>& sub_full,
                                        const std::vector<uint32_t>& export_row_indices,
                                        std::vector<ShmScalarExport>& out,
                                        const std::vector<uint8_t>* fetch_mask) {
    out.clear();
    out.resize(export_row_indices.size());
    const bool use_mask =
        fetch_mask != nullptr && fetch_mask->size() == export_row_indices.size();

    std::lock_guard<std::mutex> cg(sub_cache_mtx_);
    std::shared_lock<std::shared_mutex> lock(mutex_);

    for (size_t k = 0; k < export_row_indices.size(); ++k) {
        if (use_mask && (*fetch_mask)[k] == 0)
            continue;
        const uint32_t row = export_row_indices[k];
        if (row >= sub_full.size()) {
            out[k].ok = false;
            continue;
        }
        const std::string& name = sub_full[row];
        const uint32_t cached =
            (row < sub_cache_ids_.size()) ? sub_cache_ids_[row] : kInvalidVarSlot;
        uint32_t id = kInvalidVarSlot;
        if (cached != kInvalidVarSlot && cached < var_slots_.size() && var_slots_[cached].alive &&
            var_slots_[cached].entry.name == name) {
            id = cached;
        } else {
            auto nit = name_to_id_.find(name);
            if (nit == name_to_id_.end()) {
                out[k].ok = false;
                if (row < sub_cache_ids_.size())
                    sub_cache_ids_[row] = kInvalidVarSlot;
                continue;
            }
            id = nit->second;
            if (row < sub_cache_ids_.size())
                sub_cache_ids_[row] = id;
        }
        VarEntry& ent = var_slots_[id].entry;
        if (ent.type == VarType::Array || ent.type == VarType::String) {
            out[k].ok = false;
            continue;
        }
        out[k].type = ent.type;
        if (ent.fast_double_ptr != nullptr && ent.type == VarType::Double)
            out[k].as_double = *ent.fast_double_ptr;
        else
            out[k].as_double = scalar_double_from_var_value(ent.getter());
        out[k].ok = true;
    }
}

void VarMonitor::apply_shm_import_values(const std::vector<std::pair<std::string, VarValue>>& items) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    for (const auto& [name, value] : items) {
        auto it = name_to_id_.find(name);
        if (it == name_to_id_.end())
            continue;
        const uint32_t id = it->second;
        if (!var_slots_[id].alive)
            continue;
        VarEntry& ent = var_slots_[id].entry;
        if (!ent.setter)
            continue;
        std::optional<VarValue> coerced = coerce_var_value_for_type(ent.type, value);
        if (!coerced)
            continue;
        ent.setter(*coerced);
        mark_dirty(name);
        if (import_debug_env_enabled() && import_debug_name_matches(name) && ent.type != VarType::Array &&
            ent.type != VarType::String) {
            const double applied = scalar_double_from_var_value(*coerced);
            const double readback = scalar_double_from_var_value(ent.getter());
            std::cerr << "[VarMonitor IMPORT apply] name=" << name << " applied=" << applied << " readback=" << readback
                      << "\n";
        }
    }
}

bool VarMonitor::set_array_element(const std::string& name, size_t index, double value) {
    std::shared_lock<std::shared_mutex> lock(mutex_);
    auto it = name_to_id_.find(name);
    if (it == name_to_id_.end())
        return false;
    const uint32_t id = it->second;
    if (!var_slots_[id].alive || var_slots_[id].entry.type != VarType::Array)
        return false;
    VarEntry& ent = var_slots_[id].entry;
    if (!ent.array_elem_setter)
        return false;
    return ent.array_elem_setter(index, value);
}

void VarMonitor::invalidate_sub_cache_rows_unlocked(const std::string& name) {
    auto it = sub_cache_name_rows_.find(name);
    if (it == sub_cache_name_rows_.end())
        return;
    for (uint32_t row : it->second) {
        if (row < sub_cache_ids_.size())
            sub_cache_ids_[row] = kInvalidVarSlot;
    }
}

void VarMonitor::shm_prepare_export_cache(const std::vector<std::string>& sub, uint64_t sub_gen) {
    std::lock_guard<std::mutex> g(sub_cache_mtx_);
    if (sub_gen == sub_cache_generation_)
        return;
    sub_cache_generation_ = sub_gen;
    sub_cache_snapshot_ = sub;
    sub_cache_ids_.assign(sub.size(), kInvalidVarSlot);
    sub_cache_name_rows_.clear();
    for (uint32_t i = 0; i < sub.size(); ++i)
        sub_cache_name_rows_[sub[i]].push_back(i);
}

void VarMonitor::invalidate_shm_sub_cache() {
    std::lock_guard<std::mutex> g(sub_cache_mtx_);
    sub_cache_snapshot_.clear();
    sub_cache_ids_.clear();
    sub_cache_name_rows_.clear();
    sub_cache_generation_ = std::numeric_limits<uint64_t>::max();
}

void VarMonitor::client_connected() {
    client_count_.fetch_add(1);
}

void VarMonitor::client_disconnected() {
    client_count_.fetch_sub(1);
}

void VarMonitor::sample_loop() {
    while (running_.load()) {
        const int ms = sample_interval_ms_.load(std::memory_order_relaxed);
        std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    }
}

void VarMonitor::shm_publish_loop() {
    while (true) {
        std::unique_lock<std::mutex> lk(shm_publish_mtx_);
        shm_publish_cv_.wait(lk, [this] {
            return shm_publish_pending_ || !running_.load();
        });
        if (!running_.load())
            break;
        shm_publish_pending_ = false;
        lk.unlock();
        if (shm_publisher::is_active())
            shm_publisher::write_snapshot(this);
    }
}

void VarMonitor::write_shm_snapshot() {
    if (!running_.load())
        return;
    if (!shm_publisher::is_active())
        return;
    if (async_shm_publish_) {
        std::lock_guard<std::mutex> lk(shm_publish_mtx_);
        shm_publish_pending_ = true;
        shm_publish_cv_.notify_one();
        return;
    }
    shm_publisher::write_snapshot(this);
}

} // namespace varmon
