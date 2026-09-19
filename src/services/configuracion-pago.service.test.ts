import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { establecerModoSinpe, obtenerModoSinpe } from "./configuracion-pago.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

describe("obtenerModoSinpe", () => {
  it("devuelve MANUAL si todavia no se configuro nada", async () => {
    const fake = new FakePrisma();
    expect(await obtenerModoSinpe(comoPrisma(fake))).toBe("MANUAL");
  });

  it("devuelve el modo configurado", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    expect(await obtenerModoSinpe(comoPrisma(fake))).toBe("ONVO");
  });
});

describe("establecerModoSinpe", () => {
  it("permite cambiar de ONVO de vuelta a MANUAL", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    await establecerModoSinpe(comoPrisma(fake), "MANUAL");
    expect(await obtenerModoSinpe(comoPrisma(fake))).toBe("MANUAL");
  });
});
