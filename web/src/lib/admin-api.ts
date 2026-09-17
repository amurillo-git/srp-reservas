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

/** Para POST/PUT/DELETE admin: si el backend responde con error, devuelve el
 * cuerpo del error en vez de lanzar (varios de estos endpoints usan el
 * cuerpo del 409, ej. conflicto de bloqueos, no solo el status). */
async function enviarJsonAdmin<T>(
  metodo: "POST" | "PUT" | "DELETE",
  ruta: string,
  token: string,
  cuerpo?: unknown,
): Promise<{ readonly status: number; readonly datos: T }> {
  const respuesta = await fetch(`${BASE_URL}${ruta}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await respuesta.json().catch(() => ({}));
  return { status: respuesta.status, datos };
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

export interface ReservaEnConflicto {
  readonly codigoPublico: string;
  readonly estado: string;
  readonly cantidadPersonas: number;
}

export type ResultadoCrearBloqueo =
  | { readonly ok: true; readonly blockId: string }
  | { readonly ok: false; readonly conflicto: true; readonly reservasEnConflicto: readonly ReservaEnConflicto[] }
  | { readonly ok: false; readonly conflicto: false; readonly motivo: string };

export async function crearBloqueo(
  token: string,
  datos: { serviceId: string; date: string; startTime: string; endTime: string; reason?: string; force?: boolean },
): Promise<ResultadoCrearBloqueo> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{
    blockId?: string;
    motivo?: string;
    reservasEnConflicto?: ReservaEnConflicto[];
  }>("POST", "/admin/blocks", token, datos);
  if (status === 201 && cuerpo.blockId) return { ok: true, blockId: cuerpo.blockId };
  if (status === 409 && cuerpo.motivo === "CONFLICTO") {
    return { ok: false, conflicto: true, reservasEnConflicto: cuerpo.reservasEnConflicto ?? [] };
  }
  return { ok: false, conflicto: false, motivo: cuerpo.motivo ?? "No se pudo crear el bloqueo" };
}

export async function eliminarBloqueo(token: string, id: string): Promise<boolean> {
  const { status } = await enviarJsonAdmin("DELETE", `/admin/blocks/${id}`, token);
  return status === 200;
}

// ----------------------------------------------------------------------------
// Horarios (14.3).
// ----------------------------------------------------------------------------

export interface PlantillaSemanal {
  readonly diaSemana: number;
  readonly horaApertura: string;
  readonly horaCierre: string;
  readonly almuerzoInicio: string | null;
  readonly almuerzoFin: string | null;
  readonly activo: boolean;
}

export async function obtenerPlantillaSemanal(token: string, serviceId: string): Promise<readonly PlantillaSemanal[]> {
  const { templates } = await obtenerJsonAdmin<{ templates: PlantillaSemanal[] }>(
    `/admin/services/${serviceId}/schedule/weekly`,
    token,
  );
  return templates;
}

export async function establecerPlantillaSemanal(
  token: string,
  serviceId: string,
  dayOfWeek: number,
  datos: { openTime: string; closeTime: string; lunchStart?: string; lunchEnd?: string; active?: boolean },
): Promise<{ readonly ok: boolean; readonly motivo?: string }> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ motivo?: string }>(
    "PUT",
    `/admin/services/${serviceId}/schedule/weekly/${dayOfWeek}`,
    token,
    datos,
  );
  return status === 200 ? { ok: true } : { ok: false, motivo: cuerpo.motivo };
}

export interface ExcepcionAdmin {
  readonly id: string;
  readonly fecha: string;
  readonly tipo: "HABILITADO" | "MODIFICADO" | "CERRADO";
  readonly horaApertura: string | null;
  readonly horaCierre: string | null;
  readonly almuerzoInicio: string | null;
  readonly almuerzoFin: string | null;
  readonly motivo: string | null;
}

export async function obtenerExcepciones(token: string, serviceId: string, month: string): Promise<readonly ExcepcionAdmin[]> {
  const { exceptions } = await obtenerJsonAdmin<{ exceptions: ExcepcionAdmin[] }>(
    `/admin/services/${serviceId}/schedule/exceptions?month=${month}`,
    token,
  );
  return exceptions;
}

export async function crearExcepcion(
  token: string,
  serviceId: string,
  datos: {
    date: string;
    type: "HABILITADO" | "MODIFICADO" | "CERRADO";
    openTime?: string;
    closeTime?: string;
    lunchStart?: string;
    lunchEnd?: string;
    reason?: string;
  },
): Promise<{ readonly ok: boolean; readonly motivo?: string }> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ motivo?: string }>(
    "POST",
    `/admin/services/${serviceId}/schedule/exceptions`,
    token,
    datos,
  );
  return status === 201 ? { ok: true } : { ok: false, motivo: cuerpo.motivo };
}

export async function eliminarExcepcion(token: string, id: string): Promise<boolean> {
  const { status } = await enviarJsonAdmin("DELETE", `/admin/schedule/exceptions/${id}`, token);
  return status === 200;
}

// ----------------------------------------------------------------------------
// Gestion de reservas (14.5): busqueda, cancelacion y reprogramacion.
// ----------------------------------------------------------------------------

export interface ReservaBusqueda {
  readonly codigoPublico: string;
  readonly fecha: string;
  readonly cantidadPersonas: number;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly estado: string;
  readonly vecesReprogramada: number;
}

export interface FiltrosBusquedaReservas {
  readonly q?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
}

export async function buscarReservasAdmin(
  token: string,
  serviceId: string,
  filtros: FiltrosBusquedaReservas,
): Promise<readonly ReservaBusqueda[]> {
  const params = new URLSearchParams({ serviceId });
  if (filtros.q) params.set("q", filtros.q);
  if (filtros.status) params.set("status", filtros.status);
  if (filtros.from) params.set("from", filtros.from);
  if (filtros.to) params.set("to", filtros.to);

  const { reservas } = await obtenerJsonAdmin<{ reservas: ReservaBusqueda[] }>(
    `/admin/reservations/search?${params.toString()}`,
    token,
  );
  return reservas;
}

export type ResultadoAccionReserva = { readonly ok: true } | { readonly ok: false; readonly motivo: string };

export async function cancelarReservaAdmin(token: string, codigoPublico: string): Promise<ResultadoAccionReserva> {
  const { status, datos } = await enviarJsonAdmin<{ motivo?: string }>(
    "POST",
    `/admin/reservations/${codigoPublico}/cancel`,
    token,
  );
  if (status === 200) return { ok: true };
  return { ok: false, motivo: datos.motivo ?? "No se pudo cancelar la reserva" };
}

export async function reprogramarReservaAdmin(
  token: string,
  codigoPublico: string,
  datos: { date: string; startTime: string; partySize: number },
): Promise<ResultadoAccionReserva> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ motivo?: string }>(
    "POST",
    `/admin/reservations/${codigoPublico}/reschedule`,
    token,
    datos,
  );
  if (status === 200) return { ok: true };
  return { ok: false, motivo: cuerpo.motivo ?? "No se pudo reprogramar la reserva" };
}

// ----------------------------------------------------------------------------
// Calendario operativo (14.2): vista diaria/semanal de lotes y heats.
// ----------------------------------------------------------------------------

export interface ReservaDeHeat {
  readonly codigoPublico: string;
  readonly cantidadPersonas: number;
  readonly estado: string;
}

export interface HeatOperativo {
  readonly heatId: string;
  readonly horaInicio: string;
  readonly horaFin: string;
  readonly capacidadMaxima: number;
  readonly reservas: readonly ReservaDeHeat[];
}

export interface LoteOperativo {
  readonly loteId: string;
  readonly horaInicio: string;
  readonly horaFinUltimoHeat: string;
  readonly horaInicioLimpieza: string;
  readonly horaFinLimpieza: string;
  readonly heats: readonly HeatOperativo[];
}

export interface VentanaDelDia {
  readonly horaApertura: string;
  readonly horaCierre: string;
  readonly almuerzoInicio: string | null;
  readonly almuerzoFin: string | null;
}

export interface CalendarioOperativoDelDia {
  readonly ventanas: readonly VentanaDelDia[];
  readonly lotes: readonly LoteOperativo[];
  readonly bloqueos: readonly BloqueoAdmin[];
}

export async function obtenerCalendarioOperativo(
  token: string,
  serviceId: string,
  date: string,
): Promise<CalendarioOperativoDelDia> {
  return obtenerJsonAdmin<CalendarioOperativoDelDia>(
    `/admin/services/${serviceId}/operational-calendar?date=${date}`,
    token,
  );
}

// ----------------------------------------------------------------------------
// Auditoria (21): historial de acciones administrativas, solo lectura.
// ----------------------------------------------------------------------------

export interface EventoAuditoria {
  readonly id: string;
  readonly actorEmail: string | null;
  readonly accion: string;
  readonly objetoTipo: string;
  readonly objetoId: string;
  readonly valoresAnteriores: unknown;
  readonly valoresNuevos: unknown;
  readonly creadoEn: string;
}

export interface FiltrosAuditoria {
  readonly action?: string;
  readonly objectId?: string;
  readonly from?: string;
  readonly to?: string;
}

export async function obtenerEventosAuditoria(
  token: string,
  filtros: FiltrosAuditoria,
): Promise<readonly EventoAuditoria[]> {
  const params = new URLSearchParams();
  if (filtros.action) params.set("action", filtros.action);
  if (filtros.objectId) params.set("objectId", filtros.objectId);
  if (filtros.from) params.set("from", filtros.from);
  if (filtros.to) params.set("to", filtros.to);

  const { eventos } = await obtenerJsonAdmin<{ eventos: EventoAuditoria[] }>(
    `/admin/audit-events?${params.toString()}`,
    token,
  );
  return eventos;
}

// ----------------------------------------------------------------------------
// Usuarios y permisos (14.7).
// ----------------------------------------------------------------------------

export type RolUsuario = "ADMINISTRADOR" | "ATENCION" | "CAJA" | "OPERACION";

export interface UsuarioAdmin {
  readonly id: string;
  readonly email: string;
  readonly rol: RolUsuario;
  readonly activo: boolean;
  readonly creadoEn: string;
}

export async function listarUsuariosAdmin(token: string): Promise<readonly UsuarioAdmin[]> {
  const { usuarios } = await obtenerJsonAdmin<{ usuarios: UsuarioAdmin[] }>("/admin/users", token);
  return usuarios;
}

export type ResultadoUsuario =
  | { readonly ok: true; readonly usuario: UsuarioAdmin }
  | { readonly ok: false; readonly motivo: string };

export async function crearUsuarioAdmin(
  token: string,
  datos: { email: string; password: string; rol: RolUsuario },
): Promise<ResultadoUsuario> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ user?: UsuarioAdmin; motivo?: string; error?: string }>(
    "POST",
    "/admin/users",
    token,
    datos,
  );
  if (status === 201 && cuerpo.user) return { ok: true, usuario: cuerpo.user };
  return { ok: false, motivo: cuerpo.motivo ?? cuerpo.error ?? "No se pudo crear el usuario" };
}

export async function actualizarUsuarioAdmin(
  token: string,
  id: string,
  datos: { rol?: RolUsuario; activo?: boolean },
): Promise<ResultadoUsuario> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ user?: UsuarioAdmin; motivo?: string; error?: string }>(
    "PUT",
    `/admin/users/${id}`,
    token,
    datos,
  );
  if (status === 200 && cuerpo.user) return { ok: true, usuario: cuerpo.user };
  return { ok: false, motivo: cuerpo.motivo ?? cuerpo.error ?? "No se pudo actualizar el usuario" };
}

export type ResultadoAccionSimple = { readonly ok: true } | { readonly ok: false; readonly motivo: string };

/** Cambia la propia contrasena (cualquier rol, requiere la actual). */
export async function cambiarMiContrasenaAdmin(
  token: string,
  datos: { currentPassword: string; newPassword: string },
): Promise<ResultadoAccionSimple> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ motivo?: string; error?: string }>(
    "PUT",
    "/admin/me/password",
    token,
    datos,
  );
  if (status === 200) return { ok: true };
  return { ok: false, motivo: cuerpo.motivo ?? cuerpo.error ?? "No se pudo cambiar la contraseña" };
}

/** "Recuperacion" (solo Administrador): restablece la contrasena de otro usuario sin pedir la actual. */
export async function restablecerContrasenaAdmin(
  token: string,
  id: string,
  newPassword: string,
): Promise<ResultadoAccionSimple> {
  const { status, datos: cuerpo } = await enviarJsonAdmin<{ motivo?: string; error?: string }>(
    "PUT",
    `/admin/users/${id}/password`,
    token,
    { newPassword },
  );
  if (status === 200) return { ok: true };
  return { ok: false, motivo: cuerpo.motivo ?? cuerpo.error ?? "No se pudo restablecer la contraseña" };
}
