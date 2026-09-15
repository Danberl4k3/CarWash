# DASAV Car Wash - Sistema Web de Reservas y Operación

Sistema web integral de reservas y control de pista para **DASAV Car Wash**, desarrollado con Fastify, TypeScript, EJS y SQLite (`better-sqlite3`).

---

## 🚀 Inicio Rápido Local

1. Clona el repositorio e instala las dependencias:
   ```bash
   npm install
   ```
2. Configura tu archivo de variables de entorno:
   ```bash
   cp .env.example .env
   ```
   *(Modifica `ADMIN_PASSWORD` y `COOKIE_SECRET` con claves seguras).*
3. Inicia en modo de desarrollo con recarga en caliente:
   ```bash
   npm run dev
   ```
4. Abre [http://127.0.0.1:3000](http://127.0.0.1:3000) en tu navegador. El panel administrativo se encuentra en `/admin`.

---

## 🧪 Pruebas y Validación

- `npm test`: Ejecuta toda la suite de pruebas unitarias y de integración (14 pruebas pasando).
- `npm run typecheck`: Validación estricta de tipos con el compilador TypeScript (`tsc --noEmit`).
- `npm run build`: Compila el código TypeScript a JavaScript en el directorio `dist/`.
- `npm run test:visual`: Smoke test visual para diseño móvil y panel administrativo (requiere Edge o Chromium).
- `npm run db:backup`: Genera una copia de seguridad atómica y consistente de la base SQLite en `data/backups/`.
- `npm run db:restore <ruta>`: Valida la integridad de un archivo `.db` y lo restaura en la ruta de `DATABASE_PATH`.

---

## ☁️ Despliegue en Producción (Railway + Volume Persistente)

Para que todos los miembros del equipo y clientes, desde cualquier ubicación, utilicen la misma aplicación y compartan la misma información en tiempo real, la aplicación se despliega en **Railway** respaldada por un **Railway Volume** persistente.

### 1. Requisitos de Configuración en Railway

El archivo [`railway.toml`](./railway.toml) ya incluye la configuración de construcción y despliegue:
* **Build Command**: `npm ci && npm run build`
* **Start Command**: `npm start`
* **Health Check Path**: `/salud`
* **Health Check Timeout**: `120` segundos

### 2. Variables de Entorno en Railway

En el panel de Railway, ve a tu servicio > pestaña **Variables** y agrega las siguientes variables (nunca subas archivos `.env` a Git):

| Variable | Valor Recomendado | Propósito |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Activa optimizaciones, cache de estáticos y cookies seguras con HTTPS. |
| `HOST` | `0.0.0.0` | Permite al contenedor escuchar peticiones del proxy de Railway. |
| `DATABASE_PATH` | `/data/carwash.db` | Apunta al archivo SQLite dentro del volumen montado. |
| `ADMIN_USERNAME` | `admin` | Usuario administrador inicial. |
| `ADMIN_PASSWORD` | *(contraseña segura de 16+ caracteres)* | Contraseña del administrador si la BD se inicializa vacía. |
| `COOKIE_SECRET` | *(cadena aleatoria de 64 caracteres)* | Secreto para firma criptográfica de cookies de sesión. |
| `TRUST_PROXY` | `false` | Mantener en `false` por defecto salvo configuración específica. |

> [!NOTE]
> La variable `PORT` es inyectada automáticamente por Railway; el servidor la toma dinámicamente mediante `process.env.PORT`.

---

### 3. Configurar el Railway Volume (Persistencia)

Por defecto, los contenedores en Railway tienen un sistema de archivos efímero: cada nuevo despliegue o reinicio recrea el contenedor desde cero. **Para que la base de datos no se pierda, es indispensable crear un Volume**:

1. En el dashboard de tu proyecto en Railway, haz clic en **+ New** > **Volume**.
2. Nómbralo `data`.
3. Conecta el volumen a tu servicio del Car Wash.
4. En la configuración del volumen, establece el **Mount Path** exactamente en:
   ```text
   /data
   ```
5. Guarda los cambios. A partir de ese momento, cualquier cambio en `/data/carwash.db` se mantendrá intacto entre despliegues.

> [!WARNING]
> **Regla de Instancia Única**: SQLite es un motor de base de datos basado en archivo local (`WAL mode`). No admite múltiples instancias escribiendo simultáneamente sobre el mismo archivo. En Railway, en **Settings > Deploy > Replicas**, asegúrate de que esté configurado exactamente en **1 réplica** (instancia única).

---

### 4. Carga Inicial de la Base de Datos Existente

Si deseas transferir tu base de datos local actual con todos sus turnos, servicios y registros a Railway:

#### Opción A: Mediante Railway CLI
1. Instala e inicia sesión en la CLI:
   ```bash
   npx @railway/cli login
   ```
2. Vincula tu proyecto local al proyecto de Railway:
   ```bash
   npx @railway/cli link
   ```
3. Ejecuta la restauración de tu copia de seguridad local hacia el contenedor en Railway:
   ```bash
   npx @railway/cli run npm run db:restore data/carwash_backup_20260915.db
   ```

#### Opción B: Arranque Limpio Automatizado
Si no cargas un backup previo, la aplicación detectará que `/data/carwash.db` no existe y creará automáticamente:
* Todas las tablas y relaciones.
* El catálogo completo de servicios y precios (Lavado simple de moto a S/ 15, interior, exterior, completo, motor, cera, crema para cuero).
* Capacidad horaria por defecto (6 vehículos por turno).
* El usuario administrador con las credenciales de `ADMIN_USERNAME` y `ADMIN_PASSWORD`.

> [!IMPORTANT]
> **Contraseña de Administrador**: Si la base de datos ya contiene registros, cambiar la variable `ADMIN_PASSWORD` en Railway **no** sobrescribirá la contraseña del administrador existente. Para cambiarla en cualquier momento, ingresa al panel administrativo con tu cuenta y dirígete a **Administración > Seguridad**.

---

### 5. Copias de Seguridad (Backups)

1. **Generar un backup en cualquier momento**:
   ```bash
   npm run db:backup
   ```
   Genera una copia consistente en `data/backups/carwash_backup_YYYY-MM-DD...db`. El script ejecuta un checkpoint del WAL y utiliza la API atómica `.backup()` de `better-sqlite3`, permitiendo realizar copias en caliente sin detener el servidor ni causar bloqueos.

2. **Restaurar un backup**:
   ```bash
   npm run db:restore ruta/al/archivo_backup.db
   ```
   El script verifica la integridad de SQLite antes de reemplazar la base destino.

---

### 6. Hoja de Ruta para Escalabilidad (Futura Migración a PostgreSQL)

Actualmente, SQLite sobre un Railway Volume con 1 réplica ofrece un rendimiento excelente (tiempos de respuesta inferiores a 10 ms y cero latencia de red en consultas SQL).

Si en el futuro el negocio requiere:
- Múltiples instancias en paralelo con balanceador de carga (*Horizontal Autoscaling*).
- Múltiples sucursales operando con concurrencia extrema de cientos de solicitudes por segundo.

Se recomienda la siguiente ruta de migración:
1. Provisionar un servicio de **PostgreSQL** dentro de Railway con un solo clic.
2. Adaptar la capa de acceso a datos en `src/db.ts` utilizando `pg` o un query builder / ORM compatible con TypeScript (ej. Kysely o Drizzle).
3. Exportar las tablas existentes (`admins`, `services`, `service_prices`, `capacity_slots`, `customers`, `vehicles`, `bookings`) hacia PostgreSQL mediante un script de migración ETL.
