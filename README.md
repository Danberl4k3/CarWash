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

- `npm test`: Ejecuta la suite de pruebas unitarias y de integración (95 pruebas validadas).
- `npm run typecheck`: Validación estricta de tipos con el compilador TypeScript (`tsc --noEmit`).
- `npm run build`: Compila el código TypeScript a JavaScript en el directorio `dist/`.
- `npm run test:e2e`: Después de compilar, ejecuta 14 etapas en Edge/Chromium con una base en memoria. Para otro navegador Chromium, configura `BROWSER_PATH`.
- `npm run test:visual`: Smoke test visual para diseño móvil y panel administrativo (requiere Edge o Chromium).
- `npm run db:backup`: Genera una copia consistente de SQLite en `backups/` junto a la base de datos, también dentro del volumen de Railway.
- `npm run db:restore -- <ruta>`: Valida la integridad y las relaciones de un archivo `.db`, conserva una copia del destino y lo restaura mediante SQLite.

**Método de pago** y **Estado del pago** se eligen mediante tarjetas, como Elige el lavado. Las opciones **Pagado / No pagado** aparecen en **Separa tu turno**, sin necesidad de iniciar sesión, y también en Nueva reserva del administrador. Pagado registra el importe completo calculado por el servidor, incluidos adicionales; No pagado registra cero cobrado. Es un registro manual del estado indicado, sin verificación bancaria automática. La edición administrativa permite registrar abonos parciales.

---

## ☁️ Despliegue en Producción (Railway + Volume Persistente)

Para que todos los miembros del equipo y clientes, desde cualquier ubicación, utilicen la misma aplicación y compartan la misma información en tiempo real, la aplicación se despliega en **Railway** respaldada por un **Railway Volume** persistente.

### 1. Requisitos de Configuración en Railway

El archivo [`railway.toml`](./railway.toml) ya incluye la configuración de construcción y despliegue:
* **Builder**: Dockerfile con Node 22. Instala dependencias, compila y conserva las dependencias de producción en la imagen final.
* **Start Command**: `npm start`
* **Health Check Path**: `/salud`
* **Health Check Timeout**: `120` segundos

Conecta este repositorio y selecciona la rama `main`. El `Dockerfile` define `NODE_ENV=production`, `TZ=America/Lima` y `HOST=0.0.0.0`; el servidor utiliza el `PORT` asignado por Railway. `nixpacks.toml` queda como configuración antigua y no se utiliza con el builder Dockerfile. La configuración de despliegue se basa en la [referencia de Railway](https://docs.railway.com/config-as-code/reference).

### 2. Variables de Entorno en Railway

En el panel de Railway, ve a tu servicio > pestaña **Variables** y agrega las siguientes variables (nunca subas archivos `.env` a Git):

| Variable | Valor Recomendado | Propósito |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Activa optimizaciones, cache de estáticos y cookies seguras con HTTPS. |
| `TZ` | `America/Lima` | Fija explícitamente la zona horaria del negocio en el proceso de Node.js. |
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
3. Transfiere previamente una copia consistente de SQLite al volumen del servicio. Subir el código a GitHub no transfiere los datos locales.
4. Abre una sesión en el contenedor con `railway ssh` y ejecuta allí, usando la ruta real del backup:
   ```bash
   npm run db:restore -- /data/backups/archivo_backup.db
   ```

   `railway run` ejecuta comandos en tu equipo con variables de Railway; no restaura la base del contenedor. Consulta [Railway SSH](https://docs.railway.com/cli/ssh) y [Railway run](https://docs.railway.com/cli/run). Programa las restauraciones fuera del horario de atención para evitar nuevas escrituras mientras recuperas los datos.

#### Opción B: Arranque Limpio Automatizado
Si no cargas un backup previo, la aplicación detectará que `/data/carwash.db` no existe y creará automáticamente:
* Todas las tablas y relaciones.
* El catálogo completo de servicios y precios (lavado simple de moto a S/ 15; interior, exterior y completo; motor, cera, crema para cuero y lavado de asientos por S/ 100).
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
   Genera una copia consistente en la carpeta `backups` junto a la base; con `/data/carwash.db`, se guarda en `/data/backups`. Utiliza la API `.backup()` de `better-sqlite3` e incluye los datos pendientes del WAL. Conserva los 14 backups automáticos más recientes.

2. **Restaurar un backup**:
   ```bash
   npm run db:restore -- ruta/al/archivo_backup.db
   ```
   El script verifica la integridad y las relaciones, crea una copia `before_restore_...db` del destino existente y restaura mediante SQLite, compatible con WAL. Las copias previas a restaurar se conservan hasta que se eliminen manualmente.

Para consultas reales de placas y OCR, configura `JSON_PE_TOKEN` y `GEMINI_API_KEY` en las variables del servicio. En producción no se emplean respuestas simuladas; la reserva manual sigue disponible. Los secretos, bases de datos y copias se excluyen de Git y del contexto Docker.

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
