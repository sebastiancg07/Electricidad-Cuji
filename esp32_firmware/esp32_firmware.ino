/**
 * ============================================================================
 * POWERWATCH IoT - FIRMWARE ESP32 (Dead Man's Switch)
 * ============================================================================
 * Placa: ESP32 Dev Module / NodeMCU-32S / ESP32-WROOM
 * Función: Envía un pulso HTTP GET cada 60 segundos al servidor Node.js
 *          desplegado en Render. Al estar alimentado por corriente directa de la red
 *          (sin UPS), su apagado dispara la alerta del Watchdog.
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ============================================================================
// 1. CONFIGURACIÓN DE RED Y SERVIDOR (MODIFICA ESTOS DATOS)
// ============================================================================
const char* WIFI_SSID     = "Oikos";
const char* WIFI_PASSWORD = "madretierraparirasfelicidad";

// URL base de tu servidor en Render (ej: "https://electricidad-cuji.onrender.com")
// NOTA: NO incluir barra inclinada "/" al final
const char* SERVER_BASE_URL = "https://electricidad-cuji.onrender.com";

// Clave secreta configurada en PING_SECRET_KEY del archivo .env
const char* PING_SECRET_KEY = "madretierraparirasfelicidad";

// Intervalo de envío de ping (60 segundos = 60,000 milisegundos)
const unsigned long PING_INTERVAL_MS = 60000;

// LED indicador integrado (GPIO 2 en la mayoría de placas ESP32 DevKit)
const int LED_PIN = 2;

// ============================================================================
// VARIABLES GLOBALES
// ============================================================================
unsigned long lastPingMillis = 0;
unsigned long pingCount = 0;

// ============================================================================
// FUNCIÓN: Parpadeo visual del LED
// ============================================================================
void blinkLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(delayMs);
    digitalWrite(LED_PIN, LOW);
    if (i < times - 1) delay(delayMs);
  }
}

// ============================================================================
// FUNCIÓN: Conectar o reconectar a Wi-Fi
// ============================================================================
void connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("\n-------------------------------------------");
  Serial.printf("[WIFI] Conectando a red: %s\n", WIFI_SSID);
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Parpadeo rápido mientras conecta
    attempts++;
  }

  digitalWrite(LED_PIN, LOW);

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] ¡Conexión exitosa!");
    Serial.printf("[WIFI] Dirección IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[WIFI] Potencia señal (RSSI): %d dBm\n", WiFi.RSSI());
    Serial.println("-------------------------------------------");
    blinkLed(3, 100); // 3 parpadeos rápidos de confirmación
  } else {
    Serial.println("\n[WIFI] No se pudo conectar a la red Wi-Fi. Reintentando en el siguiente ciclo.");
  }
}

// ============================================================================
// FUNCIÓN: Enviar Ping HTTP GET al Backend
// ============================================================================
void sendPing() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[PING] Imposible enviar ping: Sin conexión Wi-Fi.");
    connectToWiFi();
    return;
  }

  pingCount++;
  Serial.printf("\n[PING #%lu] Iniciando transmisión hacia el servidor...\n", pingCount);

  // Cliente seguro para HTTPS en Render
  WiFiClientSecure client;
  // Render utiliza certificados SSL válidos (Let's Encrypt). 
  // setInsecure() permite cifrar en TLS sin necesidad de almacenar el certificado raíz en el ESP32
  client.setInsecure();

  // Configurar timeout generoso (15 segundos) por si Render está despertando del estado de reposo (Free Tier)
  client.setTimeout(15000);

  HTTPClient http;
  
  // Construir la URL completa con el query param de seguridad
  String fullUrl = String(SERVER_BASE_URL) + "/api/ping?key=" + String(PING_SECRET_KEY);
  
  Serial.printf("[PING] URL: %s\n", fullUrl.c_str());

  if (http.begin(client, fullUrl)) {
    // Timeout para la solicitud HTTP
    http.setTimeout(15000);
    http.addHeader("User-Agent", "ESP32-PowerWatch/1.0");

    unsigned long startReq = millis();
    int httpResponseCode = http.GET();
    unsigned long responseTime = millis() - startReq;

    if (httpResponseCode > 0) {
      Serial.printf("[PING] Código HTTP recibido: %d (tiempo: %lu ms)\n", httpResponseCode, responseTime);
      
      if (httpResponseCode == 200) {
        String payload = http.getString();
        Serial.printf("[PING] Servidor respondió OK: %s\n", payload.c_str());
        // 2 destellos rápidos indican éxito total
        blinkLed(2, 80);
      } else {
        Serial.printf("[PING] Servidor retornó advertencia/error: %d\n", httpResponseCode);
        blinkLed(1, 400); // 1 destello largo de advertencia
      }
    } else {
      Serial.printf("[PING] Falló la petición HTTP. Error: %s\n", http.errorToString(httpResponseCode).c_str());
      blinkLed(4, 50); // 4 destellos muy rápidos de error de red
    }

    http.end();
  } else {
    Serial.println("[PING] No fue posible inicializar la conexión HTTP.");
  }
}

// ============================================================================
// SETUP
// ============================================================================
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.begin(115200);
  delay(1500);

  Serial.println("\n=======================================================");
  Serial.println("  POWERWATCH IoT - SISTEMA DE MONITOREO DE APAGONES   ");
  Serial.println("  Principio: Dead Man's Switch                        ");
  Serial.println("=======================================================");

  // Conectar a la red Wi-Fi inicialmente
  connectToWiFi();

  // Enviar el primer ping de inmediato para confirmar arranque al volver la luz
  sendPing();
  lastPingMillis = millis();
}

// ============================================================================
// LOOP PRINCIPAL
// ============================================================================
void loop() {
  // Verificar continuamente el estado de Wi-Fi
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  // Comprobar si ha transcurrido el intervalo de 60 segundos
  unsigned long currentMillis = millis();
  if (currentMillis - lastPingMillis >= PING_INTERVAL_MS) {
    lastPingMillis = currentMillis;
    sendPing();
  }

  // Pequeña pausa no bloqueante para estabilidad del watchdog de FreeRTOS en ESP32
  delay(50);
}
