#pragma once

#include <string>
#include <utility>
#include <functional>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <shared_mutex>
#include <condition_variable>
#include <atomic>
#include <thread>
#include <chrono>
#include <variant>
#include <optional>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>

namespace varmon {

enum class VarType : int { Double = 0, Int32 = 1, Bool = 2, String = 3, Array = 4 };

using VarValue = std::variant<double, int32_t, bool, std::string, std::vector<double>>;
using Getter = std::function<VarValue()>;
using Setter = std::function<void(const VarValue&)>;
using ArrayGetter = std::function<std::vector<double>()>;
using ArrayElementSetter = std::function<bool(size_t index, double value)>;

struct VarEntry {
    std::string name;
    VarType type;
    Getter getter;
    Setter setter;
    ArrayElementSetter array_elem_setter;
    /** Solo `register_var(name, double*)`: lectura SHM sin invocar getter. */
    double* fast_double_ptr = nullptr;
};

class VarMonitor {
public:
    VarMonitor();
    ~VarMonitor();

    VarMonitor(const VarMonitor&) = delete;
    VarMonitor& operator=(const VarMonitor&) = delete;

    void register_var(const std::string& name, double* ptr);
    void register_var(const std::string& name, float* ptr);
    void register_var(const std::string& name, int32_t* ptr);
    void register_var(const std::string& name, int64_t* ptr);
    void register_var(const std::string& name, uint32_t* ptr);
    void register_var(const std::string& name, uint64_t* ptr);
    void register_var(const std::string& name, int16_t* ptr);
    void register_var(const std::string& name, uint16_t* ptr);
    void register_var(const std::string& name, int8_t* ptr);
    void register_var(const std::string& name, uint8_t* ptr);
    void register_var(const std::string& name, bool* ptr);
    void register_var(const std::string& name, std::string* ptr);

    // Registro de buffers de caracteres como una sola cadena.
    // El buffer debe mantenerse vivo mientras la variable este registrada.
    void register_char_array(const std::string& name, char* buf, size_t len);

    void register_var(const std::string& name, VarType type, Getter getter, Setter setter = nullptr);

    void register_array(const std::string& name, double* ptr, size_t count);
    void register_array(const std::string& name, std::vector<double>& vec, std::mutex& mtx);
    void register_array(const std::string& name, ArrayGetter getter);

    bool unregister_var(const std::string& name);
    void unregister_all();

    /**
     * Marca variable para publicación SHM incremental v2 (`shm_publish_dirty_mode`).
     * Con SHM v3 activo también hace `append_shm_event` (tiempo wall-clock Unix s).
     */
    void mark_dirty(const std::string& name);
    /** Como mark_dirty pero con instante explícito para v3 (p. ej. un `event_time_sec` por mensaje MAVLink). */
    void mark_dirty_at(const std::string& name, double event_time_sec);

    bool start(int sample_interval_ms = 100);
    void stop();
    bool is_running() const { return running_.load(); }
    int sample_interval_ms() const { return sample_interval_ms_.load(std::memory_order_relaxed); }
    /** Ajusta el periodo reportado en server_info y el sleep del hilo interno sample_loop (p. ej. alinear con cycle_interval_ms). */
    void set_sample_interval_ms(int ms);

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

    /** Lectura por lotes para SHM: un solo shared_lock; omite Array/String o nombre inexistente (ok=false). */
    struct ShmScalarExport {
        bool ok = false;
        VarType type = VarType::Double;
        double as_double = 0.0;
    };
    /** Export SHM: `sub_full` es la suscripción completa; `export_row_indices` son índices en `sub_full` (p. ej. need_export). */
    void get_shm_scalar_exports(const std::vector<std::string>& sub_full,
                                const std::vector<uint32_t>& export_row_indices,
                                std::vector<ShmScalarExport>& out,
                                const std::vector<uint8_t>* fetch_mask = nullptr);

    /** Invalida caché de resolución nombre→ranura (p. ej. al cambiar la lista suscrita en SHM). */
    void invalidate_shm_sub_cache();

    /** Actualiza snapshot de suscripción para caché de export SHM (llama el publisher antes de leer valores). */
    void shm_prepare_export_cache(const std::vector<std::string>& sub, uint64_t subscription_generation);

    /** Usado por el publisher SHM: si full_refresh, siempre true; si no, consume una marca dirty. */
    bool shm_should_fetch_for_publish(const std::string& name, bool full_refresh);

    void shm_clear_all_dirty();

    /** Quita marcas dirty solo para filas exportadas en este ciclo (troceo SHM + refresco completo). */
    void shm_clear_dirty_for_subscription_rows(const std::vector<std::string>& sub_full,
                                               const std::vector<uint32_t>& export_row_indices);

    /** Aplica escrituras desde SHM IMPORT en orden, con un solo shared_lock (misma semántica que set_var por ítem). */
    void apply_shm_import_values(const std::vector<std::pair<std::string, VarValue>>& items);

    void client_connected();
    void client_disconnected();
    int client_count() const { return client_count_.load(); }

    /** Escribe snapshot de variables escalares en SHM y señala al lector (sem_post). Llamar desde el lazo RT cada ciclo (ej. 10 ms). */
    void write_shm_snapshot();

    /**
     * SHM v3 (`shm_layout_version` >= 3): un append por variable al anillo (timestamp + valor, luego índice atómico).
     * `name` debe estar en la suscripción SHM. `event_time_sec`: mismo reloj que la cabecera SHM (p. ej. Unix desde epoch).
     */
    bool append_shm_event(const std::string& name, double event_time_sec, const VarValue& value);
    /** Lee el valor vía getter y publica un evento v3 (equivale a append_shm_event con el estado actual). */
    bool append_shm_event_from_current(const std::string& name, double event_time_sec);

private:
    void sample_loop();
    void uds_server_loop();
    void shm_publish_loop();
    void invalidate_sub_cache_rows_unlocked(const std::string& name);

    struct VarSlot {
        bool alive = false;
        VarEntry entry;
    };

    static constexpr uint32_t kInvalidVarSlot = UINT32_MAX;

    std::vector<VarSlot> var_slots_;
    std::unordered_map<std::string, uint32_t> name_to_id_;
    std::vector<uint32_t> free_slot_ids_;

    mutable std::mutex sub_cache_mtx_;
    uint64_t sub_cache_generation_{std::numeric_limits<uint64_t>::max()};
    std::vector<std::string> sub_cache_snapshot_;
    std::vector<uint32_t> sub_cache_ids_;
    std::unordered_map<std::string, std::vector<uint32_t>> sub_cache_name_rows_;

    mutable std::shared_mutex mutex_;
    std::atomic<bool> running_{false};
    std::atomic<int> client_count_{0};
    std::thread sample_thread_;
    std::thread rpc_thread_;
    std::thread shm_publish_thread_;
    std::atomic<int> sample_interval_ms_{100};

    bool async_shm_publish_ = false;
    std::mutex shm_publish_mtx_;
    std::condition_variable shm_publish_cv_;
    bool shm_publish_pending_ = false;

    mutable std::mutex dirty_mutex_;
    std::unordered_set<std::string> dirty_names_;
};

VarMonitor* get_global_instance();
void set_global_instance(VarMonitor* instance);

void set_config_path(const std::string& path);
bool load_config();

/** Valor entero sin signo leido de varmon.conf (key = valor). Si no existe o no es numero, devuelve default_val. */
unsigned get_config_uint(const std::string& key, unsigned default_val);

} // namespace varmon
