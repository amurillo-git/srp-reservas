// ============================================================================
// Gestion de usuarios administrativos (14.7).
//
// Reutiliza hashearContrasena de auth.service.ts (no reimplementa el
// hashing). Fuera de alcance de este slice (pendiente para mas adelante):
// recuperacion/cambio de contrasena — hoy no existe esa funcion en ningun
// lado del sistema (schema.prisma lo documenta explicitamente sobre User).
// ============================================================================

import type { PrismaClient, Rol } from "@prisma/client";
import { hashearContrasena } from "./auth.service.js";

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
