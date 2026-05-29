/**
 * Board catalog for the Arduino & ESP32 programmer.
 *
 * `protocol`:
 *   - 'stk500v1'  → AVR optiboot/Arduino bootloader (Uno, Nano, Pro Mini, Duemilanove)
 *   - 'esptool'   → Espressif ROM/stub loader (ESP32 family, ESP8266) via esptool-js
 *   - 'unsupported' → editor + AI + serial work, but in-browser flashing is not implemented yet
 *
 * `fqbn` is passed to a remote arduino-cli compile server (see compileClient.js).
 * AVR specifics (`pageSize`, `flashSize`, `signature`) drive the STK500 page programming.
 * ESP specifics (`flashBaud`, `appOffset`) drive esptool-js.
 */

export const BOARDS = [
    // ── AVR (STK500v1) ────────────────────────────────────────────────
    {
        id: 'uno',
        name: 'Arduino Uno',
        arch: 'avr',
        mcu: 'ATmega328P',
        protocol: 'stk500v1',
        fqbn: 'arduino:avr:uno',
        uploadBaud: 115200,
        pageSize: 128,
        flashSize: 32768,
        signature: [0x1e, 0x95, 0x0f],
    },
    {
        id: 'nano',
        name: 'Arduino Nano (new bootloader)',
        arch: 'avr',
        mcu: 'ATmega328P',
        protocol: 'stk500v1',
        fqbn: 'arduino:avr:nano:cpu=atmega328',
        uploadBaud: 115200,
        pageSize: 128,
        flashSize: 32768,
        signature: [0x1e, 0x95, 0x0f],
    },
    {
        id: 'nano-old',
        name: 'Arduino Nano (old bootloader)',
        arch: 'avr',
        mcu: 'ATmega328P',
        protocol: 'stk500v1',
        fqbn: 'arduino:avr:nano:cpu=atmega328old',
        uploadBaud: 57600,
        pageSize: 128,
        flashSize: 32768,
        signature: [0x1e, 0x95, 0x0f],
    },
    {
        id: 'pro-mini-16',
        name: 'Arduino Pro Mini (5V/16MHz, 328P)',
        arch: 'avr',
        mcu: 'ATmega328P',
        protocol: 'stk500v1',
        fqbn: 'arduino:avr:pro:cpu=16MHzatmega328',
        uploadBaud: 57600,
        pageSize: 128,
        flashSize: 32768,
        signature: [0x1e, 0x95, 0x0f],
    },
    {
        id: 'duemilanove',
        name: 'Arduino Duemilanove (328P)',
        arch: 'avr',
        mcu: 'ATmega328P',
        protocol: 'stk500v1',
        fqbn: 'arduino:avr:diecimila:cpu=atmega328',
        uploadBaud: 57600,
        pageSize: 128,
        flashSize: 32768,
        signature: [0x1e, 0x95, 0x0f],
    },

    // ── AVR boards needing other protocols (flash not yet in-browser) ──
    {
        id: 'mega2560',
        name: 'Arduino Mega 2560',
        arch: 'avr',
        mcu: 'ATmega2560',
        protocol: 'unsupported',
        unsupportedReason: 'Mega 2560 uses STK500v2; in-browser flashing is not implemented yet (compile + serial still work).',
        fqbn: 'arduino:avr:mega:cpu=atmega2560',
        uploadBaud: 115200,
    },
    {
        id: 'leonardo',
        name: 'Arduino Leonardo / Micro',
        arch: 'avr',
        mcu: 'ATmega32U4',
        protocol: 'unsupported',
        unsupportedReason: 'Leonardo/Micro use the Caterina (AVR109) bootloader with a 1200-baud reset; not implemented yet.',
        fqbn: 'arduino:avr:leonardo',
        uploadBaud: 57600,
    },

    // ── ESP32 family (esptool-js) ─────────────────────────────────────
    {
        id: 'esp32',
        name: 'ESP32 Dev Module',
        arch: 'esp32',
        mcu: 'ESP32',
        protocol: 'esptool',
        fqbn: 'esp32:esp32:esp32',
        flashBaud: 460800,
        appOffset: 0x10000,
    },
    {
        id: 'esp32s2',
        name: 'ESP32-S2',
        arch: 'esp32',
        mcu: 'ESP32-S2',
        protocol: 'esptool',
        fqbn: 'esp32:esp32:esp32s2',
        flashBaud: 460800,
        appOffset: 0x10000,
    },
    {
        id: 'esp32s3',
        name: 'ESP32-S3',
        arch: 'esp32',
        mcu: 'ESP32-S3',
        protocol: 'esptool',
        fqbn: 'esp32:esp32:esp32s3',
        flashBaud: 460800,
        appOffset: 0x10000,
    },
    {
        id: 'esp32c3',
        name: 'ESP32-C3',
        arch: 'esp32',
        mcu: 'ESP32-C3',
        protocol: 'esptool',
        fqbn: 'esp32:esp32:esp32c3',
        flashBaud: 460800,
        appOffset: 0x10000,
    },
    {
        id: 'esp32c6',
        name: 'ESP32-C6',
        arch: 'esp32',
        mcu: 'ESP32-C6',
        protocol: 'esptool',
        fqbn: 'esp32:esp32:esp32c6',
        flashBaud: 460800,
        appOffset: 0x10000,
    },
    {
        id: 'esp8266',
        name: 'ESP8266 (NodeMCU / Wemos D1)',
        arch: 'esp8266',
        mcu: 'ESP8266',
        protocol: 'esptool',
        fqbn: 'esp8266:esp8266:nodemcuv2',
        flashBaud: 460800,
        appOffset: 0x0,
    },
];

export const DEFAULT_BOARD_ID = 'esp32';

export function getBoardById(id) {
    return BOARDS.find((b) => b.id === id) || null;
}

/** Vendor IDs commonly seen on Arduino/ESP USB-serial bridges (for nicer port labels). */
export const KNOWN_USB_VENDORS = {
    0x2341: 'Arduino',
    0x2a03: 'Arduino (org)',
    0x1a86: 'CH340 (WCH)',
    0x10c4: 'CP210x (Silicon Labs)',
    0x0403: 'FTDI',
    0x303a: 'Espressif',
    0x239a: 'Adafruit',
};
