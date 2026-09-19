"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CreditCard, Landmark, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consultarReserva, obtenerConfiguracionPago, type ModoSinpe } from "@/lib/api";
import { formatoMoneda } from "@/lib/format";
import {
  buscarReservasAdmin,
  cancelarReservaAdmin,
  iniciarSaldoSinpeAdmin,
  iniciarSaldoTarjetaAdmin,
  marcarSaldoManualAdmin,
  reprogramarReservaAdmin,
  type ReservaBusqueda,
} from "@/lib/admin-api";

const ESTADOS = [
  { valor: "", etiqueta: "Cualquier estado" },
  { valor: "TEMPORAL", etiqueta: "Temporal" },
  { valor: "PENDIENTE_VALIDACION_SINPE", etiqueta: "Pendiente SINPE" },
  { valor: "CONFIRMADA", etiqueta: "Confirmada" },
  { valor: "PAGADA", etiqueta: "Pagada" },
  { valor: "RECHAZADA", etiqueta: "Rechazada" },
  { valor: "CANCELADA", etiqueta: "Cancelada" },
  { valor: "EXPIRADA", etiqueta: "Expirada" },
] as const;

const VARIANTE_POR_ESTADO: Record<string, "default" | "outline" | "destructive"> = {
  CONFIRMADA: "default",
  PAGADA: "default",
  CANCELADA: "destructive",
  RECHAZADA: "destructive",
  EXPIRADA: "destructive",
};

/** Motivos tecnicos que devuelve gestion-reservas.service.ts, traducidos a
 * texto que un administrador no tecnico pueda entender. */
const MOTIVOS: Record<string, string> = {
  NO_ENCONTRADA: "No se encontró esa reserva.",
  ESTADO_INVALIDO: "Esa reserva ya no se puede modificar en su estado actual.",
  NO_DISPONIBLE: "No hay cupo disponible en esa fecha y hora.",
  CONFLICTO_CONCURRENCIA: "La disponibilidad cambió justo ahora — probá de nuevo.",
};

function textoMotivo(motivo: string): string {
  return MOTIVOS[motivo] ?? motivo;
}

interface Filtros {
  q: string;
  status: string;
  from: string;
  to: string;
}

const FILTROS_VACIOS: Filtros = { q: "", status: "", from: "", to: "" };

interface FormularioReprogramar {
  date: string;
  startTime: string;
  partySize: number;
}

export function ReservationsSearch({ token, serviceId }: { token: string; serviceId: string }) {
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VACIOS);
  const [resultados, setResultados] = useState<readonly ReservaBusqueda[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [reprogramando, setReprogramando] = useState<string | null>(null);
  const [formulario, setFormulario] = useState<FormularioReprogramar>({ date: "", startTime: "", partySize: 1 });
  const [procesando, setProcesando] = useState<string | null>(null);
  const [cobrando, setCobrando] = useState<string | null>(null);
  const [modoSinpe, setModoSinpe] = useState<ModoSinpe>("MANUAL");

  useEffect(() => {
    obtenerConfiguracionPago().then(({ modoSinpe }) => setModoSinpe(modoSinpe));
  }, []);

  async function buscar() {
    setBuscando(true);
    const encontradas = await buscarReservasAdmin(token, serviceId, {
      q: filtros.q.trim() || undefined,
      status: filtros.status || undefined,
      from: filtros.from || undefined,
      to: filtros.to || undefined,
    });
    setResultados(encontradas);
    setBuscando(false);
  }

  async function cancelar(codigoPublico: string) {
    if (!window.confirm(`¿Cancelar la reserva ${codigoPublico}? Esta acción no se puede deshacer.`)) return;
    setProcesando(codigoPublico);
    const resultado = await cancelarReservaAdmin(token, codigoPublico);
    setProcesando(null);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    toast.success("Reserva cancelada.");
    setResultados((actual) =>
      actual?.map((r) => (r.codigoPublico === codigoPublico ? { ...r, estado: "CANCELADA" } : r)) ?? null,
    );
  }

  function marcarComoPagada(codigoPublico: string) {
    setResultados((actual) =>
      actual?.map((r) => (r.codigoPublico === codigoPublico ? { ...r, estado: "PAGADA" } : r)) ?? null,
    );
  }

  async function cobrarManual(codigoPublico: string) {
    if (!window.confirm(`¿Confirmás que el cliente ya pagó el saldo completo de ${codigoPublico}?`)) return;
    setProcesando(codigoPublico);
    const resultado = await marcarSaldoManualAdmin(token, codigoPublico);
    setProcesando(null);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    toast.success("Saldo cobrado. Reserva pagada por completo.");
    marcarComoPagada(codigoPublico);
  }

  function abrirReprogramar(reserva: ReservaBusqueda) {
    setReprogramando(reserva.codigoPublico);
    setFormulario({ date: reserva.fecha, startTime: "", partySize: reserva.cantidadPersonas });
  }

  async function confirmarReprogramar(codigoPublico: string) {
    if (!formulario.date || !formulario.startTime || formulario.partySize <= 0) {
      toast.error("Completá fecha, hora y cantidad de personas.");
      return;
    }
    setProcesando(codigoPublico);
    const resultado = await reprogramarReservaAdmin(token, codigoPublico, {
      date: formulario.date,
      startTime: formulario.startTime,
      partySize: formulario.partySize,
    });
    setProcesando(null);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    toast.success("Reserva reprogramada.");
    setReprogramando(null);
    setResultados((actual) =>
      actual?.map((r) =>
        r.codigoPublico === codigoPublico
          ? { ...r, fecha: formulario.date, cantidadPersonas: formulario.partySize, vecesReprogramada: r.vecesReprogramada + 1 }
          : r,
      ) ?? null,
    );
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Search className="size-4" />
        </div>
        <CardTitle className="text-base">Buscar reservas</CardTitle>
        <CardDescription>Por código, nombre, teléfono, estado o fecha.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <Label htmlFor="busqueda-q">Código, nombre o teléfono</Label>
            <Input
              id="busqueda-q"
              value={filtros.q}
              onChange={(e) => setFiltros({ ...filtros, q: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && buscar()}
              placeholder="Ej. SRP-... o Ana"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="busqueda-estado">Estado</Label>
            <select
              id="busqueda-estado"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={filtros.status}
              onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}
            >
              {ESTADOS.map((e) => (
                <option key={e.valor} value={e.valor}>
                  {e.etiqueta}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="busqueda-desde">Desde</Label>
            <Input
              id="busqueda-desde"
              type="date"
              value={filtros.from}
              onChange={(e) => setFiltros({ ...filtros, from: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="busqueda-hasta">Hasta</Label>
            <Input
              id="busqueda-hasta"
              type="date"
              value={filtros.to}
              onChange={(e) => setFiltros({ ...filtros, to: e.target.value })}
            />
          </div>
        </div>
        <Button size="sm" className="w-fit" onClick={buscar} disabled={buscando}>
          {buscando ? "Buscando..." : "Buscar"}
        </Button>

        <div className="flex flex-col gap-2 border-t pt-4">
          {resultados === null && <p className="text-sm text-muted-foreground">Buscá para ver resultados.</p>}
          {resultados !== null && resultados.length === 0 && (
            <p className="text-sm text-muted-foreground">Ninguna reserva coincide con esa búsqueda.</p>
          )}
          {resultados?.map((r) => (
            <div key={r.codigoPublico} className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{r.clienteNombre}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.codigoPublico} · {r.clienteTelefono} · {r.fecha} · {r.cantidadPersonas} personas
                    {r.vecesReprogramada > 0 ? ` · reprogramada ${r.vecesReprogramada}x` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={VARIANTE_POR_ESTADO[r.estado] ?? "outline"}>{r.estado}</Badge>
                  {r.estado === "CONFIRMADA" && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() =>
                        modoSinpe === "MANUAL" ? cobrarManual(r.codigoPublico) : setCobrando(cobrando === r.codigoPublico ? null : r.codigoPublico)
                      }
                      disabled={procesando === r.codigoPublico}
                    >
                      Cobrar saldo
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => abrirReprogramar(r)}
                    disabled={procesando === r.codigoPublico}
                  >
                    Reprogramar
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => cancelar(r.codigoPublico)}
                    disabled={procesando === r.codigoPublico}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>

              {cobrando === r.codigoPublico && (
                <PanelCobroSaldo
                  token={token}
                  codigoPublico={r.codigoPublico}
                  montoSaldo={r.montoSaldo}
                  moneda={r.moneda}
                  onPagado={() => {
                    marcarComoPagada(r.codigoPublico);
                    setCobrando(null);
                  }}
                  onCerrar={() => setCobrando(null)}
                />
              )}

              {reprogramando === r.codigoPublico && (
                <div className="flex flex-col gap-3 border-t pt-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`reprogramar-fecha-${r.codigoPublico}`}>Nueva fecha</Label>
                      <Input
                        id={`reprogramar-fecha-${r.codigoPublico}`}
                        type="date"
                        value={formulario.date}
                        onChange={(e) => setFormulario({ ...formulario, date: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`reprogramar-hora-${r.codigoPublico}`}>Nueva hora</Label>
                      <Input
                        id={`reprogramar-hora-${r.codigoPublico}`}
                        type="time"
                        value={formulario.startTime}
                        onChange={(e) => setFormulario({ ...formulario, startTime: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`reprogramar-personas-${r.codigoPublico}`}>Personas</Label>
                      <Input
                        id={`reprogramar-personas-${r.codigoPublico}`}
                        type="number"
                        min={1}
                        value={formulario.partySize}
                        onChange={(e) => setFormulario({ ...formulario, partySize: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => confirmarReprogramar(r.codigoPublico)} disabled={procesando === r.codigoPublico}>
                      {procesando === r.codigoPublico ? "Guardando..." : "Confirmar"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReprogramando(null)} disabled={procesando === r.codigoPublico}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Cobro de saldo con modo ONVO (25): elegir SINPE Móvil o tarjeta. En SINPE
 * pide teléfono+cédula (igual que el depósito) y espera confirmación; en
 * tarjeta genera un link de checkout para que el staff se lo muestre al
 * cliente. Ambos casos consultan la reserva cada pocos segundos hasta que
 * pasa a PAGADA. */
function PanelCobroSaldo({
  token,
  codigoPublico,
  montoSaldo,
  moneda,
  onPagado,
  onCerrar,
}: {
  token: string;
  codigoPublico: string;
  montoSaldo: number;
  moneda: string;
  onPagado: () => void;
  onCerrar: () => void;
}) {
  const [metodo, setMetodo] = useState<"elegir" | "sinpe">("elegir");
  const [telefono, setTelefono] = useState("");
  const [cedula, setCedula] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [intencion, setIntencion] = useState<{ numeroSinpe: string; monto: number; moneda: string } | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!intencion && !checkoutUrl) return;
    const id = setInterval(async () => {
      const reserva = await consultarReserva(codigoPublico);
      if (reserva && reserva.estado === "PAGADA") {
        clearInterval(id);
        onPagado();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [intencion, checkoutUrl, codigoPublico, onPagado]);

  async function generarSinpe(evento: FormEvent) {
    evento.preventDefault();
    setEnviando(true);
    const resultado = await iniciarSaldoSinpeAdmin(token, codigoPublico, {
      telefono: telefono.trim(),
      cedula: cedula.trim(),
    });
    setEnviando(false);
    if (!resultado.ok) {
      toast.error("No se pudo iniciar el pago SINPE.");
      return;
    }
    setIntencion({ numeroSinpe: resultado.numeroSinpe, monto: resultado.monto, moneda: resultado.moneda });
  }

  async function generarTarjeta() {
    setEnviando(true);
    const resultado = await iniciarSaldoTarjetaAdmin(token, codigoPublico);
    setEnviando(false);
    if (!resultado.ok) {
      toast.error("No se pudo iniciar el pago con tarjeta.");
      return;
    }
    setCheckoutUrl(resultado.checkoutUrl);
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <p className="text-sm text-muted-foreground">
        Saldo a cobrar: <span className="font-semibold text-foreground">{formatoMoneda(montoSaldo, moneda)}</span>
      </p>

      {metodo === "elegir" && !intencion && !checkoutUrl && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setMetodo("sinpe")} disabled={enviando}>
            <Landmark data-icon="inline-start" />
            SINPE Móvil
          </Button>
          <Button size="sm" variant="outline" onClick={generarTarjeta} disabled={enviando}>
            <CreditCard data-icon="inline-start" />
            {enviando ? "Generando..." : "Tarjeta"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
        </div>
      )}

      {metodo === "sinpe" && !intencion && (
        <form className="flex flex-col gap-3" onSubmit={generarSinpe}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`saldo-telefono-${codigoPublico}`}>Teléfono</Label>
              <Input
                id={`saldo-telefono-${codigoPublico}`}
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="+506XXXXXXXX"
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`saldo-cedula-${codigoPublico}`}>Cédula</Label>
              <Input id={`saldo-cedula-${codigoPublico}`} value={cedula} onChange={(e) => setCedula(e.target.value)} required />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={enviando}>
              {enviando ? "Generando..." : "Generar pago"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCerrar}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {intencion && (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg bg-accent p-3 text-sm">
            <div className="flex items-center justify-between">
              <span>Número SINPE</span>
              <span className="font-semibold">{intencion.numeroSinpe}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span>Monto</span>
              <span className="font-semibold text-primary">{formatoMoneda(intencion.monto, intencion.moneda)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Esperando confirmación...
          </div>
        </div>
      )}

      {checkoutUrl && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Mostrale este link al cliente para que pague desde su celular:</p>
          <a href={checkoutUrl} target="_blank" rel="noreferrer" className="break-all text-sm text-primary underline">
            {checkoutUrl}
          </a>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Esperando confirmación...
          </div>
        </div>
      )}
    </div>
  );
}
