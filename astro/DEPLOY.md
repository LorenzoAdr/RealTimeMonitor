# Despliegue del sitio Astro

Guía para generar estáticos y publicarlos. El proyecto vive en `astro/` respecto a la raíz del repositorio VarMonitor.

## 1. Requisitos y salida

- **Node.js** ≥ 22.12 (recomendado gestionar con [fnm](https://github.com/Schniz/fnm) u otro version manager).
- **Build**: desde `astro/` ejecutar `npm run build`. La salida va a **`dist/`** (HTML/CSS/JS estáticos).
- **Vista previa local**: `npm run preview` sirve `dist/` para comprobar rutas y assets antes de subir.

## 2. Configuración de Astro (`astro.config.mjs`)

El archivo [`astro.config.mjs`](./astro.config.mjs) usa `defineConfig` de Astro y el plugin Vite de Tailwind v4 (`@tailwindcss/vite`). Para despliegue conviene conocer estas claves:

| Opción | Uso típico en despliegue |
|--------|---------------------------|
| **`site`** | URL absoluta del sitio (p. ej. `https://usuario.github.io`). Necesaria para URLs canónicas, sitemap y algunas integraciones. Si no tienes dominio fijo, puedes omitirla en entornos de prueba. |
| **`base`** | Ruta bajo la que se publica el sitio. Usa `/` si el sitio está en la raíz del dominio. Si el hosting sirve desde un subdirectorio (p. ej. GitHub Pages en `https://usuario.github.io/repo/`), debe ser `'/repo/'` (barra inicial y final). Los assets y enlaces internos respetan este prefijo. |
| **`output`** | Por defecto en este proyecto es **`static`** (solo HTML estático). Cambiar a `server` o `hybrid` exige un adaptador de servidor (Node, Vercel, Netlify, etc.). |
| **`vite`** | Aquí se registra Tailwind: `plugins: [tailwindcss()]`. Puedes añadir más plugins de Vite o `resolve.alias` si lo necesitas. |
| **`compressHTML`** | `true` en producción reduce el HTML generado (opcional). |
| **`build.format`** | `'directory'` genera `ruta/index.html` (comportamiento habitual en hosting estático). `'file'` genera `ruta.html`. |

### Ejemplo ampliado (referencia)

Puedes partir del fichero actual y añadir solo lo que necesites. Ejemplo con `site`/`base` para un subpath y HTML comprimido:

```js
// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const site = process.env.PUBLIC_ASTRO_SITE ?? ''; // p.ej. https://ejemplo.com
const base = process.env.PUBLIC_ASTRO_BASE ?? '/'; // p.ej. /mi-app/

export default defineConfig({
  site: site || undefined,
  base: base.endsWith('/') ? base : `${base}/`,
  output: 'static',
  compressHTML: true,
  vite: {
    plugins: [tailwindcss()],
  },
});
```

Variables como `PUBLIC_ASTRO_SITE` pueden definirse en `.env` en la raíz de `astro/` (prefijo `PUBLIC_` si deben exponerse al cliente; aquí solo se leen en build). Para un despliegue fijo, puedes sustituir por strings literales.

### Tailwind

Los estilos globales usan `@import "tailwindcss"` en `src/styles/global.css` e importación en las páginas o layouts. No hace falta `astro add` adicional en el servidor de destino: todo queda en el CSS generado en `dist/`.

### Comprobación tras cambiar `base` o `site`

1. `npm run build`
2. `npm run preview` y revisar que imágenes, favicon y rutas cargan bien.
3. Si el hosting no redirige `*/` a `*/index.html`, revisa la documentación del proveedor (p. ej. `_redirects` o equivalente).

## 3. Dónde subir `dist/`

Cualquier hosting estático (Nginx, Apache, S3 + CloudFront, GitHub Pages, Netlify, Vercel con salida estática, etc.) solo necesita el contenido de **`dist/`** en la raíz del bucket o del `DocumentRoot` (respetando el `base` configurado).

## 4. GitHub Pages (repositorio del proyecto)

Con la configuración actual (`site` + `base: '/RealTimeMonitor/'`), la URL pública será:

**`https://LorenzoAdr.github.io/RealTimeMonitor/`**

Eso solo coincide si el repositorio en GitHub se llama **`RealTimeMonitor`** y está bajo el usuario **`LorenzoAdr`**. Si el nombre del repo es otro, cambia **`base`** en [`astro.config.mjs`](./astro.config.mjs) a `'/<nombre-del-repo>/'` (con barras como está ahora) y vuelve a hacer `npm run build` / dejar que el CI regenere.

### Pasos en GitHub

1. **Sube el workflow al remoto** (imprescindible). El fichero [`.github/workflows/deploy-astro.yml`](../.github/workflows/deploy-astro.yml) tiene que existir en **GitHub** en la rama por defecto (`main`), no solo en tu PC. En local:
   ```bash
   git status   # debería listar .github/workflows/deploy-astro.yml si aún no está commiteado
   git add .github/workflows/deploy-astro.yml astro/
   git commit -m "CI: desplegar Astro a GitHub Pages"
   git push origin main
   ```
   Hasta que no haya al menos un workflow en el remoto, la pestaña **Actions** puede mostrar la pantalla de bienvenida y **no verás** ningún workflow en el menú lateral.

2. **Dónde aparece el workflow** (después del push): entra en tu repositorio → pestaña **Actions** (arriba, junto a *Code*, *Issues*, etc.). En la **barra lateral izquierda** debería listarse **“Deploy Astro to GitHub Pages”** (es el campo `name:` del YAML). Si ves “All workflows” pero la lista está vacía, el push no incluyó `.github/workflows/` o la rama no es `main`.

3. **Ejecutarlo a mano**: **Actions** → clic en **“Deploy Astro to GitHub Pages”** → botón **“Run workflow”** (derecha) → rama `main` → **Run workflow**. Eso usa `workflow_dispatch` y no depende de que hayas tocado `astro/` en el último commit.

4. **Pages → origen del despliegue**: *Settings* → *Pages* → *Build and deployment* → *Source*: **GitHub Actions** (no “Deploy from a branch” salvo que uses otro flujo).

5. Tras un despliegue correcto, la URL suele mostrarse en el job **deploy** y en *Settings* → *Pages*.

6. **Permisos**: el workflow ya pide `pages: write` e `id-token: write`. Si el job *deploy* falla por permisos, en *Settings* → *Actions* → *General* → *Workflow permissions*, suele bastar **Read and write permissions** para el `GITHUB_TOKEN` en workflows (o revisa la documentación actual de [deploy-pages](https://github.com/actions/deploy-pages)).

### Qué hace el workflow

- Node **22**, `npm ci` y `npm run build` dentro de **`astro/`**.
- Sube **`astro/dist`** con **`actions/upload-pages-artifact@v5`** y publica con **`actions/deploy-pages@v5`** (la acción de despliegue usa **Node 24** en el runner de GitHub; versiones antiguas de `deploy-pages@v4` mostraban avisos de deprecación de Node 20).

Si tu rama principal no es `main`, edita `branches:` en el YAML. El `paths:` limita ejecuciones automáticas a cambios bajo `astro/`; para forzar un despliegue sin tocar Astro, usa *workflow_dispatch*.

### Error: `deploy-pages` 404 / `Creating Pages deployment failed` / `Not Found`

Eso aparece cuando el repositorio **no tiene GitHub Pages configurado para despliegues vía Actions**. La API devuelve 404 hasta que exista un origen de Pages compatible.

**Qué hacer (en este orden):**

1. Abre **`https://github.com/LorenzoAdr/RealTimeMonitor/settings/pages`** (ajusta usuario/repo si hace falta).

2. En **Build and deployment** → **Source**, elige **GitHub Actions**, no *Deploy from a branch*. Si sigue puesto *gh-pages* o *main* / `/ (root)*, `actions/deploy-pages` **no** podrá crear el deployment y verás el 404.

3. Si no ves la opción **GitHub Actions**, a veces hace falta guardar una vez o refrescar; en repos nuevos, GitHub puede mostrar primero sugerencias de workflows: puedes usar el de “Static HTML” solo para activar el modo Actions y luego sustituirlo por el tuyo, o simplemente cambiar el desplegable a **GitHub Actions**.

4. Vuelve a lanzar el workflow (**Actions** → **Run workflow**).

5. Repos **privados**: GitHub Pages con Actions puede requerir plan de pago según la política actual de GitHub; si el repo es privado y Pages no está disponible, el mismo tipo de error puede mostrarse.

6. **Forks**: en algunos forks hay que habilitar **Actions** en *Settings* → *Actions* → *General* y permitir workflows.
