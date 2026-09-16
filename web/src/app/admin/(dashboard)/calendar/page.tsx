"use client";

import { useEffect, useState } from "react";
import { OperationalCalendar } from "@/components/admin/operational-calendar";
import { listarServicios } from "@/lib/api";
import { obtenerSesion } from "@/lib/admin-auth";
import type { Servicio } from "@/lib/types";

export default function AdminCalendarPage() {
  const [servicio, setServicio] = useState<Servicio | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(obtenerSesion()?.token ?? null);
    listarServicios().then((servicios) => setServicio(servicios[0] ?? null));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Calendario operativo</h1>
        <p className="text-muted-foreground">Vista diaria y semanal de lotes, heats y ocupación.</p>
      </div>

      {token && servicio ? (
        <OperationalCalendar token={token} serviceId={servicio.id} />
      ) : (
        <p className="text-sm text-muted-foreground">Cargando...</p>
      )}
    </div>
  );
}
