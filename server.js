/**
 * PowerWatch IoT — Electricidad Cují (Versión 2.0)
 * Monitoreo de Red Eléctrica con Dead Man's Switch, Telegram Bot API y Dashboard
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

// Constantes de Zona Horaria (Venezuela UTC-4)
const TIMEZONE = 'America/Caracas';

// Archivo de persistencia de estado en disco (state.json)
const STATE_FILE = path.join(__dirname, 'state.json');

// Utilidad para obtener la fecha del día actual en Venezuela (YYYY-MM-DD)
function getVenezuelaDayString(dateInput = Date.now()) {
  const d = new Date(dateInput);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

// Formatear fecha y hora completa en español de Venezuela (12h con DD/MM/YYYY)
function formatDateTime(dateInput) {
  if (!dateInput) return 'Sin registro';
  const d = new Date(dateInput);
  return d.toLocaleString('es-VE', {
    timeZone: TIMEZONE,
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

// Formatear duración en segundos a texto legible ("4h 20m 15s" o "45 seg")
function formatDuration(totalSeconds) {
  if (totalSeconds < 60) {
    return `${Math.max(0, Math.floor(totalSeconds))} seg`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

// Calcular milisegundo de inicio de hoy a las 00:00:00 en Venezuela (UTC-4 fijo)
function getStartOfDayVenezuela() {
  const dayStr = getVenezuelaDayString();
  return new Date(`${dayStr}T00:00:00-04:00`).getTime();
}

// =========================================================================
// GESTIÓN DEL ESTADO EN MEMORIA Y PERSISTENCIA (state.json)
// =========================================================================

// Estado del sistema: 'WAITING' (espera inicial anti-falsos positivos), 'UP', o 'DOWN'
let state = {
  status: 'WAITING',
  stateStartTime: Date.now(),
  lastPingTime: null,
  outageStartTime: null,
  currentDay: getVenezuelaDayString(),
  pingsToday: 0,
  outagesToday: 0,
  totalDowntimeSecondsToday: 0,
  historyLogs: []
};

// Cargar estado persistente de state.json si existe
function loadPersistedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      const today = getVenezuelaDayString();
      const isSameDay = (saved.currentDay === today);

      state = {
        ...state,
        // Cargar estadísticas acumuladas si corresponden al mismo día
        pingsToday: isSameDay ? (saved.pingsToday || 0) : 0,
        outagesToday: isSameDay ? (saved.outagesToday || 0) : 0,
        totalDowntimeSecondsToday: isSameDay ? (saved.totalDowntimeSecondsToday || 0) : 0,
        historyLogs: Array.isArray(saved.historyLogs) ? saved.historyLogs : [],
        lastPingTime: saved.lastPingTime || null,
        outageStartTime: saved.outageStartTime || null,
        currentDay: today,
        // Anti-Falsos Positivos: Todo arranque o reinicio del contenedor empieza en WAITING
        status: 'WAITING',
        stateStartTime: Date.now()
      };
      console.log('✅ Estado persistente restaurado desde state.json (Iniciando en WAITING)');
    } else {
      console.log('ℹ️ No existe state.json previo. Iniciando en estado WAITING.');
    }
  } catch (err) {
    console.warn('⚠️ Error al leer state.json:', err.message);
  }
}

// Guardar estado en state.json de manera segura
function persistState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('⚠️ Error al persistir state.json:', err.message);
  }
}

loadPersistedState();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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
    return { success: true };
  } catch (error) {
    console.error('❌ Error de red con Telegram:', error.message);
    return { success: false, error: error.message };
  }
}

// Agregar evento al historial (mantener máximo 50 eventos)
function addHistoryEvent(event) {
  const now = Date.now();
  state.historyLogs.unshift({
    id: now.toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: now,
    timestampFormatted: formatDateTime(now),
    ...event
  });

  if (state.historyLogs.length > 50) {
    state.historyLogs = state.historyLogs.slice(0, 50);
  }
  persistState();
}

// Reiniciar contadores diarios si cambió de fecha en Venezuela
function checkDayRollover() {
  const today = getVenezuelaDayString();
  if (state.currentDay !== today) {
    state.currentDay = today;
    state.pingsToday = 0;
    state.outagesToday = 0;
    state.totalDowntimeSecondsToday = 0;
    persistState();
    console.log(`📅 Cambio de día registrado: ${today}. Contadores reiniciados.`);
  }
}

// =========================================================================
// WATCHDOG INTERNO: Evaluación cada 5 segundos
// =========================================================================
setInterval(async () => {
  checkDayRollover();
  const now = Date.now();

  // Si estamos en WAITING, no disparamos alertas (esperando primer latido del ESP32)
  if (state.status === 'WAITING' || !state.lastPingTime) {
    return;
  }

  const elapsedSeconds = Math.floor((now - state.lastPingTime) / 1000);

  // Si pasaron más segundos que el tiempo de gracia y estábamos en UP
  if (elapsedSeconds > GRACE_PERIOD_SECONDS && state.status === 'UP') {
    state.status = 'DOWN';
    state.stateStartTime = now;
    state.outageStartTime = now;
    state.outagesToday++;

    console.log(`🚨 [WATCHDOG] CORTE DETECTADO: ${elapsedSeconds}s sin pings del ESP32.`);

    addHistoryEvent({
      type: 'OUTAGE_START',
      message: 'Corte de CORPOELEC detectado (ESP32 sin energía eléctrica)',
      elapsedSeconds
    });

    const alertMessage = 
`🚨 <b>CORTE ELÉCTRICO DETECTADO</b> 🚨
━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Estado:</b> SIN SUMINISTRO ELÉCTRICO
⏱️ <b>Tiempo sin señal:</b> ${elapsedSeconds} seg (límite: ${GRACE_PERIOD_SECONDS}s)
📅 <b>Fecha y Hora:</b> ${formatDateTime(now)}
⚡ <b>Alimentación:</b> Red CORPOELEC sin energía
━━━━━━━━━━━━━━━━━━━━━━━━
<i>El ESP32 no está recibiendo corriente por parte de CORPOELEC.</i>`;

    persistState();
    await sendTelegramMessage(alertMessage);
  }
}, 5000);

// =========================================================================
// ENDPOINTS DE LA API
// =========================================================================

/**
 * GET /api/ping
 * Invocado por el microcontrolador ESP32 cada 60 segundos
 */
app.get('/api/ping', async (req, res) => {
  const clientKey = req.query.key;

  if (!clientKey || clientKey !== PING_SECRET_KEY) {
    return res.status(401).json({ status: 'error', message: 'Clave no válida o no proporcionada' });
  }

  checkDayRollover();
  const now = Date.now();
  const previousStatus = state.status;
  const previousPing = state.lastPingTime;

  // CASO 1: El servidor arrancó y estaba esperando el primer latido
  if (previousStatus === 'WAITING') {
    state.status = 'UP';
    state.stateStartTime = now;
    state.lastPingTime = now;
    state.pingsToday++;

    console.log('⚡ [SINCRONIZADO] Primer latido recibido tras inicio del servidor. Estado pasa a UP silenciosamente.');
    addHistoryEvent({
      type: 'SYSTEM_START',
      message: 'Servidor sincronizado con el ESP32 tras arranque'
    });
    persistState();

    return res.status(200).json({
      status: 'ok',
      systemStatus: state.status,
      timestamp: now,
      elapsedSinceLast: 0
    });
  }

  // CASO 2: Venía de un corte eléctrico (DOWN -> UP)
  if (previousStatus === 'DOWN') {
    state.status = 'UP';
    state.stateStartTime = now;
    const outageStart = state.outageStartTime || (previousPing ? previousPing + (GRACE_PERIOD_SECONDS * 1000) : now);
    const durationSeconds = Math.max(0, Math.floor((now - outageStart) / 1000));
    const durationFormatted = formatDuration(durationSeconds);

    // Acumular tiempo sin luz hoy
    state.totalDowntimeSecondsToday += durationSeconds;

    console.log(`⚡ [RESTABLECIDO] Energía de CORPOELEC recuperada tras ${durationFormatted}.`);

    addHistoryEvent({
      type: 'POWER_RESTORED',
      message: `Energía de CORPOELEC restablecida tras ${durationFormatted}`,
      outageStartTime: outageStart,
      restoredTime: now,
      durationSeconds,
      durationFormatted
    });

    state.outageStartTime = null;

    const restoredMessage = 
`⚡ <b>¡ENERGÍA ELÉCTRICA RESTABLECIDA!</b> ⚡
━━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>Estado:</b> SERVICIO DE CORPOELEC ACTIVO
⏳ <b>Duración del apagón:</b> ${durationFormatted}
📅 <b>Hora de retorno:</b> ${formatDateTime(now)}
📊 <b>Cortes registrados hoy:</b> ${state.outagesToday}
━━━━━━━━━━━━━━━━━━━━━━━━
<i>El suministro de CORPOELEC ha retornado y el ESP32 reanudó su transmisión.</i>`;

    sendTelegramMessage(restoredMessage).catch(console.error);
  }

  // Actualizar métricas generales
  state.lastPingTime = now;
  state.pingsToday++;
  persistState();

  return res.status(200).json({
    status: 'ok',
    systemStatus: state.status,
    timestamp: now,
    elapsedSinceLast: previousPing ? Math.floor((now - previousPing) / 1000) : 0
  });
});

/**
 * GET /api/status
 * Devuelve el estado completo del sistema y métricas avanzadas v2.0
 */
app.get('/api/status', (req, res) => {
  checkDayRollover();
  const now = Date.now();
  const elapsedSeconds = state.lastPingTime ? Math.floor((now - state.lastPingTime) / 1000) : null;

  // Duración del corte actual si estamos en DOWN
  let currentOutageDuration = 0;
  if (state.status === 'DOWN') {
    const start = state.outageStartTime || state.stateStartTime;
    currentOutageDuration = Math.max(0, Math.floor((now - start) / 1000));
  }

  // Tiempo total acumulado sin luz hoy (incluyendo el apagón actual si está en curso)
  const totalDowntimeSeconds = state.totalDowntimeSecondsToday + currentOutageDuration;
  const totalDowntimeToday = formatDuration(totalDowntimeSeconds);

  // Porcentaje de disponibilidad en el día de hoy
  const startOfDay = getStartOfDayVenezuela();
  const secondsElapsedToday = Math.max(1, Math.floor((now - startOfDay) / 1000));
  const uptimeRatio = Math.max(0, Math.min(100, ((secondsElapsedToday - totalDowntimeSeconds) / secondsElapsedToday) * 100));
  const uptimePercentage = `${uptimeRatio.toFixed(1)}%`;

  // Duración continua del estado actual
  const currentStateDurationSeconds = Math.max(0, Math.floor((now - (state.stateStartTime || now)) / 1000));
  let currentStateDuration = '';
  if (state.status === 'UP') {
    currentStateDuration = `Con luz desde hace ${formatDuration(currentStateDurationSeconds)}`;
  } else if (state.status === 'DOWN') {
    currentStateDuration = `Sin luz desde hace ${formatDuration(currentStateDurationSeconds)}`;
  } else {
    currentStateDuration = `Esperando primer latido desde hace ${formatDuration(currentStateDurationSeconds)}`;
  }

  res.json({
    status: state.status, // 'WAITING', 'UP', 'DOWN'
    lastPingTime: state.lastPingTime,
    lastPingFormatted: formatDateTime(state.lastPingTime),
    elapsedSeconds,
    gracePeriodSeconds: GRACE_PERIOD_SECONDS,
    pingsToday: state.pingsToday,
    outagesToday: state.outagesToday,
    totalDowntimeToday,
    totalDowntimeSeconds,
    uptimePercentage,
    currentStateDuration,
    currentStateDurationSeconds,
    stateStartTime: state.stateStartTime,
    currentOutageDuration,
    currentOutageDurationFormatted: formatDuration(currentOutageDuration),
    serverTime: now,
    serverTimeFormatted: formatDateTime(now),
    historyLogs: state.historyLogs
  });
});

/**
 * POST /api/test-telegram
 * Endpoint protegido con autenticación mediante { key: "..." }
 */
app.post('/api/test-telegram', async (req, res) => {
  const { key } = req.body || {};

  // Validación de seguridad obligatoria contra PING_SECRET_KEY
  if (!key || key !== PING_SECRET_KEY) {
    console.warn(`🔒 Acceso no autorizado a /api/test-telegram desde IP: ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Clave no autorizada o incorrecta' });
  }

  const now = Date.now();
  const testMessage = 
`🔔 <b>MENSAJE DE PRUEBA - ELECTRICIDAD CUJÍ</b>
━━━━━━━━━━━━━━━━━━━━━━━━
✅ La conexión entre el servidor Node.js y Telegram está funcionando correctamente.
📅 <b>Fecha y Hora:</b> ${formatDateTime(now)}
📡 <b>Estado actual:</b> ${state.status === 'UP' ? '⚡ ACTIVO (UP)' : (state.status === 'DOWN' ? '🚨 CORTE (DOWN)' : '⏳ EN ESPERA (WAITING)')}
⏱️ <b>Último ping ESP32:</b> ${state.lastPingTime ? `hace ${Math.floor((now - state.lastPingTime) / 1000)} seg` : 'Ninguno aún'}
━━━━━━━━━━━━━━━━━━━━━━━━
<i>Todo listo para recibir alertas automáticas de cortes eléctricos.</i>`;

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
  console.log(`🔋 PowerWatch IoT v2.0 (Electricidad Cují) iniciado en puerto ${PORT}`);
  console.log(`🕒 Zona Horaria configurada: ${TIMEZONE}`);
  console.log(`⏱️ Período de gracia: ${GRACE_PERIOD_SECONDS} segundos`);
  console.log(`📡 Esperando pings del ESP32 en /api/ping?key=...`);
  console.log(`====================================================`);
});
