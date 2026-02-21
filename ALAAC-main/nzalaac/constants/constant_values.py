def CHR_ELEMENTS():
    """Return CHR elements column names."""
    return [f"CHR{i}" for i in range(32)]


def BME_ELEMENTS():
    """Return BME elements column names."""
    return ["H0", "H1", "GAS0", "GASR0", "T0", "T1", "P0"]


def DEFAULT_EVENT_COLUMN():
    """Return default event column name."""
    return "event_name"


def DEFAULT_TIMESTAMP_COLUMN_NAME():
    """Return default timestamp column name."""
    return "timestamp"


def DEFAULT_TIMESTAMP_COLUMNS():
    """Return default timestamp columns to check."""
    return ["timestamp", "payloadCreateAt", "ts", "TimeStamp", "Timestamp"]


def DEFAULT_DEVICE_ID_COLUMNS():
    """Return default device id column name."""
    return ["component_sn", "device_id", "sensor_module_id"]


def default_dataset_options():
    """
    Get default dataset_options values.

    Returns
    -------
    default_options: dict
    """
    return {
        "paths": {
            "raw_data": "./data/",
            "output_plots": "./outputs/plots/",
            "output_files": "./output/files/",
        },
        "sampling_rates": {"default": 1.0},
        "device_id_columns": DEFAULT_DEVICE_ID_COLUMNS(),
    }
