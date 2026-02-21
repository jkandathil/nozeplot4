import ast
import os
import re
from datetime import datetime, timedelta

import matplotlib.colors as mcolors
import numpy as np
import pandas as pd
from dateutil import parser
from scipy.stats import linregress

from nzalaac.constants.constant_values import (
    DEFAULT_DEVICE_ID_COLUMNS,
    DEFAULT_EVENT_COLUMN,
    DEFAULT_TIMESTAMP_COLUMN_NAME,
    DEFAULT_TIMESTAMP_COLUMNS,
)
from nzalaac.utils.logger import ALAACLogger

logger = ALAACLogger(__name__)


def read_raw_data_df(data_source: str) -> pd.DataFrame:
    """
    Read raw datafile as csv.
    Parameters
    ----------
    data_source: path to file

    Returns
    -------
    dataframe: pd.DataFrame
    """
    filename_extension = os.path.basename(data_source)
    filename, extension = os.path.splitext(filename_extension)

    dataframe = pd.read_csv(data_source)
    dataframe["filename"] = filename
    return dataframe


def get_event_rows(dataframe, event_name, **kwargs):
    """
    Get rows matching certain event in dataframe.

    Parameters
    ----------
    dataframe: pd.DataFrame
    event_name: str
        Name of event to match.
    kwargs:
        event_col_name: name of column to look for events.

    Returns
    -------
    event_dataframe: pd.DataFrame
    """
    event_col = kwargs.get("event_column_name", DEFAULT_EVENT_COLUMN())
    return dataframe[dataframe[event_col] == event_name]


def extract_from_filename(
        filename, curated_filename=False, regex_pattern=None, pattern_flag=None, **kwargs
):
    """

    Parameters
    ----------
    filename
    curated_filename
    pattern_flag
    regex_pattern
    kwargs

    Returns
    -------

    """

    curated_order = {
        "device_id": 0,
        "annotation_id": 1,
        "time": -1,
        "analyte": [1, 0],
        "concentration": [1, 1],
        "flowrate": [1, 2],
        "humidity": [1, 3],
    }
    if curated_filename:
        order = curated_order.get(pattern_flag.lower())
        if order is None:
            raise ValueError(
                f"Expected one of: {','.join(list(curated_order.keys()))}, got {pattern_flag}"
            )
        if isinstance(order, list):
            return filename.split("_")[order[0]].split("-")[order[1]]
        return filename.split("_")[order]

    if regex_pattern is None:
        if pattern_flag == "device_id":
            regex_pattern = r"[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+-nz"
        elif pattern_flag == "concentration":
            regex_pattern = r"[0-9]+(?:\.[0-9]+)?ppb"
        else:
            raise ValueError(f"regex pattern not specified, given flag {pattern_flag}")

    filename_parts = filename.split("_")
    for part in filename_parts:
        search = re.search(re.compile(regex_pattern), part)
        if search:
            return search.group(0)
    raise ValueError(
        f"regex pattern {regex_pattern} not found in filename {filename} "
        + str(pattern_flag)
    )


def get_device_id(df, **kwargs):
    device_id_columns = kwargs.get("device_id_columns", DEFAULT_DEVICE_ID_COLUMNS())
    device_name = None
    for device_id_column in device_id_columns:
        try:
            device_name = df[device_id_column].iloc[0]
        except KeyError:
            continue
        if device_name is not None:
            break

    if device_name is None:
        try:
            device_name = extract_from_filename(
                df["filename"].loc[0], pattern_flag="device_id"
            )
        except ValueError as e:
            logger.error(
                f"Device_id not found in filename or columns in file {df['filename'].loc[0]}. {e}"
            )
            return None
    df.loc[:, "device_id"] = device_name
    return device_name


def get_concentration(df, **kwargs):
    """

    Parameters
    ----------
    df
    kwargs

    Returns
    -------

    """
    try:
        concentration = extract_from_filename(
            df["filename"].loc[0], pattern_flag="concentration"
        )
    except ValueError as e:
        logger.error(
            f"concentration not found in filename or columns in file {df['filename'].loc[0]}. {e}"
        )
        return "unknown concentration"
    df.loc[:, "concentration_value"] = concentration
    return concentration


def add_delta_seconds(dataframe, timestamp_column_names=None):
    if timestamp_column_names is None:
        timestamp_column_names = DEFAULT_TIMESTAMP_COLUMNS()
    elif type(timestamp_column_names) is not list:
        timestamp_column_names = [timestamp_column_names]

    for col_name in timestamp_column_names:
        if col_name in dataframe.columns:
            try:
                dataframe[DEFAULT_TIMESTAMP_COLUMN_NAME()] = dataframe[col_name].apply(
                    check_and_convert_timestamp_format
                )
                break
            except:
                continue
    if DEFAULT_TIMESTAMP_COLUMN_NAME() not in dataframe.columns:
        raise ValueError(
            f"Cannot find correct 'timestamp' column in {dataframe.filename.loc[0]}, columns tried: {timestamp_column_names}")
    if "delta_seconds" in dataframe.columns:
        return dataframe
    try:
        timestamps = dataframe[DEFAULT_TIMESTAMP_COLUMN_NAME()]
        dataframe["delta_seconds"] = (timestamps - timestamps.iloc[0]).dt.total_seconds()
    except Exception as e:
        raise ValueError(
            f"Something went wrong with adding delta_seconds in file {dataframe.filename.loc[0]}", e
        )
    return dataframe


def check_and_convert_timestamp_format(timestamp: str) -> datetime:
    """
    Function to verify an iso format datetime string in GMT includes MicroSeconds.

    If not, the method adds 1ms to the timestamp to ensure consistency.
    Note:
    An important assumptions of the method is that 1ms changes
    in timestamps would not affect the dynamics of our assessing timeseries

    Parameters
    ----------
    timestamp : str
        string of timestamp iso format in GMT with a ISO format
        of '%Y-%m-%d %H:%M:%S.%f%z' or '%Y-%m-%d %H:%M:%S%z'

    Returns
    -------
    timestamp : str
        string after ensuring format.

    Raises
    ------
    ValueError:
        if datetime is NaN
    """
    if timestamp is not pd.NaT:
        # Check if the timestamp string contains microseconds or not
        if "." in timestamp:
            return parser.parse(timestamp)
        else:
            return parser.parse(timestamp) + timedelta(microseconds=1000)
    else:
        raise ValueError("Datetime in this trial is NaN")

def _value(flag: str) -> float:
    """
    Extract numeric value from group flag like '1ppb', '10ppb', '2ppm'
    """
    if not flag:
        return float("inf")

    match = re.search(r"([\d.]+)", flag)
    if match:
        return float(match.group(1))

    return float("inf")

def determine_time_column(batched_data, kwargs):
    """
    Determine timestamp column name base on availability in data
    Returns None if batched_data is empty or contains no DataFrames.

    """
    if not isinstance(batched_data, dict) or not batched_data:
        logger.warning("[NOTE] batched_data is empty; cannot determine time column.")
        return None

    sample_df = None
    for dfs in batched_data.values():
        if isinstance(dfs, list) and len(dfs) > 0:
            sample_df = dfs[0]
            break

    if sample_df is None:
        logger.warning("[NOTE] batched_data contains no trials (empty lists); cannot determine time column.")
        return None

    config_time_col = kwargs.get("timestamp_column_name")
    if config_time_col and config_time_col in sample_df.columns:
        return config_time_col

    default_col = "timestamp"
    if default_col in sample_df.columns:
        return default_col

    logger.warning(
        "[NOTE] No match timestamp column found. "
        "Checked on timestamp_column_name in the config"
    )
    return None

def subplots_width_height(num_cols):
    """
    Return recommended subplot width and height based on the number of columns.
    Parameters
    ----------
    num_cols : int
        Number of subplot columns in the figure.

    Returns
    -------
    tuple[int, int]
        (subplot_width, subplot_height) in pixels, intended to be multiplied
        by the total number of columns and rows respectively when setting the
        overall figure size.
    """
    if num_cols <= 2:
        return 930, 870
    elif num_cols == 3:
        return 630, 580
    elif num_cols == 4:
        return 470, 420
    elif num_cols == 5:
        return 370, 320
    else:
        return 320, 270

def _convert(text):
    return int(text) if str(text).isdigit() else str(text).lower()

def _alphanum_key(key):
    return [_convert(c) for c in re.split(r"([0-9]+)", str(key))]

def _to_hex_color(c):
    # average plot passes Tableau keys by default: "tab:blue", etc.
    if isinstance(c, str) and c in mcolors.TABLEAU_COLORS:
        c = mcolors.TABLEAU_COLORS[c]
    return mcolors.to_hex(c)

def _extract_trialnum(df) -> int | None:
    """Return trialnum from df['reference_details'][0] if present, else None."""

    if "reference_details" not in df.columns:
        return None
    reference_details = df["reference_details"].iloc[0]

    if pd.isna(reference_details):
        return None

    if isinstance(reference_details, dict):
        reference_details = reference_details
    else:
        try:
            reference_details = ast.literal_eval(str(reference_details))
        except (ValueError, SyntaxError):
            return None

    trial_details = reference_details.get("Trial_Details")
    if not isinstance(trial_details, dict):
        return None

    return trial_details.get("trialnum")

_UUID_RE = re.compile(
    r"(?:^|_)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:_|$)"
)

def _extract_annotation_id_from_filename(name: str) -> str:
    if not name:
        return ""
    m = _UUID_RE.search(str(name))
    return m.group(1) if m else ""

def assign_trial_num(trials, time_column, trial_num_column="trial_num"):
    """
    Assigns trial number to each DataFrame in trials.
    Uses extracted trial numbers if available; otherwise, sorts by time.
    """
    trialnums = [_extract_trialnum(df) for df in trials]

    if all(t is not None for t in trialnums):
        for df, tnum in zip(trials, trialnums):
            df[trial_num_column] = int(tnum)
    else:
        # Sort trials based on earliest timestamp and assign trial_num
        df_times = [(df, pd.to_datetime(df[time_column], format="mixed", errors="coerce").min())
            for df in trials]

        df_times_sorted = sorted(df_times, key=lambda x: x[1])
        for trial_num, (df, _) in enumerate(df_times_sorted, start=1):
            df[trial_num_column] = trial_num

def filter_events(df, event_column_name, events_of_interest):
    """
    Filter a DataFrame to include only rows corresponding to specified events.
    """
    if events_of_interest:
        df = df[df[event_column_name].isin(events_of_interest)]
    return df

def calculate_slope(x, y):
    return linregress(x, y).slope

def calculate_auc(df, x_col, y_col):
    return np.trapz(df[y_col], df[x_col])

def iqr(x):
    return x.quantile(0.75) - x.quantile(0.25)

def calculate_peak2peak(col):
    return col.max() - col.min()

def calculate_metric(df, metric, x_col="delta_seconds"):
    """
    Calculate a single metric for each column in df except x_col.

    Supported metrics:
    {"max", "min", "mean", "std", "median", "iqr",
     "slope", "auc", "peak2peak", "magnitude"}
    """
    results = {}

    metric_funcs = {
        "max": lambda s, df: s.max(),
        "magnitude": lambda s, df: s.max(),
        "min": lambda s, df: s.min(),
        "mean": lambda s, df: s.mean(),
        "std": lambda s, df: s.std(),
        "median": lambda s, df: s.median(),
        "iqr": lambda s, df: iqr(s),
        "peak2peak": lambda s, df: calculate_peak2peak(s),
        "slope": lambda s, df: calculate_slope(df[x_col], s),
        "auc": lambda s, df: calculate_auc(df, x_col, s.name),
    }

    rounding = {
        "max": 2, "magnitude": 2, "min": 2, "mean": 2,
        "std": 2, "median": 2, "iqr": 2, "peak2peak": 2,
        "slope": 3, "auc": 0,
    }

    if metric not in metric_funcs:
        raise ValueError(f"Unsupported metric: {metric}")

    for col in df.columns:
        if col == x_col:
            continue

        value = metric_funcs[metric](df[col], df)
        results[f"{col}-{metric}"] = round(value, rounding[metric])

    return results

def calculate_metrics_for_single_trial(df, csv_columns, metrics_windows, x_col="delta_seconds"):
    """
    Calculate multiple metrics for selected columns of a single trial over specified windows.
    """
    row_data = {}
    for metric, window in metrics_windows.items():
        start_idx, end_idx = int(window[0] * len(df)), int(window[1] * len(df))
        filtered_df = df.iloc[start_idx:end_idx][csv_columns + [x_col]]
        if not filtered_df.empty:
            row_data.update(calculate_metric(filtered_df, metric, x_col))
    return row_data
def apply_skipped_events(df, skipped_events, event_column_name, trial_column, time_col="delta_seconds"):
    """
    Remove or trim events based on skipped_events configuration.

    Parameters
    ----------
    df : pd.DataFrame
        Combined DataFrame containing all trials.
    skipped_events : dict
        Dictionary mapping event names to either:
          - "skip" → remove entire event
          - {"start": s, "end": e} → trim s seconds from start, e seconds from end
    event_column_name : str
        Column containing event names.
    trial_column : str
        Column identifying trials.
    time_col : str, optional
        Time column in seconds. Default is "delta_seconds".

    Returns
    -------
    pd.DataFrame
        Filtered DataFrame.
    """
    df = df.copy()
    event_column = df[event_column_name].astype(str).str.strip()
    for event, rule in skipped_events.items():
        mask = event_column == event

        if rule == "skip":
            df = df[~mask]
            continue

        # Trim per trial
        if isinstance(rule, dict):
            for trial, group in df[mask].groupby(trial_column):
                start_time = group[time_col].min()
                end_time = group[time_col].max()

                lower_bound = start_time + rule.get("start", 0)
                upper_bound = end_time - rule.get("end", 0)

                drop_mask = (
                    (df[trial_column] == trial)
                    & (event_column == event)
                    & ((df[time_col] < lower_bound) | (df[time_col] > upper_bound))
                )
                df = df[~drop_mask]

    return df.reset_index(drop=True)
