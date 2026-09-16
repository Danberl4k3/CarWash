import { EventEmitter } from 'node:events';

export interface AppEvent {
  type: 'booking_created' | 'booking_updated' | 'refresh';
  data?: Record<string, unknown>;
  timestamp: string;
}

class SystemEventEmitter extends EventEmitter {
  emitAppEvent(type: AppEvent['type'], data?: Record<string, unknown>): void {
    this.emit('app_event', {
      type,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}

export const appEvents = new SystemEventEmitter();
