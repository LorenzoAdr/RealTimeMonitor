Cliente web OSS (VarMonitor) — fuente en el repositorio
=======================================================

Los ficheros del monitor (núcleo OSS) deben vivir aquí y versionarse con git:

  index.html
  js/entry.mjs
  js/app-legacy.mjs
  css/              (y demás assets que use la UI)

`web_monitor/static/` suele estar en .gitignore como árbol de trabajo/servido;
`scripts/varmon/sync_oss_web_client.sh` copia **client_oss/** → **static/** (fusiona,
sin borrar plugins/ ni lo ya sincronizado desde js_modules/).

Se ejecuta al final de tool_plugins/scripts/copy_to_mit.sh, desde
scripts/varmon/generate_webmonitor_version.sh y puede lanzarse a mano desde la raíz:

  ./scripts/varmon/sync_oss_web_client.sh

Si faltan entry.mjs / app-legacy.mjs, el backend puede servir solo el esqueleto
desde static_seed/ y verás 404 en rutas del cliente completo.
