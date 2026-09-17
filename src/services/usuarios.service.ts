// ============================================================================
// Gestion de usuarios administrativos (14.7) + cambio/recuperacion de
// contrasena.
//
// Reutiliza hashearContrasena/verificarContrasena de auth.service.ts (no
// reimplementa el hashing). Sin proveedor de notificaciones (seccion 15)
// todavia, un "olvide mi contrasena" por correo/SMS no es viable: en su
// lugar, un Administrador puede restablecer la contrasena de otro usuario
// directamente (restablecerContrasena) y comunicarsela fuera del sistema.
// ============================================================================

import type { PrismaClient, Rol } from "@prisma/client";
import { hashearContrasena, verificarContrasena } from "./auth.service.js";

const LONGITUD_MINIMA_CONTRASENA = 8;

export interface UsuarioAdmin {
  readonly id: string;
  readonly email: string;
  readonly rol: string;
  readonly activo: boolean;
  readonly creadoEn: string;
}

function comoUsuarioAdmin(u: { id: string; email: string; rol: string; activo: boolean; creadoEn: Date }): UsuarioAdmin {
  return { id: u.id, email: u.email, rol: u.rol, activo: u.activo, creadoEn: u.creadoEn.toISOString() };
}

export async function listarUsuarios(prisma: PrismaClient): Promise<readonly UsuarioAdmin[]> {
  const usuarios = await prisma.user.findMany({ orderBy: { creadoEn: "asc" } });
  return usuarios.map(comoUsuarioAdmin);
}

export interface DatosCrearUsuario {
  readonly email: string;
  readonly password: string;
  readonly rol: Rol;
}

export type ResultadoCrearUsuario =
  | { readonly ok: true; readonly usuario: UsuarioAdmin }
  | { readonly ok: false; readonly motivo: "EMAIL_YA_EXISTE" }
  | { readonly ok: false; readonly motivo: "CONTRASENA_DEBIL" };

export async function crearUsuario(prisma: PrismaClient, datos: DatosCrearUsuario): Promise<ResultadoCrearUsuario> {
  if (datos.password.length < LONGITUD_MINIMA_CONTRASENA) {
    return { ok: false, motivo: "CONTRASENA_DEBIL" };
  }
  const existente = await prisma.user.findUnique({ where: { email: datos.email } });
  if (existente) {
    return { ok: false, motivo: "EMAIL_YA_EXISTE" };
  }
  const passwordHash = await hashearContrasena(datos.password);
  const usuario = await prisma.user.create({ data: { email: datos.email, passwordHash, rol: datos.rol } });
  return { ok: true, usuario: comoUsuarioAdmin(usuario) };
}

export interface DatosActualizarUsuario {
  readonly rol?: Rol;
  readonly activo?: boolean;
}

export type ResultadoActualizarUsuario =
  | { readonly ok: true; readonly usuario: UsuarioAdmin }
  | { readonly ok: false; readonly motivo: "NO_ENCONTRADO" }
  | { readonly ok: false; readonly motivo: "NO_PUEDE_MODIFICARSE_A_SI_MISMO" };

/**
 * Cambia el rol y/o el estado activo de un usuario (14.7). `actorUserId` es
 * quien hace el cambio (del JWT): un usuario nunca puede modificarse a si
 * mismo por esta via, para no poder quedar bloqueado (desactivarse o
 * quitarse el rol de administrador) por accidente.
 */
export async function actualizarUsuario(
  prisma: PrismaClient,
  actorUserId: string,
  id: string,
  datos: DatosActualizarUsuario,
): Promise<ResultadoActualizarUsuario> {
  if (id === actorUserId) {
    return { ok: false, motivo: "NO_PUEDE_MODIFICARSE_A_SI_MISMO" };
  }
  const existente = await prisma.user.findUnique({ where: { id } });
  if (!existente) {
    return { ok: false, motivo: "NO_ENCONTRADO" };
  }
  const usuario = await prisma.user.update({ where: { id }, data: { rol: datos.rol, activo: datos.activo } });
  return { ok: true, usuario: comoUsuarioAdmin(usuario) };
}

export type ResultadoCambiarContrasena =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: "NO_ENCONTRADO" }
  | { readonly ok: false; readonly motivo: "CONTRASENA_ACTUAL_INCORRECTA" }
  | { readonly ok: false; readonly motivo: "CONTRASENA_DEBIL" };

/** Cambio de contrasena por el propio usuario (requiere conocer la actual). */
export async function cambiarContrasenaPropia(
  prisma: PrismaClient,
  userId: string,
  contrasenaActual: string,
  contrasenaNueva: string,
): Promise<ResultadoCambiarContrasena> {
  if (contrasenaNueva.length < LONGITUD_MINIMA_CONTRASENA) {
    return { ok: false, motivo: "CONTRASENA_DEBIL" };
  }
  const usuario = await prisma.user.findUnique({ where: { id: userId } });
  if (!usuario) {
    return { ok: false, motivo: "NO_ENCONTRADO" };
  }
  const valida = await verificarContrasena(contrasenaActual, usuario.passwordHash);
  if (!valida) {
    return { ok: false, motivo: "CONTRASENA_ACTUAL_INCORRECTA" };
  }
  const passwordHash = await hashearContrasena(contrasenaNueva);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  return { ok: true };
}

export type ResultadoRestablecerContrasena =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: "NO_ENCONTRADO" }
  | { readonly ok: false; readonly motivo: "CONTRASENA_DEBIL" };

/**
 * "Recuperacion" de contrasena (14.7, sin proveedor de notificaciones
 * todavia): un Administrador le asigna una contrasena nueva a otro usuario
 * sin necesitar la actual, para comunicarsela fuera del sistema.
 */
export async function restablecerContrasena(
  prisma: PrismaClient,
  id: string,
  contrasenaNueva: string,
): Promise<ResultadoRestablecerContrasena> {
  if (contrasenaNueva.length < LONGITUD_MINIMA_CONTRASENA) {
    return { ok: false, motivo: "CONTRASENA_DEBIL" };
  }
  const usuario = await prisma.user.findUnique({ where: { id } });
  if (!usuario) {
    return { ok: false, motivo: "NO_ENCONTRADO" };
  }
  const passwordHash = await hashearContrasena(contrasenaNueva);
  await prisma.user.update({ where: { id }, data: { passwordHash } });
  return { ok: true };
}
