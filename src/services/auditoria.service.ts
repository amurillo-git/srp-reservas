// ============================================================================
// Auditoria de acciones administrativas (21).
//
// Alcance de este slice (ver Gate-1): solo las acciones del panel que ya
// tienen un actor humano claro via requireAuth — cancelar/reprogramar
// reserva, aprobar/rechazar SINPE, horario semanal, excepciones y bloqueos.
// Deliberadamente fuera de alcance: eventos sin actor administrativo claro
// (reserva de clientes, asignacion/liberacion de participantes, creacion de
// heats/lotes, confirmaciones de la pasarela, vencimientos automaticos) y
// acciones sobre precios/usuarios (no existen pantallas para esas acciones
// todavia). Solo-escritura + lectura: no hay actualizar ni eliminar, los
// registros no deben modificarse desde la aplicacion.
// ============================================================================

import type { PrismaClient } from "@prisma/client";
import type { FechaISO } from "../motor-disponibilidad/motor-disponibilidad.js";

export interface ActorAuditoria {
  readonly userId: string;
  readonly email: string;
}

export interface DatosEvento {
  readonly accion: string;
  readonly objetoTipo: string;
  readonly objetoId: string;
  /** Omitir cuando el estado anterior no esta disponible sin una consulta
   * extra (aceptable para este slice: se prioriza no complicar cada punto de
   * instrumentacion sobre tener el "antes" completo en todos los casos). */
  readonly valoresAnteriores?: unknown;
  readonly valoresNuevos?: unknown;
}

export async function registrarEvento(prisma: PrismaClient, actor: ActorAuditoria, datos: DatosEvento): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actorUserId: actor.userId,
      actorEmail: actor.email,
      accion: datos.accion,
      objetoTipo: datos.objetoTipo,
      objetoId: datos.objetoId,
      valoresAnteriores: datos.valoresAnteriores as never,
      valoresNuevos: datos.valoresNuevos as never,
    },
  });
}

export interface EventoAuditoria {
  readonly id: string;
  readonly actorEmail: string | null;
  readonly accion: string;
  readonly objetoTipo: string;
  readonly objetoId: string;
  readonly valoresAnteriores: unknown;
  readonly valoresNuevos: unknown;
  /** ISO 8601 con hora (no solo fecha): la auditoria necesita el momento exacto. */
  readonly creadoEn: string;
}

export interface FiltrosAuditoria {
  readonly accion?: string;
  readonly objetoId?: string;
  readonly desde?: FechaISO;
  readonly hasta?: FechaISO;
}

/** Tope duro de resultados, igual criterio que buscarReservas (14.5): esta
 * pantalla es para investigar un caso puntual, no para exportar todo el
 * historial. */
const LIMITE_EVENTOS = 200;

export async function listarEventos(prisma: PrismaClient, filtros: FiltrosAuditoria): Promise<readonly EventoAuditoria[]> {
  const creadoEn: { gte?: Date; lte?: Date } = {};
  if (filtros.desde) creadoEn.gte = new Date(`${filtros.desde}T00:00:00.000Z`);
  if (filtros.hasta) creadoEn.lte = new Date(`${filtros.hasta}T23:59:59.999Z`);

  const eventos = await prisma.auditEvent.findMany({
    where: {
      ...(filtros.accion ? { accion: filtros.accion } : {}),
      ...(filtros.objetoId ? { objetoId: filtros.objetoId } : {}),
      ...(creadoEn.gte || creadoEn.lte ? { creadoEn } : {}),
    },
    orderBy: { creadoEn: "desc" },
    take: LIMITE_EVENTOS,
  });

  return eventos.map((e) => ({
    id: e.id,
    actorEmail: e.actorEmail,
    accion: e.accion,
    objetoTipo: e.objetoTipo,
    objetoId: e.objetoId,
    valoresAnteriores: e.valoresAnteriores,
    valoresNuevos: e.valoresNuevos,
    creadoEn: e.creadoEn.toISOString(),
  }));
}
