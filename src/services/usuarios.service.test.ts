import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { actualizarUsuario, crearUsuario, listarUsuarios } from "./usuarios.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

// Pruebas de usuarios.service.ts (14.7): gestion de usuarios administrativos
// desde el panel. Reutiliza hashearContrasena de auth.service.ts (no
// reimplementa el hashing); esas garantias ya estan probadas en
// auth.service.test.ts.

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

describe("listarUsuarios", () => {
  it("devuelve los usuarios ordenados por fecha de creacion, sin exponer passwordHash", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u2", email: "b@srp.test", passwordHash: "hash-secreto", creadoEn: new Date("2026-09-02") });
    fake.crearUsuario({ id: "u1", email: "a@srp.test", passwordHash: "hash-secreto", creadoEn: new Date("2026-09-01") });

    const resultado = await listarUsuarios(comoPrisma(fake));

    expect(resultado.map((u) => u.email)).toEqual(["a@srp.test", "b@srp.test"]);
    expect(resultado[0]).not.toHaveProperty("passwordHash");
  });
});

describe("crearUsuario", () => {
  it("crea un usuario con contrasena valida", async () => {
    const fake = new FakePrisma();

    const resultado = await crearUsuario(comoPrisma(fake), { email: "nuevo@srp.test", password: "clave-larga-123", rol: "ATENCION" });

    expect(resultado.ok).toBe(true);
    expect(fake.usuarios).toHaveLength(1);
    expect(fake.usuarios[0]!.email).toBe("nuevo@srp.test");
    expect(fake.usuarios[0]!.passwordHash).not.toBe("clave-larga-123"); // esta hasheada
  });

  it("rechaza una contrasena demasiado corta", async () => {
    const fake = new FakePrisma();

    const resultado = await crearUsuario(comoPrisma(fake), { email: "nuevo@srp.test", password: "corta", rol: "ATENCION" });

    expect(resultado).toEqual({ ok: false, motivo: "CONTRASENA_DEBIL" });
    expect(fake.usuarios).toHaveLength(0);
  });

  it("rechaza un correo ya registrado", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u1", email: "ya-existe@srp.test", passwordHash: "x" });

    const resultado = await crearUsuario(comoPrisma(fake), { email: "ya-existe@srp.test", password: "clave-larga-123", rol: "ATENCION" });

    expect(resultado).toEqual({ ok: false, motivo: "EMAIL_YA_EXISTE" });
    expect(fake.usuarios).toHaveLength(1);
  });
});

describe("actualizarUsuario", () => {
  it("cambia el rol y/o el estado activo", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u1", email: "a@srp.test", passwordHash: "x", rol: "ATENCION", activo: true });

    const resultado = await actualizarUsuario(comoPrisma(fake), "actor-admin", "u1", { rol: "CAJA", activo: false });

    expect(resultado.ok).toBe(true);
    expect(fake.usuarios[0]).toMatchObject({ rol: "CAJA", activo: false });
  });

  it("devuelve NO_ENCONTRADO si el usuario no existe", async () => {
    const fake = new FakePrisma();

    const resultado = await actualizarUsuario(comoPrisma(fake), "actor-admin", "no-existe", { activo: false });

    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADO" });
  });

  it("rechaza que un usuario se modifique a si mismo, incluso si es el unico administrador", async () => {
    const fake = new FakePrisma();
    fake.crearUsuario({ id: "u1", email: "admin@srp.test", passwordHash: "x", rol: "ADMINISTRADOR" });

    const resultado = await actualizarUsuario(comoPrisma(fake), "u1", "u1", { activo: false });

    expect(resultado).toEqual({ ok: false, motivo: "NO_PUEDE_MODIFICARSE_A_SI_MISMO" });
    expect(fake.usuarios[0]!.activo).toBe(true); // no se toco
  });
});
