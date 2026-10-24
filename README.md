# ⚡ PowerWatch IoT — Monitor de Cortes Eléctricos (Dead Man's Switch)

Sistema autónomo de monitoreo de cortes eléctricos diseñado para reemplazar servicios de terceros (como Healthchecks.io), utilizando un microcontrolador **ESP32**, un backend monolítico en **Node.js + Express** desplegable en **Render**, un **Dashboard Web en tiempo real (PWA)** y notificaciones instantáneas mediante **Telegram Bot API**.

---

## 🏛️ Principio de Funcionamiento

```
                 [ CORRIENTE DE LA CALLE ]
                           │
                           ▼
                  ┌────────────────┐
                  │ ESP32 DevKit   │
                  │  (Sin batería) │
                  └───────┬────────┘
                          │ HTTP GET /api/ping cada 60s
                          ▼
            [ Router Wi-Fi con Mini-UPS ]  <─── Sigue encendido en apagones
                          │
                   (Internet / HTTPS)
                          ▼
       ┌──────────────────────────────────────┐
       │   Render: Web Service (Node.js)      │
       │   Watchdog: Tolera 180s sin pings    │
       └──────┬────────────────────────┬──────┘
              │                        │
              ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐
     │  Telegram Bot   │      │  Dashboard Web  │
     │ Alertas Grupo   │      │   Dark Mode PWA │
     └─────────────────┘      └─────────────────┘
```

1. **Condición normal:** El ESP32 se alimenta directamente de la red eléctrica comercial y envía un `GET /api/ping?key=...` cada 60 segundos. El router permanece encendido gracias al respaldo del Mini-UPS.
2. **Corte eléctrico:** El ESP32 se apaga al instante. El router sigue transmitiendo internet por la batería del Mini-UPS.
3. **Disparo de Alerta:** El watchdog del servidor detecta que han transcurrido más de 180 segundos sin pings y envía un mensaje de alerta a Telegram: **"¡ALERTA DE APAGÓN ELÉCTRICO!"**.
4. **Retorno de energía:** Al volver la luz, el ESP32 arranca y envía un nuevo ping. El servidor calcula la duración exacta del corte, la registra en el historial y envía una notificación a Telegram: **"¡ENERGÍA ELÉCTRICA RESTABLECIDA!"** con el tiempo que duró el apagón.

---

## 📁 Estructura del Proyecto

```
ESP32/
├── package.json               # Dependencias (Express, dotenv)
├── server.js                  # Servidor Express, Watchdog y Telegram Bot API
├── .env.example               # Plantilla de variables de entorno
├── .gitignore                 # Archivos ignorados por Git
├── README.md                  # Documentación completa
├── data/
│   └── .gitkeep               # Carpeta para almacenamiento persistente local
├── public/
│   ├── index.html             # Dashboard Frontend (Tailwind CSS, Dark Mode)
│   ├── manifest.json          # Soporte PWA para añadir a pantalla de inicio
│   └── sw.js                  # Service Worker PWA
└── esp32_firmware/
    └── esp32_firmware.ino     # Sketch de Arduino/C++ para el ESP32
```

---

## 🚀 Despliegue en Render (Paso a Paso)

### 1. Subir el código a GitHub
1. Inicializa el repositorio Git en la carpeta del proyecto:
   ```bash
   git init
   git add .
   git commit -m "Initial commit - PowerWatch IoT"
   ```
2. Crea un repositorio nuevo en tu cuenta de GitHub (público o privado).
3. Conéctalo y sube el código:
   ```bash
   git remote add origin https://github.com/TU_USUARIO/powerwatch-iot.git
   git branch -M main
   git push -u origin main
   ```

### 2. Crear el Web Service en Render
1. Ve a [dashboard.render.com](https://dashboard.render.com/) e inicia sesión.
2. Haz clic en **"New +"** y selecciona **"Web Service"**.
3. Conecta tu repositorio de GitHub `powerwatch-iot`.
4. Configura los parámetros básicos:
   - **Name:** `powerwatch-iot` (o el nombre que prefieras).
   - **Region:** Selecciona la más cercana (ej: Ohio, Frankfurt).
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`

### 3. Configurar Variables de Entorno en Render
En la sección **"Environment Variables"** de tu servicio en Render, agrega:

| Variable | Valor / Ejemplo | Descripción |
| :--- | :--- | :--- |
| `PING_SECRET_KEY` | `mi_clave_secreta_123` | Clave secreta que enviará el ESP32 |
| `TELEGRAM_BOT_TOKEN` | `123456789:ABCdef...` | Token obtenido de @BotFather |
| `TELEGRAM_CHAT_ID` | `-1001234567890` | ID de tu grupo o chat de Telegram |
| `GRACE_PERIOD_SECONDS` | `180` | Segundos de tolerancia (3 minutos) |

5. Haz clic en **"Deploy Web Service"**.
6. Render generará una URL pública similar a:  
   `https://powerwatch-iot.onrender.com`

> **💡 Sobre el plan Free de Render y el ESP32:**  
> En el plan Free, los servicios entran en reposo si pasan 15 minutos sin peticiones. Dado que tu ESP32 envía un ping cada 60 segundos, **mantiene el servidor despierto de forma natural**. Si ocurre un apagón, el Watchdog dispara la alerta en el minuto 3 (mucho antes de los 15 minutos). Luego el servidor puede dormirse para ahorrar recursos. Al regresar la luz, el primer ping del ESP32 lo despierta en ~30-40 segundos y se registra el fin del corte.

---

## 🤖 Configuración del Bot y Grupo de Telegram

### Obtener el `TELEGRAM_BOT_TOKEN`
1. Abre Telegram y busca a **[@BotFather](https://t.me/BotFather)**.
2. Envía el comando `/newbot`.
3. Escribe un nombre para el bot (ej: `Monitor Electrico Casa`).
4. Escribe un nombre de usuario terminado en `bot` (ej: `MonitorElectricidad_Casa_bot`).
5. BotFather te responderá con tu **HTTP API token**. Ese es tu `TELEGRAM_BOT_TOKEN`.

### Obtener el `TELEGRAM_CHAT_ID` (Para un Grupo)
1. Crea un grupo en Telegram o utiliza uno existente donde desees recibir las alertas.
2. Agrega al bot recién creado como miembro del grupo.
3. Agrega temporalmente al bot **[@RawDataBot](https://t.me/RawDataBot)** al grupo.
4. `@RawDataBot` responderá con un JSON con la información técnica del grupo.
5. Busca el campo `"chat": { "id": -100XXXXXXXXXX }`. Ese número negativo completo (incluyendo el signo menos `-100...`) es tu `TELEGRAM_CHAT_ID`.
6. Expulsa a `@RawDataBot` del grupo para mantenerlo limpio.
7. *(Opcional)* Si prefieres recibir las alertas en tu chat privado individual (no en grupo), abre un chat con **[@userinfobot](https://t.me/userinfobot)** y copia tu ID numérico personal.

---

## 🔌 Configuración y Carga del ESP32

1. Abre el archivo [esp32_firmware/esp32_firmware.ino](file:///c:/Users/HP/OneDrive/Practica-IA/ESP32/esp32_firmware/esp32_firmware.ino) en el **Arduino IDE**.
2. En el menú **Herramientas > Placa**, selecciona **ESP32 Dev Module** (o la placa correspondiente a tu modelo).
3. Modifica las siguientes constantes en la parte superior del código:
   ```cpp
   const char* WIFI_SSID     = "TU_NOMBRE_DE_WIFI";
   const char* WIFI_PASSWORD = "TU_CONTRASENA_WIFI";
   const char* SERVER_BASE_URL = "https://tu-app-en-render.onrender.com";
   const char* PING_SECRET_KEY = "mi_clave_secreta_123";
   ```
4. Conecta el ESP32 por USB y selecciona el puerto COM correcto.
5. Haz clic en **Subir (Upload)**.
6. Abre el **Monitor Serie** a `115200 baud` para verificar la conexión inicial y la confirmación del primer ping.
7. Conecta el ESP32 a un cargador USB enchufado directamente a un tomacorriente de la red eléctrica general (sin pasar por ningún UPS o regulador con batería).

---

## 📱 Instalación del Dashboard como PWA en Móvil

1. Abre la URL de tu aplicación en Google Chrome o Safari en tu teléfono móvil.
2. En Android: Toca el menú de 3 puntos `⋮` y selecciona **"Instalar aplicación"** o **"Añadir a la pantalla de inicio"**.
3. En iOS (Safari): Toca el botón Compartir y pulsa **"Añadir a pantalla de inicio"**.
4. Ahora tendrás un icono en tu móvil con acceso directo de pantalla completa para consultar el estado del servicio eléctrico en tiempo real.
