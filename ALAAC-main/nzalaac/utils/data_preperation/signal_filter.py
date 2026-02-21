""" """

from typing import Sequence

import pandas as pd
from scipy.signal import butter, filtfilt, savgol_filter


def savitzky_golay(data: Sequence, window_length=50, polyorder=3, **kwargs):
    """
    Apply a Savitzky-Golay signal filter.

    Parameters
    ----------
    data
    """
    return savgol_filter(data, window_length, polyorder, axis=0)


def lowpass(
    data: Sequence,
    sampling_rate: float,
    cut_off_hz: float = 0.4,
    order: int = 5,
    **kwargs,
):
    """
    Lowpass signal filter.

    Parameters
    ----------
    data
    sampling_rate
    cut_off_hz
    order
    kwargs

    Returns
    -------

    """
    b, a = butter(order, cut_off_hz, btype="low", analog=False, fs=sampling_rate)
    return filtfilt(b, a, data, axis=0)


def rolling_median(data: pd.DataFrame, window_size=3, **kwargs):
    """
    Rolling median filter

    Parameters
    ----------
    data
    window_size
    kwargs

    Returns
    -------

    """
    return data.rolling(window=window_size, center=True, min_periods=1).median()


def rolling_mean(data: pd.DataFrame, window_size=3, **kwargs):
    """
    Rolling mean filter

    Parameters
    ----------
    data
    window_size
    kwargs

    Returns
    -------

    """
    return data.rolling(window=window_size, center=True, min_periods=1).mean()
