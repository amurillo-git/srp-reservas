import type { DatosClienteReserva, PlanDisponibilidad, Servicio } from "@/lib/types";

export type PasoReserva = "personas" | "fecha" | "hora" | "cliente" | "revision" | "pago" | "confirmacion";

export interface EstadoWizard {
  readonly servicio: Servicio;
  readonly cantidadPersonas: number | null;
  readonly fecha: string | null;
  readonly horaInicio: string | null;
  readonly cliente: DatosClienteReserva | null;
  readonly plan: PlanDisponibilidad | null;
  readonly codigoPublico: string | null;
  readonly idempotencyKey: string;
}
