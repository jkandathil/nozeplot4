"""Main file for entry-point to characterization batch analysis."""
from nzalaac.utils.logger import ALAACLogger, initialize_logger

initialize_logger()

import asyncio
import os
import re

import pandas as pd

import nzalaac.processors.batch_processors as batch_processors
import nzalaac.processors.trial_processors as trial_processors
from nzalaac.constants.constant_values import default_dataset_options
from nzalaac.utils.data_preperation.general_utils import add_delta_seconds
from nzalaac.utils.data_preperation.ingestion import (
    batch_by_device_id,
    load_input_json,
    prepare_raw_data,
)
from nzalaac.utils.reports.upload import upload_to_gcs


def _setup_dataset_options(config):
    """
    Setup the dataframe options from config
    """
    dataset_options = default_dataset_options()
    dataset_options.update(config.get("dataset_options", {}))
    prep_pipeline = config.get("prep_pipeline", {})
    config["prep_pipeline"] = prep_pipeline
    config["dataset_options"] = dataset_options
    return config


async def process_item(csv_path, pipeline, **kwargs):
    """
    Process single trial/csv.

    Parameters
    ----------
    csv_path: str
        Path to csv file to read.
    pipeline:
        preprocessing pipeline
    kwargs

    Returns
    -------
    output: dict
        contains 'data', final df
    """
    # Temporary Fix
    logger = ALAACLogger("src.process_item")
    regex_pattern_val = r"val-nz"
    search_val = re.search(re.compile(regex_pattern_val), os.path.basename(csv_path))
    if search_val:
        logger.warning(f"Skipped file {os.path.basename(csv_path)}, contains val-nz")
        return None

    original_data = pd.read_csv(csv_path).dropna(axis=0, how="all")
    original_data["filename"] = os.path.basename(csv_path)

    original_data = add_delta_seconds(
        original_data, kwargs.get("timestamp_column_names")
    )
    if original_data["delta_seconds"].duplicated().any():
        original_data = original_data.loc[
            ~original_data.delta_seconds.duplicated(keep="last"), :
        ].reset_index(drop=True)
    output = {"original_data": original_data, "step#": 0, "data": original_data.copy()}
    for task in pipeline:
        try:
            task_name = task.get("name")
            task_type = task.get("type")
            output["last_name"] = task_name
            output["last_type"] = task_type
            output["step#"] += 1
            task_params = task.get("params", {})
            result = await getattr(trial_processors, task_type)(
                **output, **task_params, **kwargs
            )
            output.update(result)
        except ValueError as e:
            logger.error(e)
            break
    return output


async def pipeline(path):
    """
    Main entry point

    Parameters
    ----------
    path: str
        path to config.
    """
    logger = ALAACLogger("src")

    config = load_input_json(path)
    config_data = config["data"]
    config_data = _setup_dataset_options(config_data)

    dataset_options = config_data["dataset_options"]
    preparation_pipeline = config_data.get("prep_pipeline")["pipeline"]
    dataset_options, raw_data_sources = await prepare_raw_data(dataset_options)
    tasks = [
        process_item(source, preparation_pipeline, **dataset_options)
        for source in raw_data_sources
    ]
    results = await asyncio.gather(*tasks)

    all_outputs = [result["data"] for result in results if result is not None and "data" in result]

    analysis_pipeline = config_data.get("analysis_pipeline")["pipeline"]

    output = {"input": batch_by_device_id(all_outputs, **dataset_options), "step#": 0}

    tasks = []
    for task in analysis_pipeline:
        task_name = task.get("name")
        task_type = task.get("type")
        output["last_name"] = task_name
        output["last_type"] = task_type
        output["step#"] += 1
        task_params = task.get("params", {})
        tasks.append(getattr(batch_processors, task_type)(
            output["input"], **task_params, **dataset_options
        ))

    results = await asyncio.gather(*tasks)
    all_outputs = [result["status"] for result in results]

    gcs_upload_config = config_data.get("gcs_upload", {"upload": False})
    if gcs_upload_config.get("upload", False):
        try:
            upload_to_gcs(
                gcs_upload_config=gcs_upload_config,
                dataset_options=dataset_options,
                **gcs_upload_config,
            )
        except Exception as e:
            logger.error(f"Upload failed - {e}")
