# Telemetry Commands

## Single Telemetry Reading
- Get all ADC voltage values:
    ```sh
    rpc send "{\"method\":\"TELEMETRY\"}"
    ```

## Periodic Telemetry Reading
- Start periodic telemetry: choose a period value 
- Example: period of 10 will get the telemetry every 10ms
    ```sh
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":10}}"
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":50}}"
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":250}}"
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":1000}}"
    ```

- For the AFE Viz Tool, use this:
    ```sh
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":10,\"includeRawValues\":1,\"outputFormat\":2}}"
    ```

- Additional Options
  - `includeRawValues`: (0, 1) ONLY include RCH, RRF and REF raw ADC values for post processing. Does not include calculated values
  - `outputFormat`: (0: JSON (default), 1: CBOR (over SPI only), 2: CBOR (over USB/Shell), 3: CBOR (over UART))

    ```sh
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":10,\"includeRawValues\":1}}"
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":10,\"includeRawValues\":1,\"outputFormat\":1}}"
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":10,\"outputFormat\":0}}"
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":10,\"outputFormat\":3}}"
    ```
    **CBOR base 64 encoded equivalent to period 10 outputFormat 3 command**
    ```sh
    omZtZXRob2RpVEVMRU1FVFJZZnBhcmFtc6JmcGVyaW9kCmxvdXRwdXRGb3JtYXQD
    ```

- Stop periodic telemetry:
    ```sh
    rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":0}}"
    ```
    **CBOR base 64 encoded**
    ```sh
    omZtZXRob2RpVEVMRU1FVFJZZnBhcmFtc6FmcGVyaW9kAA==
    ```

## Notes
- **Output Format**:
    ```sh
    {\"timestamp\":12345,\"ch0\":123.456789,\"ch1\":456.123456,...,\"ch15\":789.654321}
    ```
- **Period Range**: 10-1000 ms, or 0 to stop.

## Telemetry Keys
- Note: keys with * are unique to telemetry rpc calls, but others can also be received separately with module-specific RPC calls:
    - [pump (PZT)](PiezoPump.md#Telemetry-Keys), 
    - [system sentinel (SYS)](SystemSentinel.md#Telemetry-Keys), 
    - [pressure sensor (DPP)](DifferentialPressure.md#Telemetry-Keys), 
    - [temperature and humidity sensor (TRHT)](TemperatureHumidity.md#Telemetry-Keys), 
    - [Air Quality (AQ)](AirQuality.md#Telemetry-Keys)

| Key           | Description                                  |
|---------------|----------------------------------------------|
|* `sn`         | serial number                                |
|* `version`    | payload version                              |
|* `frequency`  | measured frequency of telemetry response     |
|* `A1` to `H8` | 64 resistance readings                       |
|* `ASELT`      | time since the command was sent (ms)         |
|* `BT1`        | Board temperature 1                          |
|* `BT2`        | Board temperature 2                          |
| `DPP0`        | Differential Pressure                        |
| `DPT0`        | Temperature                                  |
| `DPSN`        | Sensor Unique Serial Number (64-bit)         |
| `DPPID`       | Sensor Product ID                            |
| `PZTFR0`      | Target Flow Rate (CCM)                       |
| `PZCFR0`      | Current Flow Rate (CCM)                      |
| `PZEFR0`      | Estimated Flow Rate (CCM)                    |
| `PZVMV0`      | Measured Voltage (mV)                        |
| `PZCDV0`      | Current DAC Value                            |
| `PZEN0`       | Pump Enabled (`1` = true, `0` = false)       |
| `PZDM0`       | Direct DAC Mode (`1` = true, `0` = false)    |
| `PZCAL0`      | Calibration Valid (`1` = true, `0` = false)  |
| `AQT0`        | BME Temperature                              |
| `AQH0`        | BME Humidity                                 |
| `AQP0`        | BME Pressure                                 |
| `AQGR0`       | BME Gas Resistance                           |
| `AQAH0`       | Absolute Humidity                            |
| `AQBSTAT`     | BME Status                                   |
| `AQBTS`       | BME Timestamp                                |
| `AQBVAL`      | BME Valid                                    |
| `AQSENS`      | Sensor Name                                  |
| `AQSID`       | Sample ID                                    |
| `TRHT0`       | T/RH Sensor Temperature                      |
| `TRHH0`       | T/RH Relative Humidity                       |
| `TRHSN`       | Sensor Unique Serial Number                  |
| `SYSUT`       | System Uptime (ms)                           |
| `SYSHF`       | System Heap Free (bytes)                     |
| `SYSHA`       | System Heap Allocated (bytes)                |
| `SYSCL`       | System CPU Load (%)                          |
| `SYSRC`       | System Reset Cause (raw flags)               |


## Telemetry Example Output
```sh
{
        "code": 0,
        "message": "OK",
        "sn": "0000000009-4125-asu-nz",
        "method": "TELEMETRY",
        "format": "JSON",
        "version": 0,
        "frequency": 1001,
        "result": {
                "A1": 4073451264.000000,
                "A2": 7044422144.000000,
                "A3": 4358340096.000000,
                "A4": 4719925760.000000,
                "A5": 4500865536.000000,
                "A6": 6940639744.000000,
                "A7": 4484401152.000000,
                "A8": 4091523328.000000,
                "B1": 3541205504.000000,
                "B2": 7048803840.000000,
                "B3": 4358576128.000000,
                "B4": 4715421696.000000,
                "B5": 4192222720.000000,
                "B6": 6939432448.000000,
                "B7": 4475788800.000000,
                "B8": 4092371200.000000,
                "C1": 3388359680.000000,
                "C2": 7058199040.000000,
                "C3": 4356660736.000000,
                "C4": 4721881600.000000,
                "C5": 4225422592.000000,
                "C6": 6944275968.000000,
                "C7": 4386833920.000000,
                "C8": 4093419776.000000,
                "D1": 4086073344.000000,
                "D2": 7045031936.000000,
                "D3": 4358335488.000000,
                "D4": 4723840000.000000,
                "D5": 4317096448.000000,
                "D6": 6943047680.000000,
                "D7": 4387321856.000000,
                "D8": 4091937280.000000,
                "E1": 4205860096.000000,
                "E2": 7045048832.000000,
                "E3": 4356917248.000000,
                "E4": 4644483584.000000,
                "E5": 4285482752.000000,
                "E6": 6946737664.000000,
                "E7": 4385872384.000000,
                "E8": 4090249216.000000,
                "F1": 4303358464.000000,
                "F2": 7046922752.000000,
                "F3": 4358582272.000000,
                "F4": 4722714624.000000,
                "F5": 4304155136.000000,
                "F6": 6936986624.000000,
                "F7": 4387337728.000000,
                "F8": 4091947520.000000,
                "G1": 4181613824.000000,
                "G2": 7053799936.000000,
                "G3": 4356884992.000000,
                "G4": 4717932032.000000,
                "G5": 4366483968.000000,
                "G6": 6933904896.000000,
                "G7": 4475532288.000000,
                "G8": 4089611776.000000,
                "H1": 4308973568.000000,
                "H2": 7050665984.000000,
                "H3": 4358813184.000000,
                "H4": 4722422272.000000,
                "H5": 4302466560.000000,
                "H6": 6940585984.000000,
                "H7": 4383426048.000000,
                "H8": 4093189632.000000,
                "ASELT": 3248,
                "BT1": 28.249083,
                "BT2": 30.183149,
                "DPP0": -0.016667,
                "DPT0": 25.120001,
                "DPSN": 2523588433,
                "DPPID": 50462977,
                "PZTFR0": 0.000000,
                "PZCFR0": 0.000000,
                "PZEFR0": nan,
                "PZVMV0": 0.000000,
                "PZCDV0": 0,
                "PZEN0": 0,
                "PZDM0": 0,
                "PZCAL0": 1,
                "AQT0": 0.000000,
                "AQH0": 0.000000,
                "AQP0": 0.000000,
                "AQGR0": 0.000000,
                "AQAH0": 0.000000,
                "AQBSTAT": 0,
                "AQBTS": 0,
                "AQBVAL": false,
                "AQSENS": "UNKNOWN",
                "AQSID": 0,
                "TRHT0": 23.678188,
                "TRHH0": 28.657053,
                "TRHSN": 220234913,
                "SYSUT": 66359188,
                "SYSHF": 16300,
                "SYSHA": 0,
                "SYSCL": 3.979385,
                "SYSRC": 13
        }
}
```