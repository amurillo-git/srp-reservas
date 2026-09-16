// Cliente de la API administrativa (src/http/reservas.router.ts, rutas
// /admin/*). Igual que lib/api.ts: sin reglas de negocio, solo arma la
// solicitud con el header Authorization y tipa la respuesta.

import { ApiError } from "./api";
import type { SesionAdmin } from "./admin-auth";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api";

async function obtenerJsonAdmin<T>(ruta: string, token: string): Promise<T> {
  const respuesta = await fetch(`${BASE_URL}${ruta}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!respuesta.ok) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    throw new ApiError(respuesta.status, cuerpo.error ?? "Error al consultar la API");
  }
  return respuesta.json();
}

export async function iniciarSesionAdmin(email: string, password: string): Promise<SesionAdmin> {
  const respuesta = await fetch(`${BASE_URL}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!respuesta.ok) {
    throw new ApiError(respuesta.status, "Credenciales invalidas");
  }
  return respuesta.json();
}

export interface ReservaDelDia {
  readonly codigoPublico: string;
  readonly fecha: string;
  readonly cantidadPersonas: number;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly estado: string;
}

export async function obtenerReservasDelDia(token: string, serviceId: string, date: string): Promise<readonly ReservaDelDia[]> {
  const { reporte } = await obtenerJsonAdmin<{ reporte: ReservaDelDia[] }>(
    `/admin/reports/reservations-of-day?serviceId=${serviceId}&date=${date}`,
    token,
  );
  return reporte;
}

export interface OcupacionHeat {
  readonly heatId: string;
  readonly horaInicio: string;
  readonly capacidadMaxima: number;
  readonly ocupados: number;
  readonly disponible: number;
}

export async function obtenerOcupacionDelDia(token: string, serviceId: string, date: string): Promise<readonly OcupacionHeat[]> {
  const { reporte } = await obtenerJsonAdmin<{ reporte: OcupacionHeat[] }>(
    `/admin/reports/occupancy?serviceId=${serviceId}&date=${date}`,
    token,
  );
  return reporte;
}

export interface ReservaResumen {
  readonly codigoPublico: string;
  readonly fecha: string;
  readonly cantidadPersonas: number;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
}

export async function obtenerSinpePendientes(token: string, serviceId: string): Promise<readonly ReservaResumen[]> {
  const { reporte } = await obtenerJsonAdmin<{ reporte: ReservaResumen[] }>(
    `/admin/reports/pending-sinpe?serviceId=${serviceId}`,
    token,
  );
  return reporte;
}

export interface BloqueoAdmin {
  readonly id: string;
  readonly fecha: string;
  readonly horaInicio: string;
  readonly horaFin: string;
  readonly motivo: string | null;
}

export async function obtenerBloqueosDelDia(token: string, serviceId: string, date: string): Promise<readonly BloqueoAdmin[]> {
  const { bloqueos } = await obtenerJsonAdmin<{ bloqueos: BloqueoAdmin[] }>(
    `/admin/blocks?serviceId=${serviceId}&date=${date}`,
    token,
  );
  return bloqueos;
}
