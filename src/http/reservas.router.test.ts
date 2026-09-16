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
