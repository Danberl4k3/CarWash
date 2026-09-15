# DASAV Car Wash

Sistema de reservas y operación para DASAV Car Wash. Usa Fastify, EJS, SQLite y TypeScript.

## Inicio local

1. Copia `.env.example` como `.env` y cambia `ADMIN_PASSWORD` y `COOKIE_SECRET`.
2. Instala dependencias: `npm install`.
3. Ejecuta en desarrollo: `npm run dev`.
4. Abre `http://127.0.0.1:3000/`.

En el primer arranque se crean las tablas, servicios, turnos y el usuario administrador. Si ya existe la base de datos, cambiar `ADMIN_PASSWORD` no cambia la contraseña existente; usa `Administración > Seguridad`.

## Verificación

- `npm test`: pruebas de dominio y rutas.
- `npm run typecheck`: validación TypeScript.
- `npm run build`: genera `dist/`.
- `npm run test:visual`: smoke test de móvil y panel. Requiere Edge/Chromium y un servidor en `http://127.0.0.1:3100`.

## Producción

Usa una contraseña y secreto aleatorios, sirve la aplicación detrás de HTTPS y define `NODE_ENV=production`. Si hay un proxy inverso, define `TRUST_PROXY=true` únicamente cuando el proxy controle y reenvíe correctamente las cabeceras de cliente.

La base SQLite vive en `DATABASE_PATH`; incluye el archivo de base de datos y sus archivos WAL/SHM en la estrategia de copias de seguridad cuando la aplicación esté detenida o usa un backup SQLite consistente.
