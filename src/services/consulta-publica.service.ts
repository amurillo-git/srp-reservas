// ============================================================================
// Consulta publica de reservas por telefono y fecha: alternativa al codigo
// para el cliente que lo perdio. El telefono se guarda tal como lo escribio el
// cliente al reservar ("6068-7547", "+506 6068 7547"...), asi que se compara
// solo por sus ultimos 8 digitos. Nunca se devuelve el nombre ni el telefono
// del cliente: solo la misma vista publica que ya se obtiene con el codigo.
// ============================================================================

import type { PrismaClient } from "@prisma/client";
import {
  consultarReservaPorCodigo,
  fechaISOaDate,
  type ReservaPublica,
} from "./availability.service.js";
import type { FechaISO } from "../motor-disponibilidad/motor-disponibilidad.js";

/** Cantidad de digitos significativos de un telefono de Costa Rica. */
const DIGITOS_TELEFONO = 8;

/**
 * Deja solo los ultimos 8 digitos del telefono (ignora espacios, guiones,
 * parentesis y el prefijo +506). Devuelve null si tiene menos de 8 digitos.
 */
export function normalizarTelefono(texto: string): string | null {
  const digitos = texto.replace(/\D/g, "");
  return digitos.length >= DIGITOS_TELEFONO ? digitos.slice(-DIGITOS_TELEFONO) : null;
}

/** true si `fecha` es "YYYY-MM-DD" y existe en el calendario. */
function esFechaReal(fecha: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const date = fechaISOaDate(fecha);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === fecha;
}

function horaDeInicio(reserva: ReservaPublica): string {
  return reserva.lotes[0]?.heats[0]?.horaInicio ?? "99:99";
}

/**
 * Reservas de `fecha` cuyo telefono coincide con `telefono`, ordenadas por
 * hora. Devuelve null si el telefono o la fecha no son validos (para que la
 * capa HTTP responda 400); una busqueda valida sin coincidencias devuelve [].
 */
export async function buscarReservasPorTelefonoYFecha(
  prisma: PrismaClient,
  telefono: string,
  fecha: string,
): Promise<readonly ReservaPublica[] | null> {
  const buscado = normalizarTelefono(telefono);
  if (buscado === null || !esFechaReal(fecha)) return null;

  const dia = fechaISOaDate(fecha as FechaISO);
  const delDia = await prisma.reservation.findMany({ where: { fecha: { gte: dia, lte: dia } } });

  const publicas: ReservaPublica[] = [];
  for (const reserva of delDia) {
    if (normalizarTelefono(reserva.clienteTelefono) !== buscado) continue;
    const publica = await consultarReservaPorCodigo(prisma, reserva.codigoPublico);
    if (publica) publicas.push(publica);
  }
  return publicas.sort((a, b) => horaDeInicio(a).localeCompare(horaDeInicio(b)));
}
