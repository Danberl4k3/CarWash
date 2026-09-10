# DASAV Car Wash

## Puesta en marcha

Requisitos: Node.js 20 o superior.

```bash
npm install
copy .env.example .env
npm run dev
```

La aplicación queda disponible en `http://127.0.0.1:3000`. Para producción:

```bash
npm run typecheck
npm run build
npm start
```

## Despliegue en Railway

Conecta el repositorio de GitHub y deja que Railway use `railway.toml`. En las variables del servicio configura `HOST=0.0.0.0`, `NODE_ENV=production`, `DATABASE_PATH=/data/carwash.db`, las credenciales administrativas, `COOKIE_SECRET` y `JSON_PE_TOKEN`. Agrega un volumen con punto de montaje `/data`, genera un dominio y usa `/salud` como health check. Mantén una sola réplica porque SQLite usa un único archivo de datos.

## Variables de entorno

- `JSON_PE_TOKEN`: token privado de JSON.pe. Solo se usa en el servidor.
- `JSON_PE_URL`: opcional; por defecto `https://api.json.pe/api/placa`.
- `COOKIE_SECRET`: secreto de sesiones y formularios administrativos.
- `DATABASE_PATH`: ruta de SQLite local.
- `ADMIN_USER` y `ADMIN_PASSWORD`: acceso inicial al panel.

## Consulta de vehículos

La función `consultarVehiculoPorPlaca(placa)` está en `src/services/jsonPe.ts`. El backend recibe la placa, la normaliza y consulta JSON.pe mediante POST. La interfaz nunca recibe el token.

Antes de llamar a JSON.pe, `GET /api/vehiculos/:placa` revisa si la placa ya tiene marca, modelo, color, año o propietario guardados en SQLite. Por eso una placa ya registrada evita consultas repetidas y permite trabajar con la información guardada aunque la API no esté disponible.

JSON.pe puede no entregar año o propietario según la consulta/plan. Cuando no existan, los campos quedan editables y pueden completarse manualmente. Referencia: <https://docs.json.pe/api-consulta/endpoint/placa>.

## Lectura de placa por foto

El botón **Tomar foto** usa la cámara del celular mediante `capture="environment"`. Tesseract.js procesa la imagen en el navegador; el usuario debe confirmar la placa detectada antes de consultar los datos. Si la lectura falla, el registro manual sigue disponible.

La carga de Tesseract.js usa jsDelivr y sus datos de idioma. En una red sin acceso a esos dominios, la consulta manual continúa funcionando.

## Horarios y recojo

- Atención: lunes a sábado, de 7:00 a. m. a 6:00 p. m.
- Los horarios administrativos se seleccionan en bloques de 10 minutos.
- El recojo debe ser como mínimo una hora después del ingreso y no superar las 6:00 p. m.
- La reserva pública calcula el ingreso automático usando la hora de Lima y redondea al siguiente bloque de 10 minutos.
- El teléfono se vuelve obligatorio desde las 2:00 p. m. o si el recojo es desde las 4:00 p. m.
- Moto selecciona automáticamente el lavado de moto por S/ 15 y deshabilita extras; esta regla también se valida en el servidor.

## Datos y alcance

La base actual es SQLite. Si `DATABASE_PATH` apunta a un archivo local, los datos son compartidos por todos los usuarios que accedan a **ese mismo servidor**, pero no se sincronizan entre dispositivos que ejecuten copias distintas de la aplicación. Para uso multi-dispositivo real se debe alojar la aplicación y su base en un servidor común o migrar a una base centralizada.

Los campos de vehículo guardados son: placa, marca, modelo, color, año y propietario. Se reutilizan al registrar nuevamente la misma placa.

## Verificación

```bash
npm run typecheck
npm test
npm run build
npm run test:visual
```

`npm run test:visual` comprueba las pantallas principales con Playwright. La prueba de cámara requiere un dispositivo/navegador con permiso de cámara; en escritorio puede utilizarse el selector de archivos.
