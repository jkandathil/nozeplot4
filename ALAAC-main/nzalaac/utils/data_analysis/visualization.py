import itertools
import os
import re
from collections import defaultdict
from datetime import datetime
from math import ceil

import matplotlib
import matplotlib.colors as mcolors
import numpy as np
from dateutil import parser
from matplotlib import pyplot as plt
from plotly.subplots import make_subplots

from nzalaac.constants.constant_values import DEFAULT_TIMESTAMP_COLUMN_NAME
from nzalaac.utils.logger import ALAACLogger

matplotlib.use("Agg")

logger = ALAACLogger(__name__)

from nzalaac.utils.data_analysis.plot import (
    _plot_with_mpl,
    _plot_with_plotly,
    _save_with_mpl,
    _save_with_plotly,
    get_signal_mean_and_event_indices,
)


def monotonic_average_plot(
        list_df,
        sensing_elements,
        output_kwargs,
        group_names=None,
        save_csv=True,
        plot_kwargs=None,
        **kwargs,
):
    """
     Create monotonic average plot.

     Parameters
     ----------
     list_df: list
         The list of dataframes in batch.
     sensing_elements:
         Sensing elements to use for plot
     output_kwargs:
         kwargs related to final plot:
         n_cols, filename, plot_title
    group_names
     save_csv

     kwargs

     Returns
     -------
    """
    if plot_kwargs is None:
        plot_kwargs = {}
    plot_type = (
        "mpl" if kwargs.get("plot_type", "mpl").lower() != "plotly" else "plotly"
    )
    if group_names is None:
        group_names = list("")
    event_trim_config = kwargs.get("trim_events", {})

    if kwargs.get("skip_missing_events", False):
        filtered_list_df = []
        for group_df in list_df:
            filtered_group_df = []
            for df in group_df:
                skip = False
                unique_events = df[kwargs.get("event_column_name", "event_name")].unique()
                for event_name in event_trim_config.keys():
                    if event_name not in unique_events:
                        skip = True
                        logger.warning(f"skipped {df.filename.loc[0]}, missing event {event_name}")
                        break
                if not skip:
                    filtered_group_df.append(df)
            if len(filtered_group_df) != 0 :
                filtered_list_df.append(filtered_group_df)
        list_df = filtered_list_df

    available_cols = []
    start_date, end_date = __get_start_end_date(list_df, **kwargs)
    device_id = group_names[0].split("_")[0]

    y_ranges = defaultdict(lambda: [-np.inf, np.inf])

    color_list = kwargs.get("signal_colors", list(mcolors.TABLEAU_COLORS.keys()))
    vline_colors = kwargs.get("vline_colors", list(mcolors.TABLEAU_COLORS.keys()))

    for group_df in list_df:
        if not isinstance(group_df, list):
            group_df = [group_df]
        for df in group_df:
            for col_name in df.columns:
                if (
                        any(
                            col_name.startswith(sensing_element)
                            for sensing_element in sensing_elements
                        )
                        and not df[col_name].isna().all() and
                        col_name not in available_cols):
                    available_cols.append(col_name)

    convert = lambda text: int(text) if text.isdigit() else text.lower()
    alphanum_key = lambda key: [convert(c) for c in re.split("([0-9]+)", key)]

    try:
        available_cols = sorted(available_cols, key=alphanum_key)
    except:
        available_cols = sorted(
            available_cols,
            key=lambda x: (x.split("_")[0], x.split("_")[1]) if "_" in x else (x, "Z"),
        )

    plot_count = len(available_cols)
    if plot_count == 0:
        return None
    n_cols = output_kwargs.get("n_cols")
    if n_cols is None:
        if plot_count == 1:
            n_rows = n_cols = 1
        else:
            n_cols = int(ceil((plot_count / 15))) + 1
            n_rows = (plot_count // n_cols) + (plot_count % n_cols)
    else:
        n_rows = int(ceil(plot_count / n_cols))

    groups = [g.split("_")[-1] for g in group_names]
    indices = list(range(len(groups)))

    try:
        indices = sorted(indices, key=lambda x: alphanum_key(groups[x]))
    except:
        indices = sorted(indices, key=lambda x: groups[x])

    list_df = [list_df[x] for x in indices]
    groups = [groups[x] for x in indices]

    trial_count = [
        f"{groups[idx]}: {len(group_df)} trials "
        for idx, group_df in enumerate(list_df)
    ]

    if plot_type == "plotly":
        seen = set()
        color_list = [mcolors.to_hex(c) for c in color_list]
        vline_colors = [mcolors.to_hex(c) for c in vline_colors]
        fig = make_subplots(
            rows=n_rows,
            cols=n_cols,
            shared_xaxes=True,
            subplot_titles=[
                f"<b>{col.replace('normalized', ' ').replace('_', ' ').upper()}</b>"
                for col in available_cols
            ],
        )

        threads = []
        plot_setup = {
            "subplot_y": [],
            "vline_kwargs": {},
            "mad_median": {
                col_name: [] for col_name in available_cols if "normalized" in col_name
            },
        }

    else:
        plot_count = len(available_cols)
        if plot_count == 0:
            return None
        if plot_count == 1:
            n_rows = n_cols = 2
        else:
            n_cols = int(ceil((plot_count / 5))) + 1
            n_rows = (plot_count // n_cols) + (plot_count % 2) + 1

        fig, axes = plt.subplots(
            nrows=n_rows,
            ncols=n_cols,
            figsize=(25 * n_cols, n_rows * 30),
            dpi=55,
            layout="tight",
        )
        axes = np.ravel(axes, order="C")

    if len(list_df) <= 0:
        return None

    if len(color_list) < len(list_df):
        cycle = itertools.cycle(color_list)
        color_list = [next(cycle) for _ in range(len(list_df))]

    for idx_group, group_df in enumerate(list_df):
        signal_means, all_events = get_signal_mean_and_event_indices(
            group_df, available_cols, **kwargs
        )
        signal_means["unadjusted_delta_seconds"] = signal_means["delta_seconds"].copy()

        if save_csv:
            filename_flag = output_kwargs.get("filename", "")
            if filename_flag not in [None or ""]:
                filename_flag = output_kwargs.get("filename") + "_"

            signal_means.dropna(how="all", axis=1).to_csv(
                os.path.join(
                    kwargs["paths"]["output_files"],
                    filename_flag
                    + group_names[0].split("_")[0]
                    + "_"
                    + str(groups[idx_group] + ".csv"),
                ),
                index=None,
            )
        for event in all_events.columns:
            if event in event_trim_config:
                event_start = signal_means[f"median_time_{event}"].loc[0]
                event_end = list(all_events.columns).index(event) + 1
                event_end = (
                    signal_means["unadjusted_delta_seconds"].iloc[-1]
                    if event_end >= len(all_events.columns)
                    else signal_means[
                        f"median_time_{all_events.columns[event_end]}"
                    ].loc[0]
                )
                signal_means = trim_event(
                    signal_means,
                    event_start,
                    event_end,
                    **event_trim_config[event],
                    **event_trim_config,
                )

        if plot_type == "plotly":
            fig, threads, plot_setup = _plot_with_plotly(
                fig=fig,
                signal_means=signal_means,
                all_events=all_events,
                plot_setup=plot_setup,
                available_cols=available_cols,
                n_cols=n_cols,
                n_rows=n_rows,
                vline_colors=vline_colors,
                group_color=color_list[idx_group],
                group_name=groups[idx_group],
                groups_seen=seen,
                threads=threads,
                y_ranges=y_ranges,
                **kwargs,
            )

        else:
            fig = _plot_with_mpl(
                signal_means,
                all_events,
                fig,
                axes,
                available_cols,
                groups[idx_group],
                color_list[idx_group],
                vline_colors,
                plot_kwargs,
            )

    if plot_type == "plotly":
        _save_with_plotly(
            fig=fig,
            available_cols=available_cols,
            threads=threads,
            plot_setup=plot_setup,
            n_rows=n_rows,
            n_cols=n_cols,
            device_id=device_id,
            output_kwargs=output_kwargs,
            start_date=start_date,
            end_date=end_date,
            trial_count=trial_count,
            **kwargs,
        )
    else:
        _save_with_mpl(
            fig=fig,
            all_events=all_events,
            vline_color_list=vline_colors,
            device_id=device_id,
            output_kwargs=output_kwargs,
            start_date=start_date,
            end_date=end_date,
            trial_count=trial_count,
            **kwargs,
        )

    return None


def trim_event(
        df,
        event_start,
        event_end,
        start=None,
        end=None,
        all=False,
        reset_delta_seconds=False,
        **kwargs,
):
    excluded_indices = []
    delta_seconds = df["unadjusted_delta_seconds"]
    event_start_idx = (delta_seconds - event_start).abs().idxmin()
    if event_end == delta_seconds.iloc[-1]:
        event_end_idx = len(delta_seconds)
    else:
        event_end_idx = (delta_seconds - event_end).abs().idxmin()

    event_rows = df["unadjusted_delta_seconds"].iloc[event_start_idx:event_end_idx]
    if all:
        excluded_indices = list(event_rows.index)
    elif end is not None:
        trim_end = (event_rows - (event_rows.iloc[-1] - end)).abs().idxmin()
        if trim_end >= 0:
            excluded_indices += event_rows.loc[:trim_end].index.to_list()
    elif start is not None:
        trim_start = (event_rows - (event_rows.iloc[0] + start)).abs().idxmin()
        if trim_start >= 0:
            excluded_indices += event_rows.loc[trim_start:].index.to_list()

        excluded_indices += event_rows.loc[trim_start:].index.to_list()
    df = df.loc[~df.index.isin(excluded_indices)].reset_index(drop=True)
    if reset_delta_seconds:
        df["delta_seconds"] = delta_seconds - delta_seconds[0]

    return df


def __get_start_end_date(list_df, **kwargs):
    all_dates = []
    for group_df in list_df:
        for df in group_df:
            try:
                date = df[DEFAULT_TIMESTAMP_COLUMN_NAME()].iloc[0]
                if not isinstance(date, datetime):
                    all_dates.append(parser.parse(date))
                else:
                    all_dates.append(date)
            except:
                for part in df["filename"].iloc[0].split("_"):
                    try:
                        date = parser.parse(part)
                        all_dates.append(date)
                        break
                    except:
                        continue

    start_date = "Experiment Date Range: "
    try:
        start_date += min(all_dates).strftime("%Y-%m-%d %H:%M")
    except:
        start_date += "unknown date"

    try:
        end_date = max(all_dates).strftime("%Y-%m-%d %H:%M")
    except:
        end_date = "unknown date"
    return start_date, end_date
