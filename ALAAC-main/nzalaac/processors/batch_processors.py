import itertools
import math
import os
from concurrent.futures import ProcessPoolExecutor
from unittest import result

import matplotlib.colors as mcolors
import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import plotly.subplots as sp
from plotly.subplots import make_subplots

from nzalaac.utils.data_analysis.batching import group_by
from nzalaac.utils.data_analysis.visualization import monotonic_average_plot
from nzalaac.utils.data_preperation.general_utils import (
    _alphanum_key,
    _extract_annotation_id_from_filename,
    _to_hex_color,
    _value,
    apply_skipped_events,
    assign_trial_num,
    calculate_metrics_for_single_trial,
    determine_time_column,
    filter_events,
    iqr,
    subplots_width_height,
)
from nzalaac.utils.data_preperation.ingestion import get_sensing_element_names
from nzalaac.utils.logger import ALAACLogger

logger = ALAACLogger(__name__)

async def monotonic_average_plots(
    batched_data: dict, sensing_elements, output_kwargs=None, plot_kwargs=None, **kwargs
):
    """
    Create monotonic average plots of different groups of data.

    Parameters
    ----------
    batched_data: dict[str, pd.DataFrame]
        Complete dataset, split by key/value of module_id and list of corresponding trials.
    sensing_elements: List[str]
        List of sensing element names.
    output_kwargs: dict
        kwargs for output plot includes: n_cols, plot_title, filename
    plot_kwargs: dict
        kwargs for plt.plot()
    kwargs: dict
        other kwargs
    Returns
    -------
    output_status: dict
        true if passed.
    """
    if output_kwargs is None:
        output_kwargs = {}

    default_output_kwargs = {"plot_title": ""}
    default_output_kwargs.update(output_kwargs)

    sensing_elements = get_sensing_element_names(sensing_elements)

    for group_name, list_dfs in batched_data.items():
        if kwargs.get("group_by") is None:
            groups = list_dfs
            group_names_flag = [""]
        else:
            groups, group_names_flag = group_by(list_dfs, **kwargs.get("group_by", {}))
        group_names_flag = [f"{group_name}_{flag}" for flag in group_names_flag]
        monotonic_average_plot(
            groups,
            sensing_elements,
            default_output_kwargs,
            group_names=group_names_flag,
            **kwargs,
        )
    return {"status": True, "data":None}

def _task_worker(payload):
    """
    Lightweight multiprocessing worker that packages precomputed line-plot data.
    The worker is used with ``ProcessPoolExecutor`` to parallelize preparation
    of trace data while keeping plot generation fast.

    Parameters
    ----------
    payload : tuple
        A tuple with the following elements, in order:

        - trial_id (int)
            Sequential trial identifier.
        - column_name (str)
            Sensor column name to be plotted.
        - x (np.ndarray)
            Time values (e.g., delta_seconds).
        - y (np.ndarray)
            Sensor values corresponding to ``x``.
        - events (np.ndarray or None)
            Per-point event names used for hover display.
            Empty strings indicate no active event.
        - color (str)
            Line color for the trace.
        - line_width (float)
            Line width for the trace.
        - group (str)
            Group label (e.g., concentration or condition).

    Returns
    -------
    dict
        Dictionary containing all fields required to construct a Plotly
        ``go.Scatter`` trace without additional computation.
    """
    trial_id,trial_label, column_name, x, y, events, color, line_width, group = payload

    return {
        "trial": trial_id,
        "trial_label": trial_label,
        "column": column_name,
        "x": x,
        "y": y,
        "events": events,
        "color": color,
        "line_width": line_width,
        "group": group,
    }

async def individual_line_plots(
    batched_data,
    sensing_elements,
    trial_column="trial_id",
    group_column="concentration_value",
    output_kwargs=None,
    plot_kwargs=None,
    line_width=1.2,
    max_workers=6,
    **kwargs
):
    """
    Generate high-performance, multi-subplot line plots with event-aware hover
    information for batched experimental sensor data.

    This function:
    - Combines multiple trials per module into a single plotting context
    - Generates one subplot per sensing element
    - Draws one line per (trial × group × sensor)
    - Adds vertical event markers spanning the earliest and latest occurrence
      of each event across trials
    - Displays event names efficiently via per-point hover using ``customdata``
      (no additional traces per event)

    Parameters
    ----------
    batched_data : dict[str, list[pandas.DataFrame]]
        Mapping of module / device name to a list of trial DataFrames.
        Each DataFrame must contain time, sensor, and grouping columns.

    sensing_elements : list[str] or str
        Sensor name patterns used to identify columns for subplot creation.

    trial_column : str, default="trial_id"
        Column name identifying individual trials.

    group_column : str, default="concentration_value"
        Column used to group traces and assign colors.

    output_kwargs : dict, optional
        Output configuration (e.g., filename prefix, output path).

    plot_kwargs : dict, optional
        Plot configuration (e.g., number of subplot columns, title).

    line_width : float, default=1.2
        Line width for plotted traces.

    max_workers : int, default=6
        Number of worker processes used for parallel trace preparation.

    **kwargs
        Additional optional parameters, including:
        - event_column_name (str): Column containing event labels
        - group_by (dict): Grouping configuration
        - analyte_name (str): Name used in the plot title
        - paths (dict): Output path configuration
        - timestamp_column_name (str): Explicit timestamp column override

    Returns
    -------
    dict
        Status dictionary with at least:
        - ``{"status": True}`` on successful completion

    """

    if output_kwargs is None:
        output_kwargs = {}
    if plot_kwargs is None:
        plot_kwargs = {}
    default_output_kwargs = {"filename": "individual_"}
    default_plot_kwargs = {"linewidth": 2, "add_annotation_id":True, "display_trial_number":False,"trial_number_position":"end"}

    default_output_kwargs.update(output_kwargs)
    default_plot_kwargs.update(plot_kwargs)

    event_column_name = kwargs.get("event_column_name", "event_name")
    time_column = determine_time_column(batched_data, kwargs)
    skipped_events = kwargs.get("skipped_events") or {}

    if time_column is None:
        return {"status": True, "data": batched_data}

    sensing_elements = get_sensing_element_names(sensing_elements)
    NUM_COLS = plot_kwargs.get("num_columns", 5)

    if not isinstance(batched_data, dict):
        raise TypeError("Expected batched_data to be a dict of {group: [df,...]}")

    # Combine ALL dataframes into one DF per device / module
    for module_name, trials in batched_data.items():
        all_dfs = []
        assign_trial_num(trials, time_column, trial_column)

        if kwargs.get("group_by") is None:
            for df in trials:
                df[group_column] = ""
            groups = trials
            group_flags = [""]
        else:
            groups, group_flags = group_by(trials, **kwargs["group_by"])

        subplot_columns = set()
        for df in trials:
            if not isinstance(df, pd.DataFrame):
                raise TypeError("Each entry inside batched_data must be a pandas DataFrame")
            all_dfs.append(df)
            for se in sensing_elements:
                matching = [c for c in df.columns if se in c and "details" not in c]
                subplot_columns.update(matching)
        subplot_columns = sorted(subplot_columns)
        if not subplot_columns:
            continue

        if not all_dfs:
            raise ValueError("batched_data contains no dataframes")

        # Find Experiment Date Range
        for df_i in all_dfs:
            df_i[time_column] = pd.to_datetime(df_i[time_column], format="mixed", errors="coerce")
            if df_i[time_column].isna().any():
                problematic_timestamps = df_i.loc[df_i[time_column].isna(), time_column].head(5).tolist()
                raise ValueError(f"Unparseable timestamps in column '{time_column}'. Examples: {problematic_timestamps}")

        start_ts = min(df_i[time_column].min() for df_i in all_dfs)
        end_ts   = max(df_i[time_column].max() for df_i in all_dfs)

        start_str = start_ts.strftime("%Y%m%d-%H:%M")
        end_str   = end_ts.strftime("%Y%m%d-%H:%M")
        experiment_date_range = f"Experiment Date Range: {start_str}  -  {end_str}"

        df = pd.concat(all_dfs, ignore_index=True)
        normalized_cols = [c for c in df.columns if "normalized_" in c]
        if normalized_cols:
            df.loc[:, normalized_cols] = df.loc[:, normalized_cols] * 100

        if skipped_events:
            if event_column_name not in df.columns:
                # No event column -> cannot verify presence -> skip module
                continue

            present_events = set(df[event_column_name].dropna().astype(str).str.strip().unique())
            required = set(skipped_events.keys())

            if not required.issubset(present_events):
                # If any required skipped event is not in the data, skip plot generation
                continue

            if "delta_seconds" in df.columns and trial_column in df.columns:
                # Remove skipped events
                df = apply_skipped_events(df, skipped_events, event_column_name, trial_column, time_col="delta_seconds")

                # Re-zero time so remaining data starts from 0 (per trial)
                offsets = df.groupby(trial_column)["delta_seconds"].transform("min")
                df["delta_seconds"] = df["delta_seconds"] - offsets
            else:
                continue

        event_vlines = {}                       # Dictionary: {event_name: (earliest_time, latest_time)}
        if event_column_name in df.columns:
            unique_event_names = df[event_column_name].dropna().unique()
            for event_name in unique_event_names:
                group = df[df[event_column_name] == event_name]
                first_times_per_trial = group.groupby(trial_column)["delta_seconds"].min()

                earliest_start = first_times_per_trial.min()
                latest_start   = first_times_per_trial.max()

                event_vlines[event_name] = (earliest_start, latest_start)

        # Required columns
        needed = {trial_column, group_column, time_column} | set(subplot_columns)
        missing = needed - set(df.columns)
        if missing:
            raise KeyError(f"Missing required columns: {missing}")
        df = df.sort_values([group_column, trial_column, time_column])

        trial_label_map = {}
        if "annotation_id" in df.columns and default_plot_kwargs.get("add_annotation_id"):
            ann_per_trial = df.groupby(trial_column)["annotation_id"].first()
            trial_label_map = {
                t: f"Trial {t} - {str(ann)[:8]}" if pd.notna(ann) and str(ann).strip() else f"Trial {t}"
                for t, ann in ann_per_trial.items()
            }
        else:
            if "filename" in df.columns and default_plot_kwargs.get("add_annotation_id"):
                fname_per_trial = df.groupby(trial_column)["filename"].first()
                ann_per_trial = fname_per_trial.map(_extract_annotation_id_from_filename)

                trial_label_map = {
                    t: f"Trial {t} - {str(ann)[:8]}" if ann else f"Trial {t}"
                    for t, ann in ann_per_trial.items()
                }
            else:
                trial_label_map = {t: f"Trial {t}" for t in df[trial_column].unique()}

        unique_trials = df[trial_column].unique()
        unique_groups  = df[group_column].unique()

        # --- Match average plot group ordering + palette ---
        sorted_groups = sorted(unique_groups, key=_alphanum_key)
        base_colors = list(mcolors.TABLEAU_COLORS.values())
        extra_colors = [
            "#2E91E5",  # strong blue
            "#E15F99",  # magenta
            "#1CA71C",  # vivid green
            "#FB0D0D",  # vivid red
            "#DA16FF",  # violet
            "#B68100",  # gold
            "#750D86",  # deep purple
            "#EB663B",  # coral
            "#511CFB",  # indigo
            "#00A08B",  # teal
            ]
        default_signal_colors = base_colors + extra_colors
        # Use the same default as monotonic_average_plot unless user provides signal_colors
        signal_colors = kwargs.get("signal_colors", default_signal_colors)
        signal_colors = [_to_hex_color(c) for c in signal_colors]

        # Cycle if not enough colors
        if len(signal_colors) < len(sorted_groups):
            cycle = itertools.cycle(signal_colors)
            signal_colors = [next(cycle) for _ in range(len(sorted_groups))]

        group_colors = {g: signal_colors[i] for i, g in enumerate(sorted_groups)}

        event_names = list(event_vlines.keys())
        event_colors = {name: px.colors.qualitative.Set1[i % len(px.colors.qualitative.Set1)]
                        for i, name in enumerate(event_names)}

        tasks = []

        for group in unique_groups:
            gdf = df[df[group_column] == group]

            for trial_id in unique_trials:
                tdf = gdf[gdf[trial_column] == trial_id]
                if tdf.empty:
                    continue

                events = tdf[event_column_name].replace("-", "").fillna("").to_numpy() if event_column_name in tdf else None
                x = tdf["delta_seconds"].to_numpy()
                for col in subplot_columns:
                    y = tdf[col].to_numpy()
                    tasks.append((
                        trial_id,
                        trial_label_map.get(trial_id, f"Trial {trial_id}"),
                        col,
                        x,
                        y,
                        events,
                        group_colors[group],
                        line_width,
                        group
                    ))

        # Multiprocessing execution
        with ProcessPoolExecutor(max_workers=max_workers) as exe:
            results = list(exe.map(_task_worker, tasks))
        results = sorted(results, key=lambda r: (r["trial"], r["column"]))     # re-order trials

        subplot_positions = {
            sensor: (i // NUM_COLS + 1, i % NUM_COLS + 1)
            for i, sensor in enumerate(subplot_columns)
        }


        TOTAL_ROWS = (len(subplot_columns) - 1) // NUM_COLS + 1
        TOTAL_COLS = NUM_COLS

        # Creating the plot
        fig = sp.make_subplots(
            rows=TOTAL_ROWS,
            cols=TOTAL_COLS,
            subplot_titles=[f"<b>{col}</b>" for col in subplot_columns]
        )
        fig.update_annotations(
            font=dict(
                size=14,
                family="Arial")
        )
        for r in results:
            sensor = r["column"]
            row, col = subplot_positions[sensor]

            display_trial_number = default_plot_kwargs.get("display_trial_number", False)
            trial_number_position = default_plot_kwargs.get("trial_number_position", "end")
            if display_trial_number:
                mode="lines+text"
                if trial_number_position == "start":
                    text=[f"T{r['trial']}"] + [None] * (len(r["x"]) - 1)
                else:
                    text=[None] * (len(r["x"]) - 10) + [f"T{r['trial']}"]
            else:
                mode = "lines"
                text = None

            fig.add_trace(
                go.Scatter(
                    x=r["x"],
                    y=r["y"],
                    customdata=r["events"],
                    mode= mode,
                    text = text,
                    textposition="middle right",
                    line=dict(color=r["color"], width=r["line_width"]),
                    name=f"{r['trial_label']} - {r['group']}",
                    legendgroup=f"trial-{r['trial']}",
                    showlegend=(sensor == subplot_columns[0]),
                    hovertemplate=(
                        f"Trial: {r['trial']}<br>"
                        f"Group: {r['group']}<br>"
                        f"Event: %{{customdata}}<br>"
                        f"Time: %{{x}}<br>"
                        f"Value: %{{y}}<extra></extra>"
                    )
                ),
                row=row, col=col
            )

        for sensor, (row, col) in subplot_positions.items():
            for event_name, (t_earliest, t_latest) in event_vlines.items():
                fig.add_vline(
                    x=t_earliest,
                    line=dict(color=event_colors[event_name], dash="dash"),
                    row=row, col=col,
                    layer="above"
                )
                fig.add_vline(
                    x=t_latest,
                    line=dict(color=event_colors[event_name], dash="dash"),
                    row=row, col=col,
                    layer="above"
                )

            sensor_title_map = {
                "ANLT0": "Analyte Code", "SETP0": "MFC Set Value",
                "normalized_": "normalized response (%)","T0": "Temperature (C)",
                "abs-": "Absolute Humidity (%)","H0": "Relative Humidity (%)",
                "P0": "Pressure Value", "FLW0": "MFC Real-Time Value"
            }

            title_text = "<b>Sensor Response<b>"
            for key, val in sensor_title_map.items():
                if key in sensor:
                    title_text = f"<b>{val}<b>"
                    break
            fig.update_yaxes( title_text=title_text, title_font=dict(size=11, family="Arial"), title_standoff=3, row=row, col=col
            )
        ### add event legend
        for event_name, color in event_colors.items():
            fig.add_trace(
                go.Scatter(
                    x=[None],
                    y=[None],
                    mode="lines",
                    line=dict(color=color, dash="dash"),
                    name=f"Event: {event_name}"
                ),
                row=1, col=1
            )
        ### add group legend
        for g in sorted(unique_groups, key=_alphanum_key):
            fig.add_trace(
                go.Scatter(
                    x=[None],
                    y=[None],
                    mode="lines",
                    line=dict(color=group_colors[g], width=3),
                    name=f"{g}",
                    legendgroup=f"group-{g}",
                    showlegend=True,
                ),
                row=1, col=1
            )

        sorted_groups = sorted(
            zip(group_flags, groups),
            key=lambda x: _value(x[0].split("_")[-1])
        )

        plot_title = "<br>".join([
            f"<b>{default_plot_kwargs.get('plot_title', '')}</b>",
            f"<b>Analyte: {kwargs.get('analyte_name', 'Unspecified')} (ppb)</b>",
            f"<b>Sensor Module ID: {module_name}</b>",
            f"<span style='font-size:15px;'><b>{experiment_date_range}</b></span>",
            (
                "<span style='font-size:12px;'>"
                + ' - '.join([
                    f"<b>{flag.split('_')[-1]} ({len(group_trials)}) </b>"
                    for flag, group_trials in sorted_groups
                ])
                + "</span>"
            )
        ])
        subplot_width, subplot_height = subplots_width_height(NUM_COLS)
        fig.update_layout(
            height= subplot_height * TOTAL_ROWS,
            width=subplot_width * TOTAL_COLS,
            title=dict(
                text=plot_title,
                x=0.5,
                xanchor="center",
                font=dict(size=18)
            ),
            margin=dict(t=260),
            template="plotly_white"
        )
        fig.update_xaxes(tickfont=dict(size=10, family="Arial"))
        fig.update_yaxes(tickfont=dict(size=10, family="Arial"))

        fig.update_xaxes(title_text="<b>Time (seconds)<b>",title_font=dict(size=11, family="Arial"), title_standoff=5)
        fig.update_xaxes(range=[df["delta_seconds"].min(), df["delta_seconds"].max()])

        filepath = os.path.join(os.path.normpath(kwargs.get("paths", {}).get("output_plots", "./outputs/")),
                     default_output_kwargs.get("filename", "output_plot") + "_" + module_name + ".html")
        fig.write_html(filepath)

    return {"status": True}

async def compute_signal_metrics(
    batched_data,
    sensing_elements,
    group_column="concentration_value",
    trial_id_column = "trial_num",
    output_kwargs=None,
    **kwargs
):
    """
    Compute signal statistics for batched sensor data across trials and groups.

    This function processes a dictionary of trial data, normalizes relevant sensor
    columns, optionally filters events of interest, computes statistical measures
    (e.g., max, slope, AUC) over specified windows, and returns a summary DataFrame.
    The results can also be averaged across groups and saved to CSV files.

    Parameters
    ----------
    batched_data : dict
        Dictionary where keys are module names and values are lists of pandas DataFrames
        representing trials. Each DataFrame should include sensor measurements and a
        timestamp column.
    sensing_elements : list or str
        List of sensing element names (columns) to analyze. Will be normalized if prefixed
        with "normalized_".
    group_column : str, optional
        Name of the column used for grouping data within each trial if no explicit
        grouping is provided. Default is "concentration_value".
    trial_id_column : str, optional
        Name of the column used to store or assign trial IDs. Default is "trial_num".
    output_kwargs : dict, optional
        Dictionary for output options. Supported keys:
            - "filename": base name for CSV output files. Default is "signal_metrics".
    **kwargs : dict
        Additional optional parameters:
            - event_column_name : str
                Column name to filter events of interest. Default is "event_name".
            - events_of_interest : list
                List of events to include in the analysis. If None, all events are included.
            - stats_windows : dict
                Dictionary specifying statistics to calculate and the windows (start, end)
                as fractions of trial length. Required.
            - group_by : dict
                Parameters for grouping trials into subgroups.
            - averaging : bool
                Whether to aggregate statistics across groups. Default False.
            - averaging_method : str or function
                Aggregation method to use if averaging. E.g., "mean".
            - variation_metric : str or function
                Metric for variation if averaging. Supports "iqr" or custom callable.
            - save_csv : bool
                Whether to save the resulting summary to CSV. Default False.
            - paths : dict
                Dictionary containing output file paths. Default output folder is "./outputs/".
    """
    if output_kwargs is None:
        output_kwargs = {}
    default_output_kwargs = {"filename": "signal_metrics"}
    default_output_kwargs.update(output_kwargs)

    event_column_name = kwargs.get("event_column_name", "event_name")
    time_column = determine_time_column(batched_data, kwargs)
    if time_column is None:
        logger.warning("Time column is missing")
        return {"status": True, "data": batched_data}

    sensing_elements = get_sensing_element_names(sensing_elements)
    if not isinstance(batched_data, dict):
        raise TypeError("Expected batched_data to be a dict of {group: [df,...]}")
    stats_windows = kwargs.get("stats_windows")
    if stats_windows is None:
        raise ValueError("stats_windows is missing in the config")
    if not isinstance(stats_windows, dict):
        raise TypeError(f"Expected stats_windows to be a dict, got {type(stats_windows).__name__}")

    for module_name, trials in batched_data.items():
        assign_trial_num(trials, time_column, trial_id_column)

        if kwargs.get("group_by") is None:
            for df in trials:
                df[group_column] = ""
            groups = trials
            group_flags = [""]
        else:
            groups, group_flags = group_by(trials, **kwargs["group_by"])

        csv_columns = set()
        for df in trials:
            normalized_columns = [col for col in df.columns if "normalized_" in col and "details_" not in col]
            df[normalized_columns] = df[normalized_columns]*100

            for se in sensing_elements:
                matching = [c for c in df.columns if se in c and "details" not in c]
                csv_columns.update(matching)
        csv_columns = sorted(csv_columns)
        result_columns = sorted(set(f"{col}-{stat}" for col in csv_columns for stat in stats_windows))

        result = pd.DataFrame(columns=result_columns+["group",trial_id_column,time_column])
        for flag, dfs in zip(group_flags, groups):
            for df in dfs:
                if not isinstance(df, pd.DataFrame):
                    raise TypeError("Each entry inside batched_data must be a pandas DataFrame")
                df = filter_events(df, event_column_name, kwargs.get("events_of_interest"))
                if df.empty:
                    continue
                row_data = calculate_metrics_for_single_trial(df, csv_columns, stats_windows)
                if not row_data:
                    continue
                row_data.update({
                    "group": flag,
                    trial_id_column: df[trial_id_column].iloc[0],
                    time_column: pd.Timestamp(df[time_column].iloc[0]).strftime("%Y-%m-%d %H:%M:%S")
                })
                result = pd.concat([result, pd.DataFrame([row_data])], ignore_index=True)

        result = result.sort_values(trial_id_column)
        if kwargs.get("events_of_interest") and result.empty:
            logger.warning(f"⚠️ Warning: No trials in module '{module_name}' contain the specified events_of_interest. Skipping output.")
            return {"status": True, "skipped": True, "module": module_name}

        if kwargs.get("averaging"):
            averaging_method = kwargs.get("averaging_method")
            variation_metric = kwargs.get("variation_metric")
            variation_metric = iqr if variation_metric== "iqr" else variation_metric

            result = (result.groupby("group")[result_columns].agg([averaging_method, variation_metric]).reset_index().round(3))
            result.columns = [f"{col}_{stat}" if stat else col for col, stat in result.columns]
            exclude_keywords = ("normalized", "group", time_column)
            not_normalized_col = [col for col in result.columns if not any(k in col for k in exclude_keywords)]
            result[not_normalized_col] = result[not_normalized_col].round(1)

        if kwargs.get("save_csv"):
            filepath = os.path.join(os.path.normpath(kwargs.get("paths", {}).get("output_files", "./outputs/")),
                    default_output_kwargs.get("filename", "signal_metrics") + "_" + module_name + ".csv")
            result.to_csv(filepath, index=False)
            logger.info(f"{default_output_kwargs.get('filename', 'signal_metrics')} result has been saved")

    return {"status": True}
