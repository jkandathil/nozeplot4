/**
 * Heuristic checks for obvious board/sketch mismatches before compile.
 */

const ESP_HINTS = [
    { re: /\besp_random\s*\(/, label: 'esp_random()' },
    { re: /\bESP32\b/, label: 'ESP32' },
    { re: /#\s*include\s*[<"]WiFi/i, label: 'WiFi library' },
    { re: /#\s*include\s*[<"]Bluetooth/i, label: 'Bluetooth library' },
    { re: /\bledcWrite\s*\(/, label: 'ledcWrite()' },
    { re: /\btouchRead\s*\(/, label: 'touchRead()' },
    { re: /\bGPIO_NUM_/, label: 'GPIO_NUM_*' },
];

const AVR_HINTS = [
    { re: /\bPROGMEM\b/, label: 'PROGMEM' },
    { re: /#\s*include\s*[<"]avr\//i, label: 'avr/* headers' },
];

export function findEspOnlyFeatures(source) {
    const text = String(source || '');
    return ESP_HINTS.filter(({ re }) => re.test(text)).map(({ label }) => label);
}

export function findAvrOnlyFeatures(source) {
    const text = String(source || '');
    return AVR_HINTS.filter(({ re }) => re.test(text)).map(({ label }) => label);
}

/** @returns {string|null} User-facing warning, or null if OK to compile. */
export function boardSketchMismatchWarning(sketchSource, board) {
    if (!board || !sketchSource) return null;
    const arch = board.arch;

    if (arch === 'avr') {
        const esp = findEspOnlyFeatures(sketchSource);
        if (esp.length) {
            return (
                `This sketch looks like ESP32 code (${esp.slice(0, 3).join(', ')}${esp.length > 3 ? ', …' : ''}) ` +
                `but the board is ${board.name}. Switch the board selector to an ESP32 board, or edit the sketch for AVR/Uno.`
            );
        }
    }

    if (arch === 'esp32' || arch === 'esp8266') {
        const avr = findAvrOnlyFeatures(sketchSource);
        if (avr.length) {
            return (
                `This sketch uses AVR-only features (${avr.join(', ')}) but the board is ${board.name}. ` +
                'Switch to an Arduino Uno/Nano board, or update the sketch for ESP32.'
            );
        }
    }

    return null;
}

/** Turn raw compiler stderr into a shorter hint when possible. */
export function explainCompileFailure(stderr, board) {
    const err = String(stderr || '');
    if (board?.arch === 'avr' && /\besp_random\b/.test(err)) {
        return 'esp_random() is ESP32-only. Select an ESP32 board in the toolbar, or replace it with random() for Arduino Uno.';
    }
    if (board?.arch === 'avr' && /\bWiFi\b/.test(err)) {
        return 'WiFi is not available on Arduino Uno. Select an ESP32 board or remove WiFi code.';
    }
    return null;
}
