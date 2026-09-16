"use client";

import { useEffect, useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  crearBloqueo,
  eliminarBloqueo,
  obtenerBloqueosDelDia,
  type BloqueoAdmin,
  type ReservaEnConflicto,
} from "@/lib/admin-api";
import { hoyISO } from "@/lib/format";

interface FormularioBloqueo {
  horaInicio: string;
  horaFin: string;
  motivo: string;
}

const FORMULARIO_VACIO: FormularioBloqueo = { horaInicio: "09:00", horaFin: "10:00", motivo: "" };

export function AdministrativeBlocks({ token, serviceId }: { token: string; serviceId: string }) {
  const [fecha, setFecha] = useState(hoyISO());
  const [bloqueos, setBloqueos] = useState<readonly BloqueoAdmin[] | null>(null);
  const [formulario, setFormulario] = useState<FormularioBloqueo>(FORMULARIO_VACIO);
  const [enviando, setEnviando] = useState(false);
  const [conflicto, setConflicto] = useState<readonly ReservaEnConflicto[] | null>(null);

  useEffect(() => {
    setBloqueos(null);
    setConflicto(null);
    obtenerBloqueosDelDia(token, serviceId, fecha).then(setBloqueos);
  }, [token, serviceId, fecha]);

  async function crear(forzar: boolean) {
    setEnviando(true);
    const resultado = await crearBloqueo(token, {
      serviceId,
      date: fecha,
      startTime: formulario.horaInicio,
      endTime: formulario.horaFin,
      reason: formulario.motivo.trim() || undefined,
      force: forzar,
    });
    setEnviando(false);
    if (resultado.ok) {
      toast.success("Bloqueo creado.");
      setFormulario(FORMULARIO_VACIO);
      setConflicto(null);
      obtenerBloqueosDelDia(token, serviceId, fecha).then(setBloqueos);
      return;
    }
    if (resultado.conflicto) {
      setConflicto(resultado.reservasEnConflicto);
      return;
    }
    toast.error(resultado.motivo);
  }

  async function eliminar(id: string) {
    const ok = await eliminarBloqueo(token, id);
    if (!ok) {
      toast.error("No se pudo eliminar.");
      return;
    }
    setBloqueos((actual) => actual?.filter((b) => b.id !== id) ?? null);
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Ban className="size-4" />
        </div>
        <CardTitle className="text-base">Bloqueos administrativos</CardTitle>
        <CardDescription>Cierres temporales o eventos privados para una fecha.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="bloqueo-fecha">Fecha</Label>
          <Input id="bloqueo-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="max-w-48" />
        </div>

        <div className="flex flex-col gap-2">
          {bloqueos === null && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {bloqueos !== null && bloqueos.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin bloqueos esta fecha.</p>
          )}
          {bloqueos?.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {b.horaInicio}–{b.horaFin}
                </p>
                <p className="truncate text-xs text-muted-foreground">{b.motivo ?? "Sin motivo"}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => eliminar(b.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">Nuevo bloqueo</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="bloqueo-inicio">Desde</Label>
              <Input
                id="bloqueo-inicio"
                type="time"
                value={formulario.horaInicio}
                onChange={(e) => setFormulario({ ...formulario, horaInicio: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bloqueo-fin">Hasta</Label>
              <Input
                id="bloqueo-fin"
                type="time"
                value={formulario.horaFin}
                onChange={(e) => setFormulario({ ...formulario, horaFin: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="bloqueo-motivo">Motivo (opcional)</Label>
              <Input
                id="bloqueo-motivo"
                value={formulario.motivo}
                onChange={(e) => setFormulario({ ...formulario, motivo: e.target.value })}
              />
            </div>
          </div>

          {conflicto && conflicto.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <p className="font-medium text-destructive">
                Este bloqueo afecta {conflicto.length} reserva{conflicto.length === 1 ? "" : "s"} existente
                {conflicto.length === 1 ? "" : "s"}:
              </p>
              <ul className="flex flex-col gap-1 text-muted-foreground">
                {conflicto.map((r) => (
                  <li key={r.codigoPublico}>
                    {r.codigoPublico} · {r.estado} · {r.cantidadPersonas} personas
                  </li>
                ))}
              </ul>
              <p>No se cancelan automáticamente. Elegí cómo continuar:</p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={() => crear(true)} disabled={enviando}>
                  Forzar de todas formas
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConflicto(null)} disabled={enviando}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          {!conflicto && (
            <Button size="sm" className="w-fit" onClick={() => crear(false)} disabled={enviando}>
              {enviando ? "Creando..." : "Crear bloqueo"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
