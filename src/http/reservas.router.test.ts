import { beforeAll, describe, expect, it } from "vitest";
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
  fake.crearServicio({ id: SERVICIO_ID, nombre: "Karts", slug: "karts", moneda: "CRC", precioPorPersona: 4000, porcentajeDeposito: 50 });
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
