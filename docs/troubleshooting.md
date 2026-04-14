# Resolución de problemas

## El semáforo no abre (WSL / ENOENT / EACCES)

En algunos entornos (p. ej. **WSL**) el backend Python puede no poder abrir el semáforo POSIX creado por el C++. El mensaje del backend incluirá el **errno** (ej. `ENOENT` o `EACCES`).

### ENOENT

El archivo del semáforo no existe para el proceso Python. En Linux el semáforo está en `/dev/shm/sem.<nombre_sin_barra>` (ej. `/dev/shm/sem.varmon-lariasr-10229`).

Compruebe:

- `ls /dev/shm/sem.*` — debe aparecer el semáforo mientras el proceso C++ esté en marcha.
- Que el backend Python se ejecute con el **mismo usuario** que el proceso C++ y, en WSL, preferiblemente desde el mismo tipo de sesión (misma terminal o mismo WSL distro).

### EACCES

Problemas de permisos. El C++ crea el semáforo con `0666`. Compruebe que no haya restricciones de namespace o montajes distintos de `/dev/shm`.

### Fallback

Si el semáforo no se puede abrir, el backend usa **modo polling**: lee el segmento SHM cada ~5 ms y detecta datos nuevos por el campo `seq` del header. La grabación sigue siendo a tasa real; solo se pierde la señalización bloqueante (ligero aumento de CPU en el hilo lector).

---

## La aplicación no conecta

- Compruebe que el proceso C++ esté en ejecución y que exista el socket `/tmp/varmon-<user>-<pid>.sock`.
- Compruebe que el backend Python esté levantado y escuchando en el puerto configurado (`web_port` en `varmon.conf`).
- Si usa contraseña (`auth_password` en `varmon.conf`), el frontend debe enviarla en la URL del WebSocket: `?password=...`.
- Revise la consola del navegador (F12) y los logs del backend para errores de WebSocket o de autenticación.

---

## Gráficos vacíos o que no aparecen tras F5

- El frontend guarda la configuración (variables monitorizadas, asignación a gráficos) en `localStorage`. Tras recargar la página (F5), se restaura el layout y se pinta un segundo frame a los 500 ms para que los datos que llegan por WebSocket se dibujen. Si aun así no aparecen curvas:
  - Compruebe que la instancia UDS esté seleccionada y conectada (indicador de estado en la cabecera).
  - Compruebe que las variables estén en la lista "Monitor" (columna central) y asignadas a un gráfico (columna derecha).
- Si el cajetín del gráfico ocupa todo el espacio pero está vacío, suele ser que el primer pintado se hizo sin datos; el segundo pintado (automático a los 500 ms) debería rellenar las curvas cuando ya haya datos en el historial.

---

## Algunas variables muestran "--" al monitorizar muchas

Si al añadir muchas variables a la vez (p. ej. miles) algunas muestran "--" pero al dejar solo una de esas variables sí toma valor, la causa suele ser el **límite del SHM**:

1. **C++**: solo escribe en el segmento hasta **shm_max_vars** variables (configurable en `varmon.conf`). Si la suscripción tiene más, solo las primeras reciben valor.
2. **Python**: el backend debe **leer** el mismo `shm_max_vars` de `varmon.conf`; si no está definido en la config que carga el backend, usará 2048 por defecto y **truncará** la lectura del SHM (solo verá las primeras 2048 entradas). En ese caso las variables que están más allá en el snapshot nunca llegan al frontend.

**Qué hacer:**

- Pon en `varmon.conf` un valor de **shm_max_vars** mayor o igual al máximo de variables que vayas a monitorizar a la vez (ej. 5120 para 5000 variables).
- Asegúrate de que la clave **shm_max_vars** esté siendo leída por el backend (debe aparecer en la config; si no, el backend la ignora y usa 2048).
- **Reinicia el proceso C++** (para que cree el segmento con el nuevo tamaño) y **reinicia el backend Python** (para que cargue el nuevo valor y lea todas las entradas del SHM).

Si la suscripción supera el límite, el proceso C++ imprime un aviso una vez en stderr indicando que solo se escriben las primeras shm_max_vars variables.

---

## Depuración

- **Visor de log integrado**: en la cabecera del monitor, use el botón **Log** para abrir un panel con el registro del backend Python (y opcionalmente del proceso C++ si configuró `log_file_cpp` en `varmon.conf`). No hace falta acceder al servidor ni a la terminal; todo se consulta desde el navegador. Véase [Instalación y configuración — Visor de log integrado](setup.md#visor-de-log-integrado).
- **Backend**: los logs de `app.py` (capturados en el visor de log) muestran conexiones UDS, errores de SHM/semáforo y mensajes de WebSocket.
- **Frontend**: en la consola del navegador (F12) se pueden inspeccionar mensajes WebSocket (pestaña Network, filtro WS) y errores de JavaScript.
- **C++**: asegúrese de que `write_shm_snapshot()` se llame con la periodicidad deseada en el lazo de control de la aplicación. Para ver la salida del proceso C++ en el visor de log, redirija stderr a un archivo y configure `log_file_cpp` en `varmon.conf`.
