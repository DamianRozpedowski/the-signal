import { EventEmitter } from "node:events";

// In-process event bus feeding Server-Sent Events to connected browsers.
// Payloads are small "something changed" notices; clients re-query what they need.
export type BusEvent =
  | { type: "articles"; newCount: number; updatedCount: number; sourceId: number; clusterIds: number[] }
  | { type: "cluster"; clusterId: number; reason: string }
  | { type: "source"; sourceId: number; status: string }
  | { type: "briefing"; briefingId: number; editionDate: string }
  | { type: "notification"; userId: number; notificationId: number }
  | { type: "refresh"; at: string };

export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emit(e: BusEvent) {
  bus.emit("event", e);
}
