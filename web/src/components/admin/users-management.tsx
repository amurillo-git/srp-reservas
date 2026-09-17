"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  actualizarUsuarioAdmin,
  crearUsuarioAdmin,
  listarUsuariosAdmin,
  type RolUsuario,
  type UsuarioAdmin,
} from "@/lib/admin-api";

const ROLES: readonly { valor: RolUsuario; etiqueta: string }[] = [
  { valor: "ADMINISTRADOR", etiqueta: "Administrador" },
  { valor: "ATENCION", etiqueta: "Atención" },
  { valor: "CAJA", etiqueta: "Caja" },
  { valor: "OPERACION", etiqueta: "Operación" },
];

/** Motivos tecnicos del backend, traducidos para un administrador no tecnico. */
const MOTIVOS: Record<string, string> = {
  EMAIL_YA_EXISTE: "Ese correo ya está registrado.",
  CONTRASENA_DEBIL: "La contraseña debe tener al menos 8 caracteres.",
  NO_ENCONTRADO: "No se encontró ese usuario.",
  NO_PUEDE_MODIFICARSE_A_SI_MISMO: "No podés modificar tu propio usuario desde aquí.",
};

function textoMotivo(motivo: string): string {
  return MOTIVOS[motivo] ?? motivo;
}

function formatoFecha(iso: string): string {
  return new Intl.DateTimeFormat("es-CR", { dateStyle: "medium" }).format(new Date(iso));
}

interface FormularioNuevo {
  email: string;
  password: string;
  rol: RolUsuario;
}

const FORMULARIO_VACIO: FormularioNuevo = { email: "", password: "", rol: "ATENCION" };

export function UsersManagement({ token, propioUserId }: { token: string; propioUserId: string | null }) {
  const [usuarios, setUsuarios] = useState<readonly UsuarioAdmin[] | null>(null);
  const [formulario, setFormulario] = useState<FormularioNuevo>(FORMULARIO_VACIO);
  const [creando, setCreando] = useState(false);
  const [procesando, setProcesando] = useState<string | null>(null);

  useEffect(() => {
    listarUsuariosAdmin(token).then(setUsuarios);
  }, [token]);

  async function crear() {
    if (!formulario.email.trim() || !formulario.password) {
      toast.error("Completá correo y contraseña.");
      return;
    }
    setCreando(true);
    const resultado = await crearUsuarioAdmin(token, formulario);
    setCreando(false);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    toast.success("Usuario creado.");
    setFormulario(FORMULARIO_VACIO);
    setUsuarios((actual) => (actual ? [...actual, resultado.usuario] : [resultado.usuario]));
  }

  async function cambiarRol(id: string, rol: RolUsuario) {
    setProcesando(id);
    const resultado = await actualizarUsuarioAdmin(token, id, { rol });
    setProcesando(null);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    setUsuarios((actual) => actual?.map((u) => (u.id === id ? resultado.usuario : u)) ?? null);
  }

  async function alternarActivo(usuario: UsuarioAdmin) {
    setProcesando(usuario.id);
    const resultado = await actualizarUsuarioAdmin(token, usuario.id, { activo: !usuario.activo });
    setProcesando(null);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    toast.success(resultado.usuario.activo ? "Usuario activado." : "Usuario desactivado.");
    setUsuarios((actual) => actual?.map((u) => (u.id === usuario.id ? resultado.usuario : u)) ?? null);
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Users className="size-4" />
        </div>
        <CardTitle className="text-base">Usuarios y permisos</CardTitle>
        <CardDescription>Quién puede entrar al panel y qué rol tiene.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {usuarios === null && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {usuarios?.map((u) => {
            const esUnoMismo = u.id === propioUserId;
            return (
              <div key={u.id} className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium">{u.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Creado el {formatoFecha(u.creadoEn)}
                    {esUnoMismo ? " · vos" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                    value={u.rol}
                    disabled={esUnoMismo || procesando === u.id}
                    onChange={(e) => cambiarRol(u.id, e.target.value as RolUsuario)}
                  >
                    {ROLES.map((r) => (
                      <option key={r.valor} value={r.valor}>
                        {r.etiqueta}
                      </option>
                    ))}
                  </select>
                  <Badge variant={u.activo ? "default" : "destructive"}>{u.activo ? "Activo" : "Inactivo"}</Badge>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={esUnoMismo || procesando === u.id}
                    onClick={() => alternarActivo(u)}
                  >
                    {u.activo ? "Desactivar" : "Activar"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">Nuevo usuario</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="usuario-email">Correo</Label>
              <Input
                id="usuario-email"
                type="email"
                value={formulario.email}
                onChange={(e) => setFormulario({ ...formulario, email: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="usuario-password">Contraseña</Label>
              <Input
                id="usuario-password"
                type="password"
                value={formulario.password}
                onChange={(e) => setFormulario({ ...formulario, password: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="usuario-rol">Rol</Label>
              <select
                id="usuario-rol"
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={formulario.rol}
                onChange={(e) => setFormulario({ ...formulario, rol: e.target.value as RolUsuario })}
              >
                {ROLES.map((r) => (
                  <option key={r.valor} value={r.valor}>
                    {r.etiqueta}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button size="sm" className="w-fit" onClick={crear} disabled={creando}>
            {creando ? "Creando..." : "Crear usuario"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
