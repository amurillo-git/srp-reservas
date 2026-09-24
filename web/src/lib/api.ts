// Cliente delgado de la API publica (src/http/reservas.router.ts del
// backend). No contiene reglas de negocio: solo arma la solicitud HTTP y
// tipa la respuesta.

import type {
  DatosClienteReserva,
  PlanDisponibilidad,
  PlanRepetido,
  ReservaPublica,
  ResultadoCrearReserva,
  Servicio,
} from "./types";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function obtenerJson<T>(ruta: string): Promise<T> {
  const respuesta = await fetch(`${BASE_URL}${ruta}`);
  if (!respuesta.ok) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    throw new ApiError(respuesta.status, cuerpo.error ?? "Error al consultar la API");
  }
  return respuesta.json();
}

export async function listarServicios(): Promise<readonly Servicio[]> {
  const { servicios } = await obtenerJson<{ servicios: Servicio[] }>("/services");
  return servicios;
}

export async function listarFechasDisponibles(
  serviceId: string,
  month: string,
  partySize: number,
): Promise<readonly string[]> {
  const { fechasDisponibles } = await obtenerJson<{ fechasDisponibles: string[] }>(
    `/availability/dates?serviceId=${serviceId}&month=${month}&partySize=${partySize}`,
  );
  return fechasDisponibles;
}

export async function listarHorasDisponibles(
  serviceId: string,
  date: string,
  partySize: number,
): Promise<readonly string[]> {
  const { horasDisponibles } = await obtenerJson<{ horasDisponibles: string[] }>(
    `/availability/times?serviceId=${serviceId}&date=${date}&partySize=${partySize}`,
  );
  return horasDisponibles;
}

/** Previsualizacion del plan (precio, lotes/heats) sin retener ni crear nada. */
export async function consultarCotizacion(
  serviceId: string,
  date: string,
  startTime: string,
  partySize: number,
): Promise<PlanDisponibilidad> {
  const respuesta = await fetch(`${BASE_URL}/availability/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceId, date, startTime, partySize }),
  });
  const { plan } = await respuesta.json();
  return plan;
}

/** Previsualiza si ambas (o todas las) repeticiones caben consecutivas a
 * partir de `startTime`; si no, devuelve las horas ese mismo dia donde
 * cabria una reserva independiente solo para la vuelta restante. */
export async function consultarDisponibilidadRepeticiones(
  serviceId: string,
  date: string,
  startTime: string,
  partySize: number,
  repetitions: number,
): Promise<PlanRepetido> {
  const respuesta = await fetch(`${BASE_URL}/availability/quote-repeticiones`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceId, date, startTime, partySize, repetitions }),
  });
  return respuesta.json();
}

export interface SolicitudCrearReserva {
  readonly serviceId: string;
  readonly date: string;
  readonly startTime: string;
  readonly partySize: number;
  readonly customer: DatosClienteReserva;
  /** Vueltas completas solicitadas (1 = comportamiento de siempre). */
  readonly repetitions?: number;
  /** Solo si `repetitions` >= 2 y la 2a vuelta no cupo justo despues de la 1a. */
  readonly secondRoundStartTime?: string;
}

/** 8.8.7: idempotencyKey debe ser generada y conservada por el llamador (un
 * reintento del mismo intento de reserva debe reusar la misma clave). */
export async function crearReserva(
  solicitud: SolicitudCrearReserva,
  idempotencyKey: string,
): Promise<ResultadoCrearReserva> {
  const respuesta = await fetch(`${BASE_URL}/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(solicitud),
  });
  return respuesta.json();
}

export interface SolicitudComprobanteSinpe {
  readonly nombrePagador?: string;
  readonly numeroOrigen?: string;
  readonly referencia?: string;
}

export async function reportarComprobanteSinpe(
  codigoPublico: string,
  solicitud: SolicitudComprobanteSinpe,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const respuesta = await fetch(`${BASE_URL}/reservations/${codigoPublico}/sinpe-evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(solicitud),
  });
  if (!respuesta.ok) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    return { ok: false, error: cuerpo.error ?? "No se pudo reportar el comprobante" };
  }
  return { ok: true };
}

export type ResultadoIniciarPagoTarjeta =
  | { readonly ok: true; readonly checkoutUrl: string }
  | { readonly ok: false; readonly error: string };

/** Inicia el checkout de ONVO (6.8) para el deposito de una reserva TEMPORAL. */
export async function iniciarPagoTarjeta(codigoPublico: string): Promise<ResultadoIniciarPagoTarjeta> {
  const respuesta = await fetch(`${BASE_URL}/reservations/${codigoPublico}/card-payment`, { method: "POST" });
  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    return { ok: false, error: cuerpo.error ?? "No se pudo iniciar el pago con tarjeta" };
  }
  return { ok: true, checkoutUrl: cuerpo.checkoutUrl };
}

export type ModoSinpe = "MANUAL" | "ONVO";

export async function obtenerConfiguracionPago(): Promise<{ readonly modoSinpe: ModoSinpe }> {
  return obtenerJson<{ modoSinpe: ModoSinpe }>("/configuracion-pago");
}

export interface DatosClienteSinpeOnvo {
  readonly telefono: string;
  readonly cedula: string;
}

export type ResultadoIniciarIntencionSinpe =
  | { readonly ok: true; readonly numeroSinpe: string; readonly monto: number; readonly moneda: string }
  | { readonly ok: false; readonly error: string };

/** 25: crea la intencion de pago SINPE en ONVO (modo automatico) para el
 * deposito de una reserva TEMPORAL. */
export async function iniciarIntencionSinpe(
  codigoPublico: string,
  datos: DatosClienteSinpeOnvo,
): Promise<ResultadoIniciarIntencionSinpe> {
  const respuesta = await fetch(`${BASE_URL}/reservations/${codigoPublico}/sinpe-intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(datos),
  });
  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    return { ok: false, error: cuerpo.error ?? "No se pudo iniciar el pago SINPE" };
  }
  return { ok: true, numeroSinpe: cuerpo.numeroSinpe, monto: cuerpo.monto, moneda: cuerpo.moneda };
}

export async function consultarReserva(codigoPublico: string): Promise<ReservaPublica | null> {
  const respuesta = await fetch(`${BASE_URL}/reservations/${encodeURIComponent(codigoPublico)}`);
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) {
    throw new ApiError(respuesta.status, "No se pudo consultar la reserva");
  }
  return respuesta.json();
}
