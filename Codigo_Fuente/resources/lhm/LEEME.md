# LibreHardwareMonitorLib

Librería sin interfaz que usa el panel de VOZ para leer temperaturas, cargas y memoria
del equipo. No se modifica ni se recompila: se copia tal cual del paquete NuGet.

- Paquete: `LibreHardwareMonitorLib` 0.9.4 (`lib/net472`, para PowerShell 5.1).
- Origen: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
  (commit `b8077435b898d57539956388cddf49f7dacb86f7`).
- Licencia: MPL-2.0 — ver `LICENSE-MPL-2.0.txt`.
- SHA-256 de `LibreHardwareMonitorLib.dll`:
  `A0F2728F1734C236A9D02D9E25A88BC4F8CB7BD1FAFF1770726BEB7AF06BF8DC`

La lanza `resources/sysmon-lhm.ps1` en un proceso aparte (no es un proceso de la
extensión). La temperatura de la CPU exige permisos de administrador: la librería carga
su controlador de kernel solo mientras dura ese proceso y lo descarga al cerrar.
Sin esos permisos se leen igual las cargas, la memoria y las temperaturas de la GPU.
