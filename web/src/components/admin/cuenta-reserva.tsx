"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  agregarLineaCuentaAdmin,
  eliminarLineaCuentaAdmin,
  modificarLineaCuentaAdmin,
  obtenerCuentaAdmin,
  registrarPagoCuentaAdmin,
  type CuentaReserva,
  type LineaCuenta,
  type MetodoCobroCaja,
  type ResultadoCuentaAdmin,
  type TarifasCuenta,
} from "@/lib/admin-api";
import { formatoFechaHora12, formatoMoneda } from "@/lib/format";

const CLASE_SELECT =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Motivos tecnicos del backend traducidos a texto para el personal. */
const MOTIVOS: Record<string, string> = {
  NO_ENCONTRADA: "No se encontró esa reserva.",
  LINEA_NO_ENCONTRADA: "Esa línea ya no existe. Actualizá la cuenta.",
  ESTADO_INVALIDO: "Esa reserva no tiene cuenta en su estado actual.",
  DATOS_INVALIDOS: "Revisá los datos: hay algún valor que no es válido.",
  ULTIMA_LINEA: "No se puede quitar la última línea de la cuenta.",
};

const ETIQUETA_METODO: Record<string, string> = {
  EFECTIVO: "Efectivo",
  SINPE_MANUAL: "SINPE Móvil",
  SINPE_ONVO: "SINPE Móvil (automático)",
  TARJETA_ONVO: "Tarjeta en línea",
  TRANSFERENCIA_BANCARIA: "Transferencia bancaria",
};

const METODOS_CAJA: ReadonlyArray<{ valor: MetodoCobroCaja; etiqueta: string }> = [
  { valor: "CASH", etiqueta: "Efectivo" },
  { valor: "SINPE", etiqueta: "SINPE Móvil" },
  { valor: "BANK_TRANSFER", etiqueta: "Transferencia bancaria" },
];

function textoMotivo(motivo: string): string {
  return MOTIVOS[motivo] ?? motivo;
}

/** Misma regla que el backend: tarifa de grupo grande desde `umbralGrupoGrande` personas. */
function precioHeat(tarifas: TarifasCuenta, duracion: number, personas: number): number {
  const grande = personas >= tarifas.umbralGrupoGrande;
  if (duracion === 10) return grande ? tarifas.heat10GrupoGrande : tarifas.heat10GrupoPequeno;
  return grande ? tarifas.heat15GrupoGrande : tarifas.heat15GrupoPequeno;
}

/** Numero desde un campo de texto; null si esta vacio o no es un numero. */
function aNumero(texto: string): number | null {
  if (texto.trim() === "") return null;
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

function esEnteroPositivo(n: number | null): n is number {
  return n !== null && Number.isInteger(n) && n >= 1;
}

type FormularioAgregar = "HEAT" | "NINO" | "AJUSTE" | null;

/**
 * Cuenta de una reserva (consumo real en el parque y cobros en caja). Al abrirse
 * muestra lo reservado como primera linea; el personal puede cambiar el heat a
 * 10 o 15 min, agregar heats extra (todo el grupo o un subgrupo), ninos que
 * viajan con un adulto y ajustes, y registrar los cobros con el monto exacto.
 */
export function CuentaReservaPanel({
  token,
  codigoPublico,
  onCambio,
  onCerrar,
}: {
  token: string;
  codigoPublico: string;
  /** Avisa que la cuenta cambio (para refrescar la lista de reservas). */
  onCambio: () => void;
  onCerrar: () => void;
}) {
  const [cuenta, setCuenta] = useState<CuentaReserva | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const [agregando, setAgregando] = useState<FormularioAgregar>(null);
  const [heat, setHeat] = useState({ duracion: "15", personas: "", precio: "" });
  const [nino, setNino] = useState({ ninos: "1", heats: "1", precio: "" });
  const [ajuste, setAjuste] = useState({ monto: "", nota: "" });

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [edicion, setEdicion] = useState({ duracion: "15", cantidad: "", precio: "", descripcion: "" });
  const [precioEditado, setPrecioEditado] = useState(false);

  // `monto: null` = la persona aun no lo toco: se muestra el saldo pendiente.
  const [pago, setPago] = useState<{ monto: string | null; metodo: MetodoCobroCaja; nota: string }>({
    monto: null,
    metodo: "CASH",
    nota: "",
  });

  useEffect(() => {
    let cancelado = false;
    obtenerCuentaAdmin(token, codigoPublico).then((resultado) => {
      if (cancelado) return;
      if (resultado.ok) {
        setCuenta(resultado.cuenta);
        setHeat((h) => ({ ...h, personas: String(resultado.cuenta.cantidadPersonas) }));
      } else {
        setErrorCarga(textoMotivo(resultado.motivo));
      }
    });
    return () => {
      cancelado = true;
    };
  }, [token, codigoPublico]);

  /** Aplica el resultado de una accion: actualiza la cuenta o avisa el error. */
  function aplicar(resultado: ResultadoCuentaAdmin, exito: string): boolean {
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return false;
    }
    setCuenta(resultado.cuenta);
    setPago((p) => ({ ...p, monto: null })); // vuelve a proponer el saldo pendiente
    toast.success(exito);
    onCambio();
    return true;
  }

  async function ejecutar(accion: () => Promise<ResultadoCuentaAdmin>, exito: string): Promise<boolean> {
    setTrabajando(true);
    const resultado = await accion();
    setTrabajando(false);
    return aplicar(resultado, exito);
  }

  if (errorCarga) {
    return (
      <div className="flex flex-col gap-2 border-t pt-3 text-sm">
        <p className="text-destructive">{errorCarga}</p>
        <Button size="sm" variant="ghost" className="w-fit" onClick={onCerrar}>
          Cerrar
        </Button>
      </div>
    );
  }
  if (!cuenta) {
    return (
      <div className="flex items-center gap-2 border-t pt-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Cargando cuenta...
      </div>
    );
  }

  const moneda = cuenta.moneda;
  const dinero = (monto: number) => formatoMoneda(monto, moneda);
  const montoCobro = pago.monto ?? (cuenta.saldo > 0 ? String(cuenta.saldo) : "");

  // -- Agregar -----------------------------------------------------------------

  async function agregarHeat() {
    const personas = aNumero(heat.personas);
    const precio = aNumero(heat.precio);
    if (!esEnteroPositivo(personas)) {
      toast.error("Ingresá cuántas personas corrieron este heat.");
      return;
    }
    const ok = await ejecutar(
      () =>
        agregarLineaCuentaAdmin(token, codigoPublico, {
          type: "HEAT",
          durationMin: heat.duracion === "10" ? 10 : 15,
          people: personas,
          ...(precio !== null ? { unitPrice: precio } : {}),
        }),
      "Heat agregado a la cuenta.",
    );
    if (ok) {
      setAgregando(null);
      setHeat((h) => ({ ...h, precio: "" }));
    }
  }

  async function agregarNino() {
    const ninos = aNumero(nino.ninos);
    const heats = aNumero(nino.heats);
    const precio = aNumero(nino.precio);
    if (!esEnteroPositivo(ninos) || !esEnteroPositivo(heats)) {
      toast.error("Ingresá cuántos niños y en cuántos heats van con el adulto.");
      return;
    }
    const ok = await ejecutar(
      () =>
        agregarLineaCuentaAdmin(token, codigoPublico, {
          type: "CHILD",
          children: ninos,
          heats,
          ...(precio !== null ? { unitPrice: precio } : {}),
        }),
      "Niños acompañantes agregados.",
    );
    if (ok) {
      setAgregando(null);
      setNino({ ninos: "1", heats: "1", precio: "" });
    }
  }

  async function agregarAjuste() {
    const monto = aNumero(ajuste.monto);
    if (monto === null || monto === 0) {
      toast.error("Ingresá el monto del ajuste (positivo o negativo).");
      return;
    }
    if (ajuste.nota.trim() === "") {
      toast.error("Escribí el motivo del ajuste.");
      return;
    }
    const ok = await ejecutar(
      () => agregarLineaCuentaAdmin(token, codigoPublico, { type: "ADJUSTMENT", amount: monto, note: ajuste.nota.trim() }),
      "Ajuste agregado.",
    );
    if (ok) {
      setAgregando(null);
      setAjuste({ monto: "", nota: "" });
    }
  }

  // -- Editar / quitar ---------------------------------------------------------

  function abrirEdicion(linea: LineaCuenta) {
    setAgregando(null);
    setEditandoId(linea.id);
    setPrecioEditado(false);
    setEdicion({
      duracion: String(linea.duracionMin ?? 15),
      cantidad: String(linea.cantidad),
      precio: String(linea.precioUnitario),
      descripcion: linea.descripcion,
    });
  }

  async function guardarEdicion(linea: LineaCuenta) {
    const cantidad = aNumero(edicion.cantidad);
    const precio = aNumero(edicion.precio);
    const esAjuste = linea.tipo === "AJUSTE";
    if (!esAjuste && !esEnteroPositivo(cantidad)) {
      toast.error("La cantidad debe ser un número entero mayor a 0.");
      return;
    }
    if (precio === null) {
      toast.error("Ingresá el precio.");
      return;
    }
    const duracion = Number(edicion.duracion);
    const cambios = {
      ...(linea.tipo === "HEAT" && duracion !== linea.duracionMin ? { durationMin: duracion } : {}),
      ...(!esAjuste && cantidad !== null && cantidad !== linea.cantidad ? { quantity: cantidad } : {}),
      // Solo se manda el precio si lo escribio la persona; si no, el sistema aplica la tarifa.
      ...(precioEditado ? { unitPrice: precio } : {}),
      ...(esAjuste && edicion.descripcion.trim() !== linea.descripcion ? { description: edicion.descripcion.trim() } : {}),
    };
    if (Object.keys(cambios).length === 0) {
      setEditandoId(null);
      return;
    }
    const ok = await ejecutar(() => modificarLineaCuentaAdmin(token, codigoPublico, linea.id, cambios), "Línea actualizada.");
    if (ok) setEditandoId(null);
  }

  async function quitar(linea: LineaCuenta) {
    if (!window.confirm(`¿Quitar "${linea.descripcion}" (${dinero(linea.monto)}) de la cuenta?`)) return;
    await ejecutar(() => eliminarLineaCuentaAdmin(token, codigoPublico, linea.id), "Línea quitada.");
  }

  // -- Cobro -------------------------------------------------------------------

  async function registrarCobro() {
    const monto = aNumero(montoCobro);
    if (monto === null || monto <= 0) {
      toast.error("Ingresá el monto que recibiste.");
      return;
    }
    if (cuenta && cuenta.saldo > 0 && monto > cuenta.saldo) {
      const exceso = dinero(monto - cuenta.saldo);
      if (!window.confirm(`El monto es ${exceso} mayor que el saldo (${dinero(cuenta.saldo)}). ¿Registrar de todas formas?`)) {
        return;
      }
    }
    const nota = pago.nota.trim();
    const ok = await ejecutar(
      () => registrarPagoCuentaAdmin(token, codigoPublico, { amount: monto, method: pago.metodo, ...(nota ? { note: nota } : {}) }),
      "Cobro registrado.",
    );
    if (ok) setPago((p) => ({ ...p, nota: "" }));
  }

  // -- Vista -------------------------------------------------------------------

  const personasHeat = aNumero(heat.personas);
  const precioEstimado = esEnteroPositivo(personasHeat)
    ? (aNumero(heat.precio) ?? precioHeat(cuenta.tarifas, Number(heat.duracion), personasHeat))
    : null;
  const saldada = cuenta.saldo <= 0;

  return (
    <div className="flex flex-col gap-4 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Cuenta de la reserva</h3>
        <Button size="xs" variant="ghost" onClick={onCerrar}>
          Cerrar
        </Button>
      </div>

      {/* Lineas de consumo */}
      <ul className="flex flex-col gap-2">
        {cuenta.lineas.map((linea) => (
          <li key={linea.id} className="rounded-lg border bg-background p-2 text-sm">
            {editandoId === linea.id ? (
              <div className="flex flex-col gap-2">
                <p className="font-medium">{linea.descripcion}</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {linea.tipo === "HEAT" && (
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`ed-dur-${linea.id}`}>Duración</Label>
                      <select
                        id={`ed-dur-${linea.id}`}
                        className={CLASE_SELECT}
                        value={edicion.duracion}
                        onChange={(e) => setEdicion({ ...edicion, duracion: e.target.value })}
                      >
                        <option value="10">10 minutos</option>
                        <option value="15">15 minutos</option>
                      </select>
                    </div>
                  )}
                  {linea.tipo !== "AJUSTE" && (
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`ed-cant-${linea.id}`}>{linea.tipo === "HEAT" ? "Personas" : "Cantidad"}</Label>
                      <Input
                        id={`ed-cant-${linea.id}`}
                        type="number"
                        min={1}
                        value={edicion.cantidad}
                        onChange={(e) => setEdicion({ ...edicion, cantidad: e.target.value })}
                      />
                    </div>
                  )}
                  {linea.tipo === "AJUSTE" && (
                    <div className="flex flex-col gap-1 sm:col-span-2">
                      <Label htmlFor={`ed-desc-${linea.id}`}>Motivo</Label>
                      <Input
                        id={`ed-desc-${linea.id}`}
                        value={edicion.descripcion}
                        onChange={(e) => setEdicion({ ...edicion, descripcion: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`ed-precio-${linea.id}`}>{linea.tipo === "AJUSTE" ? "Monto" : "Precio c/u"}</Label>
                    <Input
                      id={`ed-precio-${linea.id}`}
                      type="number"
                      value={edicion.precio}
                      onChange={(e) => {
                        setEdicion({ ...edicion, precio: e.target.value });
                        setPrecioEditado(true);
                      }}
                    />
                  </div>
                </div>
                {linea.tipo === "HEAT" && !precioEditado && (
                  <p className="text-xs text-muted-foreground">
                    Si cambiás la duración o las personas, el precio se recalcula con la tarifa. Podés escribir otro precio si
                    hace falta.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => guardarEdicion(linea)} disabled={trabajando}>
                    Guardar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditandoId(null)} disabled={trabajando}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{linea.descripcion}</p>
                  <p className="text-xs text-muted-foreground">
                    {linea.tipo === "AJUSTE"
                      ? "Ajuste"
                      : `${linea.cantidad} × ${dinero(linea.precioUnitario)}${linea.tipo === "HEAT" ? " por persona" : ""}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{dinero(linea.monto)}</span>
                  <Button size="xs" variant="outline" onClick={() => abrirEdicion(linea)} disabled={trabajando}>
                    Editar
                  </Button>
                  {cuenta.lineas.length > 1 && (
                    <Button size="xs" variant="ghost" onClick={() => quitar(linea)} disabled={trabajando}>
                      Quitar
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Agregar */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={agregando === "HEAT" ? "default" : "outline"}
            onClick={() => {
              setEditandoId(null);
              setAgregando(agregando === "HEAT" ? null : "HEAT");
            }}
          >
            + Heat
          </Button>
          <Button
            size="sm"
            variant={agregando === "NINO" ? "default" : "outline"}
            onClick={() => {
              setEditandoId(null);
              setAgregando(agregando === "NINO" ? null : "NINO");
            }}
          >
            + Niño con adulto
          </Button>
          <Button
            size="sm"
            variant={agregando === "AJUSTE" ? "default" : "outline"}
            onClick={() => {
              setEditandoId(null);
              setAgregando(agregando === "AJUSTE" ? null : "AJUSTE");
            }}
          >
            + Ajuste
          </Button>
        </div>

        {agregando === "HEAT" && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">
              Un heat extra para todo el grupo o solo para algunas personas.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-heat-dur">Duración</Label>
                <select
                  id="nuevo-heat-dur"
                  className={CLASE_SELECT}
                  value={heat.duracion}
                  onChange={(e) => setHeat({ ...heat, duracion: e.target.value })}
                >
                  <option value="10">10 minutos</option>
                  <option value="15">15 minutos</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-heat-personas">Personas</Label>
                <Input
                  id="nuevo-heat-personas"
                  type="number"
                  min={1}
                  value={heat.personas}
                  onChange={(e) => setHeat({ ...heat, personas: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-heat-precio">Precio c/u (opcional)</Label>
                <Input
                  id="nuevo-heat-precio"
                  type="number"
                  min={0}
                  placeholder="Tarifa del sistema"
                  value={heat.precio}
                  onChange={(e) => setHeat({ ...heat, precio: e.target.value })}
                />
              </div>
            </div>
            {precioEstimado !== null && personasHeat !== null && (
              <p className="text-sm">
                {personasHeat} × {dinero(precioEstimado)} ={" "}
                <span className="font-semibold">{dinero(precioEstimado * personasHeat)}</span>
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={agregarHeat} disabled={trabajando}>
                Agregar heat
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAgregando(null)} disabled={trabajando}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {agregando === "NINO" && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">
              Niños que van en el kart del adulto: {dinero(cuenta.tarifas.ninoAcompanado)} por niño y por heat. No ocupan
              cupo.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-nino-cantidad">Niños</Label>
                <Input
                  id="nuevo-nino-cantidad"
                  type="number"
                  min={1}
                  value={nino.ninos}
                  onChange={(e) => setNino({ ...nino, ninos: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-nino-heats">Heats que corren juntos</Label>
                <Input
                  id="nuevo-nino-heats"
                  type="number"
                  min={1}
                  value={nino.heats}
                  onChange={(e) => setNino({ ...nino, heats: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-nino-precio">Precio c/u (opcional)</Label>
                <Input
                  id="nuevo-nino-precio"
                  type="number"
                  min={0}
                  placeholder={String(cuenta.tarifas.ninoAcompanado)}
                  value={nino.precio}
                  onChange={(e) => setNino({ ...nino, precio: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={agregarNino} disabled={trabajando}>
                Agregar niños
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAgregando(null)} disabled={trabajando}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {agregando === "AJUSTE" && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">
              Para cuadrar redondeos o descuentos. Usá un monto negativo para restar (ej. -500).
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="nuevo-ajuste-monto">Monto</Label>
                <Input
                  id="nuevo-ajuste-monto"
                  type="number"
                  value={ajuste.monto}
                  onChange={(e) => setAjuste({ ...ajuste, monto: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="nuevo-ajuste-nota">Motivo</Label>
                <Input
                  id="nuevo-ajuste-nota"
                  placeholder="Ej. Redondeo"
                  value={ajuste.nota}
                  onChange={(e) => setAjuste({ ...ajuste, nota: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={agregarAjuste} disabled={trabajando}>
                Agregar ajuste
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAgregando(null)} disabled={trabajando}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Totales */}
      <div className="rounded-2xl bg-accent p-3 text-sm">
        <div className="flex items-center justify-between">
          <span>Total consumido</span>
          <span className="font-medium">{dinero(cuenta.totalConsumido)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span>Pagado</span>
          <span className="font-medium">{dinero(cuenta.totalPagado)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-foreground/10 pt-1">
          <span className="font-semibold">{cuenta.saldo < 0 ? "A favor del cliente" : "Saldo a cobrar"}</span>
          <span className={`font-semibold ${saldada ? "" : "text-primary"}`}>{dinero(Math.abs(cuenta.saldo))}</span>
        </div>
        {saldada && (
          <div className="mt-2">
            <Badge>Cuenta saldada</Badge>
          </div>
        )}
      </div>

      {/* Pagos registrados */}
      {cuenta.pagos.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Pagos registrados</p>
          <ul className="flex flex-col gap-1 text-sm">
            {cuenta.pagos.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-2 rounded-md bg-muted/50 px-2 py-1">
                <span className="min-w-0">
                  {p.tipo === "DEPOSITO" ? "Depósito" : "Cobro"} · {ETIQUETA_METODO[p.metodo] ?? p.metodo}
                  {p.pagadoEn ? ` · ${formatoFechaHora12(p.pagadoEn)}` : ""}
                  {p.nota ? ` · ${p.nota}` : ""}
                </span>
                <span className="shrink-0 font-medium">{dinero(p.monto)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Registrar cobro */}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-sm font-medium">Registrar cobro</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="cobro-monto">Monto recibido</Label>
            <Input
              id="cobro-monto"
              type="number"
              min={0}
              value={montoCobro}
              onChange={(e) => setPago({ ...pago, monto: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cobro-metodo">Forma de pago</Label>
            <select
              id="cobro-metodo"
              className={CLASE_SELECT}
              value={pago.metodo}
              onChange={(e) => setPago({ ...pago, metodo: e.target.value as MetodoCobroCaja })}
            >
              {METODOS_CAJA.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.etiqueta}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cobro-nota">Nota (opcional)</Label>
            <Input
              id="cobro-nota"
              placeholder="Ej. N.º de transferencia"
              value={pago.nota}
              onChange={(e) => setPago({ ...pago, nota: e.target.value })}
            />
          </div>
        </div>
        <Button size="sm" className="w-fit" onClick={registrarCobro} disabled={trabajando}>
          {trabajando ? "Procesando..." : "Registrar cobro"}
        </Button>
      </div>
    </div>
  );
}
