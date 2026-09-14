// ============================================================================
// Servicio de autenticacion del panel administrativo (14.7, 20.1).
//
// Autenticacion minima para proteger las rutas /api/admin/*: hash de
// contrasena con crypto.scrypt (nativo de Node, sin dependencia extra de
// hashing) y sesiones como JWT firmados (con expiracion, sin revocacion
// activa: fuera de alcance de esta slice, ver README del PR). Ningun
// Request/Response de Express vive aqui — eso es responsabilidad de
// src/http/auth.middleware.ts; este archivo es logica de dominio pura sobre
// Prisma, igual que los demas *.service.ts del proyecto.
// ============================================================================

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";

const scrypt = promisify(scryptCallback);

const LONGITUD_HASH_BYTES = 64;
const JWT_EXPIRACION = "8h";

/** "sal:hash" (ambos en hex) — formato de almacenamiento de `User.passwordHash`. */
export async function hashearContrasena(contrasena: string): Promise<string> {
  const sal = randomBytes(16).toString("hex");
  const derivado = (await scrypt(contrasena, sal, LONGITUD_HASH_BYTES)) as Buffer;
  return `${sal}:${derivado.toString("hex")}`;
}

/** Compara en tiempo constante (`timingSafeEqual`) para no filtrar por
 * temporizacion cuanto de la contrasena coincide. */
export async function verificarContrasena(contrasena: string, hashAlmacenado: string): Promise<boolean> {
  const [sal, hashHex] = hashAlmacenado.split(":");
  if (!sal || !hashHex) return false;
  const hashOriginal = Buffer.from(hashHex, "hex");
  const derivado = (await scrypt(contrasena, sal, hashOriginal.length)) as Buffer;
  if (derivado.length !== hashOriginal.length) return false;
  return timingSafeEqual(derivado, hashOriginal);
}

export interface PayloadSesion {
  readonly userId: string;
  readonly email: string;
  readonly rol: string;
}

function obtenerSecretoJwt(): string {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) {
    throw new Error("JWT_SECRET no esta configurado (.env)");
  }
  return secreto;
}

export function emitirToken(payload: PayloadSesion): string {
  return jwt.sign(payload, obtenerSecretoJwt(), { expiresIn: JWT_EXPIRACION });
}

/** `null` si el token es invalido, esta expirado, o `JWT_SECRET` no esta
 * configurado — nunca lanza, para que el middleware siempre pueda responder
 * 401 en vez de un 500 inesperado. */
export function verificarToken(token: string): PayloadSesion | null {
  try {
    const payload = jwt.verify(token, obtenerSecretoJwt());
    if (typeof payload !== "object" || payload === null) return null;
    const { userId, email, rol } = payload as Record<string, unknown>;
    if (typeof userId !== "string" || typeof email !== "string" || typeof rol !== "string") return null;
    return { userId, email, rol };
  } catch {
    return null;
  }
}

export type ResultadoLogin =
  | { readonly ok: true; readonly token: string; readonly rol: string }
  | { readonly ok: false };

/** Verifica credenciales y emite un JWT (14.7). No distingue en la respuesta
 * entre "no existe" y "contrasena incorrecta": evitar filtrar cuentas
 * existentes por enumeracion (20.1). */
export async function iniciarSesion(
  prisma: PrismaClient,
  email: string,
  contrasena: string,
): Promise<ResultadoLogin> {
  const usuario = await prisma.user.findUnique({ where: { email } });
  if (!usuario || !usuario.activo) return { ok: false };

  const valida = await verificarContrasena(contrasena, usuario.passwordHash);
  if (!valida) return { ok: false };

  const token = emitirToken({ userId: usuario.id, email: usuario.email, rol: usuario.rol });
  return { ok: true, token, rol: usuario.rol };
}

/**
 * Si no existe ningun `User` todavia, crea el primer administrador desde
 * `ADMIN_EMAIL`/`ADMIN_PASSWORD` (variables de entorno). Resuelve el
 * problema del huevo y la gallina sin exponer un endpoint publico de
 * creacion de usuarios: se llama una sola vez al arrancar el servidor
 * (server.ts). Si las variables no estan configuradas, deja el panel sin
 * acceso y lo advierte por consola en vez de fallar el arranque completo.
 */
export async function asegurarAdminInicial(prisma: PrismaClient): Promise<void> {
  const existeAlguno = await prisma.user.findFirst();
  if (existeAlguno) return;

  const email = process.env.ADMIN_EMAIL;
  const contrasena = process.env.ADMIN_PASSWORD;
  if (!email || !contrasena) {
    console.warn(
      "No hay usuarios administrativos y ADMIN_EMAIL/ADMIN_PASSWORD no estan configurados: " +
        "el panel admin queda sin acceso hasta que se configuren y se reinicie el servidor.",
    );
    return;
  }

  const passwordHash = await hashearContrasena(contrasena);
  await prisma.user.create({ data: { email, passwordHash, rol: "ADMINISTRADOR" } });
  console.log(`Usuario administrador inicial creado: ${email}`);
}
