import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  asegurarAdminInicial,
  emitirToken,
  hashearContrasena,
  iniciarSesion,
  verificarContrasena,
  verificarToken,
} from "./auth.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

beforeAll(() => {
  process.env.JWT_SECRET = "secreto-de-prueba-no-usar-en-produccion";
});

describe("hashearContrasena / verificarContrasena", () => {
  it("una contrasena correcta verifica contra su propio hash", async () => {
    const hash = await hashearContrasena("clave-super-secreta");
    expect(await verificarContrasena("clave-super-secreta", hash)).toBe(true);
  });

  it("una contrasena incorrecta no verifica", async () => {
    const hash = await hashearContrasena("clave-super-secreta");
    expect(await verificarContrasena("otra-clave", hash)).toBe(false);
  });

  it("dos hashes de la misma contrasena son distintos (sal aleatoria)", async () => {
    const hash1 = await hashearContrasena("clave-super-secreta");
    const hash2 = await hashearContrasena("clave-super-secreta");
    expect(hash1).not.toBe(hash2);
  });
});

describe("emitirToken / verificarToken", () => {
  it("un token recien emitido se verifica y devuelve el mismo payload", () => {
    const token = emitirToken({ userId: "u1", email: "admin@srp.test", rol: "ADMINISTRADOR" });
    expect(verificarToken(token)).toEqual({ userId: "u1", email: "admin@srp.test", rol: "ADMINISTRADOR" });
  });

  it("un token con texto invalido no verifica", () => {
    expect(verificarToken("esto-no-es-un-jwt")).toBeNull();
  });

  it("un token firmado con otro secreto no verifica", () => {
    const token = emitirToken({ userId: "u1", email: "a@srp.test", rol: "ATENCION" });
    process.env.JWT_SECRET = "otro-secreto-distinto";
    expect(verificarToken(token)).toBeNull();
    process.env.JWT_SECRET = "secreto-de-prueba-no-usar-en-produccion"; // restaurar para los demas tests
  });
});

describe("iniciarSesion", () => {
  it("devuelve un token cuando el email y la contrasena coinciden", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({
      id: "u1", email: "admin@srp.test",
      passwordHash: await hashearContrasena("clave-correcta"),
      rol: "ADMINISTRADOR",
    });

    const resultado = await iniciarSesion(comoPrisma(fake), "admin@srp.test", "clave-correcta");

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.rol).toBe("ADMINISTRADOR");
    expect(verificarToken(resultado.token)).toMatchObject({ email: "admin@srp.test", rol: "ADMINISTRADOR" });
  });

  it("falla si la contrasena es incorrecta", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u1", email: "admin@srp.test", passwordHash: await hashearContrasena("clave-correcta") });

    expect(await iniciarSesion(comoPrisma(fake), "admin@srp.test", "clave-incorrecta")).toEqual({ ok: false });
  });

  it("falla si el usuario no existe", async () => {
    const fake = new FakePrisma();
    expect(await iniciarSesion(comoPrisma(fake), "nadie@srp.test", "cualquiera")).toEqual({ ok: false });
  });

  it("falla si el usuario existe pero esta inactivo", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({
      id: "u1", email: "admin@srp.test",
      passwordHash: await hashearContrasena("clave-correcta"),
      activo: false,
    });

    expect(await iniciarSesion(comoPrisma(fake), "admin@srp.test", "clave-correcta")).toEqual({ ok: false });
  });
});

describe("asegurarAdminInicial", () => {
  it("crea el admin desde ADMIN_EMAIL/ADMIN_PASSWORD si no existe ningun usuario", async () => {
    const fake = new FakePrisma();
    process.env.ADMIN_EMAIL = "bootstrap@srp.test";
    process.env.ADMIN_PASSWORD = "clave-inicial";

    await asegurarAdminInicial(comoPrisma(fake));

    expect(fake.usuarios).toHaveLength(1);
    expect(fake.usuarios[0]).toMatchObject({ email: "bootstrap@srp.test", rol: "ADMINISTRADOR" });
    expect(await verificarContrasena("clave-inicial", fake.usuarios[0]!.passwordHash)).toBe(true);

    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  it("no crea nada si ya existe al menos un usuario", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u1", email: "ya-existe@srp.test", passwordHash: "x" });
    process.env.ADMIN_EMAIL = "bootstrap@srp.test";
    process.env.ADMIN_PASSWORD = "clave-inicial";

    await asegurarAdminInicial(comoPrisma(fake));

    expect(fake.usuarios).toHaveLength(1);
    expect(fake.usuarios[0]!.email).toBe("ya-existe@srp.test");

    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  it("no crea nada si faltan las variables de entorno", async () => {
    const fake = new FakePrisma();
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;

    await asegurarAdminInicial(comoPrisma(fake));

    expect(fake.usuarios).toHaveLength(0);
  });
});
