"use client";

import { useEffect, useState } from "react";
import { ReservationsSearch } from "@/components/admin/reservations-search";
import { listarServicios } from "@/lib/api";
import { obtenerSesion } from "@/lib/admin-auth";
import type { Servicio } from "@/lib/types";

export default function AdminReservationsPage() {
  const [servicio, setServicio] = useState<Servicio | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(obtenerSesion()?.token ?? null);
    listarServicios().then((servicios) => setServicio(servicios[0] ?? null));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Gestión de reservas</h1>
        <p className="text-muted-foreground">Buscar, cancelar y reprogramar reservas existentes.</p>
      </div>

      {token && servicio ? (
        <ReservationsSearch token={token} serviceId={servicio.id} />
      ) : (
        <p className="text-sm text-muted-foreground">Cargando...</p>
      )}
    </div>
  );
}
