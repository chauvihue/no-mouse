# IMU streamer firmware (ESP32 + MPU-6050)

Reads the MPU-6050 at 1 kHz from its FIFO and streams every reading over USB serial.

- **Wiring:** MPU-6050 at I2C 0x68 on SDA = GPIO 21, SCL = GPIO 22. Keep other devices (e.g. the OLED) quiet on the bus while streaming.
- **Sensor settings:** ±8 g, ±1000 °/s, ~188 Hz low-pass, 1 kHz sample rate.
- **Output:** 921600 baud. A `t,ax,ay,az,gx,gy,gz` header, then one line per reading (t in s on the sensor's clock, accel in g, gyro in °/s). Lines starting with `#` are status messages.

## Build and flash (PlatformIO)

```bash
cd firmware/imu_testing
pio run -t upload
pio device monitor
```
