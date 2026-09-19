// Espejo tipado de las respuestas publicas de la API (src/http/reservas.router.ts
// del backend). Solo los campos que el frontend realmente consume.

export interface Servicio {
  readonly id: string;
  readonly nombre: string;
  readonly slug: string;
  readonly moneda: string;
  readonly precioPorPersonaGrupoPequeno: number;
  readonly precioPorPersonaGrupoGrande: number;
  readonly porcentajeDeposito: number;
  readonly pagoTarjetaHabilitado: boolean;
}

export interface HeatPropuesto {
  readonly horaInicio: string;
  readonly horaFin: string;
  readonly personasAsignadas: number;
}

export interface LotePropuesto {
  readonly heats: readonly HeatPropuesto[];
  readonly horaInicio: string;
  readonly horaFinActividadCliente: string;
}

export interface PrecioPropuesto {
  readonly moneda: string;
  readonly montoTotal: number;
  readonly montoDeposito: number;
  readonly montoSaldo: number;
}

export type PlanDisponibilidad =
  | {
      readonly disponible: true;
      readonly cantidadLotes: number;
      readonly lotes: readonly LotePropuesto[];
      readonly horaFinActividadCliente: string;
      readonly precio?: PrecioPropuesto;
    }
  | { readonly disponible: false; readonly motivo: string; readonly detalle?: string };

export interface DatosClienteReserva {
  readonly name: string;
  readonly phone: string;
  readonly email?: string;
}

export type ResultadoCrearReserva =
  | { readonly exito: true; readonly idReserva: string; readonly codigoPublico: string; readonly plan: PlanDisponibilidad }
  | { readonly exito: false; readonly motivo: "NO_DISPONIBLE"; readonly plan: PlanDisponibilidad }
  | { readonly exito: false; readonly motivo: "CONFLICTO_CONCURRENCIA"; readonly detalle: string };

export interface HeatDeReservaPublico {
  readonly horaInicio: string;
  readonly horaFin: string;
  readonly personas: number;
}

export interface LoteDeReservaPublico {
  readonly heats: readonly HeatDeReservaPublico[];
}

export interface ReservaPublica {
  readonly codigoPublico: string;
  readonly estado: string;
  readonly fecha: string;
  readonly cantidadPersonas: number;
  readonly moneda: string;
  readonly montoTotal: number;
  readonly montoDeposito: number;
  readonly montoSaldo: number;
  readonly lotes: readonly LoteDeReservaPublico[];
  readonly expiraEn: string | null;
  readonly pagoTarjetaHabilitado: boolean;
}
