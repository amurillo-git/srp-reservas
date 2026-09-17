"use client";

import { useEffect, useState } from "react";
import { UsersManagement } from "@/components/admin/users-management";
import { obtenerSesion, obtenerUserIdDeToken } from "@/lib/admin-auth";

export default function AdminUsersPage() {
  const [token, setToken] = useState<string | null>(null);
  const [propioUserId, setPropioUserId] = useState<string | null>(null);

  useEffect(() => {
    const sesion = obtenerSesion();
    setToken(sesion?.token ?? null);
    setPropioUserId(sesion ? obtenerUserIdDeToken(sesion.token) : null);
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Usuarios y permisos</h1>
        <p className="text-muted-foreground">Gestión de cuentas del panel administrativo.</p>
      </div>

      {token ? <UsersManagement token={token} propioUserId={propioUserId} /> : <p className="text-sm text-muted-foreground">Cargando...</p>}
    </div>
  );
}
