"use client";

import { useEffect, useState } from "react";
import { AdministrativeBlocks } from "@/components/admin/administrative-blocks";
import { CardPaymentToggle } from "@/components/admin/card-payment-toggle";
import { SinpeModeToggle } from "@/components/admin/sinpe-mode-toggle";
import { ScheduleExceptions } from "@/components/admin/schedule-exceptions";
import { WeeklySchedule } from "@/components/admin/weekly-schedule";
import { listarServicios } from "@/lib/api";
import { obtenerSesion } from "@/lib/admin-auth";
import type { Servicio } from "@/lib/types";

export default function AdminSchedulePage() {
  const [servicio, setServicio] = useState<Servicio | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(obtenerSesion()?.token ?? null);
    listarServicios().then((servicios) => setServicio(servicios[0] ?? null));
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Horarios y bloqueos</h1>
        <p className="text-muted-foreground">Horario habitual, excepciones de calendario y cierres administrativos.</p>
      </div>

      {token && servicio ? (
        <div className="flex flex-col gap-4">
          <WeeklySchedule token={token} serviceId={servicio.id} />
          <ScheduleExceptions token={token} serviceId={servicio.id} />
          <AdministrativeBlocks token={token} serviceId={servicio.id} />
          <CardPaymentToggle token={token} serviceId={servicio.id} initialEnabled={servicio.pagoTarjetaHabilitado} />
          <SinpeModeToggle token={token} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Cargando...</p>
      )}
    </div>
  );
}
