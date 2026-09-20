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
import type { PrismaClient, Rol } from "@prisma/client";
import {
  confirmarReserva,
  consultarDisponibilidad,
  consultarReservaPorCodigo,
  listarFechasConDisponibilidad,
  listarHorasDisponibles,
  listarServiciosActivos,
} from "../services/availability.service.js";
import { aprobarSinpe, rechazarSinpe, reportarComprobanteSinpe } from "../services/pagos.service.js";
import {
  crearSesionPago,
  crearSesionPagoSaldo,
  establecerPagoTarjetaHabilitado,
  procesarWebhookOnvo,
} from "../services/pago-tarjeta.service.js";
import { crearIntencionSaldoOnvo, crearIntencionSinpeOnvo } from "../services/pago-sinpe-onvo.service.js";
import { establecerModoSinpe, obtenerModoSinpe } from "../services/configuracion-pago.service.js";
import { ajustarAsistentesReales, marcarSaldoPagadoManual } from "../services/cobro-saldo.service.js";
import { iniciarSesion } from "../services/auth.service.js";
import { requireAuth, type RequestAutenticado } from "./auth.middleware.js";
import { listarEventos, registrarEvento, type ActorAuditoria } from "../services/auditoria.service.js";
import {
  actualizarUsuario,
  cambiarContrasenaPropia,
  crearUsuario,
  listarUsuarios,
  restablecerContrasena,
} from "../services/usuarios.service.js";
import { crearBloqueo, eliminarBloqueo, listarBloqueos } from "../services/bloqueos.service.js";
import { cancelarReserva, reprogramarReserva } from "../services/gestion-reservas.service.js";
import { calendarioOperativoDelDia } from "../services/calendario-operativo.service.js";
import {
  crearExcepcion,
  eliminarExcepcion,
  establecerPlantillaSemanal,
  listarExcepciones,
  listarPlantillaSemanal,
} from "../services/horarios.service.js";
import {
  buscarReservas,
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
/** 14.7: "Operador del parque" es el rol pensado para consultar el
 * calendario operativo (propuesta.md, tabla de roles); Administrador
 * mantiene acceso a todo. */
const ROLES_VEN_CALENDARIO = ["ADMINISTRADOR", "OPERACION"] as const;
/** 21: la auditoria es informacion sensible de accountability, solo Administrador. */
const ROLES_VEN_AUDITORIA = ["ADMINISTRADOR"] as const;
/** 14.7: "Administrador | ...usuarios..." — solo Administrador gestiona usuarios. */
const ROLES_GESTIONAN_USUARIOS = ["ADMINISTRADOR"] as const;
/** 14.7: solo Administrador activa/desactiva el pago con tarjeta (6.8). */
const ROLES_GESTIONAN_PAGOS = ["ADMINISTRADOR"] as const;
const ROLES_USUARIO = ["ADMINISTRADOR", "ATENCION", "CAJA", "OPERACION"] as const;
const TIPOS_EXCEPCION = ["HABILITADO", "MODIFICADO", "CERRADO"] as const;
const ESTADOS_RESERVA = [
  "TEMPORAL", "PENDIENTE_VALIDACION_SINPE", "CONFIRMADA", "RECHAZADA", "CANCELADA", "EXPIRADA",
] as const;

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

/** Actor de auditoria (21) desde el JWT que `requireAuth` ya valido y
 * adjunto a `req.usuario`. Solo se llama dentro de rutas protegidas con
 * requireAuth, asi que `usuario` siempre esta presente en ese punto. */
function actorDesde(req: Request): ActorAuditoria {
  const usuario = (req as RequestAutenticado).usuario!;
  return { userId: usuario.userId, email: usuario.email };
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

  // 25: para que el cliente sepa si debe reportar comprobante manualmente o
  // seguir el flujo automatico de ONVO. Publica: no expone nada sensible.
  router.get(
    "/configuracion-pago",
    conManejoDeErrores(async (_req, res) => {
      res.json({ modoSinpe: await obtenerModoSinpe(prisma) });
    }),
  );

  // 25: crea (y confirma) una intencion de pago SINPE en ONVO por el deposito
  // de una reserva TEMPORAL. Solo tiene efecto si el modo global es ONVO.
  router.post(
    "/reservations/:publicCode/sinpe-intent",
    conManejoDeErrores(async (req, res) => {
      const { telefono, cedula } = req.body ?? {};
      if (typeof telefono !== "string" || telefono.length === 0) {
        return enviarError(res, 400, "telefono es requerido");
      }
      if (typeof cedula !== "string" || cedula.length === 0) {
        return enviarError(res, 400, "cedula es requerida");
      }

      const resultado = await crearIntencionSinpeOnvo(prisma, req.params.publicCode!, { telefono, cedula });
      if (resultado.ok) {
        res.status(200).json({ numeroSinpe: resultado.numeroSinpe, monto: resultado.monto, moneda: resultado.moneda });
        return;
      }
      const status =
        resultado.motivo === "NO_ENCONTRADA"
          ? 404
          : resultado.motivo === "ERROR_PROVEEDOR"
            ? 502
            : resultado.motivo === "MODO_INCORRECTO"
              ? 400
              : 409;
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
      const { montoPagado } = req.body ?? {};
      if (montoPagado !== undefined && typeof montoPagado !== "number") {
        return enviarError(res, 400, "montoPagado debe ser numero");
      }

      const resultado = await aprobarSinpe(prisma, req.params.publicCode!, montoPagado);
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "SINPE_APROBADO", objetoTipo: "RESERVA", objetoId: req.params.publicCode!,
          valoresNuevos: montoPagado !== undefined ? { estado: "CONFIRMADA", montoPagado } : { estado: "CONFIRMADA" },
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : resultado.motivo === "MONTO_INVALIDO" ? 400 : 409;
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "SINPE_RECHAZADO", objetoTipo: "RESERVA", objetoId: req.params.publicCode!,
          valoresNuevos: { estado: "RECHAZADA", motivo },
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 14.5: busqueda de reservas para el panel (encontrar una reserva antes de
  // poder cancelarla/reprogramarla). Mismos roles que esas dos acciones.
  router.get(
    "/admin/reservations/search",
    requireAuth(ROLES_GESTIONAN_RESERVAS),
    conManejoDeErrores(async (req, res) => {
      const serviceId = req.query.serviceId;
      const q = req.query.q;
      const status = req.query.status;
      const from = req.query.from;
      const to = req.query.to;

      if (typeof serviceId !== "string" || serviceId.length === 0) {
        return enviarError(res, 400, "serviceId es requerido");
      }
      if (from !== undefined && (typeof from !== "string" || !PATRON_FECHA.test(from))) {
        return enviarError(res, 400, "from debe tener el formato YYYY-MM-DD");
      }
      if (to !== undefined && (typeof to !== "string" || !PATRON_FECHA.test(to))) {
        return enviarError(res, 400, "to debe tener el formato YYYY-MM-DD");
      }
      if (status !== undefined && !ESTADOS_RESERVA.includes(status as (typeof ESTADOS_RESERVA)[number])) {
        return enviarError(res, 400, `status debe ser uno de: ${ESTADOS_RESERVA.join(", ")}`);
      }

      const reservas = await buscarReservas(prisma, serviceId, {
        q: typeof q === "string" ? q : undefined,
        estado: status as (typeof ESTADOS_RESERVA)[number] | undefined,
        desde: from as string | undefined,
        hasta: to as string | undefined,
      });
      res.json({ reservas });
    }),
  );

  // 14.5-14.6: cancelacion y reprogramacion de reservas desde el panel.
  router.post(
    "/admin/reservations/:publicCode/cancel",
    requireAuth(ROLES_GESTIONAN_RESERVAS),
    conManejoDeErrores(async (req, res) => {
      const resultado = await cancelarReserva(prisma, req.params.publicCode!);
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "RESERVA_CANCELADA", objetoTipo: "RESERVA", objetoId: req.params.publicCode!,
          valoresNuevos: { estado: "CANCELADA" },
        });
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "RESERVA_REPROGRAMADA", objetoTipo: "RESERVA", objetoId: req.params.publicCode!,
          valoresNuevos: { fecha: date, horaInicio: startTime, cantidadPersonas: partySize },
        });
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "BLOQUEO_CREADO", objetoTipo: "BLOQUEO", objetoId: resultado.bloqueoId,
          valoresNuevos: { serviceId, date, startTime, endTime, reason },
        });
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "BLOQUEO_ELIMINADO", objetoTipo: "BLOQUEO", objetoId: req.params.id!,
        });
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "HORARIO_SEMANAL_ACTUALIZADO", objetoTipo: "PLANTILLA_HORARIO",
          objetoId: `${req.params.serviceId}:${diaSemana}`,
          valoresNuevos: { openTime, closeTime, lunchStart, lunchEnd, active },
        });
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "EXCEPCION_HORARIO_CREADA", objetoTipo: "EXCEPCION_HORARIO", objetoId: resultado.excepcionId,
          valoresNuevos: { date, type, openTime, closeTime, lunchStart, lunchEnd, reason },
        });
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
        await registrarEvento(prisma, actorDesde(req), {
          accion: "EXCEPCION_HORARIO_ELIMINADA", objetoTipo: "EXCEPCION_HORARIO", objetoId: req.params.id!,
        });
        res.status(200).json({ ok: true });
        return;
      }
      enviarError(res, 404, resultado.motivo);
    }),
  );

  // 14.2, 18.3: calendario operativo (vista diaria/semanal de lotes y heats
  // para el operador del parque). Solo lectura: editar horarios/bloqueos ya
  // existe en sus propias rutas.
  router.get(
    "/admin/services/:serviceId/operational-calendar",
    requireAuth(ROLES_VEN_CALENDARIO),
    conManejoDeErrores(async (req, res) => {
      const date = req.query.date;
      if (typeof date !== "string" || !PATRON_FECHA.test(date)) {
        return enviarError(res, 400, "date debe tener el formato YYYY-MM-DD");
      }
      const calendario = await calendarioOperativoDelDia(prisma, req.params.serviceId!, date);
      res.json(calendario);
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

  // 21: auditoria de solo lectura. Ver el comentario de cabecera de
  // auditoria.service.ts para el alcance exacto (que acciones se registran
  // y cuales quedan deliberadamente fuera).
  router.get(
    "/admin/audit-events",
    requireAuth(ROLES_VEN_AUDITORIA),
    conManejoDeErrores(async (req, res) => {
      const accion = req.query.action;
      const objetoId = req.query.objectId;
      const from = req.query.from;
      const to = req.query.to;

      if (from !== undefined && (typeof from !== "string" || !PATRON_FECHA.test(from))) {
        return enviarError(res, 400, "from debe tener el formato YYYY-MM-DD");
      }
      if (to !== undefined && (typeof to !== "string" || !PATRON_FECHA.test(to))) {
        return enviarError(res, 400, "to debe tener el formato YYYY-MM-DD");
      }

      const eventos = await listarEventos(prisma, {
        accion: typeof accion === "string" ? accion : undefined,
        objetoId: typeof objetoId === "string" ? objetoId : undefined,
        desde: from as string | undefined,
        hasta: to as string | undefined,
      });
      res.json({ eventos });
    }),
  );

  // 14.7: gestion de usuarios administrativos. Solo ADMINISTRADOR. Sin
  // recuperacion/cambio de contrasena en este slice (pendiente, ver
  // usuarios.service.ts).
  router.get(
    "/admin/users",
    requireAuth(ROLES_GESTIONAN_USUARIOS),
    conManejoDeErrores(async (_req, res) => {
      const usuarios = await listarUsuarios(prisma);
      res.json({ usuarios });
    }),
  );

  router.post(
    "/admin/users",
    requireAuth(ROLES_GESTIONAN_USUARIOS),
    conManejoDeErrores(async (req, res) => {
      const { email, password, rol } = req.body ?? {};

      if (typeof email !== "string" || email.trim().length === 0) {
        return enviarError(res, 400, "email es requerido");
      }
      if (typeof password !== "string") {
        return enviarError(res, 400, "password es requerido");
      }
      if (typeof rol !== "string" || !ROLES_USUARIO.includes(rol as (typeof ROLES_USUARIO)[number])) {
        return enviarError(res, 400, `rol debe ser uno de: ${ROLES_USUARIO.join(", ")}`);
      }

      const resultado = await crearUsuario(prisma, { email, password, rol: rol as Rol });
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "USUARIO_CREADO", objetoTipo: "USUARIO", objetoId: resultado.usuario.id,
          valoresNuevos: { email, rol },
        });
        res.status(201).json({ user: resultado.usuario });
        return;
      }
      const status = resultado.motivo === "EMAIL_YA_EXISTE" ? 409 : 400;
      enviarError(res, status, resultado.motivo);
    }),
  );

  router.put(
    "/admin/users/:id",
    requireAuth(ROLES_GESTIONAN_USUARIOS),
    conManejoDeErrores(async (req, res) => {
      const { rol, activo } = req.body ?? {};

      if (rol === undefined && activo === undefined) {
        return enviarError(res, 400, "rol y/o activo son requeridos");
      }
      if (rol !== undefined && (typeof rol !== "string" || !ROLES_USUARIO.includes(rol as (typeof ROLES_USUARIO)[number]))) {
        return enviarError(res, 400, `rol debe ser uno de: ${ROLES_USUARIO.join(", ")}`);
      }
      if (activo !== undefined && typeof activo !== "boolean") {
        return enviarError(res, 400, "activo debe ser booleano");
      }

      const actor = actorDesde(req);
      const resultado = await actualizarUsuario(prisma, actor.userId, req.params.id!, { rol: rol as Rol | undefined, activo });
      if (resultado.ok) {
        await registrarEvento(prisma, actor, {
          accion: "USUARIO_ACTUALIZADO", objetoTipo: "USUARIO", objetoId: req.params.id!,
          valoresNuevos: { rol, activo },
        });
        res.status(200).json({ user: resultado.usuario });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADO" ? 404 : 403;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // Cambio de contrasena por el propio usuario (cualquier rol autenticado):
  // requiere conocer la actual.
  router.put(
    "/admin/me/password",
    requireAuth(),
    conManejoDeErrores(async (req, res) => {
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== "string" || currentPassword.length === 0) {
        return enviarError(res, 400, "currentPassword es requerido");
      }
      if (typeof newPassword !== "string") {
        return enviarError(res, 400, "newPassword es requerido");
      }

      const actor = actorDesde(req);
      const resultado = await cambiarContrasenaPropia(prisma, actor.userId, currentPassword, newPassword);
      if (resultado.ok) {
        await registrarEvento(prisma, actor, {
          accion: "USUARIO_CONTRASENA_CAMBIADA", objetoTipo: "USUARIO", objetoId: actor.userId,
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status =
        resultado.motivo === "NO_ENCONTRADO" ? 404 : resultado.motivo === "CONTRASENA_ACTUAL_INCORRECTA" ? 401 : 400;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // "Recuperacion" de contrasena (14.7, sin proveedor de notificaciones
  // todavia, ver usuarios.service.ts): solo ADMINISTRADOR, sin pedir la
  // actual — se comunica la nueva fuera del sistema.
  router.put(
    "/admin/users/:id/password",
    requireAuth(ROLES_GESTIONAN_USUARIOS),
    conManejoDeErrores(async (req, res) => {
      const { newPassword } = req.body ?? {};
      if (typeof newPassword !== "string") {
        return enviarError(res, 400, "newPassword es requerido");
      }

      const resultado = await restablecerContrasena(prisma, req.params.id!, newPassword);
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "USUARIO_CONTRASENA_RESETEADA", objetoTipo: "USUARIO", objetoId: req.params.id!,
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADO" ? 404 : 400;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 6.8, 14.7: activar/desactivar "pagar con tarjeta" visible al cliente.
  router.put(
    "/admin/services/:id/card-payment",
    requireAuth(ROLES_GESTIONAN_PAGOS),
    conManejoDeErrores(async (req, res) => {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return enviarError(res, 400, "enabled debe ser booleano");
      }

      const resultado = await establecerPagoTarjetaHabilitado(prisma, req.params.id!, enabled);
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "PAGO_TARJETA_ACTUALIZADO", objetoTipo: "SERVICIO", objetoId: req.params.id!,
          valoresNuevos: { enabled },
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "SERVICIO_NO_ENCONTRADO" ? 404 : 400;
      enviarError(res, status, resultado.motivo);
    }),
  );

  // 25, 14.7: switch global MANUAL/ONVO para la deteccion de pagos SINPE.
  router.get(
    "/admin/configuracion-pago",
    requireAuth(ROLES_GESTIONAN_PAGOS),
    conManejoDeErrores(async (_req, res) => {
      res.json({ modoSinpe: await obtenerModoSinpe(prisma) });
    }),
  );

  router.put(
    "/admin/configuracion-pago",
    requireAuth(ROLES_GESTIONAN_PAGOS),
    conManejoDeErrores(async (req, res) => {
      const { modoSinpe } = req.body ?? {};
      if (modoSinpe !== "MANUAL" && modoSinpe !== "ONVO") {
        return enviarError(res, 400, "modoSinpe debe ser MANUAL u ONVO");
      }

      const anterior = await obtenerModoSinpe(prisma);
      await establecerModoSinpe(prisma, modoSinpe);
      await registrarEvento(prisma, actorDesde(req), {
        accion: "MODO_SINPE_ACTUALIZADO", objetoTipo: "CONFIGURACION_PAGO", objetoId: "singleton",
        valoresAnteriores: { modoSinpe: anterior }, valoresNuevos: { modoSinpe },
      });
      res.status(200).json({ ok: true });
    }),
  );

  // 25: cobro de saldo al llegar al Race Park, iniciado por el staff desde
  // el panel (no por el cliente): por eso vive bajo /admin y usa los mismos
  // roles que validan SINPE (manejan dinero).
  // 28: confirma cuantas personas realmente llegaron (solo menos que lo
  // reservado; mas sin avisar se resuelve manualmente). Se llama antes de
  // cobrar el saldo si el numero difiere.
  router.put(
    "/admin/reservations/:publicCode/attendees",
    requireAuth(ROLES_VALIDAN_SINPE),
    conManejoDeErrores(async (req, res) => {
      const { cantidadReal } = req.body ?? {};
      if (typeof cantidadReal !== "number") {
        return enviarError(res, 400, "cantidadReal debe ser numero");
      }

      const resultado = await ajustarAsistentesReales(prisma, req.params.publicCode!, cantidadReal);
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "ASISTENTES_AJUSTADOS", objetoTipo: "RESERVA", objetoId: req.params.publicCode!,
          valoresNuevos: { cantidadReal },
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : resultado.motivo === "CANTIDAD_INVALIDA" ? 400 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  router.post(
    "/admin/reservations/:publicCode/balance/manual",
    requireAuth(ROLES_VALIDAN_SINPE),
    conManejoDeErrores(async (req, res) => {
      const resultado = await marcarSaldoPagadoManual(prisma, req.params.publicCode!);
      if (resultado.ok) {
        await registrarEvento(prisma, actorDesde(req), {
          accion: "SALDO_COBRADO_MANUAL", objetoTipo: "RESERVA", objetoId: req.params.publicCode!,
        });
        res.status(200).json({ ok: true });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : resultado.motivo === "MODO_INCORRECTO" ? 400 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  router.post(
    "/admin/reservations/:publicCode/balance/sinpe",
    requireAuth(ROLES_VALIDAN_SINPE),
    conManejoDeErrores(async (req, res) => {
      const { telefono, cedula } = req.body ?? {};
      if (typeof telefono !== "string" || telefono.length === 0) {
        return enviarError(res, 400, "telefono es requerido");
      }
      if (typeof cedula !== "string" || cedula.length === 0) {
        return enviarError(res, 400, "cedula es requerida");
      }

      const resultado = await crearIntencionSaldoOnvo(prisma, req.params.publicCode!, { telefono, cedula });
      if (resultado.ok) {
        res.status(200).json({ numeroSinpe: resultado.numeroSinpe, monto: resultado.monto, moneda: resultado.moneda });
        return;
      }
      const status =
        resultado.motivo === "NO_ENCONTRADA"
          ? 404
          : resultado.motivo === "ERROR_PROVEEDOR"
            ? 502
            : resultado.motivo === "MODO_INCORRECTO"
              ? 400
              : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  router.post(
    "/admin/reservations/:publicCode/balance/card",
    requireAuth(ROLES_VALIDAN_SINPE),
    conManejoDeErrores(async (req, res) => {
      const resultado = await crearSesionPagoSaldo(prisma, req.params.publicCode!);
      if (resultado.ok) {
        res.status(200).json({ checkoutUrl: resultado.checkoutUrl });
        return;
      }
      const status = resultado.motivo === "NO_ENCONTRADA" ? 404 : resultado.motivo === "ERROR_PROVEEDOR" ? 502 : 409;
      enviarError(res, status, resultado.motivo);
    }),
  );

  return router;
}
