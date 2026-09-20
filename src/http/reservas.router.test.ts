import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { crearRouterReservas } from "./reservas.router.js";
import { FakePrisma } from "../services/testing/fake-prisma.js";
import { emitirToken, hashearContrasena } from "../services/auth.service.js";

// Pruebas HTTP de las rutas publicas (18.1) contra una app Express propia de
// esta suite (NO la de src/server.ts, que instancia un PrismaClient real) con
// el doble en memoria FakePrisma inyectado. Cubren la traduccion
// request/response — codigos de estado, validacion de forma — no la logica
// de negocio, que ya esta probada en motor-disponibilidad.test.ts y
// availability.service.test.ts.

beforeAll(() => {
  process.env.JWT_SECRET = "secreto-de-prueba-no-usar-en-produccion";
  process.env.ONVO_SECRET_KEY = "onvo_test_secret_key_fake";
  process.env.ONVO_WEBHOOK_SECRET = "webhook_secret_fake";
  process.env.WEB_APP_URL = "https://reservas.sarapiquiracepark.com";
});

function crearApp(prisma: PrismaClient): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", crearRouterReservas(prisma));
  return app;
}

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

/** Crea un admin en el fake y devuelve un encabezado Authorization valido
 * para las rutas /api/admin/*, sin pasar por el endpoint de login. */
async function tokenAdminDePrueba(fake: FakePrisma, rol: string = "ADMINISTRADOR") {
  const userId = `admin-${rol}`;
  const email = `${rol.toLowerCase()}@srp.test`;
  fake.crearUsuario({ id: userId, email, passwordHash: await hashearContrasena("clave-admin"), rol });
  return `Bearer ${emitirToken({ userId, email, rol })}`;
}

const SERVICIO_ID = "svc-1";
const FECHA_ISO = "2026-09-13";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");
const DIA_SEMANA_DOMINGO = 0; // FECHA_DATE.getUTCDay() === 0

function crearFixtureBase(fake: FakePrisma): void {
  fake.crearServicio({
    id: SERVICIO_ID, nombre: "Karts", slug: "karts", moneda: "CRC",
    precioPorPersonaGrupoPequeno: 4000, precioPorPersonaGrupoGrande: 4000, porcentajeDeposito: 50,
  });
  fake.crearPlantilla({
    id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DIA_SEMANA_DOMINGO,
    horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30", activo: true,
  });
}

describe("GET /api/services", () => {
  it("devuelve solo los servicios activos", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-activo", nombre: "Karts", slug: "karts", activo: true });
    fake.crearServicio({ id: "svc-inactivo", nombre: "RC (fuera de alcance)", slug: "rc", activo: false });

    const respuesta = await request(crearApp(comoPrisma(fake))).get("/api/services");

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.servicios).toHaveLength(1);
    expect(respuesta.body.servicios[0].id).toBe("svc-activo");
  });
});

describe("GET /api/availability/dates", () => {
  it("valida los parametros requeridos", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));

    expect((await request(app).get("/api/availability/dates?month=2026-09&partySize=5")).status).toBe(400);
    expect((await request(app).get(`/api/availability/dates?serviceId=${SERVICIO_ID}&partySize=5`)).status).toBe(400);
    expect((await request(app).get(`/api/availability/dates?serviceId=${SERVICIO_ID}&month=2026-09`)).status).toBe(400);
    expect(
      (await request(app).get(`/api/availability/dates?serviceId=${SERVICIO_ID}&month=2026-9&partySize=5`)).status,
    ).toBe(400);
  });

  it("devuelve las fechas del mes con disponibilidad para el tamano de grupo pedido", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);

    const respuesta = await request(crearApp(comoPrisma(fake))).get(
      `/api/availability/dates?serviceId=${SERVICIO_ID}&month=2026-09&partySize=5`,
    );

    expect(respuesta.status).toBe(200);
    // La plantilla solo abre domingo (diaSemana 0): en septiembre 2026 caen
    // los domingos 6, 13, 20 y 27.
    expect(respuesta.body.fechasDisponibles).toEqual(["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"]);
  });
});

describe("GET /api/availability/times", () => {
  it("valida los parametros requeridos", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));

    expect((await request(app).get(`/api/availability/times?date=${FECHA_ISO}&partySize=5`)).status).toBe(400);
    expect((await request(app).get(`/api/availability/times?serviceId=${SERVICIO_ID}&partySize=5`)).status).toBe(400);
    expect(
      (await request(app).get(`/api/availability/times?serviceId=${SERVICIO_ID}&date=13-09-2026&partySize=5`)).status,
    ).toBe(400);
  });

  it("devuelve las horas validas de un dia vacio para un grupo de 5 (9.4)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);

    const respuesta = await request(crearApp(comoPrisma(fake))).get(
      `/api/availability/times?serviceId=${SERVICIO_ID}&date=${FECHA_ISO}&partySize=5`,
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.horasDisponibles[0]).toBe("09:00");
    expect(respuesta.body.horasDisponibles).toContain("11:30");
    expect(respuesta.body.horasDisponibles).not.toContain("11:45"); // cruzaria el almuerzo (DISP-007)
  });
});

describe("POST /api/availability/quote", () => {
  it("valida el cuerpo de la solicitud", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app).post("/api/availability/quote").send({ serviceId: SERVICIO_ID });
    expect(respuesta.status).toBe(400);
  });

  it("devuelve el plan disponible para una hora candidata valida", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);

    const respuesta = await request(crearApp(comoPrisma(fake)))
      .post("/api/availability/quote")
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5 });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.plan.disponible).toBe(true);
  });
});

describe("POST /api/reservations", () => {
  const solicitudValida = {
    serviceId: SERVICIO_ID,
    date: FECHA_ISO,
    startTime: "09:00",
    partySize: 5,
    customer: { name: "Ana", phone: "8888-0000" },
  };

  it("exige el encabezado Idempotency-Key", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app).post("/api/reservations").send(solicitudValida);
    expect(respuesta.status).toBe(400);
  });

  it("valida el cuerpo de la solicitud", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", "idem-1")
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5 }); // sin customer
    expect(respuesta.status).toBe(400);
  });

  it("crea la reserva y devuelve 201 con el codigo publico", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);

    const respuesta = await request(crearApp(comoPrisma(fake)))
      .post("/api/reservations")
      .set("Idempotency-Key", "idem-http-1")
      .send(solicitudValida);

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.exito).toBe(true);
    expect(respuesta.body.codigoPublico).toBeTruthy();
    expect(fake.reservas).toHaveLength(1);
  });

  it("devuelve 409 cuando la fecha no tiene disponibilidad", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });
    fake.crearPlantilla({ id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DIA_SEMANA_DOMINGO, activo: false }); // fecha cerrada

    const respuesta = await request(crearApp(comoPrisma(fake)))
      .post("/api/reservations")
      .set("Idempotency-Key", "idem-http-cerrado")
      .send(solicitudValida);

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.exito).toBe(false);
    expect(respuesta.body.motivo).toBe("NO_DISPONIBLE");
  });
});

describe("GET /api/reservations/:publicCode", () => {
  it("devuelve 404 si el codigo no existe", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app).get("/api/reservations/SRP-NOEXISTE");
    expect(respuesta.status).toBe(404);
  });

  it("devuelve el estado publico de una reserva ya creada, sin exponer la limpieza", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));

    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", "idem-http-consulta")
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    const codigoPublico: string = creacion.body.codigoPublico;

    const respuesta = await request(app).get(`/api/reservations/${codigoPublico}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toMatchObject({
      codigoPublico,
      estado: "TEMPORAL",
      fecha: FECHA_ISO,
      cantidadPersonas: 5,
    });
    expect(respuesta.body.lotes).toEqual([
      { heats: [{ horaInicio: "09:00", horaFin: "09:15", personas: 5 }] },
    ]);
    expect(JSON.stringify(respuesta.body)).not.toContain("horaFinLimpieza");
    expect("liberacionOperativa" in respuesta.body).toBe(false);
  });

  it("incluye expiraEn y si el servicio tiene pago con tarjeta habilitado, para que el cliente pueda retomar el pago (14.8)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.servicios[0]!.pagoTarjetaHabilitado = true;
    const app = crearApp(comoPrisma(fake));

    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", "idem-http-consulta-expira")
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    const codigoPublico: string = creacion.body.codigoPublico;

    const respuesta = await request(app).get(`/api/reservations/${codigoPublico}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.pagoTarjetaHabilitado).toBe(true);
    expect(typeof respuesta.body.expiraEn).toBe("string");
    expect(new Date(respuesta.body.expiraEn).getTime()).toBeGreaterThan(Date.now());
  });

  it("devuelve expiraEn null y pagoTarjetaHabilitado false para una reserva ya confirmada por SINPE", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", "idem-http-consulta-confirmada")
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    const codigoPublico: string = creacion.body.codigoPublico;
    await request(app).post(`/api/reservations/${codigoPublico}/sinpe-evidence`).send({});
    await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth);

    const respuesta = await request(app).get(`/api/reservations/${codigoPublico}`);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.pagoTarjetaHabilitado).toBe(false);
    expect(respuesta.body.expiraEn).toBeNull();
  });
});

describe("flujo SINPE (POST .../sinpe-evidence, admin confirm/reject-sinpe)", () => {
  async function crearReservaTemporal(app: Express): Promise<string> {
    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", `idem-sinpe-${Date.now()}-${Math.random()}`)
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    return creacion.body.codigoPublico as string;
  }

  it("reporta el comprobante, queda pendiente de validacion, y un admin autenticado lo aprueba (6.9.1-7)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);
    const auth = await tokenAdminDePrueba(fake);

    const reporte = await request(app)
      .post(`/api/reservations/${codigoPublico}/sinpe-evidence`)
      .send({ nombrePagador: "Ana Perez", referencia: "REF-1" });
    expect(reporte.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe(
      "PENDIENTE_VALIDACION_SINPE",
    );

    const aprobacion = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth);
    expect(aprobacion.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("CONFIRMADA");
  });

  it("28: al aprobar con un monto distinto, recalcula el deposito y el saldo pendiente", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);
    const auth = await tokenAdminDePrueba(fake);
    await request(app).post(`/api/reservations/${codigoPublico}/sinpe-evidence`).send({});

    const reservaAntes = fake.reservas.find((r) => r.codigoPublico === codigoPublico)!;
    const montoPagado = Number(reservaAntes.montoTotal); // pago el 100%, no solo el deposito

    const aprobacion = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth)
      .send({ montoPagado });
    expect(aprobacion.status).toBe(200);

    const reserva = fake.reservas.find((r) => r.codigoPublico === codigoPublico)!;
    expect(reserva.montoDeposito).toBe(montoPagado);
    expect(reserva.montoSaldo).toBe(0);
  });

  it("28: devuelve 400 si montoPagado no es numero, y 400 si es 0 o negativo", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);
    const auth = await tokenAdminDePrueba(fake);
    await request(app).post(`/api/reservations/${codigoPublico}/sinpe-evidence`).send({});

    const noNumero = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth)
      .send({ montoPagado: "mucho" });
    expect(noNumero.status).toBe(400);

    const cero = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth)
      .send({ montoPagado: 0 });
    expect(cero.status).toBe(400);
  });

  it("un admin autenticado puede rechazar un comprobante pendiente, exigiendo un motivo (6.9.8)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);
    const auth = await tokenAdminDePrueba(fake, "CAJA");
    await request(app).post(`/api/reservations/${codigoPublico}/sinpe-evidence`).send({});

    const sinMotivo = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/reject-sinpe`)
      .set("Authorization", auth)
      .send({});
    expect(sinMotivo.status).toBe(400);

    const rechazo = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/reject-sinpe`)
      .set("Authorization", auth)
      .send({ motivo: "Comprobante ilegible" });
    expect(rechazo.status).toBe(200);
    const reserva = fake.reservas.find((r) => r.codigoPublico === codigoPublico)!;
    expect(reserva.estado).toBe("RECHAZADA");
    expect(reserva.motivoRechazo).toBe("Comprobante ilegible");
  });

  it("devuelve 404 al reportar un comprobante para un codigo inexistente", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app).post("/api/reservations/SRP-NOEXISTE/sinpe-evidence").send({});
    expect(respuesta.status).toBe(404);
  });

  it("devuelve 409 al aprobar SINPE de una reserva que no esta pendiente de validacion", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app); // sigue TEMPORAL, nunca se reporto comprobante
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth);
    expect(respuesta.status).toBe(409);
  });

  it("rechaza sin token (401) y con un rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);

    const sinToken = await request(app).post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`);
    expect(sinToken.status).toBe(401);

    const tokenInvalido = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", "Bearer esto-no-es-un-token-valido");
    expect(tokenInvalido.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "ATENCION"); // rol fuera de ROLES_VALIDAN_SINPE
    const sinPermiso = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });
});

describe("flujo de pago con tarjeta (POST .../card-payment, POST /webhooks/onvo)", () => {
  async function crearReservaTemporal(app: Express): Promise<string> {
    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", `idem-tarjeta-${Date.now()}-${Math.random()}`)
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    return creacion.body.codigoPublico as string;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("crea la sesion de Checkout y, cuando ONVO notifica el pago, confirma la reserva (6.8)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.servicios[0]!.pagoTarjetaHabilitado = true;
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "clcs0001", url: "https://checkout.onvopay.com/pay/clcs0001" }), { status: 201 })),
    );

    const sesion = await request(app).post(`/api/reservations/${codigoPublico}/card-payment`);
    expect(sesion.status).toBe(200);
    expect(sesion.body.checkoutUrl).toBe("https://checkout.onvopay.com/pay/clcs0001");
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("TEMPORAL");

    const webhook = await request(app)
      .post("/api/webhooks/onvo")
      .set("X-Webhook-Secret", "webhook_secret_fake")
      .send({ type: "checkout-session.succeeded", data: { id: "clcs0001", paymentStatus: "paid" } });
    expect(webhook.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("CONFIRMADA");
  });

  it("devuelve 404 al crear una sesion de pago para un codigo inexistente", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app).post("/api/reservations/SRP-NOEXISTE/card-payment");
    expect(respuesta.status).toBe(404);
  });

  it("devuelve 502 si ONVO responde con error al crear la sesion", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.servicios[0]!.pagoTarjetaHabilitado = true;
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));

    const respuesta = await request(app).post(`/api/reservations/${codigoPublico}/card-payment`);
    expect(respuesta.status).toBe(502);
  });

  it("rechaza el webhook (401) si el X-Webhook-Secret no coincide", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app)
      .post("/api/webhooks/onvo")
      .set("X-Webhook-Secret", "secreto-incorrecto")
      .send({ type: "checkout-session.succeeded", data: { id: "clcs0001", paymentStatus: "paid" } });
    expect(respuesta.status).toBe(401);
  });

  it("devuelve 409 si el servicio tiene apagado el pago con tarjeta", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake); // pagoTarjetaHabilitado queda en false por defecto
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);

    const respuesta = await request(app).post(`/api/reservations/${codigoPublico}/card-payment`);

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.error).toBe("DESHABILITADO");
  });
});

describe("configuracion-pago (25): switch global SINPE manual/ONVO", () => {
  it("GET /api/configuracion-pago devuelve MANUAL por defecto (publica, sin auth)", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    const respuesta = await request(app).get("/api/configuracion-pago");
    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({ modoSinpe: "MANUAL" });
  });

  it("GET/PUT /api/admin/configuracion-pago requieren auth y registran auditoria", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app).get("/api/admin/configuracion-pago");
    expect(sinToken.status).toBe(401);

    const auth = await tokenAdminDePrueba(fake);
    const cambio = await request(app)
      .put("/api/admin/configuracion-pago")
      .set("Authorization", auth)
      .send({ modoSinpe: "ONVO" });
    expect(cambio.status).toBe(200);

    const lectura = await request(app).get("/api/admin/configuracion-pago").set("Authorization", auth);
    expect(lectura.body).toEqual({ modoSinpe: "ONVO" });

    const evento = fake.eventosAuditoria.find((e) => e.accion === "MODO_SINPE_ACTUALIZADO");
    expect(evento?.valoresAnteriores).toEqual({ modoSinpe: "MANUAL" });
    expect(evento?.valoresNuevos).toEqual({ modoSinpe: "ONVO" });
  });

  it("PUT /api/admin/configuracion-pago valida el valor de modoSinpe", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .put("/api/admin/configuracion-pago")
      .set("Authorization", auth)
      .send({ modoSinpe: "OTRO" });
    expect(respuesta.status).toBe(400);
  });
});

describe("flujo SINPE automatico via ONVO (POST .../sinpe-intent, 25)", () => {
  async function crearReservaTemporal(app: Express): Promise<string> {
    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", `idem-sinpe-onvo-${Date.now()}-${Math.random()}`)
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    return creacion.body.codigoPublico as string;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("crea la intencion en ONVO y, cuando notifica el pago, confirma la reserva", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    await request(app).put("/api/admin/configuracion-pago").set("Authorization", auth).send({ modoSinpe: "ONVO" });
    const codigoPublico = await crearReservaTemporal(app);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.onvopay.com/v1/payment-intents") {
          return new Response(JSON.stringify({ id: "clpiment0001" }), { status: 201 });
        }
        if (url === "https://api.onvopay.com/v1/payment-methods") {
          return new Response(JSON.stringify({ id: "clpm0001" }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: "clpiment0001" }), { status: 200 });
      }),
    );

    const intencion = await request(app)
      .post(`/api/reservations/${codigoPublico}/sinpe-intent`)
      .send({ telefono: "+50688888888", cedula: "1-1111-1111" });
    expect(intencion.status).toBe(200);
    expect(intencion.body).toEqual({ numeroSinpe: "+50670196686", monto: expect.any(Number), moneda: "CRC" });
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("TEMPORAL");

    const webhook = await request(app)
      .post("/api/webhooks/onvo")
      .set("X-Webhook-Secret", "webhook_secret_fake")
      .send({ type: "payment-intent.succeeded", data: { id: "clpiment0001" } });
    expect(webhook.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("CONFIRMADA");
  });

  it("devuelve 400 si el modo global sigue en MANUAL", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);

    const respuesta = await request(app)
      .post(`/api/reservations/${codigoPublico}/sinpe-intent`)
      .send({ telefono: "+50688888888", cedula: "1-1111-1111" });
    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toBe("MODO_INCORRECTO");
  });

  it("valida que telefono y cedula sean requeridos", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaTemporal(app);

    const respuesta = await request(app).post(`/api/reservations/${codigoPublico}/sinpe-intent`).send({});
    expect(respuesta.status).toBe(400);
  });
});

describe("cobro de saldo al llegar al parque (POST /admin/reservations/:code/balance/*, 25)", () => {
  async function crearReservaConfirmada(fake: FakePrisma, app: Express): Promise<string> {
    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", `idem-saldo-${Date.now()}-${Math.random()}`)
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    const codigoPublico: string = creacion.body.codigoPublico;
    await request(app).post(`/api/reservations/${codigoPublico}/sinpe-evidence`).send({});
    const auth = await tokenAdminDePrueba(fake);
    await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`)
      .set("Authorization", auth);
    return codigoPublico;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("balance/manual marca la reserva PAGADA y registra auditoria (modo MANUAL, por defecto)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaConfirmada(fake, app);
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/balance/manual`)
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("PAGADA");
    expect(fake.eventosAuditoria.find((e) => e.accion === "SALDO_COBRADO_MANUAL")).toBeTruthy();
  });

  it("balance/manual rechaza sin token (401) y con rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaConfirmada(fake, app);

    const sinToken = await request(app).post(`/api/admin/reservations/${codigoPublico}/balance/manual`);
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "OPERACION");
    const sinPermiso = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/balance/manual`)
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });

  it("balance/sinpe crea la intencion en ONVO y, cuando notifica, la reserva pasa a PAGADA (modo ONVO)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    await request(app).put("/api/admin/configuracion-pago").set("Authorization", auth).send({ modoSinpe: "ONVO" });
    const codigoPublico = await crearReservaConfirmada(fake, app);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.onvopay.com/v1/payment-intents") {
          return new Response(JSON.stringify({ id: "clpiment-saldo-http" }), { status: 201 });
        }
        if (url === "https://api.onvopay.com/v1/payment-methods") {
          return new Response(JSON.stringify({ id: "clpm-saldo-http" }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: "clpiment-saldo-http" }), { status: 200 });
      }),
    );

    const intencion = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/balance/sinpe`)
      .set("Authorization", auth)
      .send({ telefono: "+50688888888", cedula: "1-1111-1111" });
    expect(intencion.status).toBe(200);
    expect(intencion.body.numeroSinpe).toBe("+50670196686");

    const webhook = await request(app)
      .post("/api/webhooks/onvo")
      .set("X-Webhook-Secret", "webhook_secret_fake")
      .send({ type: "payment-intent.succeeded", data: { id: "clpiment-saldo-http" } });
    expect(webhook.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("PAGADA");
  });

  it("balance/card crea la sesion de checkout por el monto del saldo", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.servicios[0]!.pagoTarjetaHabilitado = true;
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaConfirmada(fake, app);
    const auth = await tokenAdminDePrueba(fake);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "clcs-saldo-http", url: "https://checkout.onvopay.com/pay/clcs-saldo-http" }), { status: 201 })),
    );

    const respuesta = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/balance/card`)
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.checkoutUrl).toBe("https://checkout.onvopay.com/pay/clcs-saldo-http");
  });

  it("28: PUT .../attendees recalcula el total y el saldo cuando llegan menos personas, y registra auditoria", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaConfirmada(fake, app);
    const auth = await tokenAdminDePrueba(fake);
    const reservaAntes = fake.reservas.find((r) => r.codigoPublico === codigoPublico)!;
    expect(reservaAntes.cantidadPersonas).toBe(5);

    const respuesta = await request(app)
      .put(`/api/admin/reservations/${codigoPublico}/attendees`)
      .set("Authorization", auth)
      .send({ cantidadReal: 3 });

    expect(respuesta.status).toBe(200);
    const reserva = fake.reservas.find((r) => r.codigoPublico === codigoPublico)!;
    expect(reserva.cantidadPersonas).toBe(3);
    expect(fake.eventosAuditoria.find((e) => e.accion === "ASISTENTES_AJUSTADOS")).toBeTruthy();
  });

  it("28: PUT .../attendees devuelve 400 si cantidadReal es mayor a la reservada", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const codigoPublico = await crearReservaConfirmada(fake, app);
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .put(`/api/admin/reservations/${codigoPublico}/attendees`)
      .set("Authorization", auth)
      .send({ cantidadReal: 10 });

    expect(respuesta.status).toBe(400);
  });
});

describe("/api/admin/reports (25)", () => {
  function crearReservaEnFake(fake: FakePrisma, id: string, fecha: Date, estado: string) {
    fake.reservas.push({
      id, codigoPublico: `SRP-${id}`, servicioId: SERVICIO_ID, fecha, cantidadPersonas: 2, estado,
      moneda: "CRC", montoTotal: 8000, montoDeposito: 4000, montoSaldo: 4000,
      claveIdempotencia: `idem-${id}`, clienteNombre: "Cliente", clienteTelefono: "88888888", expiraEn: null,
    });
  }

  it("devuelve el reporte de reservas por fecha y estado a un admin autenticado", async () => {
    const fake = new FakePrisma();
    crearReservaEnFake(fake, "1", new Date("2026-09-10"), "CONFIRMADA");
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/reports/reservations-by-date-status")
      .query({ serviceId: SERVICIO_ID, from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.reporte).toEqual([{ fecha: "2026-09-10", estado: "CONFIRMADA", cantidad: 1 }]);
  });

  it("14.1: devuelve la lista de reservas de un dia puntual (no solo el conteo)", async () => {
    const fake = new FakePrisma();
    crearReservaEnFake(fake, "1", new Date("2026-09-10"), "CONFIRMADA");
    crearReservaEnFake(fake, "2", new Date("2026-09-11"), "CONFIRMADA"); // otro dia, no debe salir
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/reports/reservations-of-day")
      .query({ serviceId: SERVICIO_ID, date: "2026-09-10" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.reporte).toEqual([
      { codigoPublico: "SRP-1", fecha: "2026-09-10", cantidadPersonas: 2, clienteNombre: "Cliente", clienteTelefono: "88888888", estado: "CONFIRMADA" },
    ]);
  });

  it("valida from/to con el formato YYYY-MM-DD", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/reports/reservations-by-date-status")
      .query({ serviceId: SERVICIO_ID, from: "no-es-una-fecha", to: "2026-09-30" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(400);
  });

  it("rechaza sin token (401) y con un rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app)
      .get("/api/admin/reports/pending-sinpe")
      .query({ serviceId: SERVICIO_ID });
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "ATENCION");
    const sinPermiso = await request(app)
      .get("/api/admin/reports/pending-sinpe")
      .query({ serviceId: SERVICIO_ID })
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });

  it("devuelve el reporte de ocupacion para un dia puntual", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/reports/occupancy")
      .query({ serviceId: SERVICIO_ID, date: "2026-09-10" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.reporte).toEqual([]);
  });

  it("devuelve el reporte de cancelaciones y reprogramaciones como objeto (no arreglo)", async () => {
    const fake = new FakePrisma();
    crearReservaEnFake(fake, "1", new Date("2026-09-10"), "CANCELADA");
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/reports/cancellations-and-reschedules")
      .query({ serviceId: SERVICIO_ID, from: "2026-09-01", to: "2026-09-30" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({ cancelaciones: 1, reprogramaciones: 0 });
  });
});

describe("POST /api/admin/login", () => {
  it("valida email y password", async () => {
    const app = crearApp(comoPrisma(new FakePrisma()));
    expect((await request(app).post("/api/admin/login").send({ email: "a@srp.test" })).status).toBe(400);
  });

  it("devuelve un token con credenciales correctas", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({
      id: "u1", email: "admin@srp.test",
      passwordHash: await hashearContrasena("clave-correcta"), rol: "ADMINISTRADOR",
    });

    const respuesta = await request(crearApp(comoPrisma(fake)))
      .post("/api/admin/login")
      .send({ email: "admin@srp.test", password: "clave-correcta" });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.token).toBeTruthy();
    expect(respuesta.body.rol).toBe("ADMINISTRADOR");
  });

  it("devuelve 401 con credenciales incorrectas", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u1", email: "admin@srp.test", passwordHash: await hashearContrasena("clave-correcta") });

    const respuesta = await request(crearApp(comoPrisma(fake)))
      .post("/api/admin/login")
      .send({ email: "admin@srp.test", password: "incorrecta" });

    expect(respuesta.status).toBe(401);
  });
});

describe("/api/admin/blocks", () => {
  async function crearReservaTemporal(app: Express): Promise<string> {
    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", `idem-block-${Date.now()}-${Math.random()}`)
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    return creacion.body.codigoPublico as string;
  }

  it("crea un bloqueo sin conflicto (201)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .post("/api/admin/blocks")
      .set("Authorization", auth)
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "10:00", endTime: "11:00", reason: "Mantenimiento" });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.blockId).toBeTruthy();
    expect(fake.bloqueos).toHaveLength(1);
  });

  it("registra un evento de auditoria (21) al crear y al eliminar un bloqueo", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const creacion = await request(app)
      .post("/api/admin/blocks")
      .set("Authorization", auth)
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "10:00", endTime: "11:00" });
    await request(app).delete(`/api/admin/blocks/${creacion.body.blockId}`).set("Authorization", auth);

    expect(fake.eventosAuditoria.map((e) => e.accion)).toEqual(["BLOQUEO_CREADO", "BLOQUEO_ELIMINADO"]);
    expect(fake.eventosAuditoria[0]).toMatchObject({ objetoTipo: "BLOQUEO", objetoId: creacion.body.blockId });
  });

  it("9.22: devuelve 409 con las reservas en conflicto y no crea nada sin force", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const codigoPublico = await crearReservaTemporal(app); // heat en 09:00-09:15, TEMPORAL

    const respuesta = await request(app)
      .post("/api/admin/blocks")
      .set("Authorization", auth)
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", endTime: "09:30" });

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.reservasEnConflicto).toEqual([
      expect.objectContaining({ codigoPublico }),
    ]);
    expect(fake.bloqueos).toHaveLength(0);
  });

  it("crea el bloqueo pese al conflicto si force:true", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    await crearReservaTemporal(app);

    const respuesta = await request(app)
      .post("/api/admin/blocks")
      .set("Authorization", auth)
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", endTime: "09:30", force: true });

    expect(respuesta.status).toBe(201);
    expect(fake.bloqueos).toHaveLength(1);
  });

  it("lista y elimina bloqueos; exige autenticacion", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const sinToken = await request(app).get(`/api/admin/blocks?serviceId=${SERVICIO_ID}&date=${FECHA_ISO}`);
    expect(sinToken.status).toBe(401);

    const creacion = await request(app)
      .post("/api/admin/blocks")
      .set("Authorization", auth)
      .send({ serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "10:00", endTime: "11:00" });
    const blockId = creacion.body.blockId as string;

    const listado = await request(app)
      .get(`/api/admin/blocks?serviceId=${SERVICIO_ID}&date=${FECHA_ISO}`)
      .set("Authorization", auth);
    expect(listado.body.bloqueos).toHaveLength(1);

    const eliminacion = await request(app).delete(`/api/admin/blocks/${blockId}`).set("Authorization", auth);
    expect(eliminacion.status).toBe(200);
    expect(fake.bloqueos).toHaveLength(0);

    const eliminacionOtraVez = await request(app).delete(`/api/admin/blocks/${blockId}`).set("Authorization", auth);
    expect(eliminacionOtraVez.status).toBe(404);
  });
});

describe("GET /api/admin/reservations/search (14.5)", () => {
  function crearReservaEnFake(fake: FakePrisma, datos: { id: string; fecha: Date; estado: string; clienteNombre?: string; clienteTelefono?: string }) {
    fake.reservas.push({
      id: datos.id, codigoPublico: `SRP-${datos.id}`, servicioId: SERVICIO_ID, fecha: datos.fecha,
      cantidadPersonas: 2, estado: datos.estado, moneda: "CRC", montoTotal: 8000, montoDeposito: 4000, montoSaldo: 4000,
      claveIdempotencia: `idem-${datos.id}`, clienteNombre: datos.clienteNombre ?? "Cliente", clienteTelefono: datos.clienteTelefono ?? "88888888",
      expiraEn: null,
    });
  }

  it("devuelve reservas del servicio sin filtros, mas recientes primero", async () => {
    const fake = new FakePrisma();
    crearReservaEnFake(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA" });
    crearReservaEnFake(fake, { id: "2", fecha: new Date("2026-09-12"), estado: "CONFIRMADA" });
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/reservations/search")
      .query({ serviceId: SERVICIO_ID })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.reservas.map((r: { codigoPublico: string }) => r.codigoPublico)).toEqual(["SRP-2", "SRP-1"]);
  });

  it("filtra por texto libre (q) y por estado", async () => {
    const fake = new FakePrisma();
    crearReservaEnFake(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", clienteNombre: "Ana Perez" });
    crearReservaEnFake(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CANCELADA", clienteNombre: "Beto Soto" });
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const porTexto = await request(app)
      .get("/api/admin/reservations/search")
      .query({ serviceId: SERVICIO_ID, q: "ana" })
      .set("Authorization", auth);
    expect(porTexto.body.reservas.map((r: { codigoPublico: string }) => r.codigoPublico)).toEqual(["SRP-1"]);

    const porEstado = await request(app)
      .get("/api/admin/reservations/search")
      .query({ serviceId: SERVICIO_ID, status: "CANCELADA" })
      .set("Authorization", auth);
    expect(porEstado.body.reservas.map((r: { codigoPublico: string }) => r.codigoPublico)).toEqual(["SRP-2"]);
  });

  it("valida serviceId requerido y el formato de from/to", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const sinServicio = await request(app).get("/api/admin/reservations/search").set("Authorization", auth);
    expect(sinServicio.status).toBe(400);

    const fechaInvalida = await request(app)
      .get("/api/admin/reservations/search")
      .query({ serviceId: SERVICIO_ID, from: "no-es-una-fecha" })
      .set("Authorization", auth);
    expect(fechaInvalida.status).toBe(400);

    const estadoInvalido = await request(app)
      .get("/api/admin/reservations/search")
      .query({ serviceId: SERVICIO_ID, status: "NO_EXISTE" })
      .set("Authorization", auth);
    expect(estadoInvalido.status).toBe(400);
  });

  it("rechaza sin token (401) y con un rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app).get("/api/admin/reservations/search").query({ serviceId: SERVICIO_ID });
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "CAJA"); // fuera de ROLES_GESTIONAN_RESERVAS
    const sinPermiso = await request(app)
      .get("/api/admin/reservations/search")
      .query({ serviceId: SERVICIO_ID })
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });
});

describe("/api/admin/reservations/:publicCode/cancel y /reschedule (14.5-14.6)", () => {
  async function crearReservaConfirmada(app: Express, auth: string): Promise<string> {
    const creacion = await request(app)
      .post("/api/reservations")
      .set("Idempotency-Key", `idem-gestion-${Date.now()}-${Math.random()}`)
      .send({
        serviceId: SERVICIO_ID, date: FECHA_ISO, startTime: "09:00", partySize: 5,
        customer: { name: "Ana", phone: "8888-0000" },
      });
    const codigoPublico = creacion.body.codigoPublico as string;
    await request(app).post(`/api/reservations/${codigoPublico}/sinpe-evidence`).send({});
    await request(app).post(`/api/admin/reservations/${codigoPublico}/confirm-sinpe`).set("Authorization", auth);
    return codigoPublico;
  }

  it("cancela una reserva CONFIRMADA (200)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const codigoPublico = await crearReservaConfirmada(app, auth);

    const respuesta = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/cancel`)
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.estado).toBe("CANCELADA");
  });

  it("registra un evento de auditoria (21) al cancelar y al reprogramar", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const codigoPublico = await crearReservaConfirmada(app, auth); // ya deja un evento SINPE_APROBADO
    const eventosPrevios = fake.eventosAuditoria.length;

    await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/reschedule`)
      .set("Authorization", auth)
      .send({ date: FECHA_ISO, startTime: "10:00", partySize: 5 });
    await request(app).post(`/api/admin/reservations/${codigoPublico}/cancel`).set("Authorization", auth);

    const acciones = fake.eventosAuditoria.slice(eventosPrevios).map((e) => e.accion);
    expect(acciones).toEqual(["RESERVA_REPROGRAMADA", "RESERVA_CANCELADA"]);
    expect(fake.eventosAuditoria.at(-1)).toMatchObject({
      actorEmail: "administrador@srp.test", objetoTipo: "RESERVA", objetoId: codigoPublico,
    });
  });

  it("devuelve 404 al cancelar un codigo inexistente y 409 al cancelar dos veces", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const noExiste = await request(app)
      .post("/api/admin/reservations/SRP-NOEXISTE/cancel")
      .set("Authorization", auth);
    expect(noExiste.status).toBe(404);

    const codigoPublico = await crearReservaConfirmada(app, auth);
    await request(app).post(`/api/admin/reservations/${codigoPublico}/cancel`).set("Authorization", auth);
    const segundaVez = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/cancel`)
      .set("Authorization", auth);
    expect(segundaVez.status).toBe(409);
  });

  it("reprograma una reserva CONFIRMADA a otro horario (200) validando el cuerpo", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const codigoPublico = await crearReservaConfirmada(app, auth);

    const cuerpoInvalido = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/reschedule`)
      .set("Authorization", auth)
      .send({ date: FECHA_ISO, startTime: "10:00" }); // sin partySize
    expect(cuerpoInvalido.status).toBe(400);

    const respuesta = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/reschedule`)
      .set("Authorization", auth)
      .send({ date: FECHA_ISO, startTime: "10:00", partySize: 5 });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.plan).toBeTruthy();
    expect(fake.reservas.find((r) => r.codigoPublico === codigoPublico)!.cantidadPersonas).toBe(5);
  });

  it("devuelve 409 NO_DISPONIBLE si el nuevo horario no cabe", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const codigoPublico = await crearReservaConfirmada(app, auth);

    const respuesta = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/reschedule`)
      .set("Authorization", auth)
      .send({ date: FECHA_ISO, startTime: "12:00", partySize: 5 }); // hora de almuerzo: cerrado

    expect(respuesta.status).toBe(409);
  });

  it("rechaza sin token (401) y con un rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const codigoPublico = await crearReservaConfirmada(app, auth);

    const sinToken = await request(app).post(`/api/admin/reservations/${codigoPublico}/cancel`);
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "OPERACION"); // fuera de ROLES_GESTIONAN_RESERVAS
    const sinPermiso = await request(app)
      .post(`/api/admin/reservations/${codigoPublico}/cancel`)
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });
});

describe("GET /api/admin/services/:serviceId/operational-calendar (14.2)", () => {
  it("devuelve lotes, heats, ventana del dia y bloqueos para un admin autenticado", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFinUltimoHeat: "09:15", horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });
    fake.crearBloqueo({ id: "blk-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:30" });
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/operational-calendar`)
      .query({ date: FECHA_ISO })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.ventanas).toEqual([
      { horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30" },
    ]);
    expect(respuesta.body.lotes).toHaveLength(1);
    expect(respuesta.body.lotes[0].heats).toEqual([
      { heatId: "heat-1", horaInicio: "09:00", horaFin: "09:15", capacidadMaxima: 5, reservas: [] },
    ]);
    expect(respuesta.body.bloqueos).toHaveLength(1);
  });

  it("valida el formato de date", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/operational-calendar`)
      .query({ date: "no-es-una-fecha" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(400);
  });

  it("permite el rol OPERACION y rechaza sin token (401) o con un rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/operational-calendar`)
      .query({ date: FECHA_ISO });
    expect(sinToken.status).toBe(401);

    const authOperacion = await tokenAdminDePrueba(fake, "OPERACION");
    const conOperacion = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/operational-calendar`)
      .query({ date: FECHA_ISO })
      .set("Authorization", authOperacion);
    expect(conOperacion.status).toBe(200);

    const authSinPermiso = await tokenAdminDePrueba(fake, "CAJA");
    const sinPermiso = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/operational-calendar`)
      .query({ date: FECHA_ISO })
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });
});

describe("/api/admin/services/:serviceId/schedule (14.3)", () => {
  it("crea/actualiza (upsert) la plantilla semanal de un dia", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const creacion = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/schedule/weekly/0`)
      .set("Authorization", auth)
      .send({ openTime: "09:00", closeTime: "16:00", lunchStart: "12:00", lunchEnd: "12:30" });
    expect(creacion.status).toBe(200);
    expect(creacion.body.template).toMatchObject({ diaSemana: 0, horaApertura: "09:00", activo: true });
    expect(fake.plantillas).toHaveLength(1);

    const actualizacion = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/schedule/weekly/0`)
      .set("Authorization", auth)
      .send({ openTime: "10:00", closeTime: "17:00" });
    expect(actualizacion.status).toBe(200);
    expect(fake.plantillas).toHaveLength(1); // no duplico, actualizo
    expect(fake.plantillas[0]).toMatchObject({ horaApertura: "10:00", horaCierre: "17:00" });
  });

  it("valida el cuerpo y devuelve 400 con datos invalidos", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const sinCierre = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/schedule/weekly/0`)
      .set("Authorization", auth)
      .send({ openTime: "09:00" });
    expect(sinCierre.status).toBe(400);

    const invertido = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/schedule/weekly/0`)
      .set("Authorization", auth)
      .send({ openTime: "16:00", closeTime: "09:00" });
    expect(invertido.status).toBe(400);
  });

  it("lista la plantilla semanal del servicio", async () => {
    const fake = new FakePrisma();
    fake.crearPlantilla({ id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: 0, horaApertura: "09:00", horaCierre: "16:00" });
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/schedule/weekly`)
      .set("Authorization", auth);
    expect(respuesta.status).toBe(200);
    expect(respuesta.body.templates).toHaveLength(1);
  });

  it("crea, lista por mes y elimina una excepcion de calendario", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const cerrado = await request(app)
      .post(`/api/admin/services/${SERVICIO_ID}/schedule/exceptions`)
      .set("Authorization", auth)
      .send({ date: "2026-12-25", type: "CERRADO", reason: "Navidad" });
    expect(cerrado.status).toBe(201);
    const exceptionId = cerrado.body.exceptionId as string;

    const tipoInvalido = await request(app)
      .post(`/api/admin/services/${SERVICIO_ID}/schedule/exceptions`)
      .set("Authorization", auth)
      .send({ date: "2026-12-26", type: "OTRO" });
    expect(tipoInvalido.status).toBe(400);

    const listado = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/schedule/exceptions?month=2026-12`)
      .set("Authorization", auth);
    expect(listado.status).toBe(200);
    expect(listado.body.exceptions).toHaveLength(1);
    expect(listado.body.exceptions[0]).toMatchObject({ tipo: "CERRADO", motivo: "Navidad" });

    const eliminacion = await request(app)
      .delete(`/api/admin/schedule/exceptions/${exceptionId}`)
      .set("Authorization", auth);
    expect(eliminacion.status).toBe(200);

    const eliminacionOtraVez = await request(app)
      .delete(`/api/admin/schedule/exceptions/${exceptionId}`)
      .set("Authorization", auth);
    expect(eliminacionOtraVez.status).toBe(404);
  });

  it("rechaza sin token (401) y con un rol sin permiso (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app).get(`/api/admin/services/${SERVICIO_ID}/schedule/weekly`);
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "ATENCION"); // fuera de ROLES_GESTIONAN_HORARIOS
    const sinPermiso = await request(app)
      .get(`/api/admin/services/${SERVICIO_ID}/schedule/weekly`)
      .set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });
});

describe("GET /api/admin/audit-events (21)", () => {
  it("lista los eventos mas recientes primero y filtra por accion y objectId", async () => {
    const fake = new FakePrisma();
    fake.eventosAuditoria.push(
      { id: "1", actorUserId: "u1", actorEmail: "a@srp.test", accion: "RESERVA_CANCELADA", objetoTipo: "RESERVA", objetoId: "SRP-1", valoresAnteriores: null, valoresNuevos: null, creadoEn: new Date("2026-09-10T10:00:00Z") },
      { id: "2", actorUserId: "u1", actorEmail: "a@srp.test", accion: "BLOQUEO_CREADO", objetoTipo: "BLOQUEO", objetoId: "blk-1", valoresAnteriores: null, valoresNuevos: null, creadoEn: new Date("2026-09-11T10:00:00Z") },
    );
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const sinFiltro = await request(app).get("/api/admin/audit-events").set("Authorization", auth);
    expect(sinFiltro.status).toBe(200);
    expect(sinFiltro.body.eventos.map((e: { id: string }) => e.id)).toEqual(["2", "1"]);

    const porAccion = await request(app)
      .get("/api/admin/audit-events")
      .query({ action: "BLOQUEO_CREADO" })
      .set("Authorization", auth);
    expect(porAccion.body.eventos.map((e: { id: string }) => e.id)).toEqual(["2"]);

    const porObjeto = await request(app)
      .get("/api/admin/audit-events")
      .query({ objectId: "SRP-1" })
      .set("Authorization", auth);
    expect(porObjeto.body.eventos.map((e: { id: string }) => e.id)).toEqual(["1"]);
  });

  it("valida el formato de from/to", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .get("/api/admin/audit-events")
      .query({ from: "no-es-una-fecha" })
      .set("Authorization", auth);

    expect(respuesta.status).toBe(400);
  });

  it("rechaza sin token (401) y con un rol distinto de ADMINISTRADOR (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app).get("/api/admin/audit-events");
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "OPERACION");
    const sinPermiso = await request(app).get("/api/admin/audit-events").set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });
});

describe("/api/admin/users (14.7)", () => {
  it("lista, crea y actualiza un usuario, registrando auditoria (21)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const creacion = await request(app)
      .post("/api/admin/users")
      .set("Authorization", auth)
      .send({ email: "nuevo@srp.test", password: "clave-larga-123", rol: "ATENCION" });
    expect(creacion.status).toBe(201);
    expect(creacion.body.user.email).toBe("nuevo@srp.test");
    const userId = creacion.body.user.id as string;

    const lista = await request(app).get("/api/admin/users").set("Authorization", auth);
    expect(lista.status).toBe(200);
    expect(lista.body.usuarios.map((u: { email: string }) => u.email)).toContain("nuevo@srp.test");

    const actualizacion = await request(app)
      .put(`/api/admin/users/${userId}`)
      .set("Authorization", auth)
      .send({ rol: "CAJA", activo: false });
    expect(actualizacion.status).toBe(200);
    expect(actualizacion.body.user).toMatchObject({ rol: "CAJA", activo: false });

    expect(fake.eventosAuditoria.map((e) => e.accion)).toEqual(["USUARIO_CREADO", "USUARIO_ACTUALIZADO"]);
  });

  it("valida el cuerpo al crear (400) y rechaza un correo duplicado (409)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const sinRol = await request(app)
      .post("/api/admin/users")
      .set("Authorization", auth)
      .send({ email: "a@srp.test", password: "clave-larga-123" });
    expect(sinRol.status).toBe(400);

    await request(app)
      .post("/api/admin/users")
      .set("Authorization", auth)
      .send({ email: "duplicado@srp.test", password: "clave-larga-123", rol: "ATENCION" });
    const duplicado = await request(app)
      .post("/api/admin/users")
      .set("Authorization", auth)
      .send({ email: "duplicado@srp.test", password: "otra-clave-123", rol: "CAJA" });
    expect(duplicado.status).toBe(409);
  });

  it("impide que un administrador se modifique a si mismo (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake); // crea al usuario "admin-ADMINISTRADOR"

    const respuesta = await request(app)
      .put("/api/admin/users/admin-ADMINISTRADOR")
      .set("Authorization", auth)
      .send({ activo: false });

    expect(respuesta.status).toBe(403);
    expect(fake.usuarios.find((u) => u.id === "admin-ADMINISTRADOR")!.activo).toBe(true);
  });

  it("rechaza sin token (401) y con un rol distinto de ADMINISTRADOR (403)", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app).get("/api/admin/users");
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "ATENCION");
    const sinPermiso = await request(app).get("/api/admin/users").set("Authorization", authSinPermiso);
    expect(sinPermiso.status).toBe(403);
  });

  it("PUT /admin/me/password: cambia la propia contrasena (cualquier rol) y registra auditoria", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake, "ATENCION"); // password fixture: "clave-admin"

    const incorrecta = await request(app)
      .put("/api/admin/me/password")
      .set("Authorization", auth)
      .send({ currentPassword: "no-es-esta", newPassword: "clave-nueva-123" });
    expect(incorrecta.status).toBe(401);

    const correcta = await request(app)
      .put("/api/admin/me/password")
      .set("Authorization", auth)
      .send({ currentPassword: "clave-admin", newPassword: "clave-nueva-123" });
    expect(correcta.status).toBe(200);
    expect(fake.eventosAuditoria.map((e) => e.accion)).toEqual(["USUARIO_CONTRASENA_CAMBIADA"]);
  });

  it("PUT /admin/users/:id/password: un Administrador restablece la contrasena de otro usuario sin la actual", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);
    const creacion = await request(app)
      .post("/api/admin/users")
      .set("Authorization", auth)
      .send({ email: "otro@srp.test", password: "clave-larga-123", rol: "ATENCION" });
    const otroId = creacion.body.user.id as string;

    const respuesta = await request(app)
      .put(`/api/admin/users/${otroId}/password`)
      .set("Authorization", auth)
      .send({ newPassword: "clave-nueva-123" });

    expect(respuesta.status).toBe(200);
    expect(fake.eventosAuditoria.map((e) => e.accion)).toEqual(["USUARIO_CREADO", "USUARIO_CONTRASENA_RESETEADA"]);

    const authSinPermiso = await tokenAdminDePrueba(fake, "ATENCION");
    const sinPermiso = await request(app)
      .put(`/api/admin/users/${otroId}/password`)
      .set("Authorization", authSinPermiso)
      .send({ newPassword: "otra-clave-123" });
    expect(sinPermiso.status).toBe(403);
  });
});

describe("PUT /api/admin/services/:id/card-payment (6.8)", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("activa el pago con tarjeta si el webhook esta configurado, y registra auditoria", async () => {
    process.env.ONVO_WEBHOOK_SECRET = "webhook_secret_fake";
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/card-payment`)
      .set("Authorization", auth)
      .send({ enabled: true });

    expect(respuesta.status).toBe(200);
    expect(fake.servicios[0]!.pagoTarjetaHabilitado).toBe(true);
    expect(fake.eventosAuditoria.map((e) => e.accion)).toEqual(["PAGO_TARJETA_ACTUALIZADO"]);
  });

  it("rechaza activarlo (400) si ONVO_WEBHOOK_SECRET no esta configurado", async () => {
    delete process.env.ONVO_WEBHOOK_SECRET;
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const respuesta = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/card-payment`)
      .set("Authorization", auth)
      .send({ enabled: true });

    expect(respuesta.status).toBe(400);
    expect(fake.servicios[0]!.pagoTarjetaHabilitado).toBe(false);
  });

  it("valida que enabled sea booleano y devuelve 404 si el servicio no existe", async () => {
    const fake = new FakePrisma();
    const app = crearApp(comoPrisma(fake));
    const auth = await tokenAdminDePrueba(fake);

    const invalido = await request(app)
      .put("/api/admin/services/algun-id/card-payment")
      .set("Authorization", auth)
      .send({ enabled: "si" });
    expect(invalido.status).toBe(400);

    process.env.ONVO_WEBHOOK_SECRET = "webhook_secret_fake";
    const noExiste = await request(app)
      .put("/api/admin/services/no-existe/card-payment")
      .set("Authorization", auth)
      .send({ enabled: true });
    expect(noExiste.status).toBe(404);
  });

  it("rechaza sin token (401) y con un rol distinto de ADMINISTRADOR (403)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const app = crearApp(comoPrisma(fake));

    const sinToken = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/card-payment`)
      .send({ enabled: false });
    expect(sinToken.status).toBe(401);

    const authSinPermiso = await tokenAdminDePrueba(fake, "ATENCION");
    const sinPermiso = await request(app)
      .put(`/api/admin/services/${SERVICIO_ID}/card-payment`)
      .set("Authorization", authSinPermiso)
      .send({ enabled: false });
    expect(sinPermiso.status).toBe(403);
  });
});
