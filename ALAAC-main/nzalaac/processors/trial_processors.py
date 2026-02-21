import os

import numpy as np
import pandas as pd

import nzalaac.utils.data_preperation.normalization as normalization_methods
import nzalaac.utils.data_preperation.signal_filter as signal_filter
from nzalaac.utils.data_preperation.general_utils import get_device_id
from nzalaac.utils.data_preperation.ingestion import get_sensing_element_names
from nzalaac.utils.logger import ALAACLogger

logger = ALAACLogger(__name__)

async def filter_signal(data, method, sensing_elements=None, **kwargs):
    """
    Filter signal columns within dataframe

    Parameters
    ----------
    data: pd.DataFrame
        The dataframe of csv file of trial.
    method: str
        lowpass, rolling_median, rolling_mean
    sensing_elements: dict or list of strings
        extracts from config
    kwargs

    Returns
    -------
    output_dict: dict
        contains "data" df
    """
    columns_to_use = get_sensing_element_names(sensing_elements)
    columns_to_use = [
        col
        for col in data.columns
        if any(col.startswith(sensing_element) for sensing_element in columns_to_use)
    ]
    if len(columns_to_use) == 0:
        return {"data": data}
    try:
        device_id = get_device_id(data, **kwargs)
        sampling_rates = kwargs.get("sampling_rates", {})
        sampling_rate = sampling_rates.get(
            device_id, sampling_rates.get("default", 1.0)
        )
        data[columns_to_use] = getattr(signal_filter, method)(
            data[columns_to_use], sampling_rate=sampling_rate, **kwargs
        )
    except AttributeError:
        raise ValueError(f"Filtering method {method} not defined")

    return {"data": data}


async def normalize_signals(
        data, method, sensing_elements=None, save_output=True, **kwargs
):
    """
    Filter signal columns within dataframe

    Parameters
    ----------
    data: pd.DataFrame
        The dataframe of csv file of trial.
    method: str
        'baseline', for now.
    sensing_elements: dict or list of strings
        extracts from config
    save_output: bool
        save output csv.

    Returns
    -------
    output_dict: dict
        contains "data" df

    Returns
    -------

    """
    columns_to_use = get_sensing_element_names(sensing_elements)
    columns_to_use = [
        col
        for col in data.columns
        if any(col.startswith(sensing_element) for sensing_element in columns_to_use)
    ]
    if len(columns_to_use) == 0:
        return {"data": data}

    new_columns = [f"normalized_{col}" for col in columns_to_use]

    try:
        new_data, normalization_details = getattr(normalization_methods, method)(
            data[columns_to_use], **kwargs
        )
        if isinstance(new_data, (pd.DataFrame, pd.Series)):
            new_data = new_data.to_numpy()

        data = pd.concat([data, pd.DataFrame(new_data, columns=new_columns)], axis=1)
        for i, col in enumerate(new_columns):
            data[f"normalization_details_{col}"] = int(
                np.round(normalization_details['value'][i])
            )
        data["reference_event_name"] = normalization_details['reference_event_name']
        if save_output:
            data[new_columns].to_csv(
                os.path.join(
                    kwargs["paths"]["output_files"],
                    f"normalized_{data.filename.loc[0]}",
                ),
                index=False
            )

    except AttributeError as e:
        raise ValueError(f"Normalization method {method} not defined", e)

    return {"data": data}


async def rename_columns(data, rename_map, **kwargs):
    """
    Rename columns in dataframe

    Parameters
    ----------
    data: pd.DataFrame
    rename_map: dict
        contains key/value pairs of old_name/new_name
    kwargs

    Returns
    -------
    output_dict: dict
        contains 'data'
    """
    data = data.rename(rename_map, axis=1)
    return {"data": data}


async def set_column_datatypes(data, datatype_map, **kwargs):
    """
    Set Dataframe column datatypes.

    Parameters
    ----------
    data: pd.DataFrame
    datatype_map: dict
        key/value pairs of column_name/datatype
    kwargs
    Returns
    -------
    output_dict: dict
        contains 'data'
    """
    for name, column_type in datatype_map.items():
        data[name] = data[name].astype(column_type)
    return {"data": data}


async def filter_trials(data, column=None, value=None, remove_nan=False, **kwargs):
    """
    return trial if it matches value/range

    Parameters
    ----------
    data: pd.DataFrame
    column: str
        column name to use for filtering
    value: Any
        Value used when filtering
    remove_nan:
        omitt nan trials
    kwargs

    Returns
    -------
    output_dict: dict
        contains 'data'
    """
    if column is not None and value is not None:
        if data[column].loc[0] != value:
            raise ValueError
    if remove_nan:
        if column:
            if data[column].isna().any():
                raise ValueError
        else:
            if data.isna().any().any():
                raise ValueError
    return {"data": data}


# def interpolate_missing_values():

async def compute_absolute_humidity(data, temperature_col_codes=None, humidity_col_codes=None, **kwargs):
    """
    A function to compute absolute humidity based on relative humidity and pair temperature sensor
    This function is based on Magnus Formula for Absolute Humidity

    Matching logic:
        - Find all temperature columns whose name starts or ends with T_code
        - Replace that T_code with H_code to derive the matching humidity column
        - Compute absolute humidity and create new columns: "abs-<humidity_col>"

    Returns:
        {"data": data}
        (even if nothing is computed)
    """
    SATURATION_VAPOR_PRESSURE_0C = 6.112  # hPa, saturation vapor pressure at 0°C
    MAGNUS_COEFFICIENT_A = 17.67  # Empirical coefficient for Magnus equation
    MAGNUS_COEFFICIENT_B = 243.5  # Empirical coefficient for Magnus equation (°C)
    GAS_CONSTANT_RATIO = 2.1674  # Derived from the ideal gas law
    KELVIN_OFFSET = 273.15  # Convert Celsius to Kelvin

    if not temperature_col_codes or not humidity_col_codes:
        logger.info(
            "[NOTE:] temperature or humidity column codes is missing in config. Skipping absolute humidity calculation.")
        return {"data": data}

    if len(temperature_col_codes) != len(humidity_col_codes):
        logger.warning("Temperature/Humidity code list lengths do not match. "
              "Skipping absolute humidity calculation.")
        return {"data": data}

    for T_code, H_code in zip(temperature_col_codes, humidity_col_codes):
        temp_columns = [col for col in data.columns if col.startswith(T_code) or col.endswith(T_code)]

        if not temp_columns:
            logger.info(f"[NOTE:] No temperature columns found for '{T_code}'. Skipping absolute humidity calculation.")
            continue

        humidity_columns = [col.replace(T_code, H_code) for col in temp_columns]
        abs_humidity_columns = ["abs-" + col for col in humidity_columns]

        for T_col, H_col, abs_H_col in zip(temp_columns, humidity_columns, abs_humidity_columns):
            if H_col not in data.columns:
                logger.info(f"[NOTE:] Missing humidity column '{H_col}'. Skipping its pair.")
                continue

            data[abs_H_col] = (
                    (SATURATION_VAPOR_PRESSURE_0C * np.exp((MAGNUS_COEFFICIENT_A * data[T_col]) /
                                                           (data[T_col] + MAGNUS_COEFFICIENT_B)) * data[
                         H_col] * GAS_CONSTANT_RATIO) /
                    (data[T_col] + KELVIN_OFFSET)
            )

    return {"data": data}
