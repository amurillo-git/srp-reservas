// ============================================================================
// Rutas publicas de disponibilidad y reservas (seccion 18.1 de propuesta.md).
//
// Capa HTTP delgada: valida la FORMA de la solicitud (tipos, formatos) y
// traduce el resultado de availability.service.ts a codigos de estado HTTP.
// Ninguna regla de negocio vive aqui — esa vive en el motor puro
// (motor-disponibilidad.ts) y en la capa de persistencia
// (availability.service.ts). Esta capa nunca decide si algo cabe o no.
// ============================================================================

import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  confirmarReserva,
  consultarDisponibilidad,
  consultarReservaPorCodigo,
  listarFechasConDisponibilidad,
  listarHorasDisponibles,
  listarServiciosActivos,
} from "../services/availability.service.js";
import { aprobarSinpe, rechazarSinpe, reportarComprobanteSinpe } from "../services/pagos.service.js";
import { crearSesionPago, procesarWebhookOnvo } from "../services/pago-tarjeta.service.js";
import { iniciarSesion } from "../services/auth.service.js";
import { requireAuth } from "./auth.middleware.js";
import { crearBloqueo, eliminarBloqueo, listarBloqueos } from "../services/bloqueos.service.js";
import { cancelarReserva, reprogramarReserva } from "../services/gestion-reservas.service.js";
import {
  crearExcepcion,
  eliminarExcepcion,
  establecerPlantillaSemanal,
  listarExcepciones,
  listarPlantillaSemanal,
} from "../services/horarios.service.js";
import {
  cancelacionesYReprogramaciones,
  depositosPorMetodoPago,
  ocupacionHeatsDelDia,
  participantesPorDia,
  reservasDelDia,
  reservasPorFechaYEstado,
  reservasVencidas,
  sinpePendientes,
} from "../services/reportes.service.js";

/** 14.7: solo Administrador y Caja validan depositos SINPE. */
const ROLES_VALIDAN_SINPE = ["ADMINISTRADOR", "CAJA"] as const;
/** 14.7: solo Administrador gestiona bloqueos. */
const ROLES_GESTIONAN_BLOQUEOS = ["ADMINISTRADOR"] as const;
/** 14.7: Administrador y Atencion "crean y modifican reservas". */
const ROLES_GESTIONAN_RESERVAS = ["ADMINISTRADOR", "ATENCION"] as const;
/** 14.7: solo Administrador gestiona horarios. */
const ROLES_GESTIONAN_HORARIOS = ["ADMINISTRADOR"] as const;
/** 14.7: mismos roles que validan SINPE (administracion + manejo de dinero). */
const ROLES_VEN_REPORTES = ["ADMINISTRADOR", "CAJA"] as const;
const TIPOS_EXCEPCION = ["HABILITADO", "MODIFICADO", "CERRADO"] as const;

const PATRON_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PATRON_ANIO_MES = /^\d{4}-\d{2}$/;
const PATRON_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function enviarError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

/** Entero positivo desde un query param (string | string[] | undefined en Express). */
function comoEnteroPositivo(valor: unknown): number | null {
  if (typeof valor !== "string") return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Express 4 no atrapa rechazos de promesas dentro de un handler async: sin
 * este envoltorio, un error lanzado ahi tumbaria el proceso en vez de
 * convertirse en una respuesta 500 manejada por el middleware de errores. */
function conManejoDeErrores(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Valida `serviceId`, `from` y `to` (compartidos por la mayoria de los
 * reportes, 25). Devuelve `null` y ya envio la respuesta 400 si algo falta. */
function leerRangoFechas(req: Request, res: Response): { serviceId: string; from: string; to: string } | null {
  const serviceId = req.query.serviceId;
  const from = req.query.from;
  const to = req.query.to;
  if (typeof serviceId !== "string" || serviceId.length === 0) {
    enviarError(res, 400, "serviceId es requerido");
    return null;
  }
  if (typeof from !== "string" || !PATRON_FECHA.test(from)) {
    enviarError(res, 400, "from debe tener el formato YYYY-MM-DD");
    return null;
  }
  if (typeof to !== "string" || !PATRON_FECHA.test(to)) {
    enviarError(res, 400, "to debe tener el formato YYYY-MM-DD");
    return null;
  }
  return { serviceId, from, to };
}

export function crearRouterReservas(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/services",
    conManejoDeErrores(async (_req, res) => {
      const servicios = await listarServiciosActivos(prisma);
      res.json({ servicios });
    }),
  );

  router.get(
    "/availability/dates",
    conManejoDeErrores(async (req, res) => {
      const servicioId = req.query.serviceId;
      const anioMes = req.query.month;
      const cantidadPersonas = comoEnteroPositivo(req.query.partySize);

      if (typeof servicioId !== "string" || servicioId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof anioMes !== "string" || !PATRON_ANIO_MES.test(anioMes)) {
        return enviarError(res, 400, "month debe tener el formato YYYY-MM");
      }
      if (cantidadPersonas === null) {
        return enviarError(res, 400, "partySize debe ser un entero positivo");
      }

      const fechasDisponibles = await listarFechasConDisponibilidad(prisma, servicioId, anioMes, cantidadPersonas);
      res.json({ fechasDisponibles });
    }),
  );

  router.get(
    "/availability/times",
    conManejoDeErrores(async (req, res) => {
      const servicioId = req.query.serviceId;
      const fecha = req.query.date;
      const cantidadPersonas = comoEnteroPositivo(req.query.partySize);

      if (typeof servicioId !== "string" || servicioId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof fecha !== "string" || !PATRON_FECHA.test(fecha)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      if (cantidadPersonas === null) {
        return enviarError(res, 400, "partySize debe ser un entero positivo");
      }

      const horasDisponibles = await listarHorasDisponibles(prisma, servicioId, fecha, cantidadPersonas);
      res.json({ horasDisponibles });
    }),
  );

  router.post(
    "/availability/quote",
    conManejoDeErrores(async (req, res) => {
      const { serviceId, date, startTime, partySize } = req.body ?? {};

      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      if (typeof startTime !== "string" || !PATRON_HORA.test(startTime)) {
        return enviarError(res, 400, "startTime debe tener el formato HH:mm");
      }
      if (typeof partySize !== "number" || !Number.isInteger(partySize) || partySize <= 0) {
        return enviarError(res, 400, "partySize debe ser un entero positivo");
      }

      const plan = await consultarDisponibilidad(prisma, {
        servicioId: serviceId,
        fecha: date,
        horaInicioCandidata: startTime,
        cantidadPersonas: partySize,
      });
      res.json({ plan });
    }),
  );

  router.post(
    "/reservations",
    conManejoDeErrores(async (req, res) => {
      // 8.8.7: la clave de idempotencia la controla el cliente (para que un
      // reintento reutilice la MISMA clave), no el servidor.
      const claveIdempotencia = req.header("Idempotency-Key");
      if (!claveIdempotencia) {
        return enviarError(res, 400, 'El encabezado "Idempotency-Key" es requerido');
      }

      const { serviceId, date, startTime, partySize, customer } = req.body ?? {};

      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      if (typeof startTime !== "string" || !PATRON_HORA.test(startTime)) {
        return enviarError(res, 400, "startTime debe tener el formato HH:mm");
      }
      if (typeof partySize !== "number" || !Number.isInteger(partySize) || partySize <= 0) {
        return enviarError(res, 400, "partySize debe ser un entero positivo");
      }
      if (
        typeof customer !== "object" ||
        customer === null ||
        typeof customer.name !== "string" ||
        customer.name.trim().length === 0 ||
        typeof customer.phone !== "string" ||
        customer.phone.trim().length === 0
      ) {
        return enviarError(res, 400, "customer.name y customer.phone son requeridos");
      }
      if (customer.email !== undefined && typeof customer.email !== "string") {
        return enviarError(res, 400, "customer.email debe ser texto");
      }

      const resultado = await confirmarReserva(prisma, {
        servicioId: serviceId,
        fecha: date,
        horaInicioCandidata: startTime,
        cantidadPersonas: partySize,
        cliente: { nombre: customer.name, telefono: customer.phone, email: customer.email },
        claveIdempotencia,
      });

      if (resultado.exito) {
        res.status(201).json(resultado);
        return;
      }
      // NO_DISPONIBLE y CONFLICTO_CONCURRENCIA son ambos "no se pudo crear
      // ahora mismo, intente de nuevo con datos frescos": 409.
      res.status(409).json(resultado);
    }),
  );

  router.get(
    "/reservations/:publicCode",
    conManejoDeErrores(async (req, res) => {
      const reserva = await consultarReservaPorCodigo(prisma, req.params.publicCode!);
      if (!reserva) {
        return enviarError(res, 404, "No existe ninguna reserva con ese codigo");
      }
      res.json(reserva);
    }),
  );

  router.post(
    "/reservations/:publicCode/sinpe-evidence",
    conManejoDeErrores(async (req, res) => {
      const { comprobanteUrl, nombrePagador, numeroOrigen, referencia } = req.body ?? {};
      for (const [nombre, valor] of Object.entries({ comprobanteUrl, nombrePagador, numeroOrigen, referencia })) {
        if (valor !== undefined && typeof valor !== "string") {
          return enviarError(res, 400, `${nombre} debe ser texto`);
        }
      }

      const resultado = await reportarComprobanteSinpe(prisma, req.params.publicCode!, {
        comprobanteUrl,
        nombrePagador,
        numeroOrigen,
        referencia,
      });

      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 6.8: pago con tarjeta via ONVO (checkout hospedado).
  router.post(
    "/reservations/:publicCode/card-payment",
    conManejoDeErrores(async (req, res) => {
      const resultado = await crearSesionPago(prisma, req.params.publicCode!);
      if (resultado.ok) {
        res.status(200).json({ checkoutUrl: resultado.checkoutUrl });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : resultado.motivo === "ERROR_PROVEEDOR" ? 502 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // Sin requireAuth: la llama ONVO, no un usuario administrativo. La
  // autenticidad se valida con el header X-Webhook-Secret (ver
  // pago-tarjeta.service.ts), no con el JWT del panel.
  router.post(
    "/webhooks/onvo",
    conManejoDeErrores(async (req, res) => {
      const resultado = await procesarWebhookOnvo(prisma, req.header("X-Webhook-Secret"), req.body);
      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      const status =
        resultado.motivo === "FIRMA_INVALIDA" ? 401 : resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 18.3: rutas administrativas, protegidas con requireAuth.
  router.post(
    "/admin/login",
    conManejoDeErrores(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== "string" || email.length === 0 || typeof password !== "string" || password.length === 0) {
        return enviarError(res, 400, "email y password son requeridos");
      }

      const resultado = await iniciarSesion(prisma, email, password);
      if (!resultado.ok) {
        return enviarError(res, 401, "Credenciales invalidas");
      }
      res.json({ token: resultado.token, rol: resultado.rol });
    }),
  );

  router.post(
    "/admin/reservations/:publicCode/confirm-sinpe",
    requireAuth(ROLES_VALIDAN_SINPE),
    conManejoDeErrores(async (req, res) => {
      const resultado = await aprobarSinpe(prisma, req.params.publicCode!);
      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  router.post(
    "/admin/reservations/:publicCode/reject-sinpe",
    requireAuth(ROLES_VALIDAN_SINPE),
    conManejoDeErrores(async (req, res) => {
      const { motivo } = req.body ?? {};
      if (typeof motivo !== "string" || motivo.trim().length === 0) {
        return enviarError(res, 400, "motivo es requerido");
      }

      const resultado = await rechazarSinpe(prisma, req.params.publicCode!, motivo);
      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 14.5-14.6: cancelacion y reprogramacion de reservas desde el panel.
  router.post(
    "/admin/reservations/:publicCode/cancel",
    requireAuth(ROLES_GESTIONAN_RESERVAS),
    conManejoDeErrores(async (req, res) => {
      const resultado = await cancelarReserva(prisma, req.params.publicCode!);
      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  router.post(
    "/admin/reservations/:publicCode/reschedule",
    requireAuth(ROLES_GESTIONAN_RESERVAS),
    conManejoDeErrores(async (req, res) => {
      const { date, startTime, partySize } = req.body ?? {};

      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      if (typeof startTime !== "string" || !PATRON_HORA.test(startTime)) {
        return enviarError(res, 400, "startTime debe tener el formato HH:mm");
      }
      if (typeof partySize !== "number" || !Number.isInteger(partySize) || partySize <= 0) {
        return enviarError(res, 400, "partySize debe ser un entero positivo");
      }

      const resultado = await reprogramarReserva(prisma, req.params.publicCode!, {
        fecha: date, horaInicioCandidata: startTime, cantidadPersonas: partySize,
      });

      if (resultado.ok) {
        res.status(200).json({ plan: resultado.plan });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 14.4, 18.3: bloqueos administrativos. Solo ADMINISTRADOR (14.7).
  router.post(
    "/admin/blocks",
    requireAuth(ROLES_GESTIONAN_BLOQUEOS),
    conManejoDeErrores(async (req, res) => {
      const { serviceId, date, startTime, endTime, reason, force } = req.body ?? {};

      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      if (typeof startTime !== "string" || !PATRON_HORA.test(startTime)) {
        return enviarError(res, 400, "startTime debe tener el formato HH:mm");
      }
      if (typeof endTime !== "string" || !PATRON_HORA.test(endTime)) {
        return enviarError(res, 400, "endTime debe tener el formato HH:mm");
      }
      if (reason !== undefined && typeof reason !== "string") {
        return enviarError(res, 400, "reason debe ser texto");
      }
      if (force !== undefined && typeof force !== "boolean") {
        return enviarError(res, 400, "force debe ser booleano");
      }

      const resultado = await crearBloqueo(prisma, {
        servicioId: serviceId, fecha: date, horaInicio: startTime, horaFin: endTime,
        motivo: reason, forzar: force,
      });

      if (resultado.ok) {
        res.status(201).json({ blockId: resultado.bloqueoId });
        return;
      }
      // 9.22: no se crea nada; se devuelven las reservas en conflicto para
      // que el administrador decida (reintentar con force:true, u otra hora).
      res.status(409).json({ motivo: resultado.motivo, reservasEnConflicto: resultado.reservasEnConflicto });
    }),
  );

  router.get(
    "/admin/blocks",
    requireAuth(ROLES_GESTIONAN_BLOQUEOS),
    conManejoDeErrores(async (req, res) => {
      const serviceId = req.query.serviceId;
      const date = req.query.date;
      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }

      const bloqueos = await listarBloqueos(prisma, serviceId, date);
      res.json({ bloqueos });
    }),
  );

  router.delete(
    "/admin/blocks/:id",
    requireAuth(ROLES_GESTIONAN_BLOQUEOS),
    conManejoDeErrores(async (req, res) => {
      const resultado = await eliminarBloqueo(prisma, req.params.id!);
      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      enviarError(res, 404, resultado.motivo);
    }),
  );

  // 14.3, 18.3: gestion de horarios. Solo ADMINISTRADOR (14.7).
  router.put(
    "/admin/services/:serviceId/schedule/weekly/:dayOfWeek",
    requireAuth(ROLES_GESTIONAN_HORARIOS),
    conManejoDeErrores(async (req, res) => {
      const diaSemana = Number(req.params.dayOfWeek);
      const { openTime, closeTime, lunchStart, lunchEnd, active } = req.body ?? {};

      if (typeof openTime !== "string" || !PATRON_HORA.test(openTime)) {
        return enviarError(res, 400, "openTime debe tener el formato HH:mm");
      }
      if (typeof closeTime !== "string" || !PATRON_HORA.test(closeTime)) {
        return enviarError(res, 400, "closeTime debe tener el formato HH:mm");
      }
      if (lunchStart !== undefined && (typeof lunchStart !== "string" || !PATRON_HORA.test(lunchStart))) {
        return enviarError(res, 400, "lunchStart debe tener el formato HH:mm");
      }
      if (lunchEnd !== undefined && (typeof lunchEnd !== "string" || !PATRON_HORA.test(lunchEnd))) {
        return enviarError(res, 400, "lunchEnd debe tener el formato HH:mm");
      }
      if (active !== undefined && typeof active !== "boolean") {
        return enviarError(res, 400, "active debe ser booleano");
      }

      const resultado = await establecerPlantillaSemanal(prisma, req.params.serviceId!, diaSemana, {
        horaApertura: openTime, horaCierre: closeTime, almuerzoInicio: lunchStart, almuerzoFin: lunchEnd, activo: active,
      });

      if (resultado.ok) {
        res.status(200).json({ template: resultado.plantilla });
        return;
      }
      enviarError(res, 400, resultado.motivo);
    }),
  );

  router.get(
    "/admin/services/:serviceId/schedule/weekly",
    requireAuth(ROLES_GESTIONAN_HORARIOS),
    conManejoDeErrores(async (req, res) => {
      const templates = await listarPlantillaSemanal(prisma, req.params.serviceId!);
      res.json({ templates });
    }),
  );

  router.post(
    "/admin/services/:serviceId/schedule/exceptions",
    requireAuth(ROLES_GESTIONAN_HORARIOS),
    conManejoDeErrores(async (req, res) => {
      const { date, type, openTime, closeTime, lunchStart, lunchEnd, reason } = req.body ?? {};

      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      if (typeof type !== "string" || !TIPOS_EXCEPCION.includes(type as (typeof TIPOS_EXCEPCION)[number])) {
        return enviarError(res, 400, `type debe ser uno de: ${TIPOS_EXCEPCION.join(", ")}`);
      }
      for (const [nombre, valor] of Object.entries({ openTime, closeTime, lunchStart, lunchEnd })) {
        if (valor !== undefined && (typeof valor !== "string" || !PATRON_HORA.test(valor))) {
          return enviarError(res, 400, `${nombre} debe tener el formato HH:mm`);
        }
      }
      if (reason !== undefined && typeof reason !== "string") {
        return enviarError(res, 400, "reason debe ser texto");
      }

      const resultado = await crearExcepcion(prisma, req.params.serviceId!, {
        fecha: date, tipo: type as "HABILITADO" | "MODIFICADO" | "CERRADO",
        horaApertura: openTime, horaCierre: closeTime, almuerzoInicio: lunchStart, almuerzoFin: lunchEnd, motivo: reason,
      });

      if (resultado.ok) {
        res.status(201).json({ exceptionId: resultado.excepcionId });
        return;
      }
      enviarError(res, 400, resultado.motivo);
    }),
  );

  router.get(
    "/admin/services/:serviceId/schedule/exceptions",
    requireAuth(ROLES_GESTIONAN_HORARIOS),
    conManejoDeErrores(async (req, res) => {
      const anioMes = req.query.month;
      if (typeof anioMes !== "string" || !PATRON_ANIO_MES.test(anioMes)) {
        return enviarError(res, 400, "month debe tener el formato YYYY-MM");
      }
      const exceptions = await listarExcepciones(prisma, req.params.serviceId!, anioMes);
      res.json({ exceptions });
    }),
  );

  router.delete(
    "/admin/schedule/exceptions/:id",
    requireAuth(ROLES_GESTIONAN_HORARIOS),
    conManejoDeErrores(async (req, res) => {
      const resultado = await eliminarExcepcion(prisma, req.params.id!);
      if (resultado.ok) {
        res.status(200).json({ ok: true });
        return;
      }
      enviarError(res, 404, resultado.motivo);
    }),
  );

  // 25, 18.3: reportes administrativos de solo lectura.
  router.get(
    "/admin/reports/reservations-by-date-status",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const rango = leerRangoFechas(req, res);
      if (!rango) return;
      const reporte = await reservasPorFechaYEstado(prisma, rango.serviceId, rango.from, rango.to);
      res.json({ reporte });
    }),
  );

  // 14.1: dashboard admin. Lista real (no solo conteo) de las reservas de un
  // dia puntual, para poder hacer clic en cada una.
  router.get(
    "/admin/reports/reservations-of-day",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const serviceId = req.query.serviceId;
      const date = req.query.date;
      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      const reporte = await reservasDelDia(prisma, serviceId, date);
      res.json({ reporte });
    }),
  );

  router.get(
    "/admin/reports/participants-by-day",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const rango = leerRangoFechas(req, res);
      if (!rango) return;
      const reporte = await participantesPorDia(prisma, rango.serviceId, rango.from, rango.to);
      res.json({ reporte });
    }),
  );

  router.get(
    "/admin/reports/occupancy",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const serviceId = req.query.serviceId;
      const date = req.query.date;
      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      const reporte = await ocupacionHeatsDelDia(prisma, serviceId, date);
      res.json({ reporte });
    }),
  );

  router.get(
    "/admin/reports/deposits-by-payment-method",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const rango = leerRangoFechas(req, res);
      if (!rango) return;
      const reporte = await depositosPorMetodoPago(prisma, rango.serviceId, rango.from, rango.to);
      res.json({ reporte });
    }),
  );

  router.get(
    "/admin/reports/pending-sinpe",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const serviceId = req.query.serviceId;
      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      const reporte = await sinpePendientes(prisma, serviceId);
      res.json({ reporte });
    }),
  );

  router.get(
    "/admin/reports/expired-reservations",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const rango = leerRangoFechas(req, res);
      if (!rango) return;
      const reporte = await reservasVencidas(prisma, rango.serviceId, rango.from, rango.to);
      res.json({ reporte });
    }),
  );

  router.get(
    "/admin/reports/cancellations-and-reschedules",
    requireAuth(ROLES_VEN_REPORTES),
    conManejoDeErrores(async (req, res) => {
      const rango = leerRangoFechas(req, res);
      if (!rango) return;
      const reporte = await cancelacionesYReprogramaciones(prisma, rango.serviceId, rango.from, rango.to);
      res.json(reporte);
    }),
  );

  return router;
}
