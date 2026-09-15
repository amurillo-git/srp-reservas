# Despliegue a producción (Hostinger)

Estado: preparado para subir manualmente. El conector de Hostinger de esta sesión falló al conectar (error local de arranque del proceso, no de tu cuenta), así que no pude automatizarlo vía API — esta guía es para hacerlo desde hPanel. Si más adelante el conector funciona, pedime que lo automatice y no hace falta que sigas esta guía.

**Importante — una sola base de datos por ahora**: el backend de producción y el de desarrollo van a apuntar a la MISMA base de datos de Supabase (la que ya está en uso). No hay ambientes separados todavía. Es razonable para esta etapa del MVP, pero tenelo presente: cualquier prueba que hagas en producción crea datos reales en la misma DB que usamos para desarrollar.

## Arquitectura de este despliegue

- **`reservas.sarapiquiracepark.com`** → sitio estático (el build ya está listo en `web/out/`, exportado con Next.js). No necesita un proceso Node corriendo.
- **`api.sarapiquiracepark.com`** (nombre sugerido, cambialo si preferís otro) → backend Express + Prisma, como app Node.js en Hostinger.
- La base de datos ya es Supabase (nube), no vive en Hostinger.

Si tu plan de Hostinger no incluye hosting de aplicaciones Node.js, avisame — habría que buscar otro host para el backend (Railway, Render, Fly.io son opciones simples) y dejar el frontend estático en Hostinger igual.

## 1. Backend (`api.sarapiquiracepark.com`)

### En hPanel

1. Creá un subdominio `api.sarapiquiracepark.com` (o el nombre que prefieras).
2. Buscá la sección de **Node.js** / **Website → Node.js App** y creá una aplicación nueva:
   - **Versión de Node**: 20 o superior.
   - **Raíz de la aplicación**: la raíz del repo (donde está `package.json`, `src/`, `prisma/`) — **no** la carpeta `web/`.
   - **Archivo de arranque**: `dist/server.js`.
   - **Comando de instalación/build** (si hay un campo separado): `npm install && npx prisma generate && npm run build`. Si solo hay un campo de "comando de inicio", usá `npm run build && npm run start` o configuralo para correr `npm install` primero y luego `npm start`.
   - **Comando de inicio**: `npm run start` (equivale a `node dist/server.js`).
3. Si Hostinger permite conectar el repositorio de GitHub (`amurillo-git/srp-reservas`, rama `main`) para desplegar automáticamente en cada push, es la opción más cómoda — usala si está disponible. Si no, subí el código por Git/FTP/gestor de archivos (sin `node_modules/`, sin `.env`).

### Variables de entorno (configuralas en la sección de "Environment variables" de la app Node.js)

Copiá los valores REALES desde tu archivo `.env` local (no los pego acá para no duplicar secretos en un documento):

| Variable | Valor |
|---|---|
| `DATABASE_URL` | el mismo valor que tenés en `.env` local |
| `DIRECT_URL` | el mismo valor que tenés en `.env` local |
| `JWT_SECRET` | el mismo valor que tenés en `.env` local |
| `ADMIN_EMAIL` | el mismo valor que tenés en `.env` local |
| `ADMIN_PASSWORD` | el mismo valor que tenés en `.env` local |
| `NODE_ENV` | `production` |
| `TZ` | `America/Costa_Rica` |
| `EXPIRACION_INTERVALO_MS` | `60000` (opcional, es el default) |
| `WEB_APP_URL` | `https://reservas.sarapiquiracepark.com` (sin barra al final) |
| `PORT` | normalmente Hostinger lo asigna solo; si pide que lo definas vos, cualquier puerto libre (ej. `3000`) — el código ya lee `process.env.PORT`. |

`ADMIN_EMAIL`/`ADMIN_PASSWORD` solo tienen efecto la primera vez que arranca el servidor sin ningún usuario en la base de datos — como ya existe un admin (lo creamos antes en esta misma sesión), no hace nada nuevo, pero no hace daño dejarlas configuradas.

### Verificar que arrancó

Una vez desplegado, abrí `https://api.sarapiquiracepark.com/api/health` — debería responder `{"status":"ok"}`.

## 2. Frontend estático (`reservas.sarapiquiracepark.com`)

El build ya está listo en dos formas:
- Carpeta: `web/out/`
- Zip listo para subir: `web/reservas-static-build.zip`

**Ya tiene "horneada" la URL real del backend** (`https://api.sarapiquiracepark.com/api`) y el número SINPE real. Si cambiás el subdominio del backend, avisame para reconstruirlo con la URL correcta.

### En hPanel

1. Creá el subdominio `reservas.sarapiquiracepark.com` como sitio normal (hosting estático, no Node.js).
2. Andá al **Administrador de archivos** de ese subdominio, entrá a su carpeta raíz (normalmente `public_html` del subdominio) y subí `reservas-static-build.zip`.
3. Extraé el zip ahí mismo (opción "Extraer" del gestor de archivos) para que `index.html` quede directamente en la raíz del subdominio.
4. Verificá que el subdominio sirva `index.html` como página de inicio (suele ser automático).
5. La ruta `/mi-reserva` necesita que el servidor sirva `mi-reserva.html` cuando alguien pide `/mi-reserva` sin extensión. Apache (lo más común en Hostinger) normalmente resuelve esto solo; si al probar da 404, decime y ajustamos con un `.htaccess` con reglas de reescritura.

### SSL

Activá el certificado SSL gratuito (Let's Encrypt) para ambos subdominios desde hPanel — Hostinger normalmente lo ofrece con un clic una vez creado el subdominio. Sin esto el navegador va a bloquear las llamadas del frontend (HTTPS) al backend si quedara en HTTP.

## 3. DNS

Si `sarapiquiracepark.com` ya está gestionado desde el mismo hosting de Hostinger, crear los subdominios en el paso 1 y 2 debería configurar el DNS automáticamente. Si el dominio está registrado o su DNS se administra en otro lugar, vas a necesitar crear ahí:
- Un registro para `reservas` apuntando al hosting estático (A/CNAME según lo que indique hPanel).
- Un registro para `api` apuntando a la app Node.js (A/CNAME según lo que indique hPanel).

## 4. Checklist de verificación

- [ ] `https://api.sarapiquiracepark.com/api/health` responde `{"status":"ok"}`.
- [ ] `https://reservas.sarapiquiracepark.com` carga el flujo de reserva.
- [ ] Completar una reserva de prueba de punta a punta (fecha → hora → datos → confirmar → reportar SINPE).
- [ ] Login de admin funciona contra `https://api.sarapiquiracepark.com/api/admin/login` (necesitarías el panel admin para probarlo visualmente — todavía no existe; podés probarlo con `curl`).
- [ ] Borrar la reserva de prueba de la base de datos real si no la vas a usar (mismo patrón que usamos durante el desarrollo).

## 5. Cuando el conector de Hostinger funcione

Reiniciá la app de Claude Code (o reconectá el conector de Hostinger desde su configuración) y pedime que retome el despliegue — en ese caso puedo automatizar la creación de subdominios, la app Node.js, las variables de entorno y la subida del sitio estático directamente por la API, sin pasar por hPanel a mano.
