/**
 * PowerWatch IoT — Electricidad Cují (Versión 2.1)
 * Monitoreo de Red Eléctrica con Dead Man's Switch, Telegram Bot API y Dashboard
 * 
 * Lógica anti-falsos positivos por suspensión de Render:
 * - Prohibido asumir UP al arrancar.
 * - Inicio en WAITING_ESP32 con ventana de evaluación de 90s.
 * - Endpoint ligero /api/health para Keep-Alive externo (no actualiza pings del ESP32).
 * - Endpoint /api/adjust-outage-time para ajustar manualmente la hora de inicio de cortes.
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

// Períodos de tolerancia (en segundos)
const GRACE_PERIOD_SECONDS = parseInt(process.env.GRACE_PERIOD_SECONDS, 10) || 180; // 3 minutos en operación normal
const BOOT_GRACE_PERIOD_SECONDS = 90; // 90 segundos al arrancar el contenedor antes de declarar corte

// Zona Horaria Oficial (Venezuela UTC-4)
const TIMEZONE = 'America/Caracas';

// Marca de tiempo exacta del arranque del servidor
const serverBootTime = Date.now();

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

// Calcular milisegundo de inicio de hoy a las 00:00:00 en Venezuela (UTC-4)
function getStartOfDayVenezuela() {
  const dayStr = getVenezuelaDayString();
  return new Date(`${dayStr}T00:00:00-04:00`).getTime();
}

// Parsear texto de hora ("06:57 AM", "06:57", "18:30") a timestamp de Venezuela
function parseTimeToTimestamp(timeString, dateString = null) {
  if (!timeString || typeof timeString !== 'string') return null;
  const targetDay = dateString || getVenezuelaDayString();

  const clean = timeString.trim().toLowerCase();
  const isPM = clean.includes('pm') || clean.includes('p.m.') || clean.includes('p. m.');
  const isAM = clean.includes('am') || clean.includes('a.m.') || clean.includes('a. m.');

  const timeOnly = clean.replace(/[^0-9:]/g, '');
  const parts = timeOnly.split(':');
  if (parts.length < 2) return null;

  let hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parts[2] ? parseInt(parts[2], 10) : 0;

  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  const isoStr = `${targetDay}T${hh}:${mm}:${ss}-04:00`;
  const timestamp = new Date(isoStr).getTime();
  return isNaN(timestamp) ? null : timestamp;
}

// =========================================================================
// GESTIÓN DEL ESTADO EN MEMORIA Y PERSISTENCIA (state.json)
// =========================================================================

// ESTADO INICIAL: PROHIBIDO ASUMIR UP AL ARRANCAR
let state = {
  status: 'WAITING_ESP32', // Estado seguro de arranque
  stateStartTime: serverBootTime,
  lastPingTime: null, // Nulo hasta recibir un GET /api/ping real
  outageStartTime: null,
  wasDownBeforeRestart: false, // Flag si el servidor ya estaba en DOWN antes de reiniciar
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

      const hadPreviousOutage = (saved.status === 'DOWN' || Boolean(saved.outageStartTime));

      state = {
        ...state,
        pingsToday: isSameDay ? (saved.pingsToday || 0) : 0,
        outagesToday: isSameDay ? (saved.outagesToday || 0) : 0,
        totalDowntimeSecondsToday: isSameDay ? (saved.totalDowntimeSecondsToday || 0) : 0,
        historyLogs: Array.isArray(saved.historyLogs) ? saved.historyLogs : [],
        // Si el estado previo en disco era DOWN, preservamos el outageStartTime real
        outageStartTime: hadPreviousOutage ? saved.outageStartTime : null,
        wasDownBeforeRestart: hadPreviousOutage,
        currentDay: today,
        // NUNCA asumir UP: siempre arrancar en WAITING_ESP32
        status: 'WAITING_ESP32',
        stateStartTime: serverBootTime,
        lastPingTime: null
      };
      console.log('✅ Estado previo cargado desde state.json. Servidor en modo seguro WAITING_ESP32.');
    } else {
      console.log('ℹ️ Primer arranque sin state.json. Servidor en modo seguro WAITING_ESP32.');
    }
  } catch (err) {
    console.warn('⚠️ Error al leer state.json:', err.message);
  }
}

// Guardar estado en state.json
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
  }
}

// =========================================================================
// WATCHDOG INTERNO: Evaluación cada 5 segundos
// =========================================================================
setInterval(async () => {
  checkDayRollover();
  const now = Date.now();

  // CASO 1: EL SERVIDOR INICIÓ EN 'WAITING_ESP32' (Anti-Falsos Positivos)
  if (state.status === 'WAITING_ESP32') {
    const bootElapsedSeconds = Math.floor((now - serverBootTime) / 1000);

    // Si pasaron 90 segundos desde el arranque sin recibir ningún ping del ESP32:
    // Significa que el servidor inició en medio de un apagón eléctrico
    if (bootElapsedSeconds >= BOOT_GRACE_PERIOD_SECONDS) {
      console.log(`🚨 [BOOT WATCHDOG] 90s transcurridos sin respuesta del ESP32. Confirmando CORTE ELÉCTRICO.`);
      
      const wasAlreadyDown = state.wasDownBeforeRestart && state.outageStartTime;
      state.status = 'DOWN';
      state.stateStartTime = now;
      
      // Si ya conocíamos la hora de inicio del corte previo, conservarla para no perder la duración real
      if (!wasAlreadyDown) {
        state.outageStartTime = serverBootTime - (BOOT_GRACE_PERIOD_SECONDS * 1000);
        state.outagesToday++;
      }
      if (!state.lastPingTime) {
        state.lastPingTime = state.outageStartTime;
      }

      addHistoryEvent({
        type: 'OUTAGE_START',
        message: wasAlreadyDown 
          ? `Corte de CORPOELEC activo confirmado tras reinicio del servidor` 
          : `Corte de CORPOELEC detectado (servidor arrancó sin señal del ESP32)`,
        elapsedSeconds: bootElapsedSeconds
      });

      persistState();

      // Si el apagón ya estaba en curso antes de reiniciar, NO spamear mensaje duplicado
      // Solo notificar si fue un corte nuevo detectado
      if (!wasAlreadyDown) {
        const alertMessage = 
`🚨 <b>CORTE ELÉCTRICO DETECTADO</b> 🚨
━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Estado:</b> SIN SUMINISTRO ELÉCTRICO
⏱️ <b>Tiempo de verificación:</b> 90 seg tras arranque
📅 <b>Fecha y Hora:</b> ${formatDateTime(now)}
⚡ <b>Alimentación:</b> Red CORPOELEC sin energía
━━━━━━━━━━━━━━━━━━━━━━━━
<i>El servidor se ha iniciado y confirmó que el ESP32 está apagado.</i>`;
        await sendTelegramMessage(alertMessage);
      }
    }
    return;
  }

  // CASO 2: EL SERVIDOR ESTÁ EN ESTADO 'UP' NORMAL
  if (state.status === 'UP' && state.lastPingTime) {
    const elapsedSeconds = Math.floor((now - state.lastPingTime) / 1000);

    // Si pasaron más de 180 segundos sin pings
    if (elapsedSeconds > GRACE_PERIOD_SECONDS) {
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
  }
}, 5000);

// =========================================================================
// ENDPOINTS DE LA API
// =========================================================================

/**
 * GET /api/health
 * Endpoint ligero para Keep-Alive externo (Cron-job.org / UptimeRobot)
 * IMPORTANTE: NUNCA actualiza lastPingTime ni modifica el estado del ESP32.
 */
app.get('/api/health', (req, res) => {
  res.status(200).json({
    alive: true,
    serverTime: Date.now(),
    serverTimeFormatted: formatDateTime(Date.now()),
    systemStatus: state.status,
    uptimeSeconds: Math.floor((Date.now() - serverBootTime) / 1000)
  });
});

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

  // CASO A: El servidor arrancó y estaba en WAITING_ESP32
  if (previousStatus === 'WAITING_ESP32') {
    state.status = 'UP';
    state.stateStartTime = now;
    state.lastPingTime = now;
    state.outageStartTime = null;
    state.wasDownBeforeRestart = false;
    state.pingsToday++;

    console.log('⚡ [SINCRONIZADO] Primer latido del ESP32 recibido. Estado pasa a UP silenciosamente.');
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

  // CASO B: Veníamos de un corte eléctrico real (DOWN -> UP)
  if (previousStatus === 'DOWN') {
    state.status = 'UP';
    state.stateStartTime = now;
    const outageStart = state.outageStartTime || (previousPing ? previousPing + (GRACE_PERIOD_SECONDS * 1000) : (now - (GRACE_PERIOD_SECONDS * 1000)));
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
    state.wasDownBeforeRestart = false;

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
  state.status = 'UP';
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
 * POST /api/adjust-outage-time
 * Permite ajustar manualmente la hora de inicio de un corte (ej: "06:57 AM")
 */
app.post('/api/adjust-outage-time', async (req, res) => {
  const { key, time, date } = req.body || {};

  if (!key || key !== PING_SECRET_KEY) {
    return res.status(401).json({ success: false, error: 'Clave no autorizada o incorrecta' });
  }

  if (!time) {
    return res.status(400).json({ success: false, error: 'Debes proporcionar la hora (ej: 06:57 AM o 14:30)' });
  }

  const parsedTimestamp = parseTimeToTimestamp(time, date);
  if (!parsedTimestamp) {
    return res.status(400).json({ success: false, error: 'Formato de hora no válido. Ejemplos válidos: "06:57 AM", "6:57", "18:30"' });
  }

  if (parsedTimestamp > Date.now()) {
    return res.status(400).json({ success: false, error: 'La hora del corte no puede ser en el futuro.' });
  }

  // Establecer estado en DOWN con la nueva hora
  const previousOutageStart = state.outageStartTime;
  state.status = 'DOWN';
  state.outageStartTime = parsedTimestamp;
  state.stateStartTime = parsedTimestamp;
  state.lastPingTime = parsedTimestamp; // El último latido registrado del ESP32 coincide con el inicio del apagón
  state.wasDownBeforeRestart = true;

  const formattedTime = formatDateTime(parsedTimestamp);
  console.log(`✏️ [AJUSTE MANUAL] Hora de inicio de apagón ajustada a: ${formattedTime}`);

  addHistoryEvent({
    type: 'OUTAGE_START',
    message: `Hora de corte ajustada manualmente a las ${formattedTime}`,
    manualAdjustment: true
  });

  persistState();

  return res.json({
    success: true,
    message: `Hora de inicio de apagón ajustada exitosamente a las ${formattedTime}`,
    outageStartTime: parsedTimestamp,
    outageStartTimeFormatted: formattedTime
  });
});

/**
 * GET /api/status
 * Devuelve el estado completo del sistema y métricas
 */
app.get('/api/status', (req, res) => {
  checkDayRollover();
  const now = Date.now();
  const bootElapsedSeconds = Math.floor((now - serverBootTime) / 1000);
  const remainingBootSeconds = Math.max(0, BOOT_GRACE_PERIOD_SECONDS - bootElapsedSeconds);

  // Determinar último ping conocido (si está en DOWN y lastPingTime era nulo, el inicio del corte representa el último ping)
  const effectiveLastPingTime = state.lastPingTime || state.outageStartTime;
  const elapsedSeconds = effectiveLastPingTime ? Math.floor((now - effectiveLastPingTime) / 1000) : null;

  // Duración del corte actual
  let currentOutageDuration = 0;
  if (state.status === 'DOWN') {
    const start = state.outageStartTime || state.stateStartTime || serverBootTime;
    currentOutageDuration = Math.max(0, Math.floor((now - start) / 1000));
  }

  const totalDowntimeSeconds = state.totalDowntimeSecondsToday + currentOutageDuration;
  const totalDowntimeToday = formatDuration(totalDowntimeSeconds);

  // Porcentaje de disponibilidad en el día de hoy
  const startOfDay = getStartOfDayVenezuela();
  const secondsElapsedToday = Math.max(1, Math.floor((now - startOfDay) / 1000));
  const uptimeRatio = Math.max(0, Math.min(100, ((secondsElapsedToday - totalDowntimeSeconds) / secondsElapsedToday) * 100));
  const uptimePercentage = `${uptimeRatio.toFixed(1)}%`;

  let currentStateDuration = '';
  let currentStateDurationSeconds = 0;

  if (state.status === 'UP') {
    currentStateDurationSeconds = Math.max(0, Math.floor((now - (state.stateStartTime || now)) / 1000));
    currentStateDuration = `Con luz desde hace ${formatDuration(currentStateDurationSeconds)}`;
  } else if (state.status === 'DOWN') {
    currentStateDurationSeconds = currentOutageDuration;
    currentStateDuration = `Sin luz desde hace ${formatDuration(currentStateDurationSeconds)}`;
  } else {
    // WAITING_ESP32
    currentStateDurationSeconds = bootElapsedSeconds;
    currentStateDuration = `Verificando señal desde hace ${formatDuration(currentStateDurationSeconds)} (faltan ${remainingBootSeconds}s)`;
  }

  res.json({
    status: state.status, // 'WAITING_ESP32', 'UP', 'DOWN'
    serverBootTime,
    bootElapsedSeconds,
    bootGracePeriodSeconds: BOOT_GRACE_PERIOD_SECONDS,
    remainingBootSeconds,
    lastPingTime: effectiveLastPingTime,
    lastPingFormatted: formatDateTime(effectiveLastPingTime),
    elapsedSeconds,
    gracePeriodSeconds: GRACE_PERIOD_SECONDS,
    pingsToday: state.pingsToday,
    outagesToday: state.outagesToday,
    outageStartTime: state.outageStartTime,
    outageStartTimeFormatted: formatDateTime(state.outageStartTime),
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
 * POST /api/test-telegram (Protegido con key)
 */
app.post('/api/test-telegram', async (req, res) => {
  const { key } = req.body || {};

  if (!key || key !== PING_SECRET_KEY) {
    return res.status(401).json({ success: false, error: 'Clave no autorizada o incorrecta' });
  }

  const now = Date.now();
  const testMessage = 
`🔔 <b>MENSAJE DE PRUEBA - ELECTRICIDAD CUJÍ</b>
━━━━━━━━━━━━━━━━━━━━━━━━
✅ La conexión entre el servidor Node.js y Telegram está funcionando correctamente.
📅 <b>Fecha y Hora:</b> ${formatDateTime(now)}
📡 <b>Estado actual:</b> ${state.status === 'UP' ? '⚡ ACTIVO (UP)' : (state.status === 'DOWN' ? '🚨 CORTE (DOWN)' : '⏳ VERIFICANDO (WAITING_ESP32)')}
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🔋 PowerWatch IoT v2.1 (Electricidad Cují) en puerto ${PORT}`);
  console.log(`🕒 Zona Horaria: ${TIMEZONE}`);
  console.log(`⏱️ Tolerancia de arranque (WAITING_ESP32): ${BOOT_GRACE_PERIOD_SECONDS}s`);
  console.log(`⏱️ Período de gracia normal: ${GRACE_PERIOD_SECONDS}s`);
  console.log(`📡 Keep-Alive endpoint activo: /api/health`);
  console.log(`====================================================`);
});
