import itertools
import os
from collections import defaultdict
from threading import Thread

import matplotlib

matplotlib.use("Agg")

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from matplotlib import pyplot as plt
from matplotlib.colors import to_rgb
from plotly.io import write_html, write_image
from scipy.stats import stats

from nzalaac.utils.data_preperation.general_utils import get_event_rows


def get_signal_mean_and_event_indices(
        group_data, sensing_elements, average_type="mean", shadow_type="std", **kwargs
):
    max_range = max([data.delta_seconds.max() for data in group_data])
    steps = [
        np.mean(np.diff(data.delta_seconds))
        for data in group_data
        if len(data.delta_seconds) > 1
    ]
    step = np.mean(steps)
    time_grid = np.arange(0, max_range, step)

    reference_event_name = "Unknown"
    normalization_details = defaultdict(list)
    all_elements = []
    all_elements_std = []
    for element in sensing_elements:
        sensor_values = []
        for data in group_data:
            if element in data.columns:
                series = data.set_index("delta_seconds")[element]
                aligned = (
                    series.reindex(series.index.union(time_grid))
                    .interpolate("index")
                    .reindex(time_grid)
                )  #
                sensor_values.append(aligned)
                if "normalized" in element:
                    try:
                        normalization_details[element].append(
                            __get_normalization_average(data, element)
                        )
                    except KeyError:
                        continue
            else:
                sensor_values.append(pd.Series(np.nan, index=time_grid))
            if "reference_event_name" in data.columns:
                reference_event_name = data["reference_event_name"].loc[0]

        sensor_values = pd.concat(sensor_values, axis=1)

        if average_type.lower() == "median":
            average = sensor_values.median(axis=1)
        elif average_type.lower() == "mean":
            average = sensor_values.mean(axis=1)
        else:
            raise ValueError(
                f"Invalid 'average_type' {average_type}, should be 'mean' or 'median'"
            )
        if shadow_type.lower() == "std":
            deviation = sensor_values.std(axis=1)
        elif shadow_type.lower() == "iqr":
            q1 = sensor_values.quantile(0.25, axis=1)
            q3 = sensor_values.quantile(0.75, axis=1)
            deviation = q3 - q1
        else:
            raise ValueError("wrong shadow type, needs std or iqr")
        all_elements += [average]
        all_elements_std += [deviation]
    event_indices = []
    for data in group_data:
        data_indices = {}
        for event in data[kwargs.get("event_column_name", "event_name")].unique():
            try:
                data_indices[event] = get_event_rows(data, event, **kwargs).index[0]
            except:
                data_indices[event] = None
        event_indices.append(data_indices)
    event_indices = pd.DataFrame.from_records(event_indices)
    median_event_indices = event_indices.median()
    min_event_indices = event_indices.min()
    max_event_indices = event_indices.max()

    result_df = pd.DataFrame(
        np.array(all_elements + all_elements_std).T,
        index=time_grid,
        columns=sensing_elements + [f"{col}_std" for col in sensing_elements],
    )

    # Convert event indices to seconds using time_grid

    for metric, indices in zip(
            ["median", "min", "max"],
            [median_event_indices, min_event_indices, max_event_indices],
    ):
        for event, i in indices.items():
            result_df[f"{metric}_time_{event}"] = (
                time_grid[int(i)] if i < len(time_grid) else np.nan
            )

    for event, i in median_event_indices.items():
        result_df.loc[time_grid[min(int(i), len(time_grid) - 1)]:, kwargs.get("event_column_name", "event_name")] = event

    result_df = result_df.reset_index(names="delta_seconds")
    columns_median = []
    columns_mad = []
    medians = []
    if len(normalization_details.items()) > 0:
        result_df["reference_event_name"] = reference_event_name
        for column_name, median in normalization_details.items():
            columns_median.append(f"reference_event_value_{column_name}")
            columns_mad.append(f"reference_event_iqr_{column_name}")
            medians.append(median)

        median = np.median(medians, axis=-1)
        mad = stats.iqr(medians, axis=-1) / median
        mad = np.round(mad * 100.0, 2)
        df_median_mad = pd.DataFrame(
            [np.concatenate([median, mad])], columns=columns_median + columns_mad
        )
        result_df = pd.concat([result_df, df_median_mad], axis=1).ffill()

    return result_df, event_indices


def __get_normalization_average(dataframe, col):
    return dataframe[f"normalization_details_{col}"].loc[0]


def __parallel_subplots(
        fig,
        to_plot,
        delta_seconds,
        upper_bound,
        lower_bound,
        group_name,
        color,
        row,
        col,
        showlegend,
):
    fig.add_trace(
        go.Scatter(
            x=delta_seconds,
            y=to_plot,
            fill=None,
            mode="lines",
            line=dict(color=color, width=2),
            showlegend=showlegend,
            legendrank=0,
            name=group_name,
            legendgroup=group_name,
            opacity=1.0,
        ),
        row=row,
        col=col,
    )
    color = to_rgb(color)
    color = f"rgba({color[0]},{color[1]},{color[2]},0.1)"
    # trace for lower shadow
    x_combined = np.concatenate(
        [
            delta_seconds,
            [delta_seconds[-1] + 0.1],
            np.flip(delta_seconds),
            [delta_seconds[0] + 0.1],
        ]
    )
    y_combined = np.concatenate(
        [upper_bound, [lower_bound[-1]], np.flip(lower_bound), [upper_bound[0]]]
    )

    fig.add_trace(
        go.Scatter(
            y=y_combined,
            x=x_combined,
            line=dict(color=color, width=1),
            hoverinfo="skip",
            mode="lines",
            fill="toself",
            fillcolor=color,
            legendgroup=group_name,
            name=group_name,
            showlegend=False,
        ),
        row=row,
        col=col,
    )


def _plot_with_mpl(
        signal_means,
        all_events,
        fig,
        axes,
        available_cols,
        group_name,
        color_name,
        vline_color_list,
        plot_kwargs,
):
    idx_plot = 0
    for col in available_cols:
        ax = axes[idx_plot]
        ax.xaxis.grid(False)
        ax.set_facecolor("w")
        ax.tick_params(labelbottom=True)
        ax.set_title(
            col.replace("normalized_", ""),
            fontweight="bold",
            fontsize=min(fig.get_figwidth() * 0.75, 75),
        )
        upper_bound = (signal_means[col] + signal_means[f"{col}_std"]).fillna(0)
        lower_bound = (signal_means[col] - signal_means[f"{col}_std"]).fillna(0)
        ax.set_xlabel("Time (Seconds)", fontsize=min(fig.get_figwidth() * 0.55, 45))

        if "normalized" in col:
            ax.set_ylabel(
                "% normalized response",
                fontsize=min(fig.get_figwidth() * 0.55, 45),
                fontweight="bold",
            )
            to_plot = signal_means[col] * 100.0
            upper_bound *= 100.0
            lower_bound *= 100.0

            if "reference_event_name" in signal_means and f"reference_event_value_{col}" in signal_means:
                label = (
                        group_name
                        + f" median of event \"{signal_means[f'reference_event_name'].loc[0]}:\""
                        + str(int(signal_means[f"reference_event_value_{col}"].loc[0]))
                        + " ± "
                        + str(signal_means[f"reference_event_iqr_{col}"].loc[0])
                )
                ax.plot(np.NaN, np.NaN, "", color="none", label=rf"{label}%")

        else:
            if "T0" in col:
                ax.set_ylabel(
                    "C", fontsize=min(fig.get_figwidth() * 0.55, 45), fontweight="bold"
                )
            elif "P0" in col:
                ax.set_ylabel(
                    "Pa", fontsize=min(fig.get_figwidth() * 0.55, 45), fontweight="bold"
                )
            elif "H0" in col:
                ax.set_ylabel(
                    r"RH%",
                    fontsize=min(fig.get_figwidth() * 0.55, 45),
                    fontweight="bold",
                )
            else:
                ax.set_ylabel(
                    "raw response",
                    fontsize=min(fig.get_figwidth() * 0.55, 45),
                    fontweight="bold",
                )
            to_plot = signal_means[col]

        p = ax.plot(
            signal_means["delta_seconds"],
            to_plot,
            **plot_kwargs,
            color=color_name,
            label=f"{group_name}",
            alpha=0.9,
            linewidth=5,
        )
        ax.fill_between(
            signal_means["delta_seconds"],
            lower_bound,
            upper_bound,
            color=p[0].get_color(),
            alpha=0.2,
        )
        ax.tick_params(axis="y", labelsize=min(fig.get_figwidth() * 0.55, 45))
        ax.tick_params(axis="x", labelsize=min(fig.get_figwidth() * 0.55, 45))
        for i, event_name in enumerate(all_events.columns):
            last_x = signal_means["unadjusted_delta_seconds"].iloc[-1]
            first_x = signal_means["unadjusted_delta_seconds"].iloc[0]
            median_time = signal_means[f"median_time_{event_name}"].iloc[0]
            if first_x != signal_means["delta_seconds"].loc[0]:
                median_time = median_time - first_x
                last_x = signal_means["delta_seconds"].iloc[-1]
                first_x = signal_means["delta_seconds"].iloc[0]

            if first_x <= median_time <= last_x + 1:
                ax.axvline(
                    median_time,
                    0,
                    1.0,
                    color=vline_color_list[i],
                    linestyle="dashed",
                    label=event_name,
                )
        idx_plot += 1
    return fig


def _save_with_mpl(
        fig,
        all_events,
        vline_color_list,
        device_id,
        output_kwargs,
        trial_count,
        start_date,
        end_date,
        **kwargs,
):
    all_ax = fig.get_axes()
    bbox_extra_artists = []
    for ax in all_ax:
        all_labels = []
        all_labels_mad = []
        all_handles_mad = []
        all_handles = []
        all_labels_vline = []
        all_handles_vline = []
        handles, labels = ax.get_legend_handles_labels()
        for l, h in zip(labels, handles):
            if ("median of event" in l and
                    l not in all_labels_mad and
                    l not in all_labels and
                    l not in all_labels_vline
            ):
                all_labels_mad.append(l)
                all_handles_mad.append(h)
            elif (
                    l not in all_labels
                    and l not in all_labels_vline
                    and l not in all_labels_mad
                    and any(event.lower().find(l.lower()) != -1 for event in all_events.columns)

            ):
                all_labels_vline.append(l)
                all_handles_vline.append(h)
            elif (
                    l not in all_labels
                    and l not in all_labels_vline
                    and l not in all_labels_mad
            ):
                all_labels.append(l)
                all_handles.append(h)
        if len(labels) == 0:
            fig.delaxes(ax)
        else:
            legend = ax.legend(
                all_handles,
                all_labels,
                bbox_to_anchor=(1.10, 1.0),
                fontsize=min(fig.get_figwidth() * 0.55, 45),
                borderaxespad=0.0,
                framealpha=0.25,
                loc="upper right",
            )
            ax.add_artist(legend)
            vline_legend = ax.legend(
                all_handles_vline,
                all_labels_vline,
                bbox_to_anchor=(1.10, 0.0),
                fontsize=min(fig.get_figwidth() * 0.55, 45),
                borderaxespad=0.0,
                framealpha=0.25,
                loc="lower right",
            )
            ax.add_artist(vline_legend)
            mad_legend = ax.legend(
                all_handles_mad,
                all_labels_mad,
                bbox_to_anchor=(0, 0.0),
                fontsize=min(fig.get_figwidth() * 0.55, 25),
                borderaxespad=0.0,
                framealpha=0.15,
                loc="lower left",
            )
            ax.add_artist(mad_legend)

            bbox_extra_artists += [legend, vline_legend, mad_legend]
            for legobj in vline_legend.legend_handles:
                legobj.set_linewidth(7.0)

    suptitle = fig.suptitle(
        " ".join(
            [
                output_kwargs.get("plot_title", ""),
                "\n",
                kwargs.get("metadata", {}).get("batchId", "")
                + " "
                + kwargs.get("metadata", {}).get("computer", ""),
                "\n",
                f"Analyte: {kwargs.get('analyte_name', 'Unspecified')}, measured in ppb",
                "\n",
                f"Sensor Module ID: {device_id}",
                "\n",
                " - ".join(trial_count),
                "\n",
                start_date,
                "-",
                end_date,
            ]
        ),
        y=1.01,
        fontsize=min(fig.get_figwidth() * 0.75, 100),
        fontweight="bold",
    )
    fig.tight_layout()
    plt.subplots_adjust(wspace=0.3, hspace=0.15)
    fig.savefig(
        os.path.join(
            kwargs.get("paths", {}).get("output_plots", "./outputs/"),
            output_kwargs.get("filename", "output_plot") + "_" + device_id + ".jpeg",
        ),
        dpi=45,
        bbox_inches="tight",
        bbox_extra_artists=bbox_extra_artists + [suptitle],
    )
    plt.close(fig)
    plt.close("all")


def _plot_with_plotly(
        fig,
        signal_means,
        all_events,
        available_cols,
        n_cols,
        threads,
        vline_colors,
        group_color,
        group_name,
        plot_setup,
        groups_seen,
        **kwargs,
):
    for idx, col_name in enumerate(available_cols):

        row = (idx // n_cols) + 1
        col = (idx % n_cols) + 1
        upper_bound = (
            (signal_means[col_name] + signal_means[f"{col_name}_std"])
            .fillna(0)
            .to_numpy()
        )
        lower_bound = (
            (signal_means[col_name] - signal_means[f"{col_name}_std"])
            .fillna(0)
            .to_numpy()
        )
        to_plot = signal_means[col_name].to_numpy()

        # subplot titles
        max_response = np.percentile(upper_bound, 80)
        if max_response > to_plot.max() * 2:
            max_response = to_plot.max()
        min_response = np.percentile(lower_bound, 5)
        if min_response < to_plot.min() / 2:
            min_response = to_plot.min()

        if "normalized" in col_name:
            max_response = (max_response * 100.0).astype("float16")
            min_response = (min_response * 100.0).astype("float16")
            # x100 normalized values
            to_plot = (to_plot * 100.0).astype("float16")
            upper_bound = (upper_bound * 100.0).astype("float16")
            lower_bound = (lower_bound * 100.0).astype("float16")
            if len(plot_setup["subplot_y"]) <= idx:
                plot_setup["subplot_y"].append(r"% normalized response")

        elif len(plot_setup["subplot_y"]) <= idx:
            if "T0" in col_name:
                plot_setup["subplot_y"].append("C")
            elif "P0" in col_name:
                plot_setup["subplot_y"].append("Pa")
            elif "H0" in col_name:
                plot_setup["subplot_y"].append(r"RH%")
            else:
                plot_setup["subplot_y"].append(r"Raw Response%")

        delta_seconds = signal_means["delta_seconds"].to_numpy()
        thread = Thread(
            target=__parallel_subplots,
            kwargs=dict(
                fig=fig,
                to_plot=to_plot,
                upper_bound=upper_bound,
                lower_bound=lower_bound,
                delta_seconds=delta_seconds,
                group_name=group_name,
                color=group_color,
                col=col,
                row=row,
                showlegend=group_name not in groups_seen,
            ),
        )
        groups_seen.add(group_name)
        thread.start()
        threads.append(thread)

        # skip vline for events not in range
        if len(vline_colors) < len(all_events):
            cycle = itertools.cycle(vline_colors)
            vline_colors = [next(cycle) for _ in range(len(all_events))]
        for i, event_name in enumerate(all_events.columns):
            last_x = signal_means["unadjusted_delta_seconds"].iloc[-1]
            first_x = signal_means["unadjusted_delta_seconds"].iloc[0]
            median_time = signal_means[f"median_time_{event_name}"].iloc[0]
            if first_x != signal_means["delta_seconds"].loc[0]:
                median_time = median_time - first_x
                last_x = signal_means["delta_seconds"].iloc[-1]
                first_x = signal_means["delta_seconds"].iloc[0]
            if first_x <= median_time <= last_x:
                kwarg = dict(
                    x=[median_time, median_time],
                    line_color=vline_colors[i],
                    legendgroup=event_name,
                    line_width=1.0,
                    name=event_name,
                    line_dash="dash",
                    legendrank=1,
                    mode="lines",
                    showlegend=event_name not in groups_seen
                )
                groups_seen.add(event_name)
                t = Thread(
                    target=lambda: fig.add_trace(go.Scatter(y=[min_response, max_response], **kwarg), row=row,
                                                 col=col))
                t.start()
                threads.append(t)

        try:
            # get median +- MAD text
            mad_median = rf"""{group_name} median {signal_means[f'reference_event_name'].loc[0]}: {int(signal_means[f'reference_event_value_{col_name}'].loc[0])} ± {signal_means[f'reference_event_iqr_{col_name}'].loc[0]}%"""
            plot_setup["mad_median"][col_name].append(mad_median)

        except KeyError:
            plot_setup["mad_median"][col_name] = []

    return fig, threads, plot_setup


def _save_with_plotly(
        fig,
        threads,
        available_cols,
        plot_setup,
        n_cols,
        n_rows,
        device_id,
        trial_count,
        output_kwargs,
        start_date,
        end_date,
        **kwargs,
):
    for thread in threads:
        thread.join()

    fig.update_layout(
        width=500 * n_cols,
        height=450 * n_rows,
        legend_traceorder='grouped',

        title=dict(
            font=dict(size=15),
            text="<b>"
                 + "<br>".join(
                [
                    output_kwargs.get("plot_title", ""),
                    kwargs.get("metadata", {}).get("batchId", "")
                    + " " + kwargs.get("metadata", {}).get("computer", ""),
                    f"Analyte: {kwargs.get('analyte_name', 'Unspecified')} measured in ppb",
                    f"Sensor Module ID: {device_id}",
                    ", ".join(trial_count),
                    start_date + "-" + end_date,
                ]
            )
                 + "</b>",
            x=0.5,
            y=1,
            xanchor="center",
            yanchor="top",
        ),
        margin=dict(t=200),
        xaxis_title_standoff=30,
        yaxis_title_standoff=5,
    )
    for idx, col_name in enumerate(available_cols):
        row = (idx // n_cols) + 1
        col = (idx % n_cols) + 1
        fig.update_xaxes(
            title_font_size=9,
            title_text="<b>"
                       + "Time (Seconds)"
                       + "</b> <br>"
                       + "<br>".join(plot_setup["mad_median"][col_name]),
            ticks="inside",
            showticklabels=True,
            row=row,
            col=col,

        )
        fig.update_yaxes(
            title_text="<b>" + plot_setup["subplot_y"][idx] + "<b>",
            row=row,
            col=col,
            showgrid=False,
        )

    write_html(
        fig,
        os.path.join(
            kwargs.get("paths", {}).get("output_plots", "./outputs/"),
            output_kwargs.get("filename", "output_plot") + "_" + device_id + ".html",
        ),
    )
    if kwargs.get("save_jpeg", False):
        write_image(
            fig,
            os.path.join(
                kwargs.get("paths", {}).get("output_plots", "./outputs/"),
                output_kwargs.get("filename", "output_plot") + "_" + device_id + ".jpeg",
            ),
            format="jpeg",
            scale=2.0,
        )
    del fig
