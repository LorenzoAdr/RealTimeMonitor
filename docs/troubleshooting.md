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

## Depuración

- **Backend**: los logs de `app.py` muestran conexiones UDS, errores de SHM/semáforo y mensajes de WebSocket.
- **Frontend**: en la consola del navegador (F12) se pueden inspeccionar mensajes WebSocket (pestaña Network, filtro WS) y errores de JavaScript.
- **C++**: asegúrese de que `write_shm_snapshot()` se llame con la periodicidad deseada en el lazo de control de la aplicación.
