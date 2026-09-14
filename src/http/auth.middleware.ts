// ============================================================================
// Middleware de autenticacion para las rutas /api/admin/* (14.7, 20.1).
// ============================================================================

import type { NextFunction, Request, Response } from "express";
import { verificarToken, type PayloadSesion } from "../services/auth.service.js";

export interface RequestAutenticado extends Request {
  usuario?: PayloadSesion;
}

/** Exige un `Authorization: Bearer <token>` valido. Si se pasan
 * `rolesPermitidos`, ademas exige que el rol del usuario este en esa lista
 * (14.7: ej. solo ADMINISTRADOR/CAJA pueden validar depositos SINPE). */
export function requireAuth(rolesPermitidos?: readonly string[]) {
  return (req: RequestAutenticado, res: Response, next: NextFunction): void => {
    const encabezado = req.header("Authorization");
    const token = encabezado?.startsWith("Bearer ") ? encabezado.slice("Bearer ".length) : null;
    if (!token) {
      res.status(401).json({ error: "Se requiere autenticacion" });
      return;
    }

    const payload = verificarToken(token);
    if (!payload) {
      res.status(401).json({ error: "Token invalido o expirado" });
      return;
    }

    if (rolesPermitidos && !rolesPermitidos.includes(payload.rol)) {
      res.status(403).json({ error: "No tiene permiso para esta accion" });
      return;
    }

    req.usuario = payload;
    next();
  };
}
