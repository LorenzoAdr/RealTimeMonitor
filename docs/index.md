# VarMonitor

Sistema de monitorización de variables en tiempo real para aplicaciones C++20. La comunicación entre la aplicación C++ y el monitor web usa **Unix Domain Sockets (UDS)** y **memoria compartida (SHM)** con semáforos POSIX.

**Código fuente**: [VarMonitor en GitHub](https://github.com/LorenzoAdr/RealTimeMonitor).

## Qué encontrar en esta documentación

- **[Arquitectura](architecture.md)**: Componentes (C++, Python, frontend), flujo de datos, tasas visual e interna.
- **[Instalación y configuración](setup.md)**: Requisitos, instalación rápida, `varmon.conf`.
- **[Backend (Python)](backend.md)**: `app.py`, descubrimiento de instancias, WebSocket, UdsBridge, ShmReader, alarmas y grabación.
- **[Frontend](frontend.md)**: Estructura de `app.js`, columnas, gráficos Plotly, estado y persistencia.
- **[Protocolos](protocols.md)**: Formato UDS (longitud + JSON), comandos, layout SHM, mensajes WebSocket.
- **[Integración C++](cpp-integration.md)**: Cómo enlazar `libvarmonitor`, VarMonitor, `write_shm_snapshot`, macros.
- **[Resolución de problemas](troubleshooting.md)**: WSL/semáforos, "no conecta", gráficos vacíos, etc.

## Enlaces rápidos

- [VarMonitor en GitHub](https://github.com/LorenzoAdr/RealTimeMonitor) — código fuente, issues y contribuciones.
- El [README](../README.md) del repositorio contiene un resumen y la estructura del proyecto.
- Para generar y ver la documentación localmente: `mkdocs serve` (desde la raíz del repo) y abrir `http://localhost:8000`.
