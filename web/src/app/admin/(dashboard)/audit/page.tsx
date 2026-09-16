"use client";

import { useEffect, useState } from "react";
import { AuditLog } from "@/components/admin/audit-log";
import { obtenerSesion } from "@/lib/admin-auth";

export default function AdminAuditPage() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(obtenerSesion()?.token ?? null);
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Auditoría</h1>
        <p className="text-muted-foreground">Historial de acciones administrativas.</p>
      </div>

      {token ? <AuditLog token={token} /> : <p className="text-sm text-muted-foreground">Cargando...</p>}
    </div>
  );
}
