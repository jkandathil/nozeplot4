import numpy as np

from nzalaac.utils.data_preperation.general_utils import get_concentration


def between_range(
    all_data, column, inclusive=True, how="first", maximum=None, minimum=None, **kwargs
):
    """
    Create batches of data if they match range.

    Parameters
    ----------
    all_data: list[DataFrame]
    column: str
        name of column to use for batching
    inclusive: bool
        include range extremums in filtering (Defaults to true)
    how: str
        first: use first item in col's value
        mean: use mean of all values in col
        median: use median of all values in col
        max: use max of all values in col
    maximum:
        Maximum accepted range
    minimum:
        Minimum accepted range
    kwargs

    Returns
    -------
    batch: List[DataFrame]
    """
    how_dict = {
        "mean": lambda x: x.mean(),
        "first": lambda x: x.loc[0],
        "median": lambda x: x.median(),
        "max": lambda x: x.max(),
    }

    if minimum is None:
        minimum = float("-inf")
    if maximum is None:
        maximum = float("inf")
    if inclusive:
        return [
            df for df in all_data if minimum >= how_dict[how](df[column]) >= maximum
        ]
    else:
        return [df for df in all_data if minimum > how_dict[how](df[column]) > maximum]


def exact_value(all_data, column, value, how="first", **kwargs):
    """

    Parameters
    ----------
    all_data: all dataset
    column: str
        name of column to use for batching.
    value: Any
        Value to use to match in column
    how:
        first: use first item in col's value
        mean: use mean of all values in col
        median: use median of all values in col
        max: use max of all values in col

    kwargs

    Returns
    -------
    batch: List[DataFrame]
    """
    how_dict = {
        "mean": lambda x: x.mean(),
        "first": lambda x: x.loc[0],
        "median": lambda x: x.median(),
        "max": lambda x: x.max(),
    }
    return [df for df in all_data if how_dict[how](df[column]) == value]


def group_by(all_data, column=None, using="exact_value", **kwargs):
    """
    Create batches of data.

    Parameters
    ----------
    all_data
    column
    using: str
        concentration_exact_value
        concentration_between_range
        exact_value: match exact value
        between_range: inbetween max/min range
    kwargs
    Returns
    -------

    """
    if using.startswith("concentration"):
        for df in all_data:
            if "concentration_value" not in df.columns:
                df["concentration_value"] = get_concentration(df)
        using = (
            "_".join(using.split("_")[1:])
            if len(using.split("_")[1:]) > 1
            else "exact_value"
        )
        column = "concentration_value"
    elif column is None:
        raise ValueError(
            "Specify Column for 'group_by' -- possible keys: column, using, value, [between_range: inclusive, how, maximum, minimum]"
        )
    if using == "exact_value":
        all_values = kwargs.get("value")
        if all_values is None:
            all_values = list(np.unique([data[column].loc[0] for data in all_data]))
        if isinstance(all_values, list):
            return [
                exact_value(all_data, column, value, **kwargs) for value in all_values
            ], [f"{column}_{value}" for value in all_values]

        return [exact_value(all_data, column, **kwargs)], [
            f"{column}_{value}" for value in all_values
        ]
    elif using == "between_range":
        ranges = between_range(all_data, column, **kwargs)
        return ranges, [f"{column}_range_{i}" for i in range(len(ranges))]
    else:
        raise ValueError("must be exact_value or between_range for group_type")
