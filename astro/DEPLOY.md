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

1. **Sube el código** (incluida la carpeta `astro/` y [`.github/workflows/deploy-astro.yml`](../.github/workflows/deploy-astro.yml)) a la rama por defecto (`main`).

2. **Pages → origen del despliegue**: en el repo, *Settings* → *Pages* → *Build and deployment* → *Source*: elige **GitHub Actions** (no “Deploy from a branch” con `gh-pages` a menos que quieras otro flujo).

3. **Primera ejecución**: haz *push* en `main` que toque `astro/` o lanza el workflow a mano (*Actions* → *Deploy Astro to GitHub Pages* → *Run workflow*). Al terminar, la URL aparece en el resumen del job de *deploy* y en *Settings* → *Pages*.

4. **Permisos**: el workflow ya pide `pages: write` e `id-token: write`. Si el job *deploy* falla por permisos, en *Settings* → *Actions* → *General* → *Workflow permissions*, suele bastar **Read and write permissions** para el `GITHUB_TOKEN` en workflows (o revisa la documentación actual de [deploy-pages](https://github.com/actions/deploy-pages)).

### Qué hace el workflow

- Node **22**, `npm ci` y `npm run build` dentro de **`astro/`**.
- Sube **`astro/dist`** como artefacto de Pages y publica con **`actions/deploy-pages`**.

Si tu rama principal no es `main`, edita `branches:` en el YAML. El `paths:` limita ejecuciones automáticas a cambios bajo `astro/`; para forzar un despliegue sin tocar Astro, usa *workflow_dispatch*.
