const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_URL = 'https://api.json.pe/api/placa';
const PLACA_REGEX = /^[A-Z0-9]{6,8}$/;

export interface VehicleLookupData {
  marca: string | null;
  modelo: string | null;
  color: string | null;
  anio: number | null;
  propietario: string | null;
}

export class JsonPeNotFoundError extends Error {
  constructor(message = 'No se encontró información del vehículo') {
    super(message);
    this.name = 'JsonPeNotFoundError';
  }
}

export class JsonPeApiError extends Error {
  constructor(message = 'No se pudo consultar la información', public readonly statusCode?: number) {
    super(message);
    this.name = 'JsonPeApiError';
  }
}

export class JsonPeConfigError extends Error {
  constructor(message = 'JSON_PE_TOKEN no está configurado') {
    super(message);
    this.name = 'JsonPeConfigError';
  }
}

function normalizePlaca(placa: string): string {
  return placa.replace(/[\s-]/g, '').toUpperCase();
}

export async function consultarVehiculoPorPlaca(placa: string): Promise<VehicleLookupData> {
  const token = process.env.JSON_PE_TOKEN?.trim();
  if (!token) throw new JsonPeConfigError();

  const normalizedPlaca = normalizePlaca(placa);
  if (!PLACA_REGEX.test(normalizedPlaca)) throw new JsonPeNotFoundError('Formato de placa inválido');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(process.env.JSON_PE_URL?.trim() || DEFAULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ placa: normalizedPlaca }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new JsonPeApiError('Tiempo de espera agotado al consultar API');
      throw new JsonPeApiError('Error de red al consultar API');
    }

    if (response.status === 404) throw new JsonPeNotFoundError();
    if (!response.ok) throw new JsonPeApiError(`Error HTTP ${response.status} al consultar API`, response.status);

    let payload: unknown;
    try { payload = await response.json(); } catch { throw new JsonPeApiError('Respuesta no válida de la API'); }
    if (!payload || typeof payload !== 'object') throw new JsonPeNotFoundError();

    const envelope = payload as { success?: unknown; data?: unknown };
    if (envelope.success === false || !envelope.data || typeof envelope.data !== 'object') throw new JsonPeNotFoundError();
    const data = envelope.data as Record<string, unknown>;
    const marca = typeof data.marca === 'string' && data.marca.trim() ? data.marca.trim() : null;
    const modelo = typeof data.modelo === 'string' && data.modelo.trim() ? data.modelo.trim() : null;
    const color = typeof data.color === 'string' && data.color.trim() ? data.color.trim() : null;
    const ownerValue = data.propietario ?? data.nombre_propietario ?? data.propietario_nombre ?? data['dueño'] ?? data.dueno;
    const propietario = typeof ownerValue === 'string' && ownerValue.trim() ? ownerValue.trim() : null;
    const rawAnio = data.anio ?? data['año'] ?? data.year;
    const parsedAnio = typeof rawAnio === 'number' ? rawAnio : Number(rawAnio);
    const anio = Number.isInteger(parsedAnio) && parsedAnio >= 1900 && parsedAnio <= 2100 ? parsedAnio : null;
    if (!marca && !modelo && !color && anio === null) throw new JsonPeNotFoundError();
    return { marca, modelo, color, anio, propietario };
  } finally {
    clearTimeout(timeoutId);
  }
}
