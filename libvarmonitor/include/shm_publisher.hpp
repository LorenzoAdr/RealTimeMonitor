#pragma once

#include <cstddef>
#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

struct VarMonitor;

namespace varmon {

namespace shm_publisher {

/** Limpia segmentos zombie en /dev/shm para el usuario actual (varmon-<user>-<pid> con PID muerto). */
void cleanup_stale_shm_for_user();

/** Crea segmento SHM y semáforo POSIX. Nombre: varmon-<user>-<pid>. max_vars=0 usa valor por defecto (2048). */
bool init(size_t max_vars = 0);

/** Cierra y elimina segmento y semáforo. */
void shutdown();

/** Escribe snapshot de variables escalares en SHM y hace sem_post(). La aplicación RT debe llamar esto cada ciclo (ej. 10 ms). */
void write_snapshot(struct VarMonitor* mon);

/**
 * SHM v3 (shm_layout_version >= 3): append por evento en el anillo de la fila (timestamp + valor, luego índice con release).
 * Requiere que `name` esté en la suscripción SHM actual. type_byte: 0 double, 1 int32, 2 bool (mismo que v2).
 */
bool append_scalar_event(struct VarMonitor* mon, const std::string& name, double event_time_sec, double value_as_double,
                         uint8_t type_byte);

/** Versión de layout del segmento activo (2 o 3). */
uint32_t layout_version();

/** Nombre del segmento (para server_info; ej. "varmon-juan-12345"). */
std::string get_shm_name();

/** Nombre del semáforo (para server_info; ej. "/varmon-juan-12345"). */
std::string get_sem_name();

/** Semáforo solo para varmon_sidecar: mismo ritmo de post que el principal, sin competir con el lector Python. */
std::string get_sem_sidecar_name();

/** Si el publicador está activo (init() fue exitoso). */
bool is_active();

/** Suscripción SHM: solo se escriben estas variables (vacío = todas las escalares). */
void set_subscription(const std::vector<std::string>& names);

/** Se incrementa en cada set_subscription (para evitar comparar O(n) strings en cada write_snapshot). */
uint64_t subscription_generation();

/**
 * Troceo de publicación export (idle): count=N publica ~1/N filas por ciclo (índice % N == fase).
 * force_full: publicar todas las filas export cada ciclo (p. ej. REC / alarmas). count se acota a update_ratio_max.
 */
void set_shm_publish_slice(uint32_t count, bool force_full);

/** Estado actual del troceo (para server_info / depuración). */
uint32_t get_shm_publish_slice_count();
bool get_shm_publish_slice_force_full();

/** Activar medición de fases en write_snapshot (desactivado por defecto; coste ~0 si false). */
void set_perf_collect(bool enable);
bool perf_collect_enabled();
/** Añade a JSON server_info: ,"shm_perf_us":[...] (solo si perf_collect_enabled()). */
void append_perf_json(std::ostringstream& ss);

} // namespace shm_publisher
} // namespace varmon
