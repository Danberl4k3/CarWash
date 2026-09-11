# Cobros, cola de lavado y lectura de placas

## Panel administrativo

- **Marcar como pagado** registra el importe total de la reserva como cobrado. No procesa una transacción bancaria: úsalo después de recibir el dinero.
- La tarjeta muestra **✓ Pagado** y el resumen **Cobrado** suma los importes registrados. Repetir la petición no duplica el cobro.
- **Siguiente por lavar** muestra las reservas pendientes de hoy, ordenadas por minuto de recojo, luego por ingreso e identificador. Se muestran hasta cinco vehículos.
- La cola es una sugerencia basada en la reserva, no una confirmación de llegada. Comprueba que el vehículo esté presente antes de pulsar **Iniciar lavado**.
- Iniciar un lavado cambia su estado a **En proceso** y lo retira de la cola. No cambia su pago. Terminados, entregados y cancelados tampoco entran en la cola.
- Las acciones recargan el panel; las otras pestañas visibles se actualizan mediante la recarga existente cada 30 segundos.

## OCR de placas

1. Usa **Tomar foto** para elegir o capturar una imagen.
2. El lector intenta localizar texto en la imagen completa.
3. Si no lee bien, dibuja un rectángulo alrededor de la placa en la vista previa, o ajusta X, Y, Ancho y Alto. Pulsa **Leer recorte**.
4. Revisa el resultado editable y las alternativas. O/0 e I/1 pueden confundirse; las alternativas no son datos confirmados.
5. Pulsa **Usar placa detectada** para pasar la placa al formulario y consultar sus datos. No se guarda una reserva automáticamente.

La foto se procesa en el navegador; esta función no la envía a JSON.pe. El motor y el idioma se descargan desde un CDN, por lo que la primera lectura requiere conexión. La consulta posterior de datos del vehículo utiliza el servicio existente y puede consumir consultas de JSON.pe.

Se limitan las imágenes a 15 MB y 40 megapíxeles. El procesamiento utiliza lienzos reducidos; el recorte conserva la imagen original para evitar perder detalle. Hay cancelación y límites de espera. Una imagen borrosa, una placa tapada o caracteres indistinguibles no permiten garantizar una lectura correcta: siempre revisa el resultado o escribe la placa manualmente.

## Verificación y despliegue

- `npm run build` y `npm test`: compilación y pruebas de regresión, incluyendo cobro protegido por sesión/CSRF, cobro repetido y avance de la cola.
- Con una instancia local de prueba en el puerto 3199, ejecutar `node tests/ocr-browser.mjs`. También acepta `OCR_BASE_URL` y `BROWSER_PATH`.
- La prueba OCR usa imágenes sintéticas de BPP-530, BEO-391 y B0X-697. Comprueba lectura real en Edge, selección de alternativa O/0, recorte, cancelación y rechazo por tamaño. No constituye una prueba de precisión sobre las fotografías originales del usuario.
- No se modifica el esquema de base de datos ni se añaden claves de API. El servidor permite WebAssembly mediante la CSP y los recursos modificados llevan una versión en su URL para evitar usar una copia antigua del navegador.
