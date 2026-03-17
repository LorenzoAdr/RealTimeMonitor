#pragma once

#include <cstddef>
#include <cstdint>
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

/** Nombre del segmento (para server_info; ej. "varmon-juan-12345"). */
std::string get_shm_name();

/** Nombre del semáforo (para server_info; ej. "/varmon-juan-12345"). */
std::string get_sem_name();

/** Si el publicador está activo (init() fue exitoso). */
bool is_active();

/** Suscripción SHM: solo se escriben estas variables (vacío = todas las escalares). */
void set_subscription(const std::vector<std::string>& names);

} // namespace shm_publisher
} // namespace varmon
