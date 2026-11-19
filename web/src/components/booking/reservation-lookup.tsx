"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatoFechaLarga, formatoHora12, formatoMoneda, formatoRangoHora12 } from "@/lib/format";
import {
  buscarReservasPorTelefono,
  consultarReserva,
  obtenerConfiguracionPago,
  type ModoSinpe,
} from "@/lib/api";
import type { ReservaPublica } from "@/lib/types";
import { PaymentStep } from "./steps/payment-step";

const ETIQUETA_ESTADO: Record<string, string> = {
  TEMPORAL: "Retenida, pendiente de pago",
  PENDIENTE_VALIDACION_SINPE: "Comprobante en revisión",
  CONFIRMADA: "Confirmada",
  PAGADA: "Pagada",
  RECHAZADA: "Comprobante rechazado",
  CANCELADA: "Cancelada",
  EXPIRADA: "Vencida",
};

/** Segundos hasta que venza la retención (14.8): puede dar 0 si ya venció
 * pero el worker de expiracion (corre cada minuto) todavia no lo reflejo en
 * el estado. */
function segundosHastaExpirar(expiraEn: string): number {
  return Math.max(0, Math.floor((new Date(expiraEn).getTime() - Date.now()) / 1000));
}

export function ReservationLookup() {
  const searchParams = useSearchParams();
  const [codigo, setCodigo] = useState(searchParams.get("codigo") ?? "");
  const [reserva, setReserva] = useState<ReservaPublica | null | undefined>(undefined);
  const [buscando, setBuscando] = useState(false);
  const [modoSinpe, setModoSinpe] = useState<ModoSinpe>("MANUAL");

  // Busqueda alternativa por telefono + fecha, para quien perdio el codigo.
  const [porTelefono, setPorTelefono] = useState(false);
  const [telefono, setTelefono] = useState("");
  const [fechaBuscada, setFechaBuscada] = useState("");
  const [candidatas, setCandidatas] = useState<readonly ReservaPublica[] | null>(null);
  const [errorTelefono, setErrorTelefono] = useState<string | null>(null);

  function cambiarModo(telefonoActivo: boolean) {
    setPorTelefono(telefonoActivo);
    setReserva(undefined);
    setCandidatas(null);
    setErrorTelefono(null);
  }

  async function buscarPorTelefono(evento: FormEvent) {
    evento.preventDefault();
    if (telefono.trim().length === 0 || fechaBuscada.length === 0) return;
    setBuscando(true);
    setErrorTelefono(null);
    setReserva(undefined);
    setCandidatas(null);
    try {
      const resultado = await buscarReservasPorTelefono(telefono.trim(), fechaBuscada);
      if (!resultado.ok) {
        setErrorTelefono(
          resultado.motivo === "DEMASIADOS_INTENTOS"
            ? "Hiciste demasiadas búsquedas seguidas. Esperá un minuto e intentá de nuevo."
            : resultado.motivo === "DATOS_INVALIDOS"
              ? "Revisá el teléfono (8 dígitos) y la fecha."
              : "No pudimos consultar tu reserva. Intentá de nuevo.",
        );
        return;
      }
      setCandidatas(resultado.reservas);
      // Con una sola coincidencia se muestra directo, igual que al buscar por código.
      if (resultado.reservas.length === 1) setReserva(resultado.reservas[0]);
    } finally {
      setBuscando(false);
    }
  }

  useEffect(() => {
    obtenerConfiguracionPago().then(({ modoSinpe }) => setModoSinpe(modoSinpe));
  }, []);

  async function buscar(codigoBuscado: string) {
    if (codigoBuscado.trim().length === 0) return;
    setBuscando(true);
    try {
      setReserva(await consultarReserva(codigoBuscado.trim()));
    } finally {
      setBuscando(false);
    }
  }

  useEffect(() => {
    const codigoInicial = searchParams.get("codigo");
    if (!codigoInicial) return;
    let cancelado = false;
    consultarReserva(codigoInicial.trim()).then((r) => !cancelado && setReserva(r));
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function manejarEnvio(evento: FormEvent) {
    evento.preventDefault();
    buscar(codigo);
  }

  const puedeReanudarPago =
    reserva?.estado === "TEMPORAL" && reserva.expiraEn !== null && segundosHastaExpirar(reserva.expiraEn) > 0;

  return (
    <div className="flex w-full max-w-lg flex-col gap-6">
      <Card className="border-none shadow-sm">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Search className="size-5" />
          </div>
          <CardTitle className="text-xl">Consultá tu reserva</CardTitle>
          <CardDescription>
            {porTelefono
              ? "Ingresá el teléfono que usaste al reservar y la fecha de tu reserva."
              : "Ingresá el código que recibiste al reservar."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {!porTelefono ? (
            <form className="flex gap-3" onSubmit={manejarEnvio}>
              <div className="flex-1">
                <Label htmlFor="codigo" className="sr-only">
                  Código de reserva
                </Label>
                <Input
                  id="codigo"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  placeholder="SRP-XXXXX"
                  className="rounded-xl"
                />
              </div>
              <Button type="submit" className="rounded-xl" disabled={buscando}>
                {buscando ? "Buscando..." : "Buscar"}
              </Button>
            </form>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={buscarPorTelefono}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="telefono-busqueda">Teléfono</Label>
                  <Input
                    id="telefono-busqueda"
                    type="tel"
                    inputMode="tel"
                    value={telefono}
                    onChange={(e) => setTelefono(e.target.value)}
                    placeholder="8888-8888"
                    required
                    className="rounded-xl"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="fecha-busqueda">Fecha de la reserva</Label>
                  <Input
                    id="fecha-busqueda"
                    type="date"
                    value={fechaBuscada}
                    onChange={(e) => setFechaBuscada(e.target.value)}
                    required
                    className="rounded-xl"
                  />
                </div>
              </div>
              <Button type="submit" className="w-fit rounded-xl" disabled={buscando}>
                {buscando ? "Buscando..." : "Buscar"}
              </Button>
            </form>
          )}

          <button
            type="button"
            onClick={() => cambiarModo(!porTelefono)}
            className="text-primary w-fit text-sm font-medium underline underline-offset-4"
          >
            {porTelefono ? "Tengo el código de mi reserva" : "¿No tenés el código? Buscala con tu teléfono y la fecha"}
          </button>

          {!porTelefono && reserva === null && (
            <p className="text-muted-foreground text-sm">No encontramos ninguna reserva con ese código.</p>
          )}

          {errorTelefono && <p className="text-destructive text-sm">{errorTelefono}</p>}

          {porTelefono && candidatas !== null && candidatas.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No encontramos reservas con ese teléfono en esa fecha. Revisá que sea el mismo número que usaste al
              reservar y que la fecha sea la de tu reserva (no la del día en que reservaste).
            </p>
          )}

          {porTelefono && candidatas !== null && candidatas.length > 1 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Encontramos {candidatas.length} reservas. Elegí la tuya:</p>
              <ul className="flex flex-col gap-2">
                {candidatas.map((c) => {
                  const hora = c.lotes[0]?.heats[0]?.horaInicio;
                  const seleccionada = reserva?.codigoPublico === c.codigoPublico;
                  return (
                    <li key={c.codigoPublico}>
                      <button
                        type="button"
                        onClick={() => setReserva(c)}
                        aria-pressed={seleccionada}
                        className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm ${
                          seleccionada ? "border-primary bg-primary/10" : "hover:bg-accent"
                        }`}
                      >
                        <span className="font-medium">
                          {hora ? formatoHora12(hora) : "Sin hora"} · {c.cantidadPersonas}{" "}
                          {c.cantidadPersonas === 1 ? "persona" : "personas"}
                        </span>
                        <span className="text-muted-foreground">
                          {ETIQUETA_ESTADO[c.estado] ?? c.estado} · {c.codigoPublico}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {reserva && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{reserva.codigoPublico}</span>
                <Badge variant="secondary" className="rounded-full">
                  {ETIQUETA_ESTADO[reserva.estado] ?? reserva.estado}
                </Badge>
              </div>
              <Separator />
              <dl className="grid grid-cols-2 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Fecha</dt>
                <dd className="text-right font-medium">{formatoFechaLarga(reserva.fecha)}</dd>
                <dt className="text-muted-foreground">Personas</dt>
                <dd className="text-right font-medium">{reserva.cantidadPersonas}</dd>
                <dt className="text-muted-foreground">Total</dt>
                <dd className="text-right font-medium">{formatoMoneda(reserva.montoTotal, reserva.moneda)}</dd>
                <dt className="text-muted-foreground">Depósito</dt>
                <dd className="text-right font-medium">{formatoMoneda(reserva.montoDeposito, reserva.moneda)}</dd>
                <dt className="text-muted-foreground">Saldo pendiente</dt>
                <dd className="text-right font-medium">{formatoMoneda(reserva.montoSaldo, reserva.moneda)}</dd>
              </dl>
              {reserva.lotes.length > 0 && (
                <div className="rounded-2xl bg-accent p-4 text-sm">
                  {reserva.lotes.map((lote, i) => (
                    <div key={i} className="flex flex-wrap gap-2">
                      {lote.heats.map((heat, j) => (
                        <span key={j} className="rounded-lg bg-background px-2 py-1">
                          {formatoRangoHora12(heat.horaInicio, heat.horaFin)} · {heat.personas}p
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {reserva.estado === "TEMPORAL" && !puedeReanudarPago && (
                <p className="text-sm text-destructive">
                  El tiempo para completar el pago venció. Hacé una nueva reserva para volver a intentarlo.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {reserva && puedeReanudarPago && reserva.expiraEn && (
        <PaymentStep
          codigoPublico={reserva.codigoPublico}
          deposito={{ montoDeposito: reserva.montoDeposito, moneda: reserva.moneda }}
          pagoTarjetaHabilitado={reserva.pagoTarjetaHabilitado}
          modoSinpe={modoSinpe}
          segundosRestantesIniciales={segundosHastaExpirar(reserva.expiraEn)}
          onReportado={() => buscar(reserva.codigoPublico)}
        />
      )}
    </div>
  );
}
