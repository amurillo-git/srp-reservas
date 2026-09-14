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
import { iniciarSesion } from "../services/auth.service.js";
import { requireAuth } from "./auth.middleware.js";

/** 14.7: solo Administrador y Caja validan depositos SINPE. */
const ROLES_VALIDAN_SINPE = ["ADMINISTRADOR", "CAJA"] as const;

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

  return router;
}
