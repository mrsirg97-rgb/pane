import { TuiAltScreen } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi.scrollSpeedBoost");

export function applyWheelBoost(proto: any, factor: number): boolean {
  if (factor <= 1 || proto[PATCHED]) return false;
  const original = proto.routeWheel;
  if (typeof original !== "function") return false;
  proto.routeWheel = function (event: any) {
    return original.call(this, {
      ...event,
      direction: event.direction * factor,
    });
  };
  proto[PATCHED] = true;
  return true;
}

export default function scrollSpeedExtension(_pi: ExtensionAPI) {
  const factor = Math.max(
    1,
    Math.round(Number(process.env.PI_WHEEL_LINES ?? 3)),
  );
  applyWheelBoost((TuiAltScreen as any)?.prototype, factor);
}
