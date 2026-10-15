import type Database from 'better-sqlite3';
import {
  BUSINESS,
  PAYMENT_LABELS,
  STATUS_LABELS,
  VEHICLE_LABELS,
  type PaymentMethod,
  type VehicleType,
} from '../constants.js';
import { getLimaNow } from '../time.js';

export type StatisticsPeriod = '7d' | '30d' | 'month' | 'all';

export interface DayTrend {
  date: string;
  label: string;
  dayName: string;
  vehiclesCount: number;
  revenueCents: number;
  expectedCents: number;
}

export interface HourlyStat {
  hour: number;
  label: string;
  count: number;
  percentage: number;
  isPeak: boolean;
  capacityMax: number;
}

export interface DayOfWeekStat {
  dayIndex: number; // 0=Dom, 1=Lun ... 6=Sab
  dayName: string;
  shortName: string;
  totalVehicles: number;
  averageVehicles: number;
  totalRevenueCents: number;
  percentage: number;
}

export interface VehicleTypeStat {
  type: VehicleType;
  label: string;
  icon: string;
  count: number;
  percentage: number;
  revenueCents: number;
}

export interface PaymentBreakdownStat {
  method: PaymentMethod | 'pending';
  label: string;
  count: number;
  cents: number;
  percentage: number;
}

export interface TopServiceStat {
  name: string;
  category: 'base' | 'addon';
  count: number;
  percentage: number;
  revenueCents: number;
}

export interface ForecastDay {
  date: string;
  dayName: string;
  shortLabel: string;
  expectedVehicles: number;
  expectedRevenueCents: number;
  demandLevel: 'Baja' | 'Media' | 'Alta';
  demandColor: string;
  recommendedStaff: string;
}

export interface ForecastSummary {
  next7Days: ForecastDay[];
  totalExpectedVehiclesWeek: number;
  totalExpectedRevenueWeekCents: number;
  peakHoursWarning: Array<{ hour: number; label: string; historicalAverage: number }>;
  projectedMonthEnd: {
    monthName: string;
    daysInMonth: number;
    daysPassed: number;
    daysRemaining: number;
    revenueSoFarCents: number;
    vehiclesSoFar: number;
    projectedTotalRevenueCents: number;
    projectedTotalVehicles: number;
  };
  supplyEstimates: {
    waxCount: number;
    leatherCount: number;
    engineCount: number;
  };
}

export interface StatisticsData {
  period: StatisticsPeriod;
  periodLabel: string;
  startDate: string;
  endDate: string;
  totalDays: number;

  // KPIs Generales
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  totalRevenueCents: number;
  expectedRevenueCents: number;
  pendingRevenueCents: number;
  averageTicketCents: number;
  averageDailyVehicles: number;
  averageDailyRevenueCents: number;
  collectionRatePercent: number;
  averageWashTimeMinutes: number;

  // Gráficos y Desgloses
  dailyTrend: DayTrend[];
  hourlyDistribution: HourlyStat[];
  dayOfWeekDistribution: DayOfWeekStat[];
  vehicleTypes: VehicleTypeStat[];
  paymentMethods: PaymentBreakdownStat[];
  topServices: TopServiceStat[];

  // Pronóstico
  forecast: ForecastSummary;
}

const VEHICLE_ICONS: Record<VehicleType, string> = {
  motorcycle: 'motorcycle',
  car: 'car-front',
  small_suv: 'car-front',
  large_suv: 'car-front',
};

const DAY_NAMES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

const DAY_SHORT_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function offsetDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDaysDifference(startStr: string, endStr: string): number {
  const [y1, m1, d1] = startStr.split('-').map(Number);
  const [y2, m2, d2] = endStr.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.round((t2 - t1) / (1000 * 60 * 60 * 24)) + 1);
}

export function getStatisticsData(
  db: Database.Database,
  options?: { period?: string; startDate?: string; endDate?: string },
): StatisticsData {
  const now = getLimaNow();
  const today = now.date;

  let period: StatisticsPeriod = '7d';
  if (options?.period === '30d' || options?.period === 'month' || options?.period === 'all') {
    period = options.period;
  }

  let startDate: string;
  let endDate: string = today;

  if (period === '7d') {
    startDate = offsetDate(today, -6);
  } else if (period === '30d') {
    startDate = offsetDate(today, -29);
  } else if (period === 'month') {
    startDate = `${today.slice(0, 7)}-01`;
  } else {
    // 'all'
    const earliestRow = db
      .prepare("SELECT MIN(booking_date) AS min_date FROM bookings WHERE status != 'cancelled'")
      .get() as { min_date: string | null } | undefined;
    startDate = earliestRow?.min_date ? earliestRow.min_date : offsetDate(today, -29);
  }

  // Override if custom dates provided
  if (options?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(options.startDate)) {
    startDate = options.startDate;
  }
  if (options?.endDate && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate)) {
    endDate = options.endDate;
  }
  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  const totalDays = getDaysDifference(startDate, endDate);

  const periodLabels: Record<StatisticsPeriod, string> = {
    '7d': 'Últimos 7 días',
    '30d': 'Últimos 30 días',
    month: 'Este mes',
    all: 'Histórico completo',
  };

  // 1. Métricas Generales (KPIs)
  const kpiRow = db
    .prepare(`
      SELECT 
        COUNT(*) AS total_bookings,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_bookings,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_bookings,
        SUM(CASE WHEN status != 'cancelled' THEN amount_paid_cents ELSE 0 END) AS total_revenue_cents,
        SUM(CASE WHEN status != 'cancelled' THEN total_cents ELSE 0 END) AS expected_revenue_cents
      FROM bookings
      WHERE booking_date BETWEEN ? AND ?
    `)
    .get(startDate, endDate) as {
      total_bookings: number;
      completed_bookings: number;
      cancelled_bookings: number;
      total_revenue_cents: number | null;
      expected_revenue_cents: number | null;
    };

  const totalBookings = kpiRow.total_bookings - (kpiRow.cancelled_bookings || 0);
  const completedBookings = kpiRow.completed_bookings || 0;
  const cancelledBookings = kpiRow.cancelled_bookings || 0;
  const totalRevenueCents = kpiRow.total_revenue_cents || 0;
  const expectedRevenueCents = kpiRow.expected_revenue_cents || 0;
  const pendingRevenueCents = Math.max(0, expectedRevenueCents - totalRevenueCents);
  const averageTicketCents = totalBookings > 0 ? Math.round(totalRevenueCents / totalBookings) : 0;
  const averageDailyVehicles = totalDays > 0 ? Number((totalBookings / totalDays).toFixed(1)) : 0;
  const averageDailyRevenueCents = totalDays > 0 ? Math.round(totalRevenueCents / totalDays) : 0;
  const collectionRatePercent =
    expectedRevenueCents > 0
      ? Math.round((totalRevenueCents / expectedRevenueCents) * 100)
      : 100;

  // Tiempo promedio de lavado
  const washRows = db
    .prepare(`
      SELECT b.started_washing_at, b.updated_at, COALESCE(s.vehicle_type, v.vehicle_type) AS vehicle_type
      FROM bookings b
      JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN booking_snapshots s ON s.booking_id = b.id
      WHERE b.booking_date BETWEEN ? AND ?
        AND b.status = 'completed'
        AND b.started_washing_at IS NOT NULL
    `)
    .all(startDate, endDate) as Array<{
      started_washing_at: string;
      updated_at: string;
      vehicle_type: VehicleType;
    }>;

  let totalWashMinutes = 0;
  let washSampleCount = 0;
  for (const item of washRows) {
    const started = Date.parse(item.started_washing_at);
    const finished = Date.parse(item.updated_at);
    if (!isNaN(started) && !isNaN(finished) && finished > started) {
      const diffMin = (finished - started) / (1000 * 60);
      if (diffMin >= 10 && diffMin <= 180) {
        totalWashMinutes += diffMin;
        washSampleCount++;
      }
    }
  }
  const averageWashTimeMinutes =
    washSampleCount > 0
      ? Math.round(totalWashMinutes / washSampleCount)
      : 35; // default fallback (ponderado entre auto 30m y SUV 45m)

  // 2. Tendencia Diaria
  const dailyDbRows = db
    .prepare(`
      SELECT 
        booking_date,
        COUNT(*) AS count,
        SUM(amount_paid_cents) AS revenue_cents,
        SUM(total_cents) AS expected_cents
      FROM bookings
      WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
      GROUP BY booking_date
      ORDER BY booking_date ASC
    `)
    .all(startDate, endDate) as Array<{
      booking_date: string;
      count: number;
      revenue_cents: number;
      expected_cents: number;
    }>;

  const dailyMap = new Map<string, { count: number; revenue: number; expected: number }>();
  for (const r of dailyDbRows) {
    dailyMap.set(r.booking_date, {
      count: r.count,
      revenue: r.revenue_cents,
      expected: r.expected_cents,
    });
  }

  const dailyTrend: DayTrend[] = [];
  let cur = startDate;
  while (cur <= endDate) {
    const found = dailyMap.get(cur);
    const [y, m, d] = cur.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayName = DAY_NAMES[dt.getUTCDay()];
    const label = `${DAY_SHORT_NAMES[dt.getUTCDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;

    dailyTrend.push({
      date: cur,
      label,
      dayName,
      vehiclesCount: found?.count ?? 0,
      revenueCents: found?.revenue ?? 0,
      expectedCents: found?.expected ?? 0,
    });
    cur = offsetDate(cur, 1);
  }

  // 3. Distribución por Horas Pico (7:00 a 18:00)
  const capacitySlots = db.prepare('SELECT hour, max_slots FROM capacity_slots').all() as Array<{
    hour: number;
    max_slots: number;
  }>;
  const capacityMap = new Map<number, number>();
  for (const c of capacitySlots) {
    capacityMap.set(c.hour, c.max_slots);
  }

  const hourlyDbRows = db
    .prepare(`
      SELECT dropoff_hour, COUNT(*) AS count
      FROM bookings
      WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
      GROUP BY dropoff_hour
    `)
    .all(startDate, endDate) as Array<{ dropoff_hour: number; count: number }>;

  const hourlyMap = new Map<number, number>();
  for (const r of hourlyDbRows) {
    hourlyMap.set(r.dropoff_hour, r.count);
  }

  let maxHourlyCount = 0;
  for (let h = BUSINESS.openHour; h <= BUSINESS.closeHour; h++) {
    const c = hourlyMap.get(h) ?? 0;
    if (c > maxHourlyCount) maxHourlyCount = c;
  }

  const hourlyDistribution: HourlyStat[] = [];
  for (let h = BUSINESS.openHour; h <= BUSINESS.closeHour; h++) {
    const count = hourlyMap.get(h) ?? 0;
    const isPeak = maxHourlyCount > 0 && count >= Math.max(2, Math.round(maxHourlyCount * 0.75));
    hourlyDistribution.push({
      hour: h,
      label: `${h % 12 || 12}:00 ${h >= 12 ? 'p. m.' : 'a. m.'}`,
      count,
      percentage: totalBookings > 0 ? Math.round((count / totalBookings) * 100) : 0,
      isPeak,
      capacityMax: capacityMap.get(h) ?? 6,
    });
  }

  // 4. Distribución por Día de la Semana (Global y Período)
  // Usamos el histórico para obtener un perfil de día confiable
  const dowDbRows = db
    .prepare(`
      SELECT 
        CAST(strftime('%w', booking_date) AS INTEGER) AS dow,
        COUNT(*) AS count,
        SUM(amount_paid_cents) AS revenue_cents,
        COUNT(DISTINCT booking_date) AS distinct_days
      FROM bookings
      WHERE status != 'cancelled'
      GROUP BY dow
    `)
    .all() as Array<{
      dow: number;
      count: number;
      revenue_cents: number;
      distinct_days: number;
    }>;

  const dowMap = new Map<number, { count: number; revenue: number; distinct_days: number }>();
  let totalAllHistoricalVehicles = 0;
  for (const r of dowDbRows) {
    dowMap.set(r.dow, {
      count: r.count,
      revenue: r.revenue_cents,
      distinct_days: Math.max(1, r.distinct_days),
    });
    totalAllHistoricalVehicles += r.count;
  }

  // Ordenamos de Lunes (1) a Domingo (0)
  const orderedDowIndices = [1, 2, 3, 4, 5, 6, 0];
  const dayOfWeekDistribution: DayOfWeekStat[] = orderedDowIndices.map((idx) => {
    const d = dowMap.get(idx);
    const count = d?.count ?? 0;
    const distinctDays = d?.distinct_days ?? 1;
    const avg = count > 0 ? Number((count / distinctDays).toFixed(1)) : 0;
    return {
      dayIndex: idx,
      dayName: DAY_NAMES[idx],
      shortName: DAY_SHORT_NAMES[idx],
      totalVehicles: count,
      averageVehicles: avg,
      totalRevenueCents: d?.revenue ?? 0,
      percentage:
        totalAllHistoricalVehicles > 0
          ? Math.round((count / totalAllHistoricalVehicles) * 100)
          : 0,
    };
  });

  // 5. Mix de Vehículos
  const vehicleDbRows = db
    .prepare(`
      SELECT 
        COALESCE(s.vehicle_type, v.vehicle_type) AS vehicle_type,
        COUNT(*) AS count,
        SUM(b.amount_paid_cents) AS revenue_cents
      FROM bookings b
      JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN booking_snapshots s ON s.booking_id = b.id
      WHERE b.booking_date BETWEEN ? AND ? AND b.status != 'cancelled'
      GROUP BY 1
      ORDER BY count DESC
    `)
    .all(startDate, endDate) as Array<{
      vehicle_type: VehicleType;
      count: number;
      revenue_cents: number;
    }>;

  const vehicleTypes: VehicleTypeStat[] = vehicleDbRows.map((r) => ({
    type: r.vehicle_type,
    label: VEHICLE_LABELS[r.vehicle_type] || r.vehicle_type,
    icon: VEHICLE_ICONS[r.vehicle_type] || 'car-front',
    count: r.count,
    percentage: totalBookings > 0 ? Math.round((r.count / totalBookings) * 100) : 0,
    revenueCents: r.revenue_cents || 0,
  }));

  // 6. Métodos de Pago
  const paymentDbRows = db
    .prepare(`
      SELECT 
        payment_method,
        payment_status,
        amount_paid_cents,
        total_cents
      FROM bookings
      WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
    `)
    .all(startDate, endDate) as Array<{
      payment_method: PaymentMethod;
      payment_status: string;
      amount_paid_cents: number;
      total_cents: number;
    }>;

  let yapeCount = 0;
  let yapeCents = 0;
  let cashCount = 0;
  let cashCents = 0;
  let plinCount = 0;
  let plinCents = 0;
  let pendingCount = 0;
  let pendingCents = 0;

  for (const r of paymentDbRows) {
    if (r.payment_method === 'yape') {
      yapeCount++;
      yapeCents += r.amount_paid_cents;
    } else if (r.payment_method === 'cash') {
      cashCount++;
      cashCents += r.amount_paid_cents;
    } else if (r.payment_method === 'plin') {
      plinCount++;
      plinCents += r.amount_paid_cents;
    }
    if (r.payment_status === 'pending' || r.amount_paid_cents < r.total_cents) {
      pendingCount++;
      pendingCents += Math.max(0, r.total_cents - r.amount_paid_cents);
    }
  }

  const paymentMethods: PaymentBreakdownStat[] = [
    {
      method: 'cash',
      label: 'Efectivo',
      count: cashCount,
      cents: cashCents,
      percentage: totalRevenueCents > 0 ? Math.round((cashCents / totalRevenueCents) * 100) : 0,
    },
    {
      method: 'yape',
      label: 'Yape',
      count: yapeCount,
      cents: yapeCents,
      percentage: totalRevenueCents > 0 ? Math.round((yapeCents / totalRevenueCents) * 100) : 0,
    },
    {
      method: 'plin',
      label: 'Plin',
      count: plinCount,
      cents: plinCents,
      percentage: totalRevenueCents > 0 ? Math.round((plinCents / totalRevenueCents) * 100) : 0,
    },
  ];

  // 7. Top Servicios
  const servicesDbRows = db
    .prepare(`
      SELECT 
        bs.service_name,
        bs.category,
        COUNT(*) AS count,
        SUM(bs.price_cents) AS revenue_cents
      FROM booking_services bs
      JOIN bookings b ON b.id = bs.booking_id
      WHERE b.booking_date BETWEEN ? AND ? AND b.status != 'cancelled'
      GROUP BY bs.service_name, bs.category
      ORDER BY count DESC
    `)
    .all(startDate, endDate) as Array<{
      service_name: string;
      category: 'base' | 'addon';
      count: number;
      revenue_cents: number;
    }>;

  const topServices: TopServiceStat[] = servicesDbRows.map((r) => ({
    name: r.service_name,
    category: r.category,
    count: r.count,
    percentage: totalBookings > 0 ? Math.round((r.count / totalBookings) * 100) : 0,
    revenueCents: r.revenue_cents,
  }));

  // 8. 🔮 MÓDULO DE PRONÓSTICO & PROYECCIÓN (Forecasting Engine)
  // Tendencia de las últimas 2 semanas para factor de aceleración
  const last7DaysCount = db
    .prepare(`
      SELECT COUNT(*) AS count, SUM(amount_paid_cents) AS revenue
      FROM bookings
      WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
    `)
    .get(offsetDate(today, -6), today) as { count: number; revenue: number };

  const prev7DaysCount = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM bookings
      WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
    `)
    .get(offsetDate(today, -13), offsetDate(today, -7)) as { count: number };

  let momentum = 1.0;
  if (prev7DaysCount.count > 0 && last7DaysCount.count > 0) {
    momentum = last7DaysCount.count / prev7DaysCount.count;
    // Acotar entre 0.8 y 1.25 para evitar distorsiones estadísticas
    momentum = Math.max(0.8, Math.min(1.25, momentum));
  }

  // Pronóstico para los próximos 7 días (a partir de hoy + 1)
  const next7Days: ForecastDay[] = [];
  let totalExpectedVehiclesWeek = 0;
  let totalExpectedRevenueWeekCents = 0;

  for (let i = 1; i <= 7; i++) {
    const fDate = offsetDate(today, i);
    const [y, m, d] = fDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay();
    const dowInfo = dowMap.get(dow);

    // Promedio histórico del día ajustado por tendencia
    let expectedV = dowInfo && dowInfo.distinct_days > 0
      ? (dowInfo.count / dowInfo.distinct_days) * momentum
      : (averageDailyVehicles > 0 ? averageDailyVehicles : 8);

    expectedV = Math.max(2, Math.round(expectedV));
    const expectedRev = Math.round(expectedV * (averageTicketCents > 0 ? averageTicketCents : 2500));

    let demandLevel: 'Baja' | 'Media' | 'Alta' = 'Media';
    let demandColor = '#f0ae35'; // amber
    let recommendedStaff = '2 lavadores';

    if (expectedV >= 12) {
      demandLevel = 'Alta';
      demandColor = '#db5b62'; // red/danger
      recommendedStaff = '3 o 4 lavadores (Pista llena)';
    } else if (expectedV <= 5) {
      demandLevel = 'Baja';
      demandColor = '#39bc8b'; // green
      recommendedStaff = '1 lavador';
    }

    next7Days.push({
      date: fDate,
      dayName: DAY_NAMES[dow],
      shortLabel: `${DAY_SHORT_NAMES[dow]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`,
      expectedVehicles: expectedV,
      expectedRevenueCents: expectedRev,
      demandLevel,
      demandColor,
      recommendedStaff,
    });

    totalExpectedVehiclesWeek += expectedV;
    totalExpectedRevenueWeekCents += expectedRev;
  }

  // Proyección de cierre de mes
  const [currentYear, currentMonthStr, currentDayStr] = today.split('-').map(Number);
  // Días totales en el mes actual
  const daysInCurrentMonth = new Date(currentYear, currentMonthStr, 0).getDate();
  const daysPassed = Math.max(1, currentDayStr);
  const daysRemaining = Math.max(0, daysInCurrentMonth - daysPassed);

  const monthSoFar = db
    .prepare(`
      SELECT COUNT(*) AS count, SUM(amount_paid_cents) AS revenue
      FROM bookings
      WHERE booking_date BETWEEN ? AND ? AND status != 'cancelled'
    `)
    .get(`${today.slice(0, 7)}-01`, today) as { count: number; revenue: number | null };

  const vehiclesSoFarMonth = monthSoFar.count;
  const revenueSoFarMonth = monthSoFar.revenue || 0;
  const dailyRateMonth = daysPassed > 0 ? revenueSoFarMonth / daysPassed : 0;
  const dailyVehiclesRateMonth = daysPassed > 0 ? vehiclesSoFarMonth / daysPassed : 0;

  const projectedTotalRevenueCents = Math.round(
    revenueSoFarMonth + dailyRateMonth * daysRemaining,
  );
  const projectedTotalVehicles = Math.round(
    vehiclesSoFarMonth + dailyVehiclesRateMonth * daysRemaining,
  );

  const monthNames = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];

  // Identificar horas pico críticas
  const peakHoursWarning = hourlyDistribution
    .filter((h) => h.isPeak)
    .map((h) => ({
      hour: h.hour,
      label: h.label,
      historicalAverage: h.count,
    }));

  // Estimación de insumos para la semana próxima (cera, cuero, motor)
  const totalBaseCount = totalBookings > 0 ? totalBookings : 1;
  const waxRow = servicesDbRows.find((s) => s.service_name.toLowerCase().includes('cera'));
  const leatherRow = servicesDbRows.find((s) => s.service_name.toLowerCase().includes('cuero'));
  const engineRow = servicesDbRows.find((s) => s.service_name.toLowerCase().includes('motor'));

  const waxRate = waxRow ? waxRow.count / totalBaseCount : 0.15;
  const leatherRate = leatherRow ? leatherRow.count / totalBaseCount : 0.1;
  const engineRate = engineRow ? engineRow.count / totalBaseCount : 0.12;

  const forecastSummary: ForecastSummary = {
    next7Days,
    totalExpectedVehiclesWeek,
    totalExpectedRevenueWeekCents,
    peakHoursWarning,
    projectedMonthEnd: {
      monthName: monthNames[currentMonthStr - 1],
      daysInMonth: daysInCurrentMonth,
      daysPassed,
      daysRemaining,
      revenueSoFarCents: revenueSoFarMonth,
      vehiclesSoFar: vehiclesSoFarMonth,
      projectedTotalRevenueCents,
      projectedTotalVehicles,
    },
    supplyEstimates: {
      waxCount: Math.round(totalExpectedVehiclesWeek * waxRate),
      leatherCount: Math.round(totalExpectedVehiclesWeek * leatherRate),
      engineCount: Math.round(totalExpectedVehiclesWeek * engineRate),
    },
  };

  return {
    period,
    periodLabel: periodLabels[period],
    startDate,
    endDate,
    totalDays,
    totalBookings,
    completedBookings,
    cancelledBookings,
    totalRevenueCents,
    expectedRevenueCents,
    pendingRevenueCents,
    averageTicketCents,
    averageDailyVehicles,
    averageDailyRevenueCents,
    collectionRatePercent,
    averageWashTimeMinutes,
    dailyTrend,
    hourlyDistribution,
    dayOfWeekDistribution,
    vehicleTypes,
    paymentMethods,
    topServices,
    forecast: forecastSummary,
  };
}
