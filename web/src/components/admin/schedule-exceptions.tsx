"use client";

import { useEffect, useState } from "react";
import { CalendarOff, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { crearExcepcion, eliminarExcepcion, obtenerExcepciones, type ExcepcionAdmin } from "@/lib/admin-api";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function anioMes(fecha: Date): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
}

const TIPOS = [
  { valor: "HABILITADO", etiqueta: "Habilitado (abre un día normalmente cerrado)" },
  { valor: "MODIFICADO", etiqueta: "Modificado (horario distinto ese día)" },
  { valor: "CERRADO", etiqueta: "Cerrado (cierra un día normalmente abierto)" },
] as const;

interface FormularioExcepcion {
  fecha: string;
  tipo: (typeof TIPOS)[number]["valor"];
  horaApertura: string;
  horaCierre: string;
  motivo: string;
}

const FORMULARIO_VACIO: FormularioExcepcion = {
  fecha: "",
  tipo: "CERRADO",
  horaApertura: "09:00",
  horaCierre: "16:00",
  motivo: "",
};

export function ScheduleExceptions({ token, serviceId }: { token: string; serviceId: string }) {
  const [mes, setMes] = useState(() => new Date());
  const [excepciones, setExcepciones] = useState<readonly ExcepcionAdmin[] | null>(null);
  const [formulario, setFormulario] = useState<FormularioExcepcion>(FORMULARIO_VACIO);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    setExcepciones(null);
    obtenerExcepciones(token, serviceId, anioMes(mes)).then(setExcepciones);
  }, [token, serviceId, mes]);

  async function agregar() {
    if (!formulario.fecha) {
      toast.error("Elegí una fecha.");
      return;
    }
    setEnviando(true);
    const resultado = await crearExcepcion(token, serviceId, {
      date: formulario.fecha,
      type: formulario.tipo,
      openTime: formulario.tipo !== "CERRADO" ? formulario.horaApertura : undefined,
      closeTime: formulario.tipo !== "CERRADO" ? formulario.horaCierre : undefined,
      reason: formulario.motivo.trim() || undefined,
    });
    setEnviando(false);
    if (!resultado.ok) {
      toast.error(resultado.motivo ?? "No se pudo crear la excepción.");
      return;
    }
    toast.success("Excepción creada.");
    setFormulario(FORMULARIO_VACIO);
    obtenerExcepciones(token, serviceId, anioMes(mes)).then(setExcepciones);
  }

  async function eliminar(id: string) {
    const ok = await eliminarExcepcion(token, id);
    if (!ok) {
      toast.error("No se pudo eliminar.");
      return;
    }
    setExcepciones((actual) => actual?.filter((e) => e.id !== id) ?? null);
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CalendarOff className="size-4" />
        </div>
        <CardTitle className="text-base">Excepciones de calendario</CardTitle>
        <CardDescription>Feriados, cierres y horarios especiales para una fecha puntual.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="icon-sm" onClick={() => setMes(new Date(mes.getFullYear(), mes.getMonth() - 1, 1))}>
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium">
            {MESES[mes.getMonth()]} {mes.getFullYear()}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={() => setMes(new Date(mes.getFullYear(), mes.getMonth() + 1, 1))}>
            <ChevronRight />
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          {excepciones === null && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {excepciones !== null && excepciones.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin excepciones este mes.</p>
          )}
          {excepciones?.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{e.fecha}</span>
                  <Badge variant={e.tipo === "CERRADO" ? "destructive" : "outline"}>{e.tipo}</Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {e.horaApertura ? `${e.horaApertura}–${e.horaCierre}` : ""} {e.motivo ?? ""}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => eliminar(e.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">Nueva excepción</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="excepcion-fecha">Fecha</Label>
              <Input
                id="excepcion-fecha"
                type="date"
                value={formulario.fecha}
                onChange={(e) => setFormulario({ ...formulario, fecha: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="excepcion-tipo">Tipo</Label>
              <select
                id="excepcion-tipo"
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={formulario.tipo}
                onChange={(e) => setFormulario({ ...formulario, tipo: e.target.value as FormularioExcepcion["tipo"] })}
              >
                {TIPOS.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.etiqueta}
                  </option>
                ))}
              </select>
            </div>
            {formulario.tipo !== "CERRADO" && (
              <>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="excepcion-apertura">Apertura</Label>
                  <Input
                    id="excepcion-apertura"
                    type="time"
                    value={formulario.horaApertura}
                    onChange={(e) => setFormulario({ ...formulario, horaApertura: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="excepcion-cierre">Cierre</Label>
                  <Input
                    id="excepcion-cierre"
                    type="time"
                    value={formulario.horaCierre}
                    onChange={(e) => setFormulario({ ...formulario, horaCierre: e.target.value })}
                  />
                </div>
              </>
            )}
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="excepcion-motivo">Motivo (opcional)</Label>
              <Input
                id="excepcion-motivo"
                value={formulario.motivo}
                onChange={(e) => setFormulario({ ...formulario, motivo: e.target.value })}
              />
            </div>
          </div>
          <Button size="sm" className="w-fit" onClick={agregar} disabled={enviando}>
            {enviando ? "Creando..." : "Agregar excepción"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
