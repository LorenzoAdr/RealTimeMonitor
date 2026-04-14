# Miniplan: almacenamiento estable + caché de suscripción SHM

## Objetivo

Reducir `unordered_map<string, VarEntry>::find` en cada ciclo de publicación SHM cuando la lista de suscripción no cambia, manteniendo:

- `shared_mutex` sobre el almacenamiento de variables (lecturas concurrentes, registro exclusivo).
- Verificación por nombre en cada uso de id cacheado (huecos, reuse de ranura, `unregister`).

## Diseño

1. **Slots estables**  
   - `vector<VarSlot>` con `alive` + `VarEntry`.  
   - `unordered_map<string, uint32_t> name_to_id_`.  
   - `free_slot_ids_` para reutilizar índices tras `unregister`.

2. **Caché por fila de suscripción**  
   - `sub_cache_snapshot_`: última copia de la suscripción SHM.  
   - `sub_cache_ids_[i]`: id de ranura o `UINT32_MAX` si hay que resolver.  
   - `sub_cache_name_rows_`: nombre → índices de fila (para invalidar al registrar/desregistrar).

3. **`shm_prepare_export_cache(sub, subscription_generation)`** (solo `sub_cache_mtx_`): si el contador de generación de suscripción (UDS `set_shm_subscription`) cambió, rehace vectores y mapa de filas; pone ids en inválido (evita comparar O(n) strings cada ciclo).

4. **`get_shm_scalar_exports(sub, need_export, ...)`**: bajo **`sub_cache_mtx_` → `shared_lock(mutex_)`**, para cada fila exportada resuelve id (caché + comprobación `entry.name`) o `name_to_id_.find`, actualiza caché.

5. **Orden de bloqueos** (evita interbloqueo): siempre **`sub_cache_mtx_` antes que `mutex_`** en `register` / `unregister` / export SHM.

6. **`invalidate_shm_sub_cache()`**: vacía snapshot (p. ej. al cambiar suscripción desde `set_subscription`).

## Archivos

- [`libvarmonitor/include/var_monitor.hpp`](../libvarmonitor/include/var_monitor.hpp)
- [`libvarmonitor/src/var_monitor.cpp`](../libvarmonitor/src/var_monitor.cpp)
- [`libvarmonitor/src/shm_publisher.cpp`](../libvarmonitor/src/shm_publisher.cpp)

## No incluido

- Cambio de mapa a `flat_hash_map` (opcional aparte).
- Doble segmento SHM u otra semántica de lectores.
