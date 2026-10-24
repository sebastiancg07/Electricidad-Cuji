/**
 * PowerWatch IoT - Backend Server (Node.js + Express)
 * Dead Man's Switch para Monitoreo de Cortes Eléctricos con ESP32 y Telegram
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PING_SECRET_KEY = process.env.PING_SECRET_KEY || 'clave_secreta_por_defecto';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GRACE_PERIOD_SECONDS = parseInt(process.env.GRACE_PERIOD_SECONDS, 10) || 180;

// Configuración de almacenamiento local para persistencia entre reinicios
const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

// Utilidad para obtener la fecha en formato YYYY-MM-DD
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Estado inicial en memoria
let state = {
  status: 'UP', // 'UP' o 'DOWN'
  lastPingTime: Date.now(),
  outageStartTime: null,
  currentDay: getTodayString(),
  pingsToday: 0,
  outagesToday: 0,
  historyLogs: []
};

// Cargar estado persistente si existe
function loadPersistedState() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      state = {
        ...state,
        ...saved,
        // Al arrancar, si lastPingTime es muy antiguo o no existe, usamos Date.now() para dar el tiempo de gracia inicial
        lastPingTime: saved.lastPingTime || Date.now(),
        // Si el día guardado es diferente al de hoy, reiniciamos contadores diarios
        ...(saved.currentDay !== getTodayString() ? {
          currentDay: getTodayString(),
          pingsToday: 0,
          outagesToday: 0
        } : {})
      };
      console.log('✅ Estado persistente restaurado desde storage.json');
    }
  } catch (err) {
    console.warn('⚠️ No se pudo leer el archivo de persistencia, iniciando con estado en memoria:', err.message);
  }
}

// Guardar estado en archivo de forma segura
function persistState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('⚠️ Error al persistir estado en disco:', err.message);
  }
}

// Inicializar almacenamiento
loadPersistedState();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Función auxiliar para formatear duraciones en horas, minutos y segundos
function formatDuration(totalSeconds) {
  if (totalSeconds < 60) {
    return `${totalSeconds} seg`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

// Formateador de fecha/hora legible en español
function formatDateTime(dateInput) {
  const d = new Date(dateInput);
  return d.toLocaleString('es-VE', {
    timeZone: process.env.TIMEZONE || 'America/Caracas',
    hour12: true,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Enviar notificación a Telegram vía Bot API
async function sendTelegramMessage(htmlContent) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram no configurado (TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID ausentes)');
    return { success: false, error: 'Credenciales de Telegram no configuradas' };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: htmlContent,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    const data = await response.json();
    if (!data.ok) {
      console.error('❌ Error de Telegram Bot API:', data.description);
      return { success: false, error: data.description };
    }
    console.log('📨 Mensaje enviado a Telegram correctamente');
    return { success: true };
  } catch (error) {
    console.error('❌ Error de red al comunicarse con Telegram:', error.message);
    return { success: false, error: error.message };
  }
}

// Agregar evento al historial (mantener máximo 50 eventos)
function addHistoryEvent(event) {
  state.historyLogs.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    ...event
  });

  if (state.historyLogs.length > 50) {
    state.historyLogs = state.historyLogs.slice(0, 50);
  }
  persistState();
}

// Reiniciar contadores diarios si cambió de fecha
function checkDayRollover() {
  const today = getTodayString();
  if (state.currentDay !== today) {
    state.currentDay = today;
    state.pingsToday = 0;
    state.outagesToday = 0;
    persistState();
  }
}

// =========================================================================
// WATCHDOG INTERNO: Evaluación cada 5 segundos (Dead Man's Switch)
// =========================================================================
setInterval(async () => {
  checkDayRollover();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - state.lastPingTime) / 1000);

  // Si pasaron más segundos que el tiempo de gracia y aún estábamos en estado UP
  if (elapsedSeconds > GRACE_PERIOD_SECONDS && state.status === 'UP') {
    state.status = 'DOWN';
    state.outageStartTime = now;
    state.outagesToday++;

    console.log(`🚨 [WATCHDOG] CORTE DETECTADO: Han pasado ${elapsedSeconds}s sin pings del ESP32.`);

    addHistoryEvent({
      type: 'OUTAGE_START',
      message: 'Corte eléctrico detectado (sin respuesta del ESP32)',
      elapsedSeconds
    });

    const alertMessage = 
`🚨 <b>¡ALERTA DE APAGÓN ELÉCTRICO!</b> 🚨
━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Estado:</b> CORTE DE ELECTRICIDAD DETECTADO
⏱️ <b>Tiempo sin señal:</b> ${elapsedSeconds} seg (límite: ${GRACE_PERIOD_SECONDS}s)
📅 <b>Fecha y Hora:</b> ${formatDateTime(now)}
⚡ <b>Sistema:</b> Dead Man's Switch (ESP32 desconectado)
━━━━━━━━━━━━━━━━━━━━━━━━
<i>El router sigue en línea por Mini-UPS, pero el microcontrolador se apagó.</i>`;

    await sendTelegramMessage(alertMessage);
  }
}, 5000);

// =========================================================================
// RUTAS / ENDPOINTS DE LA API
// =========================================================================

/**
 * GET /api/ping
 * Invocado por el microcontrolador ESP32 cada 60 segundos
 */
app.get('/api/ping', async (req, res) => {
  const clientKey = req.query.key;

  // Validación de seguridad
  if (!clientKey || clientKey !== PING_SECRET_KEY) {
    console.warn(`🔒 Intento de ping no autorizado desde IP: ${req.ip}`);
    return res.status(401).json({ status: 'error', message: 'Clave no válida o no proporcionada' });
  }

  checkDayRollover();
  const now = Date.now();
  const previousStatus = state.status;
  const previousPing = state.lastPingTime;

  // Si veníamos de un estado DOWN (corte eléctrico), se restableció la energía!
  if (previousStatus === 'DOWN') {
    state.status = 'UP';
    const outageStart = state.outageStartTime || (previousPing + (GRACE_PERIOD_SECONDS * 1000));
    const durationSeconds = Math.max(0, Math.floor((now - outageStart) / 1000));
    const durationFormatted = formatDuration(durationSeconds);

    console.log(`⚡ [RESTABLECIDO] Energía eléctrica recuperada. Duración del corte: ${durationFormatted}`);

    addHistoryEvent({
      type: 'POWER_RESTORED',
      message: `Servicio eléctrico restablecido tras ${durationFormatted}`,
      outageStartTime: outageStart,
      restoredTime: now,
      durationSeconds,
      durationFormatted
    });

    state.outageStartTime = null;

    const restoredMessage = 
`⚡ <b>¡ENERGÍA ELÉCTRICA RESTABLECIDA!</b> ⚡
━━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>Estado:</b> SERVICIO ACTIVO Y FUNCIONANDO
⏳ <b>Duración del apagón:</b> ${durationFormatted}
📅 <b>Hora de retorno:</b> ${formatDateTime(now)}
📊 <b>Cortes registrados hoy:</b> ${state.outagesToday}
━━━━━━━━━━━━━━━━━━━━━━━━
<i>El ESP32 ha reiniciado y vuelto a transmitir sus pings con éxito.</i>`;

    // Enviar notificación a Telegram en segundo plano
    sendTelegramMessage(restoredMessage).catch(err => console.error(err));
  }

  // Actualizar marca de tiempo y métricas
  state.lastPingTime = now;
  state.pingsToday++;
  persistState();

  return res.status(200).json({
    status: 'ok',
    systemStatus: state.status,
    timestamp: now,
    elapsedSinceLast: Math.floor((now - previousPing) / 1000)
  });
});

/**
 * GET /api/status
 * Invocado periódicamente por el Dashboard Frontend para monitoreo en vivo
 */
app.get('/api/status', (req, res) => {
  checkDayRollover();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - state.lastPingTime) / 1000);
  
  let currentOutageDuration = 0;
  if (state.status === 'DOWN') {
    const start = state.outageStartTime || (state.lastPingTime + (GRACE_PERIOD_SECONDS * 1000));
    currentOutageDuration = Math.max(0, Math.floor((now - start) / 1000));
  }

  res.json({
    status: state.status,
    lastPingTime: state.lastPingTime,
    lastPingFormatted: formatDateTime(state.lastPingTime),
    elapsedSeconds,
    gracePeriodSeconds: GRACE_PERIOD_SECONDS,
    pingsToday: state.pingsToday,
    outagesToday: state.outagesToday,
    currentOutageDuration,
    currentOutageDurationFormatted: formatDuration(currentOutageDuration),
    serverTime: now,
    serverTimeFormatted: formatDateTime(now),
    historyLogs: state.historyLogs
  });
});

/**
 * POST /api/test-telegram
 * Endpoint para disparar un mensaje de prueba a Telegram desde el Dashboard
 */
app.post('/api/test-telegram', async (req, res) => {
  const testMessage = 
`🔔 <b>MENSAJE DE PRUEBA - POWERWATCH IoT</b>
━━━━━━━━━━━━━━━━━━━━━━━━
✅ La conexión entre el servidor Node.js y Telegram está funcionando correctamente.
📅 <b>Fecha del servidor:</b> ${formatDateTime(Date.now())}
📡 <b>Estado actual:</b> ${state.status === 'UP' ? '⚡ ACTIVO (UP)' : '🚨 CORTE (DOWN)'}
⏱️ <b>Último ping ESP32:</b> hace ${Math.floor((Date.now() - state.lastPingTime) / 1000)} seg
━━━━━━━━━━━━━━━━━━━━━━━━
<i>Todo listo para recibir alertas automáticas de apagones.</i>`;

  const result = await sendTelegramMessage(testMessage);

  if (result.success) {
    return res.json({ success: true, message: '¡Mensaje de prueba enviado con éxito a Telegram!' });
  } else {
    return res.status(500).json({ success: false, error: result.error || 'No se pudo enviar el mensaje a Telegram' });
  }
});

// Ruta de fallback para SPA / Dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🔋 PowerWatch IoT Server iniciado en puerto ${PORT}`);
  console.log(`⏱️ Período de gracia: ${GRACE_PERIOD_SECONDS} segundos`);
  console.log(`🔑 Clave de Ping: ${PING_SECRET_KEY.slice(0, 3)}***${PING_SECRET_KEY.slice(-3)}`);
  console.log(`📡 Esperando pings del ESP32 en /api/ping?key=...`);
  console.log(`====================================================`);
});
