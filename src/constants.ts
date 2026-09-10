export const BUSINESS = {
  name: 'DASAV Car Wash',
  timezone: 'America/Lima',
  openHour: 7,
  lastDropoffHour: 17,
  closeHour: 18,
  phoneRequiredFromHour: 14,
  latePickupHour: 16,
} as const;

export const DEFAULT_CAPACITY_PER_HOUR = 10;

export const VEHICLE_TYPES = ['motorcycle', 'car', 'small_suv', 'large_suv'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  motorcycle: 'Moto',
  car: 'Auto',
  small_suv: 'SUV pequeña',
  large_suv: 'SUV grande / camioneta',
};

export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  in_progress: 'En proceso',
  completed: 'Terminada',
  cancelled: 'Cancelada',
};

export const PAYMENT_METHODS = ['yape', 'plin', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  yape: 'Yape',
  plin: 'Plin',
  cash: 'Efectivo',
};

export const PAYMENT_STATUSES = ['pending', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function hourLabel(hour: number, minute = 0): string {
  const suffix = hour >= 12 ? 'p. m.' : 'a. m.';
  const value = hour % 12 || 12;
  return `${value}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('es-PE', {
    style: 'currency',
    currency: 'PEN',
  }).format(cents / 100);
}
