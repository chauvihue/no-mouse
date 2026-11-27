// Streams the MPU-6050 at 1 kHz over USB serial (ESP32, I2C on SDA=21, SCL=22).
//
// The sensor samples itself at exactly 1 kHz into its 1 KB FIFO (85 ms of data)
// and the loop drains it in batches, so timing comes from the sensor's own clock
// and a short stall in the loop doesn't lose readings.
//
// Serial, 921600 baud: a "t,ax,ay,az,gx,gy,gz" header, then one line per reading
// (t in s on the sensor's clock, accel in g, gyro in deg/s). This is the format
// the Simulation's live mode and CSV import read. Lines starting with '#' are
// status messages that readers skip.
//
// Nothing else may talk on the I2C bus while streaming: with the OLED refreshing
// on the same bus, FIFO reads came back corrupted.

#include <Arduino.h>
#include <Wire.h>

constexpr uint32_t BAUD_RATE = 921600;  // 115200 only carries ~270 lines per second
constexpr uint32_t I2C_HZ = 400000;     // the MPU-6050's maximum

constexpr uint8_t MPU_ADDR = 0x68;  // 0x69 if the AD0 pin is pulled high
constexpr uint8_t REG_SMPLRT_DIV = 0x19;
constexpr uint8_t REG_CONFIG = 0x1A;
constexpr uint8_t REG_GYRO_CONFIG = 0x1B;
constexpr uint8_t REG_ACCEL_CONFIG = 0x1C;
constexpr uint8_t REG_FIFO_EN = 0x23;
constexpr uint8_t REG_USER_CTRL = 0x6A;
constexpr uint8_t REG_PWR_MGMT_1 = 0x6B;
constexpr uint8_t REG_FIFO_COUNT_H = 0x72;
constexpr uint8_t REG_FIFO_R_W = 0x74;

// Ranges match the Simulation's sensor model: accel +-8 g, gyro +-1000 deg/s.
constexpr float ACCEL_LSB_PER_G = 4096.0f;
constexpr float GYRO_LSB_PER_DPS = 32.8f;

constexpr uint32_t SAMPLE_RATE_HZ = 1000;
constexpr int FRAME_BYTES = 12;          // accel xyz + gyro xyz, 2 bytes each
constexpr int FIFO_FULL_ALIGNED = 1020;  // 85 whole frames in the 1024-byte FIFO; more means it overflowed
constexpr int FRAMES_PER_READ = 10;      // 120 bytes, within Wire's 128-byte buffer

constexpr uint32_t DRAIN_PERIOD_US = 5000;  // read the FIFO in batches of ~5 readings
constexpr int MAX_FAILED_READS = 20;        // failed reads in a row before re-initialising

bool mpuReady = false;
uint32_t sampleIndex = 0;  // readings since the stream started, at the sensor's 1 kHz
uint32_t streamStartUs = 0;

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegisters(uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  // Send a STOP here, not a repeated start (endTransmission(false)): on this
  // board the repeated start gave timeouts and corrupt bytes.
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// Empties the FIFO and restarts it. Readings lost since the last drain are
// skipped in the timestamps, so t keeps following real time.
bool restartFifo() {
  bool ok = writeRegister(REG_USER_CTRL, 0x00)   // FIFO off
         && writeRegister(REG_USER_CTRL, 0x04)   // FIFO_RESET
         && writeRegister(REG_USER_CTRL, 0x40);  // FIFO on
  sampleIndex = (uint64_t)(micros() - streamStartUs) * SAMPLE_RATE_HZ / 1000000;
  return ok;
}

bool initMPU() {
  bool ok = writeRegister(REG_PWR_MGMT_1, 0x01)    // wake up, clock from gyro X PLL
         && writeRegister(REG_SMPLRT_DIV, 0x00)    // 1 kHz / (1 + 0) = 1 kHz
         && writeRegister(REG_CONFIG, 0x01)        // ~188 Hz low-pass: keeps tap vibrations
         && writeRegister(REG_GYRO_CONFIG, 0x10)   // +-1000 deg/s
         && writeRegister(REG_ACCEL_CONFIG, 0x10)  // +-8 g
         && writeRegister(REG_FIFO_EN, 0x78);      // accel + gyro xyz into the FIFO
  if (!ok) return false;
  delay(100);  // let the gyro settle so the first readings aren't garbage
  streamStartUs = micros();
  if (!restartFifo()) return false;
  Serial.println("t,ax,ay,az,gx,gy,gz");
  return true;
}

// A failed bus read comes back as one repeated word (0xFEFE, 0x7F7F, 0xFFFF).
// A real reading never has all six values identical.
bool isGarbage(const uint8_t *f) {
  for (int i = 2; i < FRAME_BYTES; i += 2) {
    if (f[i] != f[0] || f[i + 1] != f[1]) return false;
  }
  return true;
}

void printReading(const uint8_t *f) {
  auto s16 = [](const uint8_t *p) { return (int16_t)((p[0] << 8) | p[1]); };
  // t printed from integers: a float loses millisecond precision after a few hours.
  Serial.printf("%lu.%03lu,%.4f,%.4f,%.4f,%.2f,%.2f,%.2f\n",
                (unsigned long)(sampleIndex / SAMPLE_RATE_HZ), (unsigned long)(sampleIndex % SAMPLE_RATE_HZ),
                s16(f + 0) / ACCEL_LSB_PER_G, s16(f + 2) / ACCEL_LSB_PER_G, s16(f + 4) / ACCEL_LSB_PER_G,
                s16(f + 6) / GYRO_LSB_PER_DPS, s16(f + 8) / GYRO_LSB_PER_DPS, s16(f + 10) / GYRO_LSB_PER_DPS);
  sampleIndex++;
}

// Prints every complete reading waiting in the FIFO. Returns false if the
// sensor didn't answer.
bool drainFifo() {
  uint8_t countBytes[2];
  if (!readRegisters(REG_FIFO_COUNT_H, countBytes, 2)) return false;
  int count = (countBytes[0] << 8) | countBytes[1];
  if (count > FIFO_FULL_ALIGNED) {
    // The FIFO filled up and overwrote old bytes, so readings are no longer aligned.
    Serial.println("# FIFO overflow: some readings were lost");
    return restartFifo();
  }

  uint8_t buf[FRAMES_PER_READ * FRAME_BYTES];
  for (int frames = count / FRAME_BYTES; frames > 0;) {
    int n = min(frames, FRAMES_PER_READ);
    bool ok = readRegisters(REG_FIFO_R_W, buf, n * FRAME_BYTES);
    for (int i = 0; ok && i < n; i++) ok = !isGarbage(buf + i * FRAME_BYTES);
    if (!ok) {
      // We no longer know where the next reading starts in the FIFO:
      // throw its contents away and start clean.
      Serial.println("# bad I2C read: FIFO restarted, some readings were lost");
      return restartFifo();
    }
    for (int i = 0; i < n; i++) printReading(buf + i * FRAME_BYTES);
    frames -= n;
  }
  return true;
}

void setup() {
  Serial.setTxBufferSize(8192);  // printing queues instead of blocking the loop
  Serial.begin(BAUD_RATE);
  Wire.begin(SDA, SCL);
  Wire.setClock(I2C_HZ);
  mpuReady = initMPU();
}

void loop() {
  if (!mpuReady) {
    Serial.println("# MPU-6050 not found at 0x68: check wiring");
    delay(1000);
    mpuReady = initMPU();
    return;
  }

  static uint32_t lastDrainUs = 0;
  uint32_t nowUs = micros();
  if (nowUs - lastDrainUs < DRAIN_PERIOD_US) return;
  lastDrainUs = nowUs;

  // Skip the odd failed read; only treat the sensor as gone if reads keep failing.
  static int failedReads = 0;
  if (!drainFifo()) {
    if (++failedReads >= MAX_FAILED_READS) {
      failedReads = 0;
      mpuReady = false;
    }
    return;
  }
  failedReads = 0;
}
