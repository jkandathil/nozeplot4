"""Public methods here should return tuple [df, details_about_normalization]"""

from math import ceil
from typing import Tuple

import numpy as np

from nzalaac.constants.constant_values import DEFAULT_EVENT_COLUMN
from nzalaac.utils.data_preperation.general_utils import get_event_rows
from nzalaac.utils.logger import ALAACLogger

logger = ALAACLogger(__name__)

def baseline(
        sensor_values,
        reference_event_flag="RFC",
        reference_event=None,
        start_end_portion: Tuple[float, float] = None,
        **kwargs,
):
    """
    Baseline normalize columns.

    Parameters
    ----------
    sensor_values: array of column value
    reference_event_flag: flag within event name to specify it as a reference.
    reference_event: exact name of event for baseline.
    start_end_portion: start and ending portions of event to use, optional
    kwargs: contains "original_data" with event_col and event_column_name

    Returns
    -------

    """

    original_data = kwargs.get("original_data")

    event_col_name = kwargs.get("event_column_name", DEFAULT_EVENT_COLUMN())
    event_col = original_data[event_col_name].astype(str)

    if reference_event is None:
        flag = reference_event_flag or "RFC"
        matches = event_col.str.contains(flag, na=False)

        if not matches.any() and flag != "RFC":
            matches = event_col.str.contains("RFC", na=False)
        if not matches.any():
            raise ValueError(
                f"No event contains reference_event_flag='{reference_event_flag}' "
                f"in file {original_data['filename'].iloc[0]}"
            )
        reference_event = event_col[matches].iloc[0]

    if reference_event not in event_col.values:
        raise ValueError(f"Reference Event {reference_event} is not in dataframe! {original_data.filename.loc[0]}")

    event_df = get_event_rows(original_data, reference_event, **kwargs)

    if start_end_portion is None:
        # unless specified, default to last 3 seconds
        if event_df.empty:
            raise ValueError(
                f"No rows matching event '{reference_event}' in dataframe {original_data['filename'].iloc[0]}"
            )
        baseline_end = event_df.index[-1]
        end_event_time = event_df["delta_seconds"].iloc[-1]
        start_event_time = event_df["delta_seconds"].iloc[0]
        total_time = end_event_time - start_event_time
        if total_time < 3.0:
            start_end_portion = [0.9, 1.0]
            logger.warning(
                f"Warning: event {reference_event} in file {original_data['filename'].loc[0]} shorter than 3.0 seconds, defaulting to last 10%"
            )
        else:
            baseline_start = (
                (event_df["delta_seconds"] - (end_event_time - 3.0)).abs().idxmin()
            )

    # default to use last 10% of event.
    if start_end_portion is not None:
        start_percent = min(max(0.0, start_end_portion[0]), 1.0)
        end_percent = min(1.0, start_end_portion[1])
        baseline_start, baseline_end = (
            event_df.index[int(ceil(len(event_df) * start_percent))],
            event_df.index[int(ceil((len(event_df) - 1) * end_percent))],
        )
        if baseline_start > baseline_end:
            raise ValueError(
                f"Start index for norm should be before end index, got {baseline_start} {baseline_end}"
            )
    normalization_details = {"value": np.median(
        sensor_values[baseline_start:baseline_end], axis=0
    ), "reference_event_name": reference_event}
    return (
        sensor_values.apply(
            _baseline_normalize,
            axis=0,
            args=(
                baseline_end,
                baseline_start,
            ),
        ),
        normalization_details,
    )


def _baseline_normalize(data, end_index, start_index=0):
    """
    Apply normalization on column based on baseline period indices.

    Parameters
    ----------
    data
    end_index
    start_index

    Returns
    -------

    """
    return (data / np.median(data[start_index:end_index])).fillna(1.0) - 1.0
