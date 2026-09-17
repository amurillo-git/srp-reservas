// Sesion del panel administrativo: solo un token JWT + rol en localStorage.
// No hay servidor propio (export estatico) que pueda guardar una cookie de
// sesion, asi que el token vive en el navegador y viaja como
// "Authorization: Bearer <token>" en cada llamada admin (ver admin-api.ts).

const CLAVE_TOKEN = "srp_admin_token";
const CLAVE_ROL = "srp_admin_rol";

export interface SesionAdmin {
  readonly token: string;
  readonly rol: string;
}

/** `localStorage` no existe durante el build estatico (Next prerenderiza
 * los Client Components a HTML): estas funciones solo deben llamarse desde
 * un efecto o un manejador de evento, nunca en el cuerpo del componente. */
export function obtenerSesion(): SesionAdmin | null {
  const token = window.localStorage.getItem(CLAVE_TOKEN);
  const rol = window.localStorage.getItem(CLAVE_ROL);
  if (!token || !rol) return null;
  return { token, rol };
}

export function guardarSesion(sesion: SesionAdmin): void {
  window.localStorage.setItem(CLAVE_TOKEN, sesion.token);
  window.localStorage.setItem(CLAVE_ROL, sesion.rol);
}

export function borrarSesion(): void {
  window.localStorage.removeItem(CLAVE_TOKEN);
  window.localStorage.removeItem(CLAVE_ROL);
}

/** Lee el `userId` del payload del JWT sin verificar la firma (14.7): solo
 * para saber, en la UI, cual fila de la tabla de usuarios es "vos mismo" y
 * deshabilitar su edicion — la autorizacion real siempre la hace el backend.
 * `null` si el token no tiene la forma esperada. */
export function obtenerUserIdDeToken(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return typeof payload.userId === "string" ? payload.userId : null;
  } catch {
    return null;
  }
}
