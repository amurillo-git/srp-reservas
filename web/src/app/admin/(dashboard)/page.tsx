"use client";

import { useEffect, useState } from "react";
import { Ban, CreditCard, Flag, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listarServicios } from "@/lib/api";
import {
  obtenerBloqueosDelDia,
  obtenerOcupacionDelDia,
  obtenerReservasDelDia,
  obtenerSinpePendientes,
  type BloqueoAdmin,
  type OcupacionHeat,
  type ReservaDelDia,
  type ReservaResumen,
} from "@/lib/admin-api";
import { obtenerSesion } from "@/lib/admin-auth";
import { formatoFechaLarga, hoyISO } from "@/lib/format";
import type { Servicio } from "@/lib/types";

/** Estado de carga de una seccion del dashboard: cada widget se resuelve de
 * forma independiente (14.1) para que un 403 (rol sin permiso, ver Gate-1
 * del panel admin) o cualquier otro error en un widget no tumbe a los
 * demas. */
type EstadoSeccion<T> =
  | { readonly tipo: "cargando" }
  | { readonly tipo: "lista"; readonly datos: readonly T[] }
  | { readonly tipo: "error"; readonly mensaje: string };

function usarSeccion<T>(
  cargar: ((token: string, servicioId: string) => Promise<readonly T[]>) | null,
  token: string | null,
  servicioId: string | null,
): EstadoSeccion<T> {
  const [estado, setEstado] = useState<EstadoSeccion<T>>({ tipo: "cargando" });

  useEffect(() => {
    if (!cargar || !token || !servicioId) return;
    let cancelado = false;
    setEstado({ tipo: "cargando" });
    cargar(token, servicioId)
      .then((datos) => {
        if (!cancelado) setEstado({ tipo: "lista", datos });
      })
      .catch((error: unknown) => {
        if (cancelado) return;
        const status = error instanceof Object && "status" in error ? (error as { status: number }).status : null;
        const mensaje = status === 403 ? "Tu rol no tiene permiso para ver esto." : "No se pudo cargar.";
        setEstado({ tipo: "error", mensaje });
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, servicioId]);

  return estado;
}

export default function AdminInicioPage() {
  const [servicio, setServicio] = useState<Servicio | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const fecha = hoyISO();

  useEffect(() => {
    setToken(obtenerSesion()?.token ?? null);
    listarServicios().then((servicios) => setServicio(servicios[0] ?? null));
  }, []);

  const servicioId = servicio?.id ?? null;
  const reservas = usarSeccion<ReservaDelDia>(
    (t, s) => obtenerReservasDelDia(t, s, fecha),
    token,
    servicioId,
  );
  const ocupacion = usarSeccion<OcupacionHeat>((t, s) => obtenerOcupacionDelDia(t, s, fecha), token, servicioId);
  const sinpePendientes = usarSeccion<ReservaResumen>((t, s) => obtenerSinpePendientes(t, s), token, servicioId);
  const bloqueos = usarSeccion<BloqueoAdmin>((t, s) => obtenerBloqueosDelDia(t, s, fecha), token, servicioId);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Inicio</h1>
        <p className="text-muted-foreground">{formatoFechaLarga(fecha)}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SeccionReservas estado={reservas} />
        <SeccionOcupacion estado={ocupacion} />
        <SeccionSinpePendientes estado={sinpePendientes} />
        <SeccionBloqueos estado={bloqueos} />
      </div>
    </div>
  );
}

function EncabezadoSeccion({
  icono,
  titulo,
  descripcion,
}: {
  icono: React.ReactNode;
  titulo: string;
  descripcion: string;
}) {
  return (
    <CardHeader>
      <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">{icono}</div>
      <CardTitle className="text-base">{titulo}</CardTitle>
      <CardDescription>{descripcion}</CardDescription>
    </CardHeader>
  );
}

function EstadoVacioOError({ estado }: { estado: EstadoSeccion<unknown> }) {
  if (estado.tipo === "cargando") return <p className="text-sm text-muted-foreground">Cargando...</p>;
  if (estado.tipo === "error") return <p className="text-sm text-destructive">{estado.mensaje}</p>;
  return null;
}

function SeccionReservas({ estado }: { estado: EstadoSeccion<ReservaDelDia> }) {
  return (
    <Card className="border-none shadow-sm">
      <EncabezadoSeccion icono={<Users className="size-4" />} titulo="Reservas de hoy" descripcion="Todas, sin importar el estado." />
      <CardContent className="flex flex-col gap-2">
        <EstadoVacioOError estado={estado} />
        {estado.tipo === "lista" && estado.datos.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay reservas para hoy.</p>
        )}
        {estado.tipo === "lista" &&
          estado.datos.map((r) => (
            <div key={r.codigoPublico} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{r.clienteNombre}</p>
                <p className="text-xs text-muted-foreground">
                  {r.codigoPublico} · {r.cantidadPersonas} personas
                </p>
              </div>
              <Badge variant="outline">{r.estado}</Badge>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function SeccionOcupacion({ estado }: { estado: EstadoSeccion<OcupacionHeat> }) {
  return (
    <Card className="border-none shadow-sm">
      <EncabezadoSeccion icono={<Flag className="size-4" />} titulo="Ocupación de heats" descripcion="Cupo usado y disponible por horario." />
      <CardContent className="flex flex-col gap-2">
        <EstadoVacioOError estado={estado} />
        {estado.tipo === "lista" && estado.datos.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay heats programados para hoy.</p>
        )}
        {estado.tipo === "lista" &&
          estado.datos.map((h) => (
            <div key={h.heatId} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">{h.horaInicio}</span>
              <span className="text-muted-foreground">
                {h.ocupados}/{h.capacidadMaxima} ocupados · {h.disponible} libres
              </span>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function SeccionSinpePendientes({ estado }: { estado: EstadoSeccion<ReservaResumen> }) {
  return (
    <Card className="border-none shadow-sm">
      <EncabezadoSeccion
        icono={<CreditCard className="size-4" />}
        titulo="SINPE pendientes"
        descripcion="Depósitos esperando validación, sin importar la fecha."
      />
      <CardContent className="flex flex-col gap-2">
        <EstadoVacioOError estado={estado} />
        {estado.tipo === "lista" && estado.datos.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay comprobantes pendientes.</p>
        )}
        {estado.tipo === "lista" &&
          estado.datos.map((r) => (
            <div key={r.codigoPublico} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{r.clienteNombre}</p>
                <p className="text-xs text-muted-foreground">{r.codigoPublico}</p>
              </div>
              <span className="text-xs text-muted-foreground">{r.fecha}</span>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function SeccionBloqueos({ estado }: { estado: EstadoSeccion<BloqueoAdmin> }) {
  return (
    <Card className="border-none shadow-sm">
      <EncabezadoSeccion icono={<Ban className="size-4" />} titulo="Bloqueos activos" descripcion="Cierres administrativos de hoy." />
      <CardContent className="flex flex-col gap-2">
        <EstadoVacioOError estado={estado} />
        {estado.tipo === "lista" && estado.datos.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay bloqueos hoy.</p>
        )}
        {estado.tipo === "lista" &&
          estado.datos.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">
                {b.horaInicio}–{b.horaFin}
              </span>
              <span className="truncate text-muted-foreground">{b.motivo ?? "Sin motivo"}</span>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
