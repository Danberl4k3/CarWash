import type { VehicleType } from '../constants.js';
import { formatPeruvianPlate } from './plate-ocr.js';

export interface JsonPeVehicleData {
  placa: string;
  marca?: string | null;
  modelo?: string | null;
  serie?: string | null;
  color?: string | null;
  motor?: string | null;
  vin?: string | null;
  anio?: number | null;
  carroceria?: string | null;
  propietario?: string | null;
}

export interface VehicleConsultationResult {
  found: boolean;
  source: 'sunarp' | 'local' | 'mock';
  placa: string;
  marca?: string;
  modelo?: string;
  color?: string;
  fullModel?: string;
  vehicleType: VehicleType;
  vehicleTypeLabel: string;
  details?: Partial<JsonPeVehicleData>;
}

const DEFAULT_API_URL = 'https://api.json.pe/api/placa';
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Normaliza la placa para la API de json.pe (alfanumérica sin guiones ni espacios).
 */
export function normalizePlateForApi(plate: string): string {
  return plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Clasifica inteligentemente el vehículo en las categorías de DASAV Car Wash:
 * - motorcycle
 * - car (Sedán / Hatchback)
 * - small_suv (SUV compacta / Crossover)
 * - large_suv (SUV grande / Camioneta Pickup)
 */
export function classifyVehicleType(
  marca?: string | null,
  modelo?: string | null,
  placa?: string | null,
  carroceria?: string | null,
): VehicleType {
  const brand = (marca || '').toUpperCase();
  const mod = (modelo || '').toUpperCase();
  const body = (carroceria || '').toUpperCase();
  const text = `${brand} ${mod} ${body}`.trim();
  const cleanPlate = placa ? normalizePlateForApi(placa) : '';

  // 1. Detección de motocicleta o trimóvil por placa o texto
  if (
    /^[0-9]{4}[A-Z0-9]{2}$/.test(cleanPlate) ||
    /^[A-Z0-9]{2}[0-9]{4}$/.test(cleanPlate) ||
    /MOTO|SCOOTER|TRIMOVIL|TORITO|PULSAR|BAJAJ|ITALIKA|WANXIN|ZONGSHEN|RONCO|GL150|YBR|BOXER|KTM\b|WAV\b|DISCOVER\b|MOTOCICLETA/.test(text)
  ) {
    return 'motorcycle';
  }

  // 2. Detección de Camionetas Pickup / SUV Grandes
  if (
    /HILUX|AMAROK|RANGER|FRONTIER|NAVARA|L200|LAND CRUISER|PRADO|FORTUNER|EXPLORER|TAHOE|SUBURBAN|EXPEDITION|PATHFINDER|PATROL|F-150|F150|RAM\b|SILVERADO|COLORADO|D-MAX|DMAX|BT-50|BT50|PILOT|TRAVERSE|HIGHLANDER|SANTA FE|SORENTO|PAJERO|MONTERO|PICKUP|PICK UP|WIDETRACK|TITAN|TUNDRA|TACOMA|GLADIATOR|DEFENDER/.test(text)
  ) {
    return 'large_suv';
  }

  // 3. Detección de SUV Compactas / Crossovers / Station Wagons
  if (
    /RAV4|SPORTAGE|TUCSON|CRETA|DUSTER|TRACKER|KICKS|CX-5|CX-3|CX-30|SELTOS|HR-V|WR-V|T-CROSS|NIVUS|TAOS|ECOSPORT|ESCAPE|COMPASS|RENEGADE|TIGGO|CS35|CS55|HAVAL|COOLRAY|COROLLA CROSS|YARIS CROSS|STATION WAGON|SUV|CROSSOVER|VITARA|JIMNY|SONET|VENUE|KONA|KROK|SUBARU XV|OUTBACK|FORESTER|ASX|ECLIPSE CROSS|Q3|Q5|X1|X3|GLA|GLB|GLC|XC40|XC60/.test(text)
  ) {
    return 'small_suv';
  }

  // 4. Predeterminado: Auto (Sedán / Hatchback / Coupé)
  return 'car';
}

export function getVehicleTypeLabel(type: VehicleType): string {
  switch (type) {
    case 'motorcycle':
      return 'Moto';
    case 'car':
      return 'Auto (Sedán / Hatchback)';
    case 'small_suv':
      return 'SUV Compacta';
    case 'large_suv':
      return 'SUV Grande / Camioneta Pickup';
    default:
      return 'Vehículo';
  }
}

/**
 * Consulta la placa en la API json.pe (o fallback simulado si no hay token).
 */
export async function consultarPlacaJsonPe(rawPlate: string): Promise<VehicleConsultationResult> {
  const formattedPlate = formatPeruvianPlate(rawPlate);
  const cleanPlate = normalizePlateForApi(rawPlate);

  if (cleanPlate.length < 5 || cleanPlate.length > 8) {
    return {
      found: false,
      source: 'sunarp',
      placa: formattedPlate,
      vehicleType: 'car',
      vehicleTypeLabel: getVehicleTypeLabel('car'),
    };
  }

  const token = process.env.JSON_PE_TOKEN?.trim();
  const apiUrl = process.env.JSON_PE_URL?.trim() || DEFAULT_API_URL;

  // Si hay token, consultar la API en vivo
  if (token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ placa: cleanPlate }),
        signal: controller.signal,
      });

      if (res.status === 404) {
        return {
          found: false,
          source: 'sunarp',
          placa: formattedPlate,
          vehicleType: classifyVehicleType(null, null, formattedPlate),
          vehicleTypeLabel: getVehicleTypeLabel(classifyVehicleType(null, null, formattedPlate)),
        };
      }

      if (res.ok) {
        const json = (await res.json()) as {
          success?: boolean;
          message?: string;
          data?: Record<string, unknown>;
        };

        if (json && json.success && json.data) {
          const data = json.data;
          const marca = typeof data.marca === 'string' ? data.marca.trim() : '';
          const modelo = typeof data.modelo === 'string' ? data.modelo.trim() : '';
          const color = typeof data.color === 'string' ? data.color.trim() : '';
          const carroceria = typeof data.carroceria === 'string' ? data.carroceria.trim() : '';
          const anio = typeof data.anio === 'number' ? data.anio : undefined;
          const vin = typeof data.vin === 'string' ? data.vin.trim() : undefined;
          const serie = typeof data.serie === 'string' ? data.serie.trim() : undefined;
          const motor = typeof data.motor === 'string' ? data.motor.trim() : undefined;

          const fullModel = [marca, modelo, color ? `(${color})` : ''].filter(Boolean).join(' ');
          const vehicleType = classifyVehicleType(marca, modelo, formattedPlate, carroceria);

          return {
            found: true,
            source: 'sunarp',
            placa: formattedPlate,
            marca: marca || undefined,
            modelo: modelo || undefined,
            color: color || undefined,
            fullModel: fullModel || undefined,
            vehicleType,
            vehicleTypeLabel: getVehicleTypeLabel(vehicleType),
            details: {
              placa: formattedPlate,
              marca,
              modelo,
              color,
              carroceria,
              anio,
              vin,
              serie,
              motor,
            },
          };
        }
      }
    } catch {
      // Si falla la llamada externa, continuar al mock o no encontrado
    } finally {
      clearTimeout(timer);
    }
  }

  // Fallback simulado para desarrollo, tests y demostración sin token
  return getMockVehicleConsultation(formattedPlate, cleanPlate);
}

/**
 * Base de datos simulada para pruebas offline y tests unitarios
 */
function getMockVehicleConsultation(formattedPlate: string, cleanPlate: string): VehicleConsultationResult {
  const mocks: Record<string, Partial<JsonPeVehicleData>> = {
    F3H792: { marca: 'FIAT', modelo: 'FIORINO', color: 'BLANCO BANCHISA', carroceria: 'FURGONETA' },
    ABC123: { marca: 'TOYOTA', modelo: 'YARIS', color: 'PLATA METÁLICO', carroceria: 'SEDAN' },
    SUV001: { marca: 'KIA', modelo: 'SPORTAGE', color: 'GRIS OSCURO', carroceria: 'STATION WAGON' },
    PIK999: { marca: 'TOYOTA', modelo: 'HILUX 4X4', color: 'BLANCO', carroceria: 'PICK UP' },
    '12345A': { marca: 'HONDA', modelo: 'GL150 CARGO', color: 'ROJO', carroceria: 'MOTOCICLETA' },
    MOT123: { marca: 'BAJAJ', modelo: 'PULSAR NS200', color: 'NEGRO', carroceria: 'MOTOCICLETA' },
  };

  const foundMock = mocks[cleanPlate];
  if (foundMock) {
    const fullModel = [foundMock.marca, foundMock.modelo, foundMock.color ? `(${foundMock.color})` : '']
      .filter(Boolean)
      .join(' ');
    const vehicleType = classifyVehicleType(
      foundMock.marca,
      foundMock.modelo,
      formattedPlate,
      foundMock.carroceria,
    );
    return {
      found: true,
      source: 'mock',
      placa: formattedPlate,
      marca: foundMock.marca || undefined,
      modelo: foundMock.modelo || undefined,
      color: foundMock.color || undefined,
      fullModel,
      vehicleType,
      vehicleTypeLabel: getVehicleTypeLabel(vehicleType),
      details: foundMock,
    };
  }

  // Si no está en los mocks, clasificar por formato de placa
  const vehicleType = classifyVehicleType(null, null, formattedPlate);
  return {
    found: false,
    source: 'mock',
    placa: formattedPlate,
    vehicleType,
    vehicleTypeLabel: getVehicleTypeLabel(vehicleType),
  };
}
