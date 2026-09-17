import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import {
  classifyVehicleType,
  consultarPlacaJsonPe,
  getVehicleTypeLabel,
  normalizePlateForApi,
} from '../src/services/json-pe.js';
import {
  detectAmbiguities,
  formatPeruvianPlate,
  processLocalPlateOcr,
  processPlateOcr,
} from '../src/services/plate-ocr.js';

describe('Servicio de OCR de Placas Peruanas (plate-ocr)', () => {
  it('formatea correctamente placas vehiculares peruanas a formato estándar con guion', () => {
    expect(formatPeruvianPlate('ABC123')).toBe('ABC-123');
    expect(formatPeruvianPlate('abc-123')).toBe('ABC-123');
    expect(formatPeruvianPlate('F3H792')).toBe('F3H-792');
    expect(formatPeruvianPlate('12345A')).toBe('1234-5A');
  });

  it('detecta ambigüedades comunes de caracteres en placas peruanas', () => {
    const ambiguities1 = detectAmbiguities('ABC-1O3');
    expect(ambiguities1.length).toBeGreaterThan(0);
    expect(ambiguities1[0]).toContain('Duda entre caracteres');

    const ambiguities2 = detectAmbiguities('1BC-123');
    expect(ambiguities2.length).toBeGreaterThan(0);
    expect(ambiguities2[0]).toContain('Primer carácter');

    const ambiguitiesClean = detectAmbiguities('ABC-123');
    expect(ambiguitiesClean.length).toBe(0);
  });

  it('cumple estrictamente el contrato JSON requerido para OCR', async () => {
    // 1. Placa válida
    const resultValid = await processPlateOcr('SIMULATE_DATA_ABC-123_IMAGE');
    expect(resultValid).toEqual({
      placa: 'ABC-123',
      confianza: 0.95,
      legible: true,
      notas: '',
    });

    // 2. Placa no detectada o vacía
    const resultEmpty = await processPlateOcr('SIMULATE_NO_PLATE_IMAGE');
    expect(resultEmpty).toEqual({
      placa: null,
      confianza: 0,
      legible: false,
      notas: 'No se detectó placa',
    });

    // 3. Placa borrosa o ilegible
    const resultBlurred = await processPlateOcr('SIMULATE_BLURRED_IMAGE');
    expect(resultBlurred.placa).toBeNull();
    expect(resultBlurred.legible).toBe(false);
    expect(resultBlurred.notas).toContain('ilegible');

    // 4. Carácter ambiguo
    const resultAmbiguous = await processPlateOcr('SIMULATE_AMBIGUOUS_IMAGE');
    expect(resultAmbiguous.placa).toBe('ABC-1O3');
    expect(resultAmbiguous.confianza).toBeLessThan(0.9);
    expect(resultAmbiguous.notas).toContain('ambiguo');
  });
});

describe('Servicio de Consulta SUNARP / json.pe y Clasificación (json-pe)', () => {
  it('normaliza la placa para la API de json.pe eliminando guiones y espacios', () => {
    expect(normalizePlateForApi('ABC-123')).toBe('ABC123');
    expect(normalizePlateForApi(' F3H - 792 ')).toBe('F3H792');
  });

  it('clasifica correctamente los tipos de vehículos de DASAV Car Wash', () => {
    // Autos (Sedanes / Hatchbacks)
    expect(classifyVehicleType('TOYOTA', 'YARIS')).toBe('car');
    expect(classifyVehicleType('HYUNDAI', 'ACCENT')).toBe('car');
    expect(classifyVehicleType('KIA', 'RIO')).toBe('car');

    // SUVs compactas / Crossovers
    expect(classifyVehicleType('KIA', 'SPORTAGE')).toBe('small_suv');
    expect(classifyVehicleType('HYUNDAI', 'TUCSON')).toBe('small_suv');
    expect(classifyVehicleType('TOYOTA', 'RAV4')).toBe('small_suv');
    expect(classifyVehicleType('RENAULT', 'DUSTER')).toBe('small_suv');

    // Camionetas Pickups y SUVs Grandes
    expect(classifyVehicleType('TOYOTA', 'HILUX 4X4')).toBe('large_suv');
    expect(classifyVehicleType('VOLKSWAGEN', 'AMAROK')).toBe('large_suv');
    expect(classifyVehicleType('FORD', 'RANGER')).toBe('large_suv');
    expect(classifyVehicleType('TOYOTA', 'PRADO')).toBe('large_suv');

    // Motocicletas
    expect(classifyVehicleType('HONDA', 'GL150')).toBe('motorcycle');
    expect(classifyVehicleType('BAJAJ', 'PULSAR NS200')).toBe('motorcycle');
    expect(classifyVehicleType('WANXIN', 'TRIMOVIL')).toBe('motorcycle');
    expect(classifyVehicleType(null, null, '1234-5A')).toBe('motorcycle');
  });

  it('obtiene etiquetas amigables por categoría', () => {
    expect(getVehicleTypeLabel('car')).toBe('Auto (Sedán / Hatchback)');
    expect(getVehicleTypeLabel('small_suv')).toBe('SUV Compacta');
    expect(getVehicleTypeLabel('large_suv')).toBe('SUV Grande / Camioneta Pickup');
    expect(getVehicleTypeLabel('motorcycle')).toBe('Moto');
  });

  it('consulta datos vehiculares simulados con retorno completo y tipificado', async () => {
    const resFiat = await consultarPlacaJsonPe('F3H-792');
    expect(resFiat.found).toBe(true);
    expect(resFiat.placa).toBe('F3H-792');
    expect(resFiat.marca).toBe('FIAT');
    expect(resFiat.modelo).toBe('FIORINO');
    expect(resFiat.fullModel).toContain('FIAT FIORINO');

    const resSuv = await consultarPlacaJsonPe('SUV-001');
    expect(resSuv.found).toBe(true);
    expect(resSuv.vehicleType).toBe('small_suv');

    const resPickup = await consultarPlacaJsonPe('PIK-999');
    expect(resPickup.found).toBe(true);
    expect(resPickup.vehicleType).toBe('large_suv');

    const resMoto = await consultarPlacaJsonPe('1234-5A');
    expect(resMoto.found).toBe(true);
    expect(resMoto.vehicleType).toBe('motorcycle');
  });
});

describe('Endpoints HTTP de OCR y Consulta Vehicular', () => {
  it('POST /api/placa/ocr procesa imagen y devuelve JSON exacto', async () => {
    const db = createDatabase(':memory:').db;
    const app = await buildApp({ db });

    // 1. Imagen con placa válida
    const resValid = await app.inject({
      method: 'POST',
      url: '/api/placa/ocr',
      payload: {
        image: 'data:image/jpeg;base64,SIMULATE_DATA_ABC-123_IMAGE',
        autoLookup: false,
      },
    });
    expect(resValid.statusCode).toBe(200);
    const bodyValid = JSON.parse(resValid.payload);
    expect(bodyValid).toEqual({
      placa: 'ABC-123',
      confianza: 0.95,
      legible: true,
      notas: '',
    });

    // 2. Imagen sin placa detectada
    const resNone = await app.inject({
      method: 'POST',
      url: '/api/placa/ocr',
      payload: {
        image: 'SIMULATE_NO_PLATE_SAMPLE',
        autoLookup: false,
      },
    });
    expect(resNone.statusCode).toBe(200);
    const bodyNone = JSON.parse(resNone.payload);
    expect(bodyNone).toEqual({
      placa: null,
      confianza: 0,
      legible: false,
      notas: 'No se detectó placa',
    });

    // 3. Con autoLookup: true adjunta información vehicular de SUNARP / mock
    const resAuto = await app.inject({
      method: 'POST',
      url: '/api/placa/ocr',
      payload: {
        image: 'SIMULATE_DATA_F3H-792_SAMPLE',
        autoLookup: true,
      },
    });
    expect(resAuto.statusCode).toBe(200);
    const bodyAuto = JSON.parse(resAuto.payload);
    expect(bodyAuto.placa).toBe('F3H-792');
    expect(bodyAuto.vehicle).toBeDefined();
    expect(bodyAuto.vehicle.found).toBe(true);
    expect(bodyAuto.vehicle.marca).toBe('FIAT');

    await app.close();
  });

  it('POST /api/placa/consultar y GET /api/vehiculo-lookup resuelven placas con éxito', async () => {
    const db = createDatabase(':memory:').db;
    const app = await buildApp({ db });

    // Consulta POST /api/placa/consultar
    const resPost = await app.inject({
      method: 'POST',
      url: '/api/placa/consultar',
      payload: { placa: 'SUV-001' },
    });
    expect(resPost.statusCode).toBe(200);
    const bodyPost = JSON.parse(resPost.payload);
    expect(bodyPost.found).toBe(true);
    expect(bodyPost.vehicleType).toBe('small_suv');
    expect(bodyPost.marca).toBe('KIA');

    // Consulta GET /api/vehiculo-lookup con fallback a SUNARP
    const resGet = await app.inject({
      method: 'GET',
      url: '/api/vehiculo-lookup?plate=PIK-999',
    });
    expect(resGet.statusCode).toBe(200);
    const bodyGet = JSON.parse(resGet.payload);
    expect(bodyGet.found).toBe(true);
    expect(bodyGet.vehicleType).toBe('large_suv');
    expect(bodyGet.marca).toBe('TOYOTA');

    await app.close();
  });
});
