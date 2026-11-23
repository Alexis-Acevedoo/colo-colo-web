# Colo Colo · versión web

Versión web (PWA) de la app iOS de Colo Colo. Es HTML, CSS y JavaScript sin dependencias ni paso de compilación.

**URL:** https://alexis-acevedoo.github.io/colo-colo-web/

## Qué muestra

- **Inicio:** próximo partido (rival, fecha, hora, estadio, ciudad, local/visita, fase, árbitro y TV cuando ESPN los publica), posición en la Liga de Primera, copa internacional (solo si juega Libertadores o Sudamericana este año) y últimos 3 resultados.
- **En vivo:** desde 15 minutos antes del partido, la tarjeta se actualiza cada 30 segundos con marcador, minuto y goles.
- **Tabla:** tabla completa y "carrera por el título" (puntos de diferencia con Colo Colo, partidos que quedan, puntaje máximo posible y puntos que faltan para asegurar el título).
- **Calendario:** botón que descarga un `.ics` con alertas 2 días, 1 día y 15 minutos antes (reemplaza las notificaciones locales de la app iOS).

Competencias para "próximo partido" y "últimos resultados": Liga de Primera y Copa Chile.

## Instalar en el iPhone

1. Abrir la URL en **Safari**.
2. Botón Compartir → **Agregar a pantalla de inicio**.

Se abre a pantalla completa, con el ícono "CC", y sigue el modo oscuro del sistema.

## Datos

API pública de ESPN (`site.api.espn.com`), gratis, sin clave y no oficial. Permite llamadas desde el navegador (CORS), así que no hace falta servidor ni proxy. Toda la lógica de ESPN está en `app.js` (la misma de `ESPNClient.swift` / `HomeRepository.swift`). El último resultado se guarda en `localStorage` para abrir al instante y sin conexión.

## Publicación

GitHub Pages sirve los archivos tal cual desde la raíz de la rama configurada en *Settings → Pages*.
