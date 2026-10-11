# Validación del sistema — 11 de octubre de 2026

Se validaron 95 pruebas unitarias e integraciones en 8 archivos y un recorrido de 14 etapas en Edge/Chromium. TypeScript y compilación correctos; auditoría npm sin vulnerabilidades detectadas. Las pruebas usan SQLite en memoria o archivos temporales, sin modificar la base real.

La selección Pagado / No pagado está disponible en Separa tu turno sin iniciar sesión. Se comprueban pagos con efectivo, Yape y Plin, importe calculado con adicionales, estado pendiente predeterminado, rechazo de valores inválidos y reflejo en comprobante y caja. El navegador comprueba una reserva pública pagada y la visibilidad del campo en móvil.

La revisión estática de Antigravity se contrastó con ejecución y pruebas de regresión. Se corrigieron abonos perdidos, minutos de edición, datos y precios históricos, temporizadores, filtros después de refrescar el panel, restauración con WAL, persistencia de servicios/capacidad, compatibilidad de pickups antiguos, privacidad de consultas, escape HTML/CSV, revocación de sesiones y errores HTTP.

El recorrido en navegador comprueba reservas, pagos, adicionales, tema oscuro, abonos, cambios de estado, filtros tras SSE, ticket, CSV, QR, privacidad, contenido HTML, móvil, desfase de reloj y cierre de sesión. La suite HTTP también comprueba clientes, servicios, capacidad, contraseña, migraciones y backup/restauración.

La CI de GitHub ejecuta tipos, compilación, pruebas e imagen Docker sobre Linux y Node 22. Railway usa el Dockerfile, el puerto proporcionado por la plataforma y `/salud`. SQLite requiere volumen persistente y una sola réplica; estas opciones se configuran en Railway según el README.

La validación local se realizó con Node 24.17.0 en Windows. Las consultas reales a json.pe/Gemini, cámara e impresión físicas y el estado de un despliegue Railway requieren comprobación en sus respectivos entornos; las pruebas locales no acreditan esos servicios externos.
