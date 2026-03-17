# Performance

La herramienta está orientada a **máxima performance**: minimizar latencia y uso de CPU y red entre el proceso C++ que publica variables y el navegador que las visualiza.

## Comunicación de bajo coste: SHM y UDS

- **C++ ↔ Python**: no hay TCP. La comunicación es local mediante:
  - **Memoria compartida (SHM)**: el proceso C++ escribe snapshots en un segmento en `/dev/shm/` y señaliza con un semáforo POSIX. Python mapea el mismo segmento y lee sin copias adicionales ni serialización por red.
  - **Unix Domain Sockets (UDS)**: comandos (listar variables, leer/escribir una variable, suscribir SHM) van por un socket local. Menor overhead que TCP y sin pasar por la pila de red.

Con esto se evita sobrecarga de red y de CPU en el camino crítico de datos en vivo.

## Medidas para evitar sobrecarga de red y de máquina

Además del uso de SHM y UDS, se aplican varias medidas para no saturar ni la red ni el navegador ni el backend.

### Variables monitorizadas únicamente

- Solo las variables que el usuario ha elegido **monitorizar** se envían por WebSocket al navegador.
- El C++ solo escribe en SHM las variables suscritas (`set_shm_subscription`): si la suscripción tiene nombres, escribe solo esas (iterando por nombre con `get_var`, no por todas las variables registradas); si está **vacía**, no escribe ninguna entrada (solo actualiza la cabecera con `count = 0` y hace `sem_post`), evitando volcar todas las variables en cada ciclo cuando nadie está monitorizando. La lista de variables disponibles se obtiene entonces por UDS (`list_names` / `list_vars`) bajo demanda.
- Las variables no monitorizadas se ignoran en el envío al cliente; no se transmite todo el conjunto de variables en cada actualización.
- El número máximo de variables que caben en el segmento SHM es **shm_max_vars** (configurable en `varmon.conf`; C++ y Python deben usar el mismo valor). Si monitorizas más que ese límite, solo las primeras reciben valor; el resto muestran "--". Véase [Resolución de problemas — Algunas variables muestran "--"](troubleshooting.md#algunas-variables-muestran-al-monitorizar-muchas).

Ver [Protocolos — Sistema de actualización de variables monitorizadas](protocols.md#sistema-de-actualización-de-variables-monitorizadas).

### Rel act (periodo de actualización al navegador)

- El backend no envía un mensaje `vars_update` en cada ciclo de SHM.
- Se respeta un intervalo mínimo entre envíos al WebSocket (configurable en la UI como **Rel act**). Así se limita la tasa de mensajes y de re-renderizado en el navegador sin perder utilidad para el usuario.

### Listas virtualizables en el navegador de variables

- El panel para **añadir variables** (browser) puede mostrar cientos o miles de nombres.
- La lista es **virtualizable**: solo se renderizan las filas visibles (y un pequeño overscan). Con muchas variables se evita crear miles de nodos DOM y se mantiene la UI fluida.

### Downsample en gráficas

- En las gráficas de series temporales no se dibujan todos los puntos del historial.
- Se aplica **downsample** (p. ej. límite configurable de puntos máximos por serie) para reducir el trabajo de renderizado del canvas y mantener tiempos de dibujo acotados incluso con buffers largos.

### Carga adaptativa (adaptive load)

- Si la pestaña del navegador no está visible (`document.hidden`), el frontend puede **omitir** o espaciar actualizaciones de gráficas y tablas.
- Así se reduce el uso de CPU y GPU cuando el usuario no está mirando el monitor.

### Gestión de grandes archivos (análisis offline)

- Al cargar grabaciones TSV muy grandes para análisis offline, se evita leer todo el fichero en memoria de una vez:
  - **Vista previa**: se lee solo una porción inicial para estimar tamaño y número de filas.
  - **Estimación de riesgo**: según tamaño y número de columnas/filas se decide si conviene usar **modo seguro**.
  - **Modo seguro**: en lugar de cargar el archivo completo, se trabaja por **segmentos** (rangos de bytes). El usuario puede navegar por el archivo (avanzar/retroceder) y solo se cargan los segmentos necesarios, manteniendo un tamaño de datos acotado en memoria.

### Buffer visual e historial

- El historial en el frontend (`historyCache`) tiene un **buffer visual** configurable: se retiene una ventana de tiempo limitada para las series. Los datos fuera de esa ventana pueden descartarse o no enviarse, evitando crecimiento ilimitado de memoria en el cliente.

---

En conjunto, estas medidas permiten usar VarMonitor con muchas variables y alta frecuencia de actualización sin sobrecargar la red ni la máquina.
