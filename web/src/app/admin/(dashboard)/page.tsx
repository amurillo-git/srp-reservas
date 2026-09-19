"use client";

import { useEffect, useState } from "react";
import { Ban, CreditCard, Flag, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { listarServicios } from "@/lib/api";
import {
  confirmarSinpeAdmin,
  obtenerBloqueosDelDia,
  obtenerOcupacionDelDia,
  obtenerReservasDelDia,
  obtenerSinpePendientes,
  rechazarSinpeAdmin,
  type BloqueoAdmin,
  type OcupacionHeat,
  type ReservaDelDia,
  type SinpePendiente,
} from "@/lib/admin-api";
import { obtenerSesion } from "@/lib/admin-auth";
import { formatoFechaLarga, formatoMoneda, hoyISO } from "@/lib/format";
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
  const sinpePendientes = usarSeccion<SinpePendiente>((t, s) => obtenerSinpePendientes(t, s), token, servicioId);
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
        <SeccionSinpePendientes estado={sinpePendientes} token={token} />
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

function SeccionSinpePendientes({
  estado,
  token,
}: {
  estado: EstadoSeccion<SinpePendiente>;
  token: string | null;
}) {
  const [pendientes, setPendientes] = useState<readonly SinpePendiente[] | null>(null);
  const [expandido, setExpandido] = useState<string | null>(null);

  useEffect(() => {
    if (estado.tipo === "lista") setPendientes(estado.datos);
  }, [estado]);

  function quitarDeLaLista(codigoPublico: string) {
    setPendientes((actual) => actual?.filter((r) => r.codigoPublico !== codigoPublico) ?? null);
    setExpandido(null);
  }

  const lista = pendientes ?? [];

  return (
    <Card className="border-none shadow-sm">
      <EncabezadoSeccion
        icono={<CreditCard className="size-4" />}
        titulo="SINPE pendientes"
        descripcion="Depósitos esperando validación, sin importar la fecha."
      />
      <CardContent className="flex flex-col gap-2">
        <EstadoVacioOError estado={estado} />
        {estado.tipo === "lista" && lista.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay comprobantes pendientes.</p>
        )}
        {estado.tipo === "lista" &&
          token &&
          lista.map((r) => (
            <RevisionSinpe
              key={r.codigoPublico}
              reserva={r}
              token={token}
              expandido={expandido === r.codigoPublico}
              onExpandir={() => setExpandido((actual) => (actual === r.codigoPublico ? null : r.codigoPublico))}
              onResuelto={() => quitarDeLaLista(r.codigoPublico)}
            />
          ))}
      </CardContent>
    </Card>
  );
}

function RevisionSinpe({
  reserva,
  token,
  expandido,
  onExpandir,
  onResuelto,
}: {
  reserva: SinpePendiente;
  token: string;
  expandido: boolean;
  onExpandir: () => void;
  onResuelto: () => void;
}) {
  const [modoMonto, setModoMonto] = useState<"exacto" | "otro">("exacto");
  const [montoOtro, setMontoOtro] = useState("");
  const [mostrarRechazo, setMostrarRechazo] = useState(false);
  const [motivoRechazo, setMotivoRechazo] = useState("");
  const [procesando, setProcesando] = useState(false);

  async function aprobar() {
    let montoPagado: number | undefined;
    if (modoMonto === "otro") {
      montoPagado = Number(montoOtro);
      if (!montoOtro || !(montoPagado > 0)) {
        toast.error("Ingresá un monto válido.");
        return;
      }
    }
    setProcesando(true);
    const resultado = await confirmarSinpeAdmin(token, reserva.codigoPublico, montoPagado);
    setProcesando(false);
    if (!resultado.ok) {
      toast.error("No se pudo aprobar el comprobante.");
      return;
    }
    toast.success("Comprobante aprobado. Reserva confirmada.");
    onResuelto();
  }

  async function rechazar() {
    if (!motivoRechazo.trim()) {
      toast.error("Ingresá el motivo del rechazo.");
      return;
    }
    setProcesando(true);
    const resultado = await rechazarSinpeAdmin(token, reserva.codigoPublico, motivoRechazo.trim());
    setProcesando(false);
    if (!resultado.ok) {
      toast.error("No se pudo rechazar el comprobante.");
      return;
    }
    toast.success("Comprobante rechazado.");
    onResuelto();
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{reserva.clienteNombre}</p>
          <p className="text-xs text-muted-foreground">
            {reserva.codigoPublico} · {reserva.fecha}
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={onExpandir}>
          {expandido ? "Cerrar" : "Revisar"}
        </Button>
      </div>

      {expandido && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <dl className="grid grid-cols-2 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Nombre de quien pagó</dt>
            <dd className="text-right">{reserva.nombrePagador ?? "—"}</dd>
            <dt className="text-muted-foreground">Número de origen</dt>
            <dd className="text-right">{reserva.numeroOrigen ?? "—"}</dd>
            <dt className="text-muted-foreground">Referencia</dt>
            <dd className="text-right">{reserva.referencia ?? "—"}</dd>
          </dl>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`monto-${reserva.codigoPublico}`}
                checked={modoMonto === "exacto"}
                onChange={() => setModoMonto("exacto")}
              />
              Monto exacto ({formatoMoneda(reserva.montoDeposito, reserva.moneda)})
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={`monto-${reserva.codigoPublico}`}
                checked={modoMonto === "otro"}
                onChange={() => setModoMonto("otro")}
              />
              Otro
              <Input
                type="number"
                min={0}
                step="1"
                className="h-7 w-32"
                value={montoOtro}
                onChange={(e) => {
                  setModoMonto("otro");
                  setMontoOtro(e.target.value);
                }}
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={aprobar} disabled={procesando}>
              {procesando ? "Procesando..." : "Aprobar"}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setMostrarRechazo((v) => !v)} disabled={procesando}>
              Rechazar
            </Button>
          </div>

          {mostrarRechazo && (
            <div className="flex flex-col gap-2">
              <Input
                placeholder="Motivo del rechazo"
                value={motivoRechazo}
                onChange={(e) => setMotivoRechazo(e.target.value)}
              />
              <Button size="sm" variant="destructive" onClick={rechazar} disabled={procesando}>
                {procesando ? "Procesando..." : "Confirmar rechazo"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
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
