import type { DatosClienteReserva, PlanDisponibilidad, Servicio } from "@/lib/types";

export type PasoReserva =
  | "personas"
  | "fecha"
  | "hora"
  | "vuelta2"
  | "cliente"
  | "revision"
  | "pago"
  | "confirmacion";

export interface EstadoWizard {
  readonly servicio: Servicio;
  readonly cantidadPersonas: number | null;
  /** Vueltas completas solicitadas (1 = una sola, comportamiento de siempre). */
  readonly repeticiones: number;
  readonly fecha: string | null;
  readonly horaInicio: string | null;
  /** Solo si `repeticiones` es 2 y la 2a vuelta no cupo justo despues de la 1a. */
  readonly horaInicioVuelta2: string | null;
  readonly cliente: DatosClienteReserva | null;
  readonly plan: PlanDisponibilidad | null;
  readonly codigoPublico: string | null;
  readonly idempotencyKey: string;
}
