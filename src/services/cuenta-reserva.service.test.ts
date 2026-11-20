import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  agregarLinea,
  eliminarLinea,
  modificarLinea,
  obtenerCuenta,
  registrarPago,
  sincronizarCuentaTrasCambioDePersonas,
  type Cuenta,
} from "./cuenta-reserva.service.js";
import { FakePrisma, type FilaReserva } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

/** Servicio con las tarifas reales del parque. */
function escenario(datos: Partial<FilaReserva> = {}, conDepositoRegistrado = true) {
  const fake = new FakePrisma();
  fake.crearServicio({
    id: "svc-1",
    precioPorPersonaGrupoPequeno: 7000,
    precioPorPersonaGrupoGrande: 6500,
    precio10GrupoPequeno: 6000,
    precio10GrupoGrande: 5500,
    precioNinoAcompanado: 1000,
  });
  const reserva: FilaReserva = {
    id: "res-1",
    codigoPublico: "SRP-0001",
    servicioId: "svc-1",
    fecha: new Date("2026-11-14T00:00:00.000Z"),
    cantidadPersonas: 14,
    repeticiones: 1,
    estado: "CONFIRMADA",
    moneda: "CRC",
    montoTotal: 91000,
    montoDeposito: 45500,
    montoSaldo: 45500,
    claveIdempotencia: "idem-1",
    clienteNombre: "Yil Rojas",
    clienteTelefono: "60687547",
    expiraEn: null,
    confirmadaEn: new Date(),
    ...datos,
  };
  fake.reservas.push(reserva);
  if (conDepositoRegistrado) {
    fake.payments.push({
      id: "pago-dep",
      reservationId: "res-1",
      tipo: "DEPOSITO",
      monto: 45500,
      moneda: "CRC",
      metodo: "SINPE_MANUAL",
      estado: "PAGADO",
      creadoEn: new Date(),
      pagadoEn: new Date(),
    });
  }
  return { fake, prisma: comoPrisma(fake) };
}

function cuentaDe(resultado: { ok: boolean } & Record<string, unknown>): Cuenta {
  expect(resultado.ok).toBe(true);
  return resultado.cuenta as Cuenta;
}

describe("obtenerCuenta", () => {
  it("abre la cuenta con una linea base: heat de 15 min por lo reservado", async () => {
    const { prisma, fake } = escenario();

    const cuenta = cuentaDe(await obtenerCuenta(prisma, "SRP-0001"));

    expect(cuenta.lineas).toHaveLength(1);
    expect(cuenta.lineas[0]).toMatchObject({
      tipo: "HEAT", duracionMin: 15, cantidad: 14, precioUnitario: 6500, monto: 91000, esBase: true,
    });
    expect(cuenta.totalConsumido).toBe(91000);
    expect(cuenta.totalPagado).toBe(45500);
    expect(cuenta.saldo).toBe(45500);
    expect(cuenta.moneda).toBe("CRC");
    expect(fake.consumos).toHaveLength(1);
  });

  it("incluye las tarifas vigentes para que la pantalla pueda mostrarlas", async () => {
    const { prisma } = escenario();

    const cuenta = cuentaDe(await obtenerCuenta(prisma, "SRP-0001"));

    expect(cuenta.tarifas).toEqual({
      heat15GrupoPequeno: 7000,
      heat15GrupoGrande: 6500,
      heat10GrupoPequeno: 6000,
      heat10GrupoGrande: 5500,
      ninoAcompanado: 1000,
      umbralGrupoGrande: 5,
    });
  });

  it("es idempotente: consultar dos veces no duplica lineas", async () => {
    const { prisma, fake } = escenario();

    await obtenerCuenta(prisma, "SRP-0001");
    await obtenerCuenta(prisma, "SRP-0001");

    expect(fake.consumos).toHaveLength(1);
  });

  it("con 2 heats reservados crea una linea base por heat", async () => {
    const { prisma } = escenario({ cantidadPersonas: 4, repeticiones: 2, montoTotal: 56000, montoDeposito: 28000, montoSaldo: 28000 });

    const cuenta = cuentaDe(await obtenerCuenta(prisma, "SRP-0001"));

    expect(cuenta.lineas).toHaveLength(2);
    expect(cuenta.lineas.every((l) => l.cantidad === 4 && l.monto === 28000 && l.precioUnitario === 7000)).toBe(true);
    expect(cuenta.totalConsumido).toBe(56000);
  });

  it("sin deposito registrado en el ledger usa el monto de deposito de la reserva", async () => {
    const { prisma } = escenario({}, false);

    const cuenta = cuentaDe(await obtenerCuenta(prisma, "SRP-0001"));

    expect(cuenta.totalPagado).toBe(45500);
    expect(cuenta.saldo).toBe(45500);
  });

  it("no cuenta pagos pendientes o rechazados como pagado", async () => {
    const { prisma, fake } = escenario();
    fake.payments.push({
      id: "pago-x", reservationId: "res-1", tipo: "SALDO", monto: 10000, moneda: "CRC",
      metodo: "SINPE_ONVO", estado: "PENDIENTE", creadoEn: new Date(),
    });

    const cuenta = cuentaDe(await obtenerCuenta(prisma, "SRP-0001"));

    expect(cuenta.totalPagado).toBe(45500);
  });

  it("rechaza reservas que no estan confirmadas ni pagadas", async () => {
    const { prisma } = escenario({ estado: "PENDIENTE_VALIDACION_SINPE" });

    expect(await obtenerCuenta(prisma, "SRP-0001")).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const { prisma } = escenario();

    expect(await obtenerCuenta(prisma, "SRP-NO-EXISTE")).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });
});

describe("caso real: 14 personas de 10 min y despues 10 personas de 15 min", () => {
  it("registra montos exactos, saldo y cierra como PAGADA", async () => {
    const { prisma, fake } = escenario();
    const inicial = cuentaDe(await obtenerCuenta(prisma, "SRP-0001"));
    const base = inicial.lineas[0]!;

    // Hicieron el heat de 10 min en vez del de 15.
    const tras10 = cuentaDe(await modificarLinea(prisma, "SRP-0001", base.id, { duracionMin: 10 }));
    expect(tras10.lineas[0]).toMatchObject({ duracionMin: 10, precioUnitario: 5500, monto: 77000 });
    expect(tras10.saldo).toBe(31500);

    // Despues 10 de ellos hicieron un heat extra de 15 min.
    const tras15 = cuentaDe(
      await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 10 }),
    );
    expect(tras15.lineas[1]).toMatchObject({ duracionMin: 15, cantidad: 10, precioUnitario: 6500, monto: 65000, esBase: false });
    expect(tras15.totalConsumido).toBe(142000);
    expect(fake.reservas[0]!.montoTotal).toBe(142000);

    // Cobran 32.000 (redondeo) y luego el resto.
    const traspago1 = cuentaDe(await registrarPago(prisma, "SRP-0001", { monto: 32000, metodo: "EFECTIVO" }));
    expect(traspago1.totalPagado).toBe(77500);
    expect(traspago1.saldo).toBe(64500);
    expect(fake.reservas[0]!.estado).toBe("CONFIRMADA");
    expect(fake.reservas[0]!.montoSaldo).toBe(64500);

    const traspago2 = cuentaDe(await registrarPago(prisma, "SRP-0001", { monto: 64500, metodo: "SINPE_MANUAL" }));
    expect(traspago2.saldo).toBe(0);
    expect(fake.reservas[0]!.estado).toBe("PAGADA");
    expect(fake.reservas[0]!.montoSaldo).toBe(0);
    expect(fake.payments.filter((p) => p.tipo === "SALDO")).toHaveLength(2);
  });

  it("un cobro mayor al saldo cierra la cuenta y deja el saldo a favor visible", async () => {
    const { prisma, fake } = escenario();
    await obtenerCuenta(prisma, "SRP-0001");

    const cuenta = cuentaDe(await registrarPago(prisma, "SRP-0001", { monto: 46000, metodo: "EFECTIVO" }));

    expect(cuenta.saldo).toBe(-500);
    expect(fake.reservas[0]!.estado).toBe("PAGADA");
    expect(fake.reservas[0]!.montoSaldo).toBe(0);
  });

  it("agregar consumo a una reserva PAGADA la reabre como CONFIRMADA con saldo", async () => {
    const { prisma, fake } = escenario();
    await obtenerCuenta(prisma, "SRP-0001");
    await registrarPago(prisma, "SRP-0001", { monto: 45500, metodo: "EFECTIVO" });
    expect(fake.reservas[0]!.estado).toBe("PAGADA");

    const cuenta = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 3 }));

    expect(cuenta.saldo).toBe(21000);
    expect(fake.reservas[0]!.estado).toBe("CONFIRMADA");
    expect(fake.reservas[0]!.montoSaldo).toBe(21000);
  });
});

describe("agregarLinea", () => {
  it("un subgrupo pequeno paga la tarifa de grupo pequeno de 10 min", async () => {
    const { prisma } = escenario();

    const cuenta = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 10, personas: 3 }));

    expect(cuenta.lineas[1]).toMatchObject({ duracionMin: 10, cantidad: 3, precioUnitario: 6000, monto: 18000 });
  });

  it("el limite de grupo grande es de 5 personas", async () => {
    const { prisma } = escenario();

    const cuenta = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 10, personas: 5 }));

    expect(cuenta.lineas[1]).toMatchObject({ precioUnitario: 5500, monto: 27500 });
  });

  it("permite fijar un precio unitario distinto al de la tarifa", async () => {
    const { prisma } = escenario();

    const cuenta = cuentaDe(
      await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 2, precioUnitario: 5000 }),
    );

    expect(cuenta.lineas[1]).toMatchObject({ precioUnitario: 5000, monto: 10000 });
  });

  it("ninos acompanantes: cantidad de ninos por heats a la tarifa del servicio", async () => {
    const { prisma } = escenario();

    const cuenta = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "NINO_ACOMPANADO", ninos: 2, heats: 2 }));

    expect(cuenta.lineas[1]).toMatchObject({ tipo: "NINO_ACOMPANADO", cantidad: 4, precioUnitario: 1000, monto: 4000 });
    expect(cuenta.lineas[1]!.descripcion).toContain("2");
    expect(cuenta.totalConsumido).toBe(95000);
  });

  it("los ninos acompanantes no cambian la cantidad de personas de la reserva", async () => {
    const { prisma, fake } = escenario();

    await agregarLinea(prisma, "SRP-0001", { tipo: "NINO_ACOMPANADO", ninos: 1, heats: 1 });

    expect(fake.reservas[0]!.cantidadPersonas).toBe(14);
  });

  it("ajuste negativo con nota", async () => {
    const { prisma } = escenario();

    const cuenta = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "AJUSTE", monto: -500, nota: "Redondeo" }));

    expect(cuenta.lineas[1]).toMatchObject({ tipo: "AJUSTE", cantidad: 1, precioUnitario: -500, monto: -500, descripcion: "Redondeo" });
    expect(cuenta.totalConsumido).toBe(90500);
  });

  it("guarda quien registro la linea", async () => {
    const { prisma, fake } = escenario();

    await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 1 }, "caja@srp.cr");

    expect(fake.consumos.at(-1)!.creadoPor).toBe("caja@srp.cr");
  });

  it.each([
    ["duracion invalida", { tipo: "HEAT", duracionMin: 12, personas: 3 }],
    ["personas en cero", { tipo: "HEAT", duracionMin: 10, personas: 0 }],
    ["personas no entero", { tipo: "HEAT", duracionMin: 10, personas: 2.5 }],
    ["precio negativo", { tipo: "HEAT", duracionMin: 10, personas: 2, precioUnitario: -1 }],
    ["ninos en cero", { tipo: "NINO_ACOMPANADO", ninos: 0, heats: 1 }],
    ["heats en cero", { tipo: "NINO_ACOMPANADO", ninos: 1, heats: 0 }],
    ["ajuste en cero", { tipo: "AJUSTE", monto: 0, nota: "x" }],
    ["ajuste sin nota", { tipo: "AJUSTE", monto: 500, nota: "  " }],
  ] as const)("rechaza datos invalidos: %s", async (_nombre, entrada) => {
    const { prisma, fake } = escenario();

    const resultado = await agregarLinea(prisma, "SRP-0001", entrada);

    expect(resultado).toEqual({ ok: false, motivo: "DATOS_INVALIDOS" });
    expect(fake.consumos.filter((c) => !c.esBase)).toHaveLength(0);
  });

  it("rechaza reservas que no estan confirmadas ni pagadas", async () => {
    const { prisma } = escenario({ estado: "CANCELADA" });

    expect(await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 10, personas: 1 })).toEqual({
      ok: false, motivo: "ESTADO_INVALIDO",
    });
  });
});

describe("modificarLinea", () => {
  it("cambiar las personas de un heat recalcula el precio segun el tamano del grupo", async () => {
    const { prisma } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;

    const cuenta = cuentaDe(await modificarLinea(prisma, "SRP-0001", base.id, { cantidad: 4 }));

    expect(cuenta.lineas[0]).toMatchObject({ cantidad: 4, precioUnitario: 7000, monto: 28000 });
  });

  it("un precio unitario indicado manda sobre la tarifa", async () => {
    const { prisma } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;

    const cuenta = cuentaDe(await modificarLinea(prisma, "SRP-0001", base.id, { duracionMin: 10, precioUnitario: 5000 }));

    expect(cuenta.lineas[0]).toMatchObject({ duracionMin: 10, precioUnitario: 5000, monto: 70000 });
  });

  it("modifica el monto de un ajuste", async () => {
    const { prisma } = escenario();
    const conAjuste = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "AJUSTE", monto: -500, nota: "Redondeo" }));

    const cuenta = cuentaDe(await modificarLinea(prisma, "SRP-0001", conAjuste.lineas[1]!.id, { precioUnitario: -1000 }));

    expect(cuenta.lineas[1]).toMatchObject({ precioUnitario: -1000, monto: -1000 });
  });

  it("no permite cambiar la duracion de lineas que no son heats", async () => {
    const { prisma } = escenario();
    const conNino = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "NINO_ACOMPANADO", ninos: 1, heats: 1 }));

    expect(await modificarLinea(prisma, "SRP-0001", conNino.lineas[1]!.id, { duracionMin: 10 })).toEqual({
      ok: false, motivo: "DATOS_INVALIDOS",
    });
  });

  it("rechaza cantidad invalida o duracion invalida", async () => {
    const { prisma } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;

    expect(await modificarLinea(prisma, "SRP-0001", base.id, { cantidad: 0 })).toEqual({ ok: false, motivo: "DATOS_INVALIDOS" });
    expect(await modificarLinea(prisma, "SRP-0001", base.id, { duracionMin: 20 })).toEqual({ ok: false, motivo: "DATOS_INVALIDOS" });
  });

  it("no toca lineas de otra reserva", async () => {
    const { prisma, fake } = escenario();
    fake.consumos.push({
      id: "consumo-otra", reservationId: "res-OTRA", tipo: "HEAT", descripcion: "x", duracionMin: 15,
      cantidad: 1, precioUnitario: 7000, monto: 7000, esBase: false, creadoPor: null, creadoEn: new Date(),
    });

    expect(await modificarLinea(prisma, "SRP-0001", "consumo-otra", { cantidad: 2 })).toEqual({
      ok: false, motivo: "LINEA_NO_ENCONTRADA",
    });
    expect(fake.consumos.find((c) => c.id === "consumo-otra")!.cantidad).toBe(1);
  });
});

describe("modificarLinea: la cantidad de personas de la reserva sigue a la linea reservada", () => {
  it("bajar las personas de la linea reservada actualiza la cantidad de personas de la reserva", async () => {
    const { prisma, fake } = escenario({ cantidadPersonas: 15, montoTotal: 97500, montoDeposito: 48750, montoSaldo: 48750 });
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;

    const cuenta = cuentaDe(await modificarLinea(prisma, "SRP-0001", base.id, { cantidad: 14 }));

    expect(fake.reservas[0]!.cantidadPersonas).toBe(14);
    expect(cuenta.cantidadPersonas).toBe(14);
    expect(cuenta.totalConsumido).toBe(91000);
  });

  it("subir las personas de la linea reservada tambien actualiza la cantidad de la reserva", async () => {
    const { prisma, fake } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;

    await modificarLinea(prisma, "SRP-0001", base.id, { cantidad: 16 });

    expect(fake.reservas[0]!.cantidadPersonas).toBe(16);
  });

  it("con dos heats reservados, la reserva queda con la mayor cantidad de sus lineas reservadas", async () => {
    const { prisma, fake } = escenario({ cantidadPersonas: 4, repeticiones: 2, montoTotal: 56000, montoDeposito: 28000, montoSaldo: 28000 });
    const [primera, segunda] = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas;

    await modificarLinea(prisma, "SRP-0001", primera!.id, { cantidad: 3 });
    expect(fake.reservas[0]!.cantidadPersonas).toBe(4); // la otra linea sigue en 4

    await modificarLinea(prisma, "SRP-0001", segunda!.id, { cantidad: 3 });
    expect(fake.reservas[0]!.cantidadPersonas).toBe(3);
  });

  it("cambiar una linea extra (heat extra, ninos) o solo la duracion no cambia la cantidad de la reserva", async () => {
    const { prisma, fake } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;
    const conExtra = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 10 }));

    await modificarLinea(prisma, "SRP-0001", conExtra.lineas[1]!.id, { cantidad: 6 });
    await modificarLinea(prisma, "SRP-0001", base.id, { duracionMin: 10 });

    expect(fake.reservas[0]!.cantidadPersonas).toBe(14);
  });
});

describe("eliminarLinea", () => {
  it("quita la linea y recalcula el total y el saldo", async () => {
    const { prisma, fake } = escenario();
    const conExtra = cuentaDe(await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 10 }));
    expect(conExtra.totalConsumido).toBe(156000);

    const cuenta = cuentaDe(await eliminarLinea(prisma, "SRP-0001", conExtra.lineas[1]!.id));

    expect(cuenta.lineas).toHaveLength(1);
    expect(cuenta.totalConsumido).toBe(91000);
    expect(fake.reservas[0]!.montoTotal).toBe(91000);
  });

  it("no permite borrar la ultima linea", async () => {
    const { prisma } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;

    expect(await eliminarLinea(prisma, "SRP-0001", base.id)).toEqual({ ok: false, motivo: "ULTIMA_LINEA" });
  });

  it("devuelve LINEA_NO_ENCONTRADA si no existe", async () => {
    const { prisma } = escenario();
    await obtenerCuenta(prisma, "SRP-0001");

    expect(await eliminarLinea(prisma, "SRP-0001", "no-existe")).toEqual({ ok: false, motivo: "LINEA_NO_ENCONTRADA" });
  });
});

describe("registrarPago", () => {
  it("guarda el cobro con metodo, nota, quien lo registro y fecha", async () => {
    const { prisma, fake } = escenario();

    await registrarPago(prisma, "SRP-0001", { monto: 20000, metodo: "TRANSFERENCIA_BANCARIA", nota: "Ref 123" }, "caja@srp.cr");

    expect(fake.payments.at(-1)).toMatchObject({
      reservationId: "res-1", tipo: "SALDO", monto: 20000, moneda: "CRC", metodo: "TRANSFERENCIA_BANCARIA",
      estado: "PAGADO", nota: "Ref 123", registradoPor: "caja@srp.cr",
    });
    expect(fake.payments.at(-1)!.pagadoEn).toBeInstanceOf(Date);
  });

  it("un pago parcial deja la reserva CONFIRMADA con el saldo restante", async () => {
    const { prisma, fake } = escenario();

    const cuenta = cuentaDe(await registrarPago(prisma, "SRP-0001", { monto: 20000, metodo: "EFECTIVO" }));

    expect(cuenta.saldo).toBe(25500);
    expect(fake.reservas[0]!.estado).toBe("CONFIRMADA");
    expect(fake.reservas[0]!.montoSaldo).toBe(25500);
  });

  it.each([
    ["monto cero", { monto: 0, metodo: "EFECTIVO" }],
    ["monto negativo", { monto: -5, metodo: "EFECTIVO" }],
    ["monto no numerico", { monto: Number.NaN, metodo: "EFECTIVO" }],
    ["metodo no permitido", { monto: 1000, metodo: "TARJETA_ONVO" }],
  ] as const)("rechaza datos invalidos: %s", async (_nombre, entrada) => {
    const { prisma, fake } = escenario();

    const resultado = await registrarPago(prisma, "SRP-0001", entrada as never);

    expect(resultado).toEqual({ ok: false, motivo: "DATOS_INVALIDOS" });
    expect(fake.payments.filter((p) => p.tipo === "SALDO")).toHaveLength(0);
  });

  it("rechaza reservas que no estan confirmadas ni pagadas", async () => {
    const { prisma } = escenario({ estado: "EXPIRADA" });

    expect(await registrarPago(prisma, "SRP-0001", { monto: 1000, metodo: "EFECTIVO" })).toEqual({
      ok: false, motivo: "ESTADO_INVALIDO",
    });
  });
});

describe("sincronizarCuentaTrasCambioDePersonas", () => {
  it("si la cuenta esta abierta, reajusta las lineas base a la nueva cantidad", async () => {
    const { prisma, fake } = escenario();
    await obtenerCuenta(prisma, "SRP-0001");
    await agregarLinea(prisma, "SRP-0001", { tipo: "HEAT", duracionMin: 15, personas: 2 });

    await sincronizarCuentaTrasCambioDePersonas(comoPrisma(fake), "res-1", 16);

    const base = fake.consumos.find((c) => c.esBase)!;
    expect(base).toMatchObject({ cantidad: 16, precioUnitario: 6500, monto: 104000 });
    expect(fake.consumos.find((c) => !c.esBase)!.cantidad).toBe(2);
    // La linea extra es un subgrupo de 2 personas: tarifa de grupo pequeno (2 x 7.000).
    expect(fake.reservas[0]!.montoTotal).toBe(104000 + 14000);
  });

  it("respeta la duracion que tenga la linea base", async () => {
    const { prisma, fake } = escenario();
    const base = cuentaDe(await obtenerCuenta(prisma, "SRP-0001")).lineas[0]!;
    await modificarLinea(prisma, "SRP-0001", base.id, { duracionMin: 10 });

    await sincronizarCuentaTrasCambioDePersonas(comoPrisma(fake), "res-1", 16);

    expect(fake.consumos.find((c) => c.esBase)).toMatchObject({ duracionMin: 10, cantidad: 16, precioUnitario: 5500, monto: 88000 });
  });

  it("si la cuenta nunca se abrio, no hace nada", async () => {
    const { fake } = escenario();

    await sincronizarCuentaTrasCambioDePersonas(comoPrisma(fake), "res-1", 16);

    expect(fake.consumos).toHaveLength(0);
    expect(fake.reservas[0]!.montoTotal).toBe(91000);
  });
});
