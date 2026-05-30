# NozePlot Arduino compile server

The browser **cannot** run a C/C++ toolchain, so the "MCU Flash" page can only
**flash** firmware in-browser. To compile sketches from source (so the AI loop
can build → flash), run this tiny local server. It wraps
[`arduino-cli`](https://arduino.github.io/arduino-cli/) and returns the compiled
firmware to the app.

## 1. Install arduino-cli

macOS (Homebrew):

```bash
brew install arduino-cli
```

or (any OS):

```bash
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
```

## 2. Install the board cores you need

```bash
arduino-cli config init
# ESP32 family:
arduino-cli config add board_manager.additional_urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32        # ESP32 / S2 / S3 / C3 / C6
arduino-cli core install esp8266:esp8266    # optional, ESP8266
arduino-cli core install arduino:avr        # Uno / Nano / Pro Mini
```

## 3. Run the server

```bash
cd tools/arduino-compile-server
node server.mjs           # or: npm start
# → NozePlot Arduino compile server → http://localhost:8787
```

Optional env vars: `PORT` (default 8787), `ARDUINO_CLI` (path to the binary).

## 4. Point the app at it

In **MCU Flash → Settings**, set **Remote compile server URL** to:

```
http://localhost:8787
```

Chrome/Edge allow requests from the (https) GitHub Pages app to
`http://localhost`, so no tunnel is needed for local use. If you host the server
remotely, serve it over **https** and the same-origin/CORS headers will apply
(this server already sends permissive CORS headers).

Now **Verify** compiles, and **Flash** compiles-then-flashes. Libraries added in
the app's **Libraries** panel are installed with `arduino-cli lib install`
before each build.

## Contract

```
POST /compile
  request:  { fqbn, sketch, files?: { [name]: string }, libraries?: string[] }
  response: { ok, stdout, stderr,
              hex?:   base64 Intel HEX            // AVR
              parts?: [{ address, data:base64 }]  // ESP (merged.bin @0x0, or boot/part/app) }
```
