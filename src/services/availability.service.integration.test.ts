// ============================================================================
// Pruebas de integracion de availability.service.ts contra PostgreSQL real
// (proyecto Supabase "SRP reservas").
//
// A DIFERENCIA de availability.service.test.ts (que usa el doble en memoria
// FakePrisma), este archivo es el UNICO lugar donde se puede verificar de
// verdad la garantia de concurrencia de 8.8: que el `SELECT ... FOR UPDATE`
// de `bloquearFilasInvolucradas` realmente serializa dos transacciones que
// compiten por el mismo heat (CONC-001, seccion 24).
//
// Gateado con `describe.skipIf`: si no hay `DATABASE_URL` en el entorno, la
// suite se omite (no falla) y `npm test` sigue funcionando sin una base de
// datos disponible. Para activarla:
//
//   1. Crear el proyecto Supabase "SRP reservas" (plan free) si no existe.
//   2. Copiar `.env.example` a `.env` y completar DATABASE_URL y DIRECT_URL
//      con las cadenas de Project Settings -> Database -> Connection string.
//   3. Aplicar el esquema: `npx prisma db push`.
//   4. Ejecutar `npm test` normalmente (Vitest recoge las variables de
//      entorno del proceso; no hace falta ningun flag adicional).
//
// Verificado contra el proyecto Supabase "SRP Reservas" (2026-09-14): CONC-001
// pasa en ~10s de red real. El timeout de 30s en beforeAll/afterAll/it (en vez
// de los 5s por defecto de Vitest) es deliberado: contra el pooler real, cada
// intento de confirmarReserva hace varias consultas secuenciales por ronda de
// estabilizacion, y eso no alcanza en 5s bajo latencia de red real.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { confirmarReserva, consultarDisponibilidad } from "./availability.service.js";

const SERVICIO_ID = "test-svc-conc-001";
const FECHA_ISO = "2026-09-13"; // domingo, horario habitual (6.2): usado solo por esta suite
const FECHA_DATE = new Date(`${FECHA_ISO}T00:00:00.000Z`);
const DIA_SEMANA_DOMINGO = FECHA_DATE.getUTCDay();

describe.skipIf(!process.env.DATABASE_URL)("availability.service (integracion, Postgres real)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Limpieza defensiva por si una corrida anterior quedo a medias, en
    // orden de dependencias FK (heatAllocation -> reservation/heat ->
    // operationalBatch -> scheduleTemplate/service).
    await prisma.heatAllocation.deleteMany({ where: { reservation: { servicioId: SERVICIO_ID } } });
    await prisma.reservation.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.heat.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.operationalBatch.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.scheduleTemplate.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.service.deleteMany({ where: { id: SERVICIO_ID } });

    await prisma.service.create({
      data: {
        id: SERVICIO_ID,
        nombre: "Karts (prueba de integracion)",
        slug: `karts-test-${Date.now()}`,
        moneda: "CRC",
        precioPorPersona: 4000,
        porcentajeDeposito: 50,
      },
    });
    // Unico dia de la semana abierto: fuerza a que ambos clientes compitan
    // por el MISMO heat existente, sin poder "escapar" a otra hora del dia.
    await prisma.scheduleTemplate.create({
      data: {
        servicioId: SERVICIO_ID,
        diaSemana: DIA_SEMANA_DOMINGO,
        horaApertura: "09:00",
        horaCierre: "09:15", // una sola ranura de 15 minutos en todo el dia
        activo: true,
      },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.heatAllocation.deleteMany({ where: { reservation: { servicioId: SERVICIO_ID } } });
    await prisma.reservation.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.heat.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.operationalBatch.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.scheduleTemplate.deleteMany({ where: { servicioId: SERVICIO_ID } });
    await prisma.service.deleteMany({ where: { id: SERVICIO_ID } });
    await prisma.$disconnect();
  }, 30_000);

  it("CONC-001: si dos clientes piden el ultimo espacio del mismo heat al mismo tiempo, solo una transaccion tiene exito", async () => {
    // Heat de 09:00-09:15 con 4/5 ocupados por una reserva ya confirmada:
    // queda exactamente UN espacio libre para que ambos clientes compitan.
    const lote = await prisma.operationalBatch.create({
      data: {
        servicioId: SERVICIO_ID,
        fecha: FECHA_DATE,
        horaInicio: "09:00",
        horaFinUltimoHeat: "09:15",
        horaInicioLimpieza: "09:15",
        horaFinLimpieza: "09:30", // fuera del horario de esta suite (cierre 09:15); no afecta el heat existente
        cantidadHeats: 1,
      },
    });
    const heat = await prisma.heat.create({
      data: {
        loteId: lote.id,
        servicioId: SERVICIO_ID,
        fecha: FECHA_DATE,
        horaInicio: "09:00",
        horaFin: "09:15",
        posicionEnLote: 1,
      },
    });
    const reservaExistente = await prisma.reservation.create({
      data: {
        codigoPublico: `SRP-FIX-${Date.now()}`,
        servicioId: SERVICIO_ID,
        fecha: FECHA_DATE,
        cantidadPersonas: 4,
        estado: "CONFIRMADA",
        moneda: "CRC",
        montoTotal: 16000,
        montoDeposito: 8000,
        montoSaldo: 8000,
        claveIdempotencia: `idem-fixture-${Date.now()}`,
        clienteNombre: "Fixture existente",
        clienteTelefono: "00000000",
      },
    });
    await prisma.heatAllocation.create({
      data: { reservationId: reservaExistente.id, heatId: heat.id, cantidadParticipantes: 4 },
    });

    // Confirmacion previa: la consulta (fuera de transaccion) ve exactamente
    // 1 espacio libre antes de que ambos clientes intenten confirmar.
    const disponibilidadPrevia = await consultarDisponibilidad(prisma, {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 1,
    });
    expect(disponibilidadPrevia.disponible).toBe(true);

    const solicitudBase = {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 1,
      cliente: { nombre: "Cliente concurrente", telefono: "00000001" },
    };

    const [resultadoA, resultadoB] = await Promise.all([
      confirmarReserva(prisma, { ...solicitudBase, claveIdempotencia: `idem-conc-a-${Date.now()}` }),
      confirmarReserva(prisma, { ...solicitudBase, claveIdempotencia: `idem-conc-b-${Date.now()}` }),
    ]);

    const exitos = [resultadoA, resultadoB].filter((r) => r.exito);
    const fallos = [resultadoA, resultadoB].filter((r) => !r.exito);
    expect(exitos).toHaveLength(1);
    expect(fallos).toHaveLength(1);

    // La verificacion definitiva no es el resultado logico sino el estado
    // final en base de datos: el heat nunca debe superar su capacidad de 5.
    const asignacionesActivas = await prisma.heatAllocation.findMany({
      where: { heatId: heat.id, estado: "ACTIVA" },
    });
    const totalParticipantes = asignacionesActivas.reduce((suma, a) => suma + a.cantidadParticipantes, 0);
    expect(totalParticipantes).toBeLessThanOrEqual(5);
    expect(totalParticipantes).toBe(5); // 4 existentes + exactamente 1 de los dos clientes concurrentes
  }, 30_000);
});
